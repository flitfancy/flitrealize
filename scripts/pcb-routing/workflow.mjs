import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {compileTasks,buildTaskDsn,decodeSes,validateCandidate,overlayBoard,taskConnectivity} from './model.mjs';
import {runRouter} from './runtime.mjs';
import {executeNative,prepareNativeSource,updateBoardSnapshot} from './provider.mjs';

export async function runWorkflow({board,policy,directory,runtime,selection={},escapes={seeds:[],traceSeeds:[]},apply=false,windowId=null,reworkNets=[],settings={},route=runRouter,native=executeNative,log=()=>{}}){
 await fs.mkdir(directory,{recursive:true});const started=performance.now(),runId=randomUUID();
 const state={schemaVersion:1,provider:'easyeda-pro',backend:'freerouting',runId,status:'running',mode:apply?'apply':'candidate',saved:false,target:board.target,tasks:[],counts:{connectedExisting:0,candidates:0,blocked:0,delegated:0},timings:{}};
 const checkpoint=async()=>fs.writeFile(path.join(directory,'workflow.json'),JSON.stringify(state,null,2)+'\n');
 const tasks=compileTasks(board,policy,selection),initial=board,accepted=[],mutableApplied=new Set();let current=board;
 await checkpoint();
 for(const planned of tasks){
  const task=compileTasks(current,policy,{nets:[planned.net],roles:[planned.role]}).find(t=>t.id===planned.id),record={id:task.id,net:task.net,role:task.role,status:task.status};state.tasks.push(record);
  if(task.status==='delegated'){state.counts.delegated++;continue;}
  if(task.status==='already-connected'){state.counts.connectedExisting++;record.scope='endpoint-connectivity; engineering rules are checked separately';continue;}
  if(task.dependentOnMain){const main=compileTasks(current,policy,{nets:[task.net],roles:['load_current_main']})[0];if(!main||main.status!=='already-connected'){record.status='blocked';record.issues=[{code:'LOAD_PATH_NOT_READY'}];state.counts.blocked++;continue;}}
  const slug=createHash('sha256').update(task.id).digest('hex').slice(0,12),taskDir=path.join(directory,'task-'+state.tasks.length+'-'+slug);await fs.mkdir(taskDir,{recursive:true});
  const t=performance.now();let candidate,input,validation;
  try{
   const localMutable=reworkNets.filter(n=>!mutableApplied.has(n));
   for(const relaxed of [false,true]){
    if(relaxed&&(!task.sensitive||task.noiseTarget<=task.noiseGap))break;
    input=buildTaskDsn(current,task,policy,{escapes,reworkNets:localMutable,relaxPreferences:relaxed});
    const suffix=relaxed?'preferred-relaxed':'preferred';const files={input:path.join(taskDir,suffix+'.dsn'),output:path.join(taskDir,suffix+'.ses'),result:path.join(taskDir,suffix+'-result.json'),log:path.join(taskDir,suffix+'.log')};await fs.writeFile(files.input,input.dsn);
    const extraLayers=localMutable.flatMap(net=>policy.nets.find(n=>n.net===net).primaryAutoLayers);
    const result=await route(runtime,{...files,layers:[...new Set([...task.layers,...extraLayers])],layerOrder:current.layers,ignoredClasses:input.ignoredClasses,optimize:policy.automation?.optimizer?.enabled!==false,...settings});
    candidate=decodeSes(await fs.readFile(files.output,'utf8'),current,input);validation=validateCandidate(current,task,candidate,input);record.routerSeconds=(record.routerSeconds??0)+result.seconds;
    if(validation.passed)break;
   }
   await fs.writeFile(path.join(taskDir,'candidate.json'),JSON.stringify({task,input:{...input,dsn:undefined},candidate,validation},null,2));
   if(!validation.passed){record.status='blocked';record.issues=validation.issues;state.counts.blocked++;}
   else{record.status='candidate-validated';record.warnings=validation.warnings;record.addedLines=candidate.segments.length;record.addedVias=candidate.vias.length;accepted.push({task,input,candidate});for(const n of input.reworkNets)mutableApplied.add(n);current=overlayBoard(current,candidate,input.reworkNets);state.counts.candidates++;}
  }catch(error){record.status='blocked';record.issues=[{code:error.message.split(':')[0],detail:error.message}];state.counts.blocked++;}
  record.seconds=(performance.now()-t)/1000;await checkpoint();log({net:record.net,role:record.role,status:record.status,seconds:record.seconds,issues:record.issues});
 }
 const selectedNets=[...new Set(accepted.flatMap(a=>[a.task.net,...a.input.reworkNets]))],mutable=[...mutableApplied];
 const initialSegments=initial.segments.filter(s=>!mutableApplied.has(s.net)),initialVias=initial.vias.filter(v=>!mutableApplied.has(v.net));
 // Native writing preserves the validated candidate exactly. Keep only new
 // model objects; explicitly reworked nets replace their previous copper.
 const expected={segments:current.segments.filter(s=>mutableApplied.has(s.net)||!initialSegments.some(o=>o===s)),vias:current.vias.filter(v=>mutableApplied.has(v.net)||!initialVias.some(o=>o===v))};
 const set={schemaVersion:1,runId,target:initial.target,before:{objects:initial.native.objects,sourceInvariantHash:initial.native.sourceInvariantHash,footprintHash:initial.native.footprintHash},selectedNets,mutableNets:mutable,layerIds:initial.layers,pads:initial.pads,expected,tasks:accepted.map(a=>a.task)};
 await fs.writeFile(path.join(directory,'candidate-set.json'),JSON.stringify(set,null,2));
 if(apply&&accepted.length){
  if(!windowId)throw Error('WINDOW_ID_REQUIRED');
  const sourceFile=await prepareNativeSource(directory),t=performance.now();
  try{
   const result=await native({directory,windowId,mode:'apply',input:set,sourceFile,logName:'apply'});state.timings.apply=(performance.now()-t)/1000;
   if(result.status==='rolled-back'){state.status='rolled-back';state.issues=[{code:result.error}];}
   else if(result.status!=='applied-verified-unsaved'){state.status='needs-attention';state.issues=[{code:result.error??result.status}];}
   else{
    const actual=updateBoardSnapshot(initial,result);
    const actualConnectivity=set.tasks.map(task=>({id:task.id,...taskConnectivity(actual,task)}));if(actualConnectivity.some(c=>!c.connected))throw Error('ACTUAL_TASK_CONNECTIVITY_FAILED');
    const s=performance.now(),saved=await native({directory,windowId,mode:'save',input:{target:set.target,runId},sourceFile,logName:'save'});state.timings.save=(performance.now()-s)/1000;
    if(saved.status!=='saved'||!saved.saved)throw Error('SAVE_NOT_CONFIRMED');state.saved=true;
    const readback=await native({directory,windowId,mode:'inspect',input:{target:set.target},sourceFile,logName:'readback'});
    if(readback.sourceInvariantHash!==saved.sourceInvariantHash||JSON.stringify(readback.objects)!==JSON.stringify(saved.objects))throw Error('INDEPENDENT_READBACK_CHANGED');
    state.status=state.counts.blocked?'saved-with-blocked-tasks':'saved-and-read-back';state.actualConnectivity=actualConnectivity;state.pcbCounts=saved.counts;
    for(const record of state.tasks)if(record.status==='candidate-validated')record.status='saved-and-read-back';
   }
  }catch(error){state.status='needs-attention';state.issues=[{code:error.message,receiptFile:error.receiptFile}];}
 }else state.status=accepted.length?'candidate-ready':state.counts.blocked?'blocked':'no-routing-needed';
 state.totalSeconds=(performance.now()-started)/1000;await checkpoint();return{...state,reportFile:path.join(directory,'workflow.json'),candidateFile:path.join(directory,'candidate-set.json')};
}
