#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {isDirectExecution} from './lib/cli-entrypoint.mjs';
import {runPythonJson} from './lib/pcb-python.mjs';
import {studyOutputDirectory,pcbImplementationFingerprint} from './lib/pcb-study.mjs';
export {studyOutputDirectory} from './lib/pcb-study.mjs';

const help=`Offline PCB pre-routing and reusable analysis; no EDA writes.
node scripts/pcb-preroute.mjs --project-root DIR --input FILE --mode MODE [--candidate FILE]
  modes: prepare | fanout | route | verify | diagnose | ground
         scan | joint-fanout | paths | repair-plan | transition-plan | prune | shortcut | compose
  --output PROJECT_RELATIVE_DIR --python EXECUTABLE --timeout-ms N
Input is a {board,policy,options,...} request, or a normalized frozen pre-route input.
Ground is potential-space analysis, not actual poured copper or native DRC.`;
const read=async f=>JSON.parse((await fs.readFile(f,'utf8')).replace(/^\uFEFF/,''));
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function implementationFingerprint() {
  return pcbImplementationFingerprint(fileURLToPath(new URL('./',import.meta.url)),{directories:['pcb-routing'],files:['pcb-preroute.mjs','lib/pcb-study.mjs','lib/pcb-python.mjs']});
}

function commonBoard(board) {
  if(!board?.pads||!board.segments||!board.vias)throw Error('STUDY_BOARD_REQUIRED');
  if(board.units!==undefined&&board.units!=='mil')throw Error('STUDY_BOARD_UNITS_MUST_BE_MIL');
  return{...board,pads:board.pads.map(p=>({...p,ref:p.ref??p.owner,pin:p.pin??p.number}))};
}
function normalizeBoardForGrid(board) {
  const out=structuredClone(board);
  if(!out.boardMil){const b=out.bounds??out.boardBounds;if(!b||b.minX!==0||b.minY!==0)throw Error('PREROUTE_ZERO_ORIGIN_RECTANGULAR_BOARD_REQUIRED');out.boardMil=[b.maxX,b.maxY];}
  if(out.pads)out.pads=out.pads.map(p=>({...p,owner:p.owner??p.ref,number:p.number??p.pin}));return out;
}
export function summarizePreroute(result,directory) {
  return{status:result.status,mode:result.mode,nativeWrites:0,report:directory,
    ...(result.verification?{connected:result.verification.nowConnected,remaining:result.verification.remaining,issues:result.verification.issues.length}:{}),
    ...(result.input?{pads:result.input.pads.length,nets:result.input.nets.length,delegated:result.input.delegatedNets}:{}),
    ...(result.board?{segments:result.board.segments.length,vias:result.board.vias.length}:{}),
    ...(result.connected!==undefined?{connected:result.connected}:{}),
    ...(result.potentialReachableGroundPads!==undefined?{potentialReachableGroundPads:result.potentialReachableGroundPads,groundPads:result.groundPads}:{}),
    ...(result.graphStatus?{graphStatus:result.graphStatus}:{}),
    ...(result.resultFile?{resultFile:result.resultFile}:{}),scope:result.scope??'offline candidate/analysis; native DRC and ground return not verified'};
}

export async function runPrerouteStudy(request,{mode=request.mode??'prepare',directory,python,timeoutMs=180000,log=()=>{}}={}) {
  if(!directory)throw Error('PREROUTE_REPORT_DIRECTORY_REQUIRED');
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw Error('INVALID_PREROUTE_TIMEOUT');
  if(request.units!==undefined&&request.units!=='mil'||request.policy?.units!==undefined&&request.policy.units!=='mil')throw Error('STUDY_UNITS_MUST_BE_MIL');
  const write=async(name,value)=>fs.writeFile(path.join(directory,name),JSON.stringify(value,null,2)+'\n');
  await fs.mkdir(directory,{recursive:true});await write('request.json',request);
  let result;
  if(['prepare','fanout','route','verify','diagnose','ground'].includes(mode)){
    const {preparePrerouteInput}=await import('./pcb-routing/preroute/prepare.mjs');
    const {validatePrerouteInput}=await import('./pcb-routing/preroute/schema.mjs');
    const legacy=request.boardMil&&request.nets,raw=request.prerouteInput??(legacy?request:null);
    const input=raw?validatePrerouteInput(structuredClone(raw),{requireComponentCopper:!['verify','ground'].includes(mode)}):preparePrerouteInput({board:normalizeBoardForGrid(request.board),policy:request.policy,options:request.options});
    await write('input.json',input);
    if(mode==='prepare')result={status:'planned',mode,input,nativeWrites:0};
    else if(mode==='verify'){
      if(!request.candidate)throw Error('PREROUTE_CANDIDATE_REQUIRED');
      const {verifyPreroute}=await import('./pcb-routing/preroute/verify.mjs');const verification=verifyPreroute({input,candidate:request.candidate});
      await write('verification.json',verification);result={status:verification.status,mode,verification,nativeWrites:0};
    }else{
      const args=['--mode',mode,'--input',path.join(directory,'input.json'),'--output',directory];
      if(request.candidate){if(mode!=='ground')throw Error('CANDIDATE_ONLY_SUPPORTED_FOR_GROUND_OR_VERIFY');await write('candidate.json',request.candidate);args.push('--candidate',path.join(directory,'candidate.json'),'--candidate-mode',request.candidateMode??'replace');}
      if(request.noArrays)args.push('--no-arrays');
      result={...await runPythonJson(fileURLToPath(new URL('./pcb-routing/preroute/preroute.py',import.meta.url)),undefined,{python,args,timeoutMs,log}),mode};
      if(['route','fanout'].includes(mode)){
        const candidate=await read(result.resultFile);const {verifyPreroute}=await import('./pcb-routing/preroute/verify.mjs');const verification=verifyPreroute({input,candidate});
        await write('verification.json',verification);result.verification=verification;if(verification.status!=='independently-verified')result.status='failed';
      }
    }
  }else{
    const board=request.board?commonBoard(request.board):null;
    const budget=(await import('./pcb-routing/task-budget.mjs')).createTaskBudget({...request.budget,totalMs:Math.min(timeoutMs,request.budget?.totalMs??timeoutMs)});
    if(mode==='scan')result=(await import('./pcb-routing/via-space.mjs')).runViaSpaceScan({...request,board,budget});
    else if(mode==='joint-fanout')result=(await import('./pcb-routing/source-escapes.mjs')).runSourceEscapes({...request,board,budget});
    else if(mode==='paths')result=(await import('./pcb-routing/copper-path.mjs')).runCopperPaths({...request,board});
    else if(mode==='repair-plan')result=(await import('./pcb-routing/local-repair.mjs')).planLocalRepair(request);
    else if(mode==='transition-plan')result=(await import('./pcb-routing/transition-planner.mjs')).planTransitionSeeds({...request,board,budget});
    else if(mode==='prune')result=(await import('./pcb-routing/copper-cleanup.mjs')).pruneCopper(board,request.policy,request.options);
    else if(mode==='shortcut')result=(await import('./pcb-routing/copper-cleanup.mjs')).bypassVias(board,request.policy,request.options);
    else if(mode==='compose'){
      const module=await import('./pcb-routing/route-composition.mjs');const graph=module.buildRouteConflictGraph({...request,board,budget});await write('route-conflicts.json',graph);
      result=await module.selectCompatibleRoutes(graph,{...request.options,python,timeoutMs,budget});
    }else throw Error('UNKNOWN_PREROUTE_MODE:'+mode);
    const blocked=mode==='joint-fanout'&&!result.assignment?.chosen||mode==='compose'&&!result.selectedIds;
    result={...result,status:blocked?'blocked':result.status??'planned',mode,nativeWrites:0};
  }
  const manifest={schemaVersion:1,kind:'flitrealize.pcb-preroute-study',mode,inputHash:digest(request),implementationHash:await implementationFingerprint(),nativeWrites:0,groundVerified:false,nativeDrcRun:false};
  await write('manifest.json',manifest);await write('result.json',result);const summary=summarizePreroute(result,directory);await write('summary.json',summary);return{...result,report:directory,summary};
}

export async function main(args=process.argv.slice(2),{log=value=>console.log(JSON.stringify(value))}={}) {
  const values=new Set(['--project-root','--input','--mode','--output','--python','--timeout-ms','--candidate']),o={};
  for(let i=0;i<args.length;i++){if(args[i]==='--help'){console.log(help);return;}const key=args[i],value=args[++i];if(!values.has(key)||!value||value.startsWith('--')||o[key]!==undefined)throw Error('INVALID_PREROUTE_ARGUMENT:'+key);o[key]=value;}
  if(!o['--project-root']||!o['--input'])throw Error('PROJECT_ROOT_AND_INPUT_REQUIRED');
  const root=await fs.realpath(o['--project-root']),request=await read(path.resolve(root,o['--input']));
  if(o['--candidate'])request.candidate=await read(path.resolve(root,o['--candidate']));
  const directory=await studyOutputDirectory(root,o['--output']);
  const result=await runPrerouteStudy(request,{mode:o['--mode']??request.mode??'prepare',directory,python:o['--python'],timeoutMs:Number(o['--timeout-ms']??180000),log});log(result.summary);
  if(['failed','blocked'].includes(result.status))process.exitCode=1;return result;
}
if(isDirectExecution(import.meta.url))main().catch(error=>{console.error(JSON.stringify({status:'failed',error:error.message,nativeWrites:0}));process.exitCode=1;});
