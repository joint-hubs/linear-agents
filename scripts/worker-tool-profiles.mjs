import {existsSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,basename} from 'node:path';
import {readToolProfiles,toolProfilesPath,thoughtmapStdioConfig} from './tool-profiles.mjs';
// Only the launch-owned copies change; running native definitions stay frozen.
// Each role has a private server namespace and a server-side tool subset.
// Native user permission rules remain unchanged.
export function stampWorkerToolProfiles(configDir,{squad,env=process.env}={}){
 const config=readToolProfiles({path:toolProfilesPath(env)}),dir=join(configDir,'agents');const stamped=[];
 if(!existsSync(dir))return stamped;
 for(const file of readdirSync(dir).filter(f=>f.endsWith('.md'))){
  const path=join(dir,file),text=readFileSync(path,'utf8'),match=text.match(/^---\r?\n([\s\S]*?)\r?\n---/);if(!match)continue;
  let front=match[1];const line=front.match(/^tools:\s*(.*)$/m);
  const own=line?(line[1].trim()==='[]'?[]:line[1].split(',').map(t=>t.trim()).filter(Boolean)):null;
  const tools=own??config.squadTools?.[squad]??config.globalTools??null;
  if(tools===null)continue;
  const role=basename(file,'.md'),server='thoughtmap_'+role.replace(/[^a-z0-9_]/gi,'_');
  const selected=tools.filter(t=>t.startsWith('mcp__thoughtmap__'));
  const actual=tools.map(t=>t.startsWith('mcp__thoughtmap__')?'mcp__'+server+'__'+t.slice('mcp__thoughtmap__'.length):t);
  const toolsLine='tools: '+(actual.length?actual.join(', '):'[]');
  front=line?front.replace(/^tools:.*$/m,toolsLine):front+'\n'+toolsLine;
  // The metadata's server field must reflect a server that was actually
  // attached — a disabled server writes no inline block and must report null.
  const attached=selected.length>0&&config.mcp.thoughtmap.enabled;
  if(attached){
   // A role's pre-existing MCP field is preserved; reject an ambiguous merge.
   if(/^mcpServers:/m.test(front))throw Error('worker MCP definition already exists: '+role);
   front+='\nmcpServers: '+JSON.stringify([{[server]:thoughtmapStdioConfig(config.mcp.thoughtmap, selected)}]);
  }
  writeFileSync(path,'---\n'+front+'\n---'+text.slice(match[0].length));stamped.push({role,tools,server:attached?server:null});
 }
 return stamped;
}
