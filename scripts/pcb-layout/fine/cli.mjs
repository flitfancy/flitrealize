import fs from 'node:fs/promises';
import path from 'node:path';
import { studyOutputDirectory } from '../../lib/pcb-study.mjs';
import { loadLayoutProject, readJson, hash } from '../pcb-layout-project.mjs';
import { solveFineLayout, applyFineLayout, resumeFineSave, verifyFineLayout, fineEngineIdentity } from './workflow.mjs';
import { digest, fail } from './common.mjs';
import { prepareLayoutInputs } from '../pcb-layout-prepare.mjs';
import { normalizeFineRequest } from './request.mjs';
import { routeFineCandidate } from './routing.mjs';

export async function main(args=process.argv.slice(2),{log=v=>console.log(JSON.stringify(v)),executionOptions={}}={}) {
  const allowed=new Set(['--stage','--mode','--project-root','--inputs','--prepared','--request','--output','--python','--seconds','--seed','--workers','--from','--window-id','--routing-receipt','--resume-save','--receipt']),o={};
  for(let i=0;i<args.length;i++){if(args[i]==='--help'){log('node scripts/pcb-layout.mjs fine --stage solve|route|apply|resume-save|verify --project-root DIR --output RELATIVE_DIR. Solve: (--inputs FILE | --prepared DIR) --request FILE [--python EXE --seconds TOTAL --seed N --workers N]. Route: --from REPORT [--python EXE --seconds N]. Apply: --from REPORT --window-id ID [--routing-receipt FILE]. Resume-save: --from REPORT --window-id ID --resume-save APPLICATION_OR_RECEIPT [--routing-receipt FILE for old unbound evidence]. Verify: --from REPORT --window-id ID --receipt APPLICATION_OR_RECEIPT; read-only native verification, save outcome remains separate. Solve never writes native PCB; failed labels do not produce a qualified complete candidate.');return;}const key=args[i],value=args[++i];if(!allowed.has(key)||!value||value.startsWith('--')||o[key]!==undefined)fail('FINE_INVALID_ARGUMENT',key);o[key]=value;}
  if(o['--stage']&&o['--mode'])fail('FINE_STAGE_CONFLICT');
  const mode=o['--stage']??o['--mode']??'solve',stageFlags={solve:['--inputs','--prepared','--request','--python','--seconds','--seed','--workers'],route:['--from','--python','--seconds'],apply:['--from','--window-id','--routing-receipt'],'resume-save':['--from','--window-id','--routing-receipt','--resume-save'],verify:['--from','--window-id','--receipt','--routing-receipt']};
  if(!stageFlags[mode]||Object.keys(o).some(k=>!['--stage','--mode','--project-root','--output',...stageFlags[mode]].includes(k)))fail('FINE_STAGE_ARGUMENTS');
  const root=await fs.realpath(o['--project-root']??fail('FINE_PROJECT_ROOT_REQUIRED')),directory=await studyOutputDirectory(root,o['--output']);
  if(mode==='solve'){
    if(Boolean(o['--inputs'])===Boolean(o['--prepared'])||!o['--request']||o['--from']||o['--window-id'])fail('FINE_SOLVE_ARGUMENTS');
    const prepared=o['--prepared']?path.resolve(root,o['--prepared']):null,inputs=await readJson(prepared?path.join(prepared,'inputs.json'):path.resolve(root,o['--inputs']));
    if(prepared){const manifest=await readJson(path.join(prepared,'manifest.json'));if(hash(inputs)!==manifest.inputsHash||hash(inputs.snapshot)!==manifest.snapshotHash)fail('FINE_PREPARED_INPUT_CHANGED');}
    const request=await readJson(path.resolve(root,o['--request'])),settings=Object.fromEntries([['timeLimitSeconds','--seconds'],['seed','--seed'],['workers','--workers']].filter(([,flag])=>o[flag]).map(([key,flag])=>[key,Number(o[flag])]));
    const {result}=await solveFineLayout({inputs,request,directory,settings,runtime:{pythonPath:o['--python']}});log({status:result.status,report:directory,candidateHash:result.candidateHash,nativeWrites:0,stages:result.stages,timing:result.timing,audit:result.audit?{localAccepted:result.audit.localAccepted,outsidePreserved:result.audit.outsidePreserved,regressions:result.audit.regressions,borrowedRefs:result.audit.borrowedRefs}:null});if(result.status!=='candidate-passed')process.exitCode=1;return result;
  }
  if(!['route','apply','resume-save','verify'].includes(mode)||!o['--from']||mode!=='route'&&!o['--window-id']||mode==='route'&&o['--window-id']||o['--inputs']||o['--prepared']||o['--request'])fail('FINE_APPLY_ARGUMENTS');
  const from=path.resolve(root,o['--from']),inputs=await readJson(path.join(from,'inputs.json')),request=await readJson(path.join(from,'request.json')),candidate=await readJson(path.join(from,'candidate.json')),result=await readJson(path.join(from,'result.json')),manifest=await readJson(path.join(from,'manifest.json'));
  if(digest(candidate)!==manifest.candidateFileHash||digest(result)!==manifest.resultHash)fail('FINE_REPORT_CHANGED');
  if(mode==='route'){
    if(digest(await fineEngineIdentity())!==digest(result.source.engine))fail('FINE_ENGINE_CHANGED');
    const prepared=prepareLayoutInputs(inputs);if(!prepared.state.ready)fail('FINE_INPUTS_NOT_READY');
    const receipt=await routeFineCandidate({scope:normalizeFineRequest(prepared.model,request),candidate,directory,python:o['--python'],timeoutMs:Number(o['--seconds']??30)*1000});log({status:receipt.status,report:directory,candidateHash:receipt.candidateHash,nativeWrites:0,scope:receipt.scope});if(receipt.status!=='passed')process.exitCode=1;return receipt;
  }
  const current=await loadLayoutProject(root);if(['config','contract','mechanical'].some(k=>digest(current[k])!==digest(inputs[k])))fail('FINE_PROJECT_INPUTS_CHANGED');
  const routingReceipt=o['--routing-receipt']?await readJson(path.resolve(root,o['--routing-receipt'])):undefined;
  const applyInput={inputs,request,candidate,result,routingReceipt,options:{...executionOptions,projectRoot:root,windowId:o['--window-id'],providerId:inputs.config.provider,reportDir:directory}};
  const application=mode==='verify'?await verifyFineLayout({...applyInput,receiptFile:o['--receipt']}):mode==='resume-save'?await resumeFineSave({...applyInput,resumeSave:o['--resume-save']}):await applyFineLayout(applyInput);
  await fs.writeFile(path.join(directory,mode==='verify'?'verification.json':'application.json'),JSON.stringify(application,null,2)+'\n',{flag:'wx'});log(application);if(application.status!=='verified')process.exitCode=1;return application;
}
