#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {recordRuntimeEvent,queryRuntimeEvents,isRuntimeToken,RUNTIME_STAGES} from './runtime-events.mjs';
export function runtimeContext(env=process.env){
 const c={taskKey:env.LA_TASK_KEY,supervisorSessionId:env.FENIX_SUPERVISOR_SESSION_ID,workflowRunId:env.LA_SUPERVISOR_RUN,actorId:env.FENIX_ACTOR_ID,role:env.FENIX_ACTOR_ROLE,attemptId:env.FENIX_ATTEMPT_ID};
 return Object.values(c).every(isRuntimeToken)?c:null;
}
const id=(parts)=>'hook:'+createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export function recordHookEvent(input,{env=process.env,dbPath}={}){
 const c=runtimeContext(env);if(!c||!input||typeof input!=='object')return [];
 const event=input.hook_event_name, nativeId=input.agent_id;
 const child=['SubagentStart','SubagentStop'].includes(event);
 if(child&&!isRuntimeToken(nativeId))return [];
 const identity=child?{...c,actorId:c.actorId+':'+nativeId,parentActorId:c.actorId,role:isRuntimeToken(input.agent_type)?input.agent_type:'unknown'}:c;
 const rows=[]; const emit=(type,payload={},eventId)=>rows.push(recordRuntimeEvent({...identity,eventType:type,eventId:eventId??id([c.attemptId,input.session_id??null,event,nativeId??null,type,event==='Stop'?randomUUID():null]),payload},{dbPath}));
 if(event==='SessionStart'||event==='SubagentStart')emit(child||c.role!=='supervisor'?'actor_started':'supervisor_started');
 else if(event==='SessionEnd'||event==='SubagentStop')emit(child||c.role!=='supervisor'?'actor_stopped':'supervisor_stopped',{status:'ended'});
 else if(event==='Stop')emit('actor_state_changed',{state:'idle'});
 else return [];
 if(!child&&RUNTIME_STAGES.includes(env.FENIX_STAGE)){
   if(event==='SessionStart'){
     let dependencies=[];try{dependencies=JSON.parse(env.FENIX_DEPENDS_ON_ATTEMPTS||'[]');}catch{}
     if(!Array.isArray(dependencies)||!dependencies.every(isRuntimeToken))dependencies=[];
     emit('stage_attempt_started',{stages:[env.FENIX_STAGE],dependsOnAttemptIds:dependencies});
     if(env.FENIX_RUNTIME_RETURN){
       // The pending return is RETAINED in the registry across retries (the
       // follow-up no longer clears it at launch), so the same payload can be
       // re-delivered by a later turn's SessionStart. The event id is therefore
       // keyed on the return's CONTENT, not on the attempt or session: a
       // re-delivery after a failed launch — or any later turn of the same
       // child — collapses onto the first recorded row (first write wins),
       // leaving exactly one return_to_dev per pending return. The stored
       // toAttemptId is the attempt that actually consumed it.
       try{const p=JSON.parse(env.FENIX_RUNTIME_RETURN);emit('return_to_dev',{fromAttemptId:p.sourceAttemptId,toAttemptId:c.attemptId,source:p.source,reason:p.reason,evidenceRef:p.evidenceRef,evidenceKind:p.evidenceKind??'direct'},id(['return_to_dev',c.taskKey,c.workflowRunId,p.sourceAttemptId,p.source,p.reason,p.evidenceRef??null,p.evidenceKind??'direct']));}catch{}
     }
   }
   if(event==='SessionEnd')emit('stage_attempt_completed',{stages:[env.FENIX_STAGE],status:'ended'});
 }
 return rows;
}
export function recordRuntimeChoice(stages,{env=process.env,dbPath}={}){
 const c=runtimeContext(env);if(!c||!Array.isArray(stages))return null;
 const normalized=stages.length?stages:['supervisor'];
 const previous=queryRuntimeEvents({taskKey:c.taskKey},{dbPath}).filter(e=>e.workflowRunId===c.workflowRunId&&['workflow_selected','workflow_revised'].includes(e.type)).at(-1);
 if(previous&&JSON.stringify(previous.payload.stages)===JSON.stringify(normalized))return null;
 return recordRuntimeEvent({...c,eventId:'flow:'+randomUUID(),eventType:previous?'workflow_revised':'workflow_selected',payload:{stages:normalized}},{dbPath});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const text=readFileSync(0,'utf8');if(Buffer.byteLength(text)<=1048576)recordHookEvent(JSON.parse(text));}catch{}
}
