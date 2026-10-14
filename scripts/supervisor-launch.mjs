import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, cpSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { prepareAgentLaunch } from './agent-launch-profile.mjs';

// The canonical agents dir accumulates every launch's copies (cpSync merges,
// it never deletes), so a role removed from the squad source would otherwise
// stay available forever. The prune is scoped and fail-closed: a file is
// removed ONLY when it is a top-level .md absent from the fresh snapshot,
// absent from this launch's skip list, and byte-identical to the same-named
// file in the previous launch-owned snapshot (launch-profile.json) — the
// proof it was launch-copied, not authored in place. Anything uncertain stays.
function pruneStaleCopiedAgents(configDir,launch){
 const agentsDir=join(configDir,'agents'),freshDir=join(launch.configDir,'agents');
 if(!existsSync(agentsDir)||!existsSync(freshDir))return [];
 const launchRoot=resolve(join(dirname(configDir),'launch'));
 let prevAgentsDir=null;
 try{
  const meta=JSON.parse(readFileSync(join(dirname(configDir),'launch-profile.json'),'utf8'));
  if(typeof meta?.outputDir==='string'){
   const resolved=resolve(meta.outputDir);
   if(resolved.startsWith(launchRoot+sep)&&resolved!==resolve(launch.configDir)&&existsSync(join(resolved,'agents')))prevAgentsDir=join(resolved,'agents');
  }
 }catch{/* no or unreadable metadata → no provenance → prune nothing */}
 if(!prevAgentsDir)return [];
 const skippedNames=new Set(launch.skipped.map(s=>String(s?.path).split(/[\\/]/).pop()));
 const fresh=new Set(readdirSync(freshDir));
 const removed=[];
 for(const name of readdirSync(agentsDir)){
  if(!name.endsWith('.md')||fresh.has(name)||skippedNames.has(name))continue;
  const path=join(agentsDir,name);
  try{
   if(!lstatSync(path).isFile())continue;
   const prevPath=join(prevAgentsDir,name);
   if(!existsSync(prevPath)||!lstatSync(prevPath).isFile())continue;
   if(!readFileSync(path).equals(readFileSync(prevPath)))continue;
   rmSync(path);removed.push(name);
  }catch{/* uncertain → the file stays */}
 }
 return removed;
}

// A Supervisor keeps one private native history; each process gets immutable
// MCP/tool snapshots and refreshed settings only before that process starts.
export function prepareSupervisorLaunch(env = process.env) {
 const configDir=env.CLAUDE_CONFIG_DIR;
 if(!configDir) throw Error('CLAUDE_CONFIG_DIR is required');
 const sessionId=env.FENIX_SUPERVISOR_SESSION_ID;
 const context=sessionId ? {taskKey:env.LA_TASK_KEY,supervisorSessionId:sessionId,workflowRunId:env.LA_SUPERVISOR_RUN,actorId:sessionId+':supervisor',role:'supervisor',attemptId:'launch:'+randomUUID()} : null;
 const outputDir=join(dirname(configDir),'launch',randomUUID());
 const launch=prepareAgentLaunch({squad:'supervisor',role:'lead',outputDir,previousConfigDir:configDir,env,context});
 mkdirSync(configDir,{recursive:true});
 for(const name of ['settings.json','snapshot.json','CLAUDE.md']) if(existsSync(join(outputDir,name)))copyFileSync(join(outputDir,name),join(configDir,name));
 if(existsSync(join(outputDir,'agents')))cpSync(join(outputDir,'agents'),join(configDir,'agents'),{recursive:true});
 // Must run before launch-profile.json is overwritten below: the previous
 // snapshot it names is the provenance proof the prune decides on.
 const prunedAgents=pruneStaleCopiedAgents(configDir,launch);
 if(context){
   const promptPath=join(configDir,'CLAUDE.md');
   const text=existsSync(promptPath)?readFileSync(promptPath,'utf8'):'';
   writeFileSync(promptPath,text+'\n\n## Runtime workflow completion\nWhen spawning a next stage, pass --after-child with the comma-separated child IDs whose completed output it depends on. Record every final flow choice with supervisor-triage record --size. Never infer dependency order from timestamps. After the task delivery is verified and all requested work is complete, run node "$LA_ROOT/scripts/runtime-workflow.mjs" complete before your final delivery response. This records an explicit completion event for this task. Never run it for a pause, an idle turn, a failed attempt or unfinished work.\n');
 }
 const metadata={revision:launch.profile.revision,changes:launch.changes,profileInitial:launch.profileInitial,outputDir,at:new Date().toISOString()};
 writeFileSync(join(dirname(configDir),'launch-profile.json'),JSON.stringify(metadata,null,2));
 return {...launch,configDir,prunedAgents,env:{...env,...launch.env,CLAUDE_CONFIG_DIR:configDir}};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const launch=prepareSupervisorLaunch();
  const child=spawn(process.env.LA_CLAUDE_BIN||'claude',[...process.argv.slice(2),...launch.cliArgs],{env:launch.env,stdio:'inherit'});
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>child.kill(signal));
  child.on('error',()=>{console.error('Supervisor process could not start');process.exitCode=1;});
  child.on('exit',(code)=>{process.exitCode=code??1;});
 }catch(error){console.error('Supervisor launch refused: '+error.message);process.exitCode=1;}
}
