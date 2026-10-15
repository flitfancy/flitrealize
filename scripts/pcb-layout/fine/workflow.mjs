import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { prepareLayoutInputs } from '../pcb-layout-prepare.mjs';
import { cpSatSettings, executeCpSat } from '../pcb-layout-cpsat.mjs';
import { layoutEngineIdentity } from '../pcb-layout-project.mjs';
import { applyLayout, resumeLayoutSave, verifyLayout, preflightLayout, inspectLayout } from '../pcb-layout-execution.mjs';
import { normalizeFineRequest } from './request.mjs';
import { compileFineProblem } from './compile.mjs';
import { materializeFineCandidate, normalizeExternalFinePlan, auditFineCandidate, verifyFineReadback } from './audit.mjs';
import { digest, fail, createFineTiming } from './common.mjs';
import { writeFinePreview } from './preview.mjs';
import { verifyFineRoutingReceipt } from './routing.mjs';
import { solveFineLabels } from './labels.mjs';
import { fineLabelRules } from './label-geometry.mjs';
import { inspectCandidate } from '../pcb-layout-solver-core.mjs';
import { recordFineAcceptance, fineApplicationEvidence, findFineExecution, findFineRouting, fineHistoricalState } from './evidence.mjs';

export const fineEngineIdentity=()=>layoutEngineIdentity();
const write=async(dir,name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
async function recordFineResult(directory,result,candidate) {
  if(candidate)await write(directory,'candidate.json',candidate);
  await write(directory,'result.json',result);
  await write(directory,'manifest.json',{schemaVersion:1,kind:'flitrealize.fine-layout.manifest',source:result.source,candidateHash:result.candidateHash,candidateFileHash:candidate?digest(candidate):null,resultHash:digest(result),nativeWrites:0});
}
const solverFailure=status=>({MODEL_INVALID:'model-invalid',UNKNOWN:'budget-exhausted',INFEASIBLE:'infeasible-for-compiled-model',EXECUTION_ERROR:'execution-failed'}[status]??'no-candidate');
export async function solveFineLayout(options) {
  const timing=options.timing??createFineTiming();
  try {
    const operation=await solveFineLayoutCore({...options,timing});
    if(!options.timing&&options.directory)await write(options.directory,'timing.json',timing.snapshot());
    return {...operation,timing:timing.snapshot()};
  } catch(error) {
    error.timing=timing.snapshot();
    if(!options.timing&&options.directory){
      await fs.mkdir(options.directory,{recursive:true});
      await timing.run('files',()=>write(options.directory,'failure.json',{status:'failed',error:{code:error.code,message:error.message},nativeWrites:0,timingFile:'timing.json'}));
      await write(options.directory,'timing.json',timing.snapshot());
    }
    throw error;
  }
}
async function solveFineLayoutCore({inputs,request,settings={},runtime={},directory,executor=executeCpSat,timing,preview=false}) {
  const started=performance.now(),prepared=timing.sync('prepare',()=>{const value=prepareLayoutInputs(inputs);if(!value.state.ready)fail('FINE_INPUTS_NOT_READY',JSON.stringify(value.diagnostics));return value;});
  const scope=timing.sync('scope',()=>normalizeFineRequest(prepared.model,request)),separate=scope.request.labels.mode==='separate',budget=cpSatSettings({timeLimitSeconds:25,displacementWeight:0,...settings});
  const compilation=timing.sync('compile',()=>compileFineProblem(scope,{...budget,timeLimitSeconds:separate?budget.timeLimitSeconds*.8:budget.timeLimitSeconds}));
  const engine=await timing.run('implementationIdentity',()=>fineEngineIdentity());
  if(directory)await timing.run('files',async()=>{await fs.mkdir(directory,{recursive:true});await write(directory,'inputs.json',inputs);await write(directory,'request.json',request);await write(directory,'problem.json',compilation.problem);});
  const stages=[{id:'request',status:'ready',sourceHash:inputs.snapshot.sourceHash}],solveStarted=performance.now();
  let solver,bodyCandidate,candidate=null,labelStage=null,status;
  try{solver=await timing.run('bodySolve',()=>executor(compilation.problem,runtime));}catch(error){solver={status:'EXECUTION_ERROR',error:{code:error.code,message:error.message}};}
  if(['FEASIBLE','OPTIMAL'].includes(solver.status)){
    try{bodyCandidate=timing.sync('reconstruction',()=>materializeFineCandidate(scope,compilation,solver,{bodyOnly:separate,timing}));}
    catch(error){solver.candidateError={code:error.code,message:error.message};}
  }
  stages.push({id:'body',status:bodyCandidate?(bodyCandidate.audit.localAccepted?'accepted':'rejected'):solver.candidateError?'invalid-candidate':solverFailure(solver.status),budgetSeconds:compilation.problem.settings.timeLimitSeconds,seconds:(performance.now()-solveStarted)/1000});
  if(bodyCandidate?.audit.localAccepted){
    if(!separate)candidate=bodyCandidate;
    else{
      const remaining=Math.min(scope.request.labels.maxSeconds??Infinity,budget.timeLimitSeconds-(performance.now()-solveStarted)/1000);
      if(remaining<=0)labelStage={status:'UNKNOWN',budgetSeconds:0};
      else{const before=performance.now();try{labelStage=await solveFineLabels(scope,bodyCandidate.plan,{...budget,timeLimitSeconds:remaining,seed:budget.seed+1},runtime,executor,timing);}catch(error){labelStage={status:'EXECUTION_ERROR',error:{code:error.code,message:error.message}};}labelStage.budgetSeconds=remaining;labelStage.seconds=(performance.now()-before)/1000;}
      if(labelStage.labels){try{candidate=timing.sync('reconstruction',()=>materializeFineCandidate(scope,compilation,solver,{labels:labelStage.labels,timing}));}catch(error){labelStage.candidateError={code:error.code,message:error.message};}}
    }
  }
  stages.push({id:'labels',status:!separate?'joint':labelStage?(candidate?'completed':solverFailure(labelStage.status)):'not-run',budgetSeconds:labelStage?.budgetSeconds,seconds:labelStage?.seconds,bodyHash:labelStage?.problem?.coverage.bodyHash});
  status=candidate?(candidate.audit.localAccepted?'candidate-passed':'candidate-rejected'):labelStage?'labels-'+solverFailure(labelStage.status):bodyCandidate?'body-candidate-rejected':solver.candidateError?'body-candidate-invalid':solverFailure(solver.status);
  stages.push({id:'acceptance',status:candidate?(candidate.audit.localAccepted?'passed':'failed'):'not-run'});
  let rendering={status:preview?'not-run':'not-requested',files:[]};
  if(preview&&candidate&&directory){try{rendering=await timing.run('preview',()=>writeFinePreview(scope,compilation,candidate,directory,timing));}catch(error){rendering={status:'failed',files:[],error:{code:error.code??'FINE_PREVIEW_FAILED',message:error.message}};}}
  const result={schemaVersion:1,kind:'flitrealize.fine-layout.result',status,source:{sourceHash:inputs.snapshot.sourceHash,inputsHash:digest(inputs),requestHash:digest(request),engine},candidateHash:candidate?.candidateHash??null,solverStatus:solver.status,solver:solver.solver,rendering,
    scope:{movableRefs:scope.request.movableRefs,allowedNeighborRefs:scope.request.allowedNeighborRefs,frozenRefs:scope.frozenRefs,labelMovableOwnerRefs:[...scope.labelMoving],lockSources:scope.lockSources,crossingNets:scope.crossingNets,region:scope.request.region,selection:scope.selection},audit:candidate?.audit??null,
    stages,bodyAudit:bodyCandidate?.audit??null,errors:[solver.error,solver.candidateError,labelStage?.error,labelStage?.candidateError].filter(Boolean),
    routing:{status:'not-run',required:scope.request.routing.required,nets:scope.request.routing.nets??[],candidateHash:candidate?.candidateHash??null},state:{placement:status,labels:stages[2].status,native:'not-applied',saved:false,nativeWrites:0},timing:{requestedTotalSeconds:budget.timeLimitSeconds,totalSeconds:(performance.now()-started)/1000,profileFile:'timing.json',scope:'Workflow through result assembly; timing.json includes recorded file output and optional preview. Body/label stage totals overlap their compile/reconstruction/audit samples.'},
    unverified:['Actual copper and ground return','Current sharing, thermal, EMI and manufacturing acceptance','Native write/save/readback until explicitly invoked'],report:directory??null};
  if(directory)await timing.run('files',async()=>{await write(directory,'solver.json',solver);if(bodyCandidate&&separate)await write(directory,'body-candidate.json',bodyCandidate);if(labelStage){if(labelStage.problem)await write(directory,'label-problem.json',labelStage.problem);await write(directory,'label-solver.json',labelStage.solver??labelStage);}await recordFineResult(directory,result,candidate);});
  return {result,candidate,bodyCandidate,labelStage,prepared,scope,compilation};
}

/** Validate an already generated complete plan and use the SAME application
 * contract. No solver call, native write, or rewrite of its original evidence. */
export async function adoptFineLayout({inputs,request,plan,directory,provenance={}}) {
  const started=performance.now(),prepared=prepareLayoutInputs(inputs);
  if(!prepared.state.ready)fail('FINE_INPUTS_NOT_READY',JSON.stringify(prepared.diagnostics));
  const scope=normalizeFineRequest(prepared.model,request),compilation=compileFineProblem(scope);
  const normalized=normalizeExternalFinePlan(scope,compilation,plan),audit=auditFineCandidate(scope,compilation,normalized);
  const engine=await fineEngineIdentity(),candidate={schemaVersion:1,kind:'flitrealize.fine-layout.candidate',plan:normalized,audit,candidateHash:digest(normalized)};
  const status=audit.localAccepted?'candidate-passed':'candidate-rejected';
  const result={schemaVersion:1,kind:'flitrealize.fine-layout.result',status,source:{sourceHash:inputs.snapshot.sourceHash,inputsHash:digest(inputs),requestHash:digest(request),engine,mode:'adopted-complete-plan'},candidateHash:candidate.candidateHash,
    provenance:{...provenance,externalPlanHash:digest(plan),role:'Existing target poses revalidated by the current implementation; original generator evidence is not reissued'},solverStatus:'not-run',
    scope:{movableRefs:scope.request.movableRefs,allowedNeighborRefs:scope.request.allowedNeighborRefs,frozenRefs:scope.frozenRefs,labelMovableOwnerRefs:[...scope.labelMoving],lockSources:scope.lockSources,crossingNets:scope.crossingNets,region:scope.request.region,selection:scope.selection},audit,
    stages:[{id:'request',status:'ready',sourceHash:inputs.snapshot.sourceHash},{id:'existing-plan',status:'reconstructed-from-native-geometry'},{id:'acceptance',status:audit.localAccepted?'passed':'failed'}],
    routing:{status:'not-run',required:scope.request.routing.required,nets:scope.request.routing.nets??[],candidateHash:candidate.candidateHash},state:{placement:status,labels:audit.labelStatus,native:'not-applied',saved:false,nativeWrites:0},
    timing:{totalSeconds:(performance.now()-started)/1000,scope:'Revalidation of existing poses; no search'},unverified:['Native current-source check and write/save/readback','Actual copper, DRC and electrical acceptance'],report:directory??null};
  if(directory){
    await fs.mkdir(directory,{recursive:true});await write(directory,'inputs.json',inputs);await write(directory,'request.json',request);await write(directory,'external-plan.json',plan);
    await recordFineResult(directory,result,audit.localAccepted?candidate:null);
  }
  return {result,candidate:audit.localAccepted?candidate:null,prepared,scope,compilation};
}
async function fineApplicationContext({inputs,request,candidate,result,options,...references}) {
  if(candidate?.kind!=='flitrealize.fine-layout.candidate'||result?.status!=='candidate-passed')fail('FINE_COMPLETE_CANDIDATE_REQUIRED');
  if(!candidate||result.candidateHash!==digest(candidate.plan)||candidate.candidateHash!==result.candidateHash)fail('FINE_CANDIDATE_CHANGED');
  if(digest(inputs)!==result.source.inputsHash||digest(request)!==result.source.requestHash)fail('FINE_INPUTS_CHANGED');
  const currentEngine = await fineEngineIdentity();
  if (digest(currentEngine) !== digest(result.source.engine)) {
    const error = Object.assign(Error('FINE_ENGINE_CHANGED'), { code: 'FINE_ENGINE_CHANGED',
      details: { field: 'engine', expected: currentEngine, actual: result.source.engine } });
    try { error.state = await fineHistoricalState({ inputs, request, candidate, result, options, ...references }); }
    catch (historyError) { error.historyError = { code: historyError.code, message: historyError.message }; }
    throw error;
  }
  const prepared=prepareLayoutInputs(inputs);if(!prepared.state.ready)fail('FINE_INPUTS_NOT_READY');
  const scope=normalizeFineRequest(prepared.model,request),compiled=compileFineProblem(scope),audit=auditFineCandidate(scope,compiled,candidate.plan);
  if(!audit.localAccepted)fail('FINE_CANDIDATE_REJECTED');
  if(!audit.nativeEligible)fail('FINE_NATIVE_ACCEPTANCE_REQUIRED');
  let current;
  function currentContext(baseline) {
    if(current?.sourceHash===baseline.sourceHash)return current;
    const livePrepared=baseline.sourceHash===inputs.snapshot.sourceHash?prepared:prepareLayoutInputs({...inputs,snapshot:baseline});
    if(!livePrepared.state.ready)fail('FINE_LIVE_INPUTS_NOT_READY',JSON.stringify(livePrepared.diagnostics));
    const liveScope=normalizeFineRequest(livePrepared.model,request);
    // Reuse the current native geometry for acceptance. The candidate's
    // original relation distances remain the improvement/non-regression basis.
    const liveCompiled={...compiled,baseline:inspectCandidate(liveScope.model)};
    return current={sourceHash:baseline.sourceHash,scope:liveScope,compiled:liveCompiled};
  }
  function checkCurrent(baseline,effective,writeSet) {
    const live=currentContext(baseline),plan={...effective,
      labels:effective.labels.map(l=>writeSet.labels.includes(l.id)?l:live.compiled.baseline.plan.labels.find(a=>a.id===l.id)),
      testPads:effective.testPads.map(p=>writeSet.pads.includes(p.id)?p:live.compiled.baseline.plan.testPads.find(a=>a.id===p.id))};
    const audit=auditFineCandidate(live.scope,live.compiled,plan,{liveBaseline:true});
    if(!audit.localAccepted)fail('FINE_LIVE_CANDIDATE_REJECTED',JSON.stringify(audit));
    return {live,plan,audit};
  }
  const validatePreflight=async native=>checkCurrent(native.live,native.geometry.effectivePlan,native.geometry.writeSet).audit;
  const validateReadback=async actual=>{
    if(actual.writeBaseline&&actual.effectivePlan&&actual.writeSet){const {live,plan}=checkCurrent(actual.writeBaseline,actual.effectivePlan,actual.writeSet);verifyFineReadback(live.scope.model,plan,actual);}
    else verifyFineReadback(prepared.model,candidate.plan,actual);
    if(options?.validateReadback)await options.validateReadback(actual);
  };
  const glyphRules=fineLabelRules(prepared.model,scope.request.labels),dependencyPadIds=[...new Set([...scope.request.relations.flatMap(r=>[r.from,r.to].flatMap(e=>(e.pads??[e]).map(p=>p.padId))),...prepared.model.limits.filter(l=>[...l.left,...l.right].some(p=>scope.moving.has(p.owner))).flatMap(l=>[...l.left,...l.right].map(p=>p.id))])];
  const config={...prepared.model.mechanical,lockedDesignators:[...new Set([...scope.model.fixed.keys(),...scope.request.fixedRefs])],labelGeometryMode:scope.request.labels.mode,labelRules:glyphRules,labelClearanceMil:scope.request.labels.clearanceMil??prepared.model.mechanical.clearanceMil,labelOwnerMaxDistanceMil:glyphRules.maxOwnerDistanceMil,...(glyphRules.orientation?{labelOrientation:glyphRules.orientation,labelOrientationOwnerRefs:[...scope.labelMoving]}:{}),fineAcceptance:{schemaVersion:1,baselinePolicy:scope.request.baselinePolicy,sourceHash:inputs.snapshot.sourceHash,liveScope:true,labelMovableOwnerRefs:[...scope.labelMoving],dependencyPadIds,dependencyRefs:[...new Set([...prepared.model.fixed.keys(),...scope.request.fixedRefs])]}};
  return {scope,config,validateReadback,validatePreflight};
}
function applicationResult(input, execution, evidence) {
  return {schemaVersion:1,kind:'flitrealize.fine-layout.application',source:input.result.source,candidateHash:input.candidate.candidateHash,status:execution.status,
    state:{placement:'candidate-passed',native:execution.applyState==='applied'?'applied':execution.status,saved:execution.saved??null,verified:execution.status==='verified'},
    acceptanceEvidence:evidence,preservedChanges:execution.preservedChanges??[],execution};
}
function sourceDifference(before,live) {
  const objects={};
  for(const key of ['components','pads','items','outlines','regions']) {
    const old=new Map((before[key]??[]).map(v=>[v.id,v])),now=new Map((live[key]??[]).map(v=>[v.id,v]));
    objects[key]=[...new Set([...old.keys(),...now.keys()])].flatMap(id=>{
      const a=old.get(id),b=now.get(id);if(digest(a??null)===digest(b??null))return [];
      const fields=Object.fromEntries([...new Set([...Object.keys(a??{}),...Object.keys(b??{})])].filter(k=>digest(a?.[k]??null)!==digest(b?.[k]??null)).map(k=>[k,{before:a?.[k]??null,after:b?.[k]??null}]));
      return [{id,ref:b?.ref??b?.owner??a?.ref??a?.owner??null,fields}];
    });
  }
  const lines=s=>String(s??'').split('\n').filter(l=>!l.startsWith('{"type":"DOCHEAD"')),old=new Set(lines(before.source)),now=new Set(lines(live.source));
  return {expectedSourceHash:before.sourceHash,actualSourceHash:live.sourceHash,objects,routing:{before:before.routing,after:live.routing},sourceRecords:{removed:[...old].filter(l=>!now.has(l)),added:[...now].filter(l=>!old.has(l))},
    nextAction:'Retain changes proved outside this write and its dependencies. Resolve only reported conflicts; keep the candidate bound to its original inputs.'};
}

/** Same audited candidate and native checkPlan as apply, with no modification. */
export async function preflightFineLayout(input) {
  const started=performance.now(),context=await fineApplicationContext(input);
  const reference=input.receiptFile??await findFineExecution(input,context.config);
  if(reference){
    const checked=await verifyWithContext({...input,receiptFile:reference},context);
    const failed=checked.verification?.error?.message??'';
    let difference,nativeRequests=1;
    if(failed.includes('SOURCE_CHANGED_RECONCILE')){
      const live=await inspectLayout({...input.options,config:context.config});
      difference=sourceDifference(input.inputs.snapshot,live);difference.comparisonBasis='Frozen pre-apply snapshot; the original apply receipt supplies the expected post-apply fingerprint.';nativeRequests++;
    }
    return {...checked,...(difference?{sourceDifference:difference}:{}),kind:'flitrealize.fine-layout.preflight',nextAction:checked.status!=='verified'?'review-readback':checked.state.saved?'verify-only':checked.state.saveUnsettled?'reconcile-original-request':'resume-save',timing:{preparationSeconds:checked.timing.preparationSeconds,edaSeconds:checked.timing.edaSeconds,totalSeconds:(performance.now()-started)/1000},nativeRequests};
  }
  const routingReceipt=input.routingReceipt??(context.scope.request.routing.required?await findFineRouting(input):undefined);
  if(context.scope.request.routing.required&&!routingReceipt)fail('FINE_REQUIRED_ROUTING_NOT_VERIFIED');
  if(routingReceipt)await verifyFineRoutingReceipt(context.scope,input.candidate,routingReceipt);
  const prepared=performance.now(),native=await (input.execution??preflightLayout)({...input.options,config:context.config,plan:input.candidate.plan,snapshot:input.inputs.snapshot,validatePreflight:context.validatePreflight});
  return {schemaVersion:1,kind:'flitrealize.fine-layout.preflight',status:native.status,source:input.result.source,candidateHash:input.candidate.candidateHash,
    state:{native:'unconfirmed',saved:null,nativeWrites:0},nextAction:native.status==='preflight-passed'?'apply':'review-source-and-preflight',native,
    ...(native.live.sourceHash!==input.inputs.snapshot.sourceHash?{sourceDifference:sourceDifference(input.inputs.snapshot,native.live)}:{}),
    timing:{preparationSeconds:(prepared-started)/1000,edaSeconds:(performance.now()-prepared)/1000,totalSeconds:(performance.now()-started)/1000},nativeRequests:1};
}

/** Reuse verified core evidence for the same plan; never replay apply/save. */
export async function executeFineCandidate(input) {
  const context=await fineApplicationContext(input),reference=input.receiptFile??await findFineExecution(input,context.config);
  if(reference){
    const bound=await fineApplicationEvidence({...input,reference,required:context.scope.request.routing.required,config:context.config});
    if(bound.save.unsettled&&bound.save.saved!==true)fail('FINE_TARGET_OUTCOME_UNKNOWN','Reconcile the original request: '+reference);
    if(bound.save.saved===true)return verifyWithContext({...input,receiptFile:reference},context,bound);
    return resumeWithContext({...input,resumeSave:reference},context,bound);
  }
  const routingReceipt=input.routingReceipt??(context.scope.request.routing.required?await findFineRouting(input):undefined);
  return applyWithContext({...input,routingReceipt},context);
}

export async function applyFineLayout(input) {
  return applyWithContext(input, await fineApplicationContext(input));
}
async function applyWithContext(input, context) {
  const {inputs,request,candidate,result,options,execution=applyLayout}=input;
  const routingReceipt=input.routingReceipt?structuredClone(input.routingReceipt):undefined;
  if(context.scope.request.routing.required&&!routingReceipt)fail('FINE_REQUIRED_ROUTING_NOT_VERIFIED');
  if(routingReceipt)await verifyFineRoutingReceipt(context.scope,candidate,routingReceipt);
  const acceptanceEvidence=await recordFineAcceptance({inputs,request,candidate,result},context.scope.request.routing.required,routingReceipt,options);
  const executed=await execution({...options,config:context.config,plan:candidate.plan,snapshot:inputs.snapshot,validateReadback:context.validateReadback,validatePreflight:context.validatePreflight,acceptanceEvidence});
  return applicationResult(input,executed,acceptanceEvidence);
}
async function fineRecoveryContext(input, reference, context, existingBound) {
  const bound=existingBound??await fineApplicationEvidence({...input,reference,required:context.scope.request.routing.required,config:context.config});
  if(bound.routingReceipt)await verifyFineRoutingReceipt(context.scope,input.candidate,bound.routingReceipt);
  return {...context,bound};
}
export async function resumeFineSave(input) {
  if(!input.resumeSave)fail('FINE_RESUME_RECEIPT_REQUIRED');
  return resumeWithContext(input, await fineApplicationContext(input));
}
async function resumeWithContext(input, context, existingBound) {
  const {bound,validateReadback}=await fineRecoveryContext(input,input.resumeSave,context,existingBound);
  // Use the original receipt and the existing save state machine. No apply,
  // route search, new save identity or second copy of routing evidence.
  const executed=await (input.execution??resumeLayoutSave)({...input.options,config:bound.receipt.config,plan:bound.receipt.plan,snapshot:bound.receipt.snapshot,validateReadback,resumeSave:bound.nativeReference});
  return applicationResult(input,executed,bound.receipt.acceptanceEvidence??null);
}
export async function verifyFineLayout(input) {
  if(!input.receiptFile)fail('FINE_VERIFY_RECEIPT_REQUIRED');
  const started=performance.now();
  return verifyWithContext(input, await fineApplicationContext(input), undefined, started);
}
async function verifyWithContext(input, context, existingBound, started=performance.now()) {
  const {bound,validateReadback}=await fineRecoveryContext(input,input.receiptFile,context,existingBound);
  const prepared=performance.now();
  let verified;
  try {
    verified=await (input.execution??verifyLayout)({...input.options,config:bound.receipt.config,plan:bound.receipt.plan,snapshot:bound.receipt.snapshot,writeBaseline:bound.receipt.writeBaseline,expectedSourceHash:bound.receipt.expectedSourceHash,validateReadback});
  } catch(error) { verified={status:'verification-failed',error:{code:error.code??'FINE_VERIFICATION_FAILED',message:error.message}}; }
  return {schemaVersion:1,kind:'flitrealize.fine-layout.verification',source:input.result.source,candidateHash:input.candidate.candidateHash,status:verified.status,
    state:{placement:'candidate-passed',native:'read-only',saved:bound.save.saved,verified:verified.status==='verified',savePending:bound.save.pending,saveUnsettled:bound.save.unsettled,nativeWrites:0},
    applyReceipt:bound.receiptFile,verification:verified,timing:{preparationSeconds:(prepared-started)/1000,edaSeconds:(performance.now()-prepared)/1000,totalSeconds:(performance.now()-started)/1000}};
}
