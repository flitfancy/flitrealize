import fs from 'node:fs/promises';
import path from 'node:path';
import { studyOutputDirectory } from '../../lib/pcb-study.mjs';
import { loadLayoutProject, readJson, hash } from '../pcb-layout-project.mjs';
import { solveFineLayout, adoptFineLayout, resumeFineSave, verifyFineLayout, preflightFineLayout, executeFineCandidate, fineEngineIdentity } from './workflow.mjs';
import { digest, fail, createFineTiming } from './common.mjs';
import { prepareLayoutInputs } from '../pcb-layout-prepare.mjs';
import { normalizeFineRequest } from './request.mjs';
import { routeFineCandidate } from './routing.mjs';
import { getLayoutProvider } from '../pcb-layout-provider.mjs';
import { fineHistoricalState } from './evidence.mjs';

export async function main(args=process.argv.slice(2),{log=v=>console.log(JSON.stringify(v)),executionOptions={}}={}) {
  const timing=createFineTiming();
  const allowed=new Set(['--stage','--mode','--project-root','--inputs','--prepared','--request','--plan-file','--output','--python','--seconds','--seed','--workers','--from','--window-id','--routing-receipt','--resume-save','--receipt','--preview']),o={};
  for(let i=0;i<args.length;i++){if(args[i]==='--help'){log('node scripts/pcb-layout.mjs fine --stage solve|adopt|route|preflight|apply|resume-save|verify --project-root DIR --output RELATIVE_DIR. Solve: (--inputs FILE | --prepared DIR) --request FILE [--python EXE --seconds TOTAL --seed N --workers N --preview comparison]. Adopt: (--inputs FILE | --prepared DIR) --request FILE --plan-file COMPLETE_PLAN_OR_CANDIDATE; revalidates existing poses without search or native writes. Route: --from REPORT [--python EXE --seconds N]. Preflight (read-only) / Apply: --from COMPLETE_REPORT [--window-id ID; auto-selects one project session] [--receipt ORIGINAL_APPLY_RECEIPT] [--routing-receipt FILE]. Resume-save: --from REPORT --window-id ID --resume-save APPLICATION_OR_RECEIPT [--routing-receipt FILE for old unbound evidence]. Verify: --from REPORT --window-id ID --receipt APPLICATION_OR_RECEIPT; read-only native verification, save outcome remains separate. Solve never writes native PCB; failed labels do not produce a qualified complete candidate.');return;}const key=args[i],value=args[++i];if(!allowed.has(key)||!value||value.startsWith('--')||o[key]!==undefined)fail('FINE_INVALID_ARGUMENT',key);o[key]=value;}
  if(o['--stage']&&o['--mode'])fail('FINE_STAGE_CONFLICT');
  const mode=o['--stage']??o['--mode']??'solve',stageFlags={solve:['--inputs','--prepared','--request','--python','--seconds','--seed','--workers','--preview'],adopt:['--inputs','--prepared','--request','--plan-file'],route:['--from','--python','--seconds'],preflight:['--from','--window-id','--receipt','--routing-receipt'],apply:['--from','--window-id','--routing-receipt','--receipt'],'resume-save':['--from','--window-id','--routing-receipt','--resume-save'],verify:['--from','--window-id','--receipt','--routing-receipt']};
  if(!stageFlags[mode]||Object.keys(o).some(k=>!['--stage','--mode','--project-root','--output',...stageFlags[mode]].includes(k)))fail('FINE_STAGE_ARGUMENTS');
  if(o['--preview']!==undefined&&!['none','comparison'].includes(o['--preview']))fail('FINE_PREVIEW_MODE');
  const root=await fs.realpath(o['--project-root']??fail('FINE_PROJECT_ROOT_REQUIRED')),directory=mode==='solve'?await timing.run('files',()=>studyOutputDirectory(root,o['--output'])):await studyOutputDirectory(root,o['--output']);
  if(['solve','adopt'].includes(mode)){
    let loaded;
    try {
    if(Boolean(o['--inputs'])===Boolean(o['--prepared'])||!o['--request']||o['--from']||o['--window-id'])fail('FINE_SOLVE_ARGUMENTS');
    const load=async()=>{
      const prepared=o['--prepared']?path.resolve(root,o['--prepared']):null,inputs=await readJson(prepared?path.join(prepared,'inputs.json'):path.resolve(root,o['--inputs']));
      if(prepared){const manifest=await readJson(path.join(prepared,'manifest.json'));if(hash(inputs)!==manifest.inputsHash||hash(inputs.snapshot)!==manifest.snapshotHash)fail('FINE_PREPARED_INPUT_CHANGED');}
      const request=await readJson(path.resolve(root,o['--request'])),settings=Object.fromEntries([['timeLimitSeconds','--seconds'],['seed','--seed'],['workers','--workers']].filter(([,flag])=>o[flag]).map(([key,flag])=>[key,Number(o[flag])]));
      return {inputs,request,settings};
    };
    loaded=mode==='solve'?await timing.run('inputRead',load):await load();
    const {inputs,request,settings}=loaded;
    let operation;
    if(mode==='adopt'){
      if(!o['--plan-file'])fail('FINE_PLAN_FILE_REQUIRED');
      const file=path.resolve(root,o['--plan-file']),external=await readJson(file),plan=external.plan??external;
      if(external.plan&&external.sourceHash!==undefined&&external.sourceHash!==plan.sourceHash)fail('FINE_PLAN_SOURCE_CHANGED');
      operation=await adoptFineLayout({inputs,request,plan,directory,provenance:{sourceFile:file,sourceFileHash:digest(external)}});
    }else operation=await solveFineLayout({inputs,request,directory,settings,runtime:{pythonPath:o['--python']},timing,preview:o['--preview']==='comparison'});
    if(mode==='solve')await fs.writeFile(path.join(directory,'timing.json'),JSON.stringify(timing.snapshot(),null,2)+'\n',{flag:'wx'});
    const {result}=operation;log({status:result.status,report:directory,candidateHash:result.candidateHash,nativeWrites:0,stages:result.stages,timing:result.timing,timingFile:mode==='solve'?path.join(directory,'timing.json'):undefined,rendering:result.rendering,audit:result.audit?{localAccepted:result.audit.localAccepted,nativeEligible:result.audit.nativeEligible,outsidePreserved:result.audit.outsidePreserved,regressions:result.audit.regressions,borrowedRefs:result.audit.borrowedRefs}:null});if(result.status!=='candidate-passed')process.exitCode=1;return result;
    } catch(error) {
      if(mode==='solve'){
        const profile=timing.snapshot(),failedPhase=profile.events.filter(e=>e.status==='failed').at(-1)?.name??profile.events.at(-1)?.name??'arguments';
        await timing.run('files',()=>fs.writeFile(path.join(directory,'failure.json'),JSON.stringify({status:'failed',failedPhase,error:{code:error.code??'FINE_SOLVE_FAILED',message:error.message},sourceHash:loaded?.inputs?.snapshot?.sourceHash,nativeWrites:0,timingFile:'timing.json'},null,2)+'\n',{flag:'wx'}));
        await fs.writeFile(path.join(directory,'timing.json'),JSON.stringify(timing.snapshot(),null,2)+'\n',{flag:'wx'});
      }
      throw error;
    }
  }
  if(!['route','preflight','apply','resume-save','verify'].includes(mode)||!o['--from']||mode==='route'&&o['--window-id']||o['--inputs']||o['--prepared']||o['--request'])fail('FINE_APPLY_ARGUMENTS');
  const from=path.resolve(root,o['--from']),inputs=await readJson(path.join(from,'inputs.json')),request=await readJson(path.join(from,'request.json')),candidate=await readJson(path.join(from,'candidate.json')),result=await readJson(path.join(from,'result.json')),manifest=await readJson(path.join(from,'manifest.json'));
  if(digest(candidate)!==manifest.candidateFileHash||digest(result)!==manifest.resultHash)fail('FINE_REPORT_CHANGED');
  if(mode==='route'){
    if(digest(await fineEngineIdentity())!==digest(result.source.engine))fail('FINE_ENGINE_CHANGED');
    const prepared=prepareLayoutInputs(inputs);if(!prepared.state.ready)fail('FINE_INPUTS_NOT_READY');
    const receipt=await routeFineCandidate({scope:normalizeFineRequest(prepared.model,request),candidate,directory,python:o['--python'],timeoutMs:Number(o['--seconds']??30)*1000});log({status:receipt.status,report:directory,candidateHash:receipt.candidateHash,nativeWrites:0,scope:receipt.scope});if(receipt.status!=='passed')process.exitCode=1;return receipt;
  }
  const started = performance.now();
  const commands = { public: 1, windowDiscovery: 0, nativeRequests: 0 };
  let windowSeconds = 0, nativeSeconds = 0, application;
  try {
    const current = await loadLayoutProject(root);
    if (['config','contract','mechanical'].some(k => digest(current[k]) !== digest(inputs[k]))) fail('FINE_PROJECT_INPUTS_CHANGED');
    const routingReceipt = o['--routing-receipt'] ? await readJson(path.resolve(root,o['--routing-receipt'])) : undefined;
    const provider = getLayoutProvider(inputs.config.provider);
    let windowId = o['--window-id'];
    if (!windowId) {
      const before = performance.now(); commands.windowDiscovery++;
      try { windowId = await (executionOptions.resolveWindow ?? provider.resolveWindow)({ projectRoot: root }); }
      finally { windowSeconds += (performance.now() - before) / 1000; }
    }
    const transport = executionOptions.transport ?? provider.execute;
    const measuredTransport = async request => {
      const before = performance.now(); commands.nativeRequests++;
      try { return await transport(request); }
      finally { nativeSeconds += (performance.now() - before) / 1000; }
    };
    const applyInput = { inputs, request, candidate, result, routingReceipt, receiptFile: o['--receipt'],
      options: { ...executionOptions, transport: measuredTransport, projectRoot: root, windowId,
        providerId: inputs.config.provider ?? 'easyeda-pro', reportDir: directory } };
    application = mode === 'preflight' ? await preflightFineLayout(applyInput)
      : mode === 'verify' ? await verifyFineLayout(applyInput)
      : mode === 'resume-save' ? await resumeFineSave({ ...applyInput, resumeSave: o['--resume-save'] })
      : await executeFineCandidate(applyInput);
  } catch (error) {
    if (mode !== 'preflight') throw error;
    if (error.state === undefined && !error.historyError) {
      try { error.state = await fineHistoricalState({ inputs, request, candidate, result, receiptFile: o['--receipt'],
        options: { projectRoot: root, providerId: inputs.config.provider ?? 'easyeda-pro' } }); }
      catch (historyError) { error.historyError = { code: historyError.code, message: historyError.message }; }
    }
    application = { kind: 'flitrealize.fine-layout.preflight', status: 'preflight-blocked',
      state: error.state ?? { nativeWrites: 0, saved: null },
      error: { code: error.code ?? 'FINE_PREFLIGHT_FAILED', message: error.message },
      conflict: error.details, historyError: error.historyError,
      nextAction: error.details ? 'Review the reported binding conflict; preserve historical save evidence. Do not rewrite the old receipt.'
        : 'Resolve the reported input, session or evidence issue; preserve the original candidate.' };
  }
  application.commands = commands;
  application.timing = { ...application.timing, windowDiscoverySeconds: windowSeconds,
    nativeTransportSeconds: nativeSeconds, wallSeconds: (performance.now() - started) / 1000,
    scope: 'From project reload through result assembly; excludes final report serialization and write. Native time includes host transport and EDA work.' };
  const file = path.join(directory, mode === 'preflight' ? 'preflight.json' : mode === 'verify' ? 'verification.json' : 'application.json');
  await fs.writeFile(file, JSON.stringify(application,null,2) + '\n', { flag: 'wx' });
  const executionReference = application.applyReceipt ?? application.execution?.resumeSaveReport ?? application.state?.applyReceipt;
  log({ status: application.status, report: directory, resultFile: file, state: application.state,
    error: application.error ?? application.native?.error ?? application.execution?.error ?? application.verification?.error,
    conflict: application.conflict, historyError: application.historyError, nextAction: application.nextAction,
    executionReference,
    sourceDifference: application.sourceDifference ? { expectedSourceHash: application.sourceDifference.expectedSourceHash,
      actualSourceHash: application.sourceDifference.actualSourceHash,
      changedObjects: Object.fromEntries(Object.entries(application.sourceDifference.objects).map(([k,v]) => [k,v.length])), details: file } : undefined,
    timing: application.timing, commands });
  if (!['verified','preflight-passed'].includes(application.status)) process.exitCode = 1;
  return application;
}
