import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { prepareLayoutInputs } from '../pcb-layout-prepare.mjs';
import { cpSatSettings, executeCpSat } from '../pcb-layout-cpsat.mjs';
import { layoutEngineIdentity } from '../pcb-layout-project.mjs';
import { applyLayout, resumeLayoutSave, verifyLayout } from '../pcb-layout-execution.mjs';
import { normalizeFineRequest } from './request.mjs';
import { compileFineProblem } from './compile.mjs';
import { materializeFineCandidate, auditFineCandidate, verifyFineReadback } from './audit.mjs';
import { digest, fail } from './common.mjs';
import { verifyFineRoutingReceipt } from './routing.mjs';
import { solveFineLabels } from './labels.mjs';
import { fineLabelRules } from './label-geometry.mjs';
import { recordFineAcceptance, fineApplicationEvidence } from './evidence.mjs';

export const fineEngineIdentity=()=>layoutEngineIdentity();
const write=async(dir,name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const solverFailure=status=>({MODEL_INVALID:'model-invalid',UNKNOWN:'budget-exhausted',INFEASIBLE:'infeasible-for-compiled-model',EXECUTION_ERROR:'execution-failed'}[status]??'no-candidate');
export async function solveFineLayout({inputs,request,settings={},runtime={},directory,executor=executeCpSat}) {
  const started=performance.now(),prepared=prepareLayoutInputs(inputs);
  if(!prepared.state.ready)fail('FINE_INPUTS_NOT_READY',JSON.stringify(prepared.diagnostics));
  const scope=normalizeFineRequest(prepared.model,request),separate=scope.request.labels.mode==='separate',budget=cpSatSettings({timeLimitSeconds:25,displacementWeight:0,...settings});
  const compilation=compileFineProblem(scope,{...budget,timeLimitSeconds:separate?budget.timeLimitSeconds*.8:budget.timeLimitSeconds});
  const engine=await fineEngineIdentity();
  if(directory){await fs.mkdir(directory,{recursive:true});await write(directory,'inputs.json',inputs);await write(directory,'request.json',request);await write(directory,'problem.json',compilation.problem);}
  const stages=[{id:'request',status:'ready',sourceHash:inputs.snapshot.sourceHash}],solveStarted=performance.now();
  let solver,bodyCandidate,candidate=null,labelStage=null,status;
  try{solver=await executor(compilation.problem,runtime);}catch(error){solver={status:'EXECUTION_ERROR',error:{code:error.code,message:error.message}};}
  if(['FEASIBLE','OPTIMAL'].includes(solver.status)){
    try{bodyCandidate=materializeFineCandidate(scope,compilation,solver,{bodyOnly:separate});}
    catch(error){solver.candidateError={code:error.code,message:error.message};}
  }
  stages.push({id:'body',status:bodyCandidate?(bodyCandidate.audit.localAccepted?'accepted':'rejected'):solver.candidateError?'invalid-candidate':solverFailure(solver.status),budgetSeconds:compilation.problem.settings.timeLimitSeconds,seconds:(performance.now()-solveStarted)/1000});
  if(bodyCandidate?.audit.localAccepted){
    if(!separate)candidate=bodyCandidate;
    else{
      const remaining=Math.min(scope.request.labels.maxSeconds??Infinity,budget.timeLimitSeconds-(performance.now()-solveStarted)/1000);
      if(remaining<=0)labelStage={status:'UNKNOWN',budgetSeconds:0};
      else{const before=performance.now();try{labelStage=await solveFineLabels(scope,bodyCandidate.plan,{...budget,timeLimitSeconds:remaining,seed:budget.seed+1},runtime,executor);}catch(error){labelStage={status:'EXECUTION_ERROR',error:{code:error.code,message:error.message}};}labelStage.budgetSeconds=remaining;labelStage.seconds=(performance.now()-before)/1000;}
      if(labelStage.labels){try{candidate=materializeFineCandidate(scope,compilation,solver,{labels:labelStage.labels});}catch(error){labelStage.candidateError={code:error.code,message:error.message};}}
    }
  }
  stages.push({id:'labels',status:!separate?'joint':labelStage?(candidate?'completed':solverFailure(labelStage.status)):'not-run',budgetSeconds:labelStage?.budgetSeconds,seconds:labelStage?.seconds,bodyHash:labelStage?.problem?.coverage.bodyHash});
  status=candidate?(candidate.audit.localAccepted?'candidate-passed':'candidate-rejected'):labelStage?'labels-'+solverFailure(labelStage.status):bodyCandidate?'body-candidate-rejected':solver.candidateError?'body-candidate-invalid':solverFailure(solver.status);
  stages.push({id:'acceptance',status:candidate?(candidate.audit.localAccepted?'passed':'failed'):'not-run'});
  const result={schemaVersion:1,kind:'flitrealize.fine-layout.result',status,source:{sourceHash:inputs.snapshot.sourceHash,inputsHash:digest(inputs),requestHash:digest(request),engine},candidateHash:candidate?.candidateHash??null,solverStatus:solver.status,solver:solver.solver,
    scope:{movableRefs:scope.request.movableRefs,allowedNeighborRefs:scope.request.allowedNeighborRefs,frozenRefs:scope.frozenRefs,lockSources:scope.lockSources,crossingNets:scope.crossingNets,region:scope.request.region},audit:candidate?.audit??null,
    stages,bodyAudit:bodyCandidate?.audit??null,errors:[solver.error,solver.candidateError,labelStage?.error,labelStage?.candidateError].filter(Boolean),
    routing:{status:'not-run',required:scope.request.routing.required,nets:scope.request.routing.nets??[],candidateHash:candidate?.candidateHash??null},state:{placement:status,labels:stages[2].status,native:'not-applied',saved:false,nativeWrites:0},timing:{requestedTotalSeconds:budget.timeLimitSeconds,totalSeconds:(performance.now()-started)/1000,scope:'Bounded body then remaining-time label budget; process startup and evidence I/O are separately observable wall-time overhead'},
    unverified:['Actual copper and ground return','Current sharing, thermal, EMI and manufacturing acceptance','Native write/save/readback until explicitly invoked'],report:directory??null};
  if(directory){await write(directory,'solver.json',solver);if(bodyCandidate&&separate)await write(directory,'body-candidate.json',bodyCandidate);if(labelStage){if(labelStage.problem)await write(directory,'label-problem.json',labelStage.problem);await write(directory,'label-solver.json',labelStage.solver??labelStage);}if(candidate)await write(directory,'candidate.json',candidate);await write(directory,'result.json',result);await write(directory,'manifest.json',{schemaVersion:1,kind:'flitrealize.fine-layout.manifest',source:result.source,candidateHash:result.candidateHash,candidateFileHash:candidate?digest(candidate):null,resultHash:digest(result),nativeWrites:0});}
  return {result,candidate,bodyCandidate,labelStage,prepared,scope,compilation};
}
async function fineApplicationContext({inputs,request,candidate,result,options}) {
  if(candidate?.kind!=='flitrealize.fine-layout.candidate'||result?.status!=='candidate-passed')fail('FINE_COMPLETE_CANDIDATE_REQUIRED');
  if(!candidate||result.candidateHash!==digest(candidate.plan)||candidate.candidateHash!==result.candidateHash)fail('FINE_CANDIDATE_CHANGED');
  if(digest(inputs)!==result.source.inputsHash||digest(request)!==result.source.requestHash)fail('FINE_INPUTS_CHANGED');
  if(digest(await fineEngineIdentity())!==digest(result.source.engine))fail('FINE_ENGINE_CHANGED');
  const prepared=prepareLayoutInputs(inputs);if(!prepared.state.ready)fail('FINE_INPUTS_NOT_READY');
  const scope=normalizeFineRequest(prepared.model,request),compiled=compileFineProblem(scope),audit=auditFineCandidate(scope,compiled,candidate.plan);
  if(!audit.localAccepted)fail('FINE_CANDIDATE_REJECTED');
  if(!audit.nativeEligible)fail('FINE_NATIVE_PREFLIGHT_REQUIRES_CLEAN_BOARD','The public writer rejects existing global geometry failures; this local candidate stays offline.');
  const validateReadback=async actual=>{verifyFineReadback(prepared.model,candidate.plan,actual);if(options?.validateReadback)await options.validateReadback(actual);};
  const glyphRules=fineLabelRules(prepared.model,scope.request.labels),config={...prepared.model.mechanical,labelGeometryMode:scope.request.labels.mode,labelClearanceMil:glyphRules.clearanceMil,labelGapByOwner:glyphRules.gapByOwner,labelOwnerMaxDistanceMil:glyphRules.maxOwnerDistanceMil};
  return {scope,config,validateReadback};
}
function applicationResult(input, execution, evidence) {
  return {schemaVersion:1,kind:'flitrealize.fine-layout.application',source:input.result.source,candidateHash:input.candidate.candidateHash,status:execution.status,
    state:{placement:'candidate-passed',native:execution.applyState==='applied'?'applied':execution.status,saved:execution.saved??null,verified:execution.status==='verified'},
    acceptanceEvidence:evidence,execution};
}
export async function applyFineLayout(input) {
  const {inputs,request,candidate,result,options,execution=applyLayout}=input;
  const routingReceipt=input.routingReceipt?structuredClone(input.routingReceipt):undefined;
  const context=await fineApplicationContext(input);
  if(context.scope.request.routing.required&&!routingReceipt)fail('FINE_REQUIRED_ROUTING_NOT_VERIFIED');
  if(routingReceipt)await verifyFineRoutingReceipt(context.scope,candidate,routingReceipt);
  const acceptanceEvidence=await recordFineAcceptance({inputs,request,candidate,result},context.scope.request.routing.required,routingReceipt,options);
  const executed=await execution({...options,config:context.config,plan:candidate.plan,snapshot:inputs.snapshot,validateReadback:context.validateReadback,acceptanceEvidence});
  return applicationResult(input,executed,acceptanceEvidence);
}
async function fineRecoveryContext(input, reference) {
  const context=await fineApplicationContext(input);
  const bound=await fineApplicationEvidence({...input,reference,required:context.scope.request.routing.required,config:context.config});
  if(bound.routingReceipt)await verifyFineRoutingReceipt(context.scope,input.candidate,bound.routingReceipt);
  return {...context,bound};
}
export async function resumeFineSave(input) {
  if(!input.resumeSave)fail('FINE_RESUME_RECEIPT_REQUIRED');
  const {bound,validateReadback}=await fineRecoveryContext(input,input.resumeSave);
  // Use the original receipt and the existing save state machine. No apply,
  // route search, new save identity or second copy of routing evidence.
  const executed=await (input.execution??resumeLayoutSave)({...input.options,config:bound.receipt.config,plan:bound.receipt.plan,snapshot:bound.receipt.snapshot,validateReadback,resumeSave:bound.nativeReference});
  return applicationResult(input,executed,bound.receipt.acceptanceEvidence??null);
}
export async function verifyFineLayout(input) {
  if(!input.receiptFile)fail('FINE_VERIFY_RECEIPT_REQUIRED');
  const {bound,validateReadback}=await fineRecoveryContext(input,input.receiptFile);
  let verified;
  try {
    verified=await (input.execution??verifyLayout)({...input.options,config:bound.receipt.config,plan:bound.receipt.plan,snapshot:bound.receipt.snapshot,expectedSourceHash:bound.receipt.expectedSourceHash,validateReadback});
  } catch(error) { verified={status:'verification-failed',error:{code:error.code??'FINE_VERIFICATION_FAILED',message:error.message}}; }
  return {schemaVersion:1,kind:'flitrealize.fine-layout.verification',source:input.result.source,candidateHash:input.candidate.candidateHash,status:verified.status,
    state:{placement:'candidate-passed',native:'read-only',saved:bound.save.saved,verified:verified.status==='verified',savePending:bound.save.pending,saveUnsettled:bound.save.unsettled,nativeWrites:0},
    applyReceipt:bound.receiptFile,verification:verified};
}
