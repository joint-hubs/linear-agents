#!/usr/bin/env node
import {recordRuntimeEvent} from './runtime-events.mjs';
import {pathToFileURL} from 'node:url';
export function completeWorkflow(env=process.env){
 const context={taskKey:env.LA_TASK_KEY,supervisorSessionId:env.FENIX_SUPERVISOR_SESSION_ID,workflowRunId:env.LA_SUPERVISOR_RUN,actorId:env.FENIX_ACTOR_ID,role:env.FENIX_ACTOR_ROLE||'supervisor'};
 return recordRuntimeEvent({...context,eventId:context.workflowRunId+':workflow-completed',eventType:'workflow_completed',payload:{status:'completed'}});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv[2]!=='complete'){console.error('Usage: runtime-workflow.mjs complete');process.exitCode=2;}
 else try{completeWorkflow();console.log(JSON.stringify({recorded:true}));}catch{console.error('Workflow completion requires the managed task runtime context');process.exitCode=1;}
}
