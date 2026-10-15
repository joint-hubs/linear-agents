import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export function installRuntimeHooks(configDir) {
 const file=join(configDir,'settings.json');const settings=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
 settings.hooks??={};
 const script=join(dirname(fileURLToPath(import.meta.url)),'runtime-hook.mjs').replaceAll('\\','/');
 const command='node "'+script+'"';
 for(const event of ['SessionStart','SessionEnd','SubagentStart','SubagentStop','Stop']){
  const entries=settings.hooks[event]??=[];
  if(!entries.some(e=>e.hooks?.some(h=>h.command===command)))entries.push({hooks:[{type:'command',command,timeout:10}]});
  settings.hooks[event]=entries;
 }
 writeFileSync(file,JSON.stringify(settings,null,2)+'\n');
}
