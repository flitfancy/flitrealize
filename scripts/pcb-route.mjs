#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDirectExecution} from './lib/cli-entrypoint.mjs';
import {compileTasks} from './pcb-routing/model.mjs';
import {normalizeBoard} from './providers/easyeda-pro/routing-input.mjs';
import {ensureRuntime} from './pcb-routing/runtime.mjs';
import {activeWindow,executeNative,legacySnapshot,digest} from './providers/easyeda-pro/routing-provider.mjs';
import {studyOutputDirectory,pcbImplementationFingerprint} from './lib/pcb-study.mjs';
import {runWorkflow} from './pcb-routing/workflow.mjs';
const help=`PCB routing with a single FR backend and native EDA verification.
node <skill>/scripts/pcb-route.mjs --project-root <project> --mode prepare|plan|run
  --policy <project-relative-json> [default design/PCB_ROUTING_EXECUTION.v2.json]
  --window-id <window> | --snapshot <capture.json> | --from <legacy-export-directory>
  --prepared <prepared-directory> --output <project-relative-directory>
  --net <name> (repeatable) --role <role> (repeatable)
  --runtime <runtime.json> --heap 2g --passes 5 --timeout-ms 180000
  --rework-net <single-role-net> (repeatable) --apply
Default prepare/run is read-only/candidate-only. --apply writes verified candidates.
Runtime setup: --mode runtime [--runtime <existing-runtime.json>] [--install]`;
function options(args){const values=new Set(['--project-root','--mode','--policy','--window-id','--snapshot','--from','--prepared','--output','--net','--role','--runtime','--heap','--passes','--timeout-ms','--rework-net','--escapes']);const flags=new Set(['--help','--apply','--install','--no-install','--optimize','--no-optimize','--fanout']);const result={nets:[],roles:[],rework:[]};for(let i=0;i<args.length;i++){const a=args[i];if(flags.has(a)){result[a]=true;continue;}if(!values.has(a))throw Error('UNKNOWN_OPTION:'+a);const v=args[++i];if(!v||v.startsWith('--'))throw Error('MISSING_OPTION_VALUE:'+a);if(a==='--net')result.nets.push(v);else if(a==='--role')result.roles.push(v);else if(a==='--rework-net')result.rework.push(v);else{if(result[a]!==undefined)throw Error('DUPLICATE_OPTION:'+a);result[a]=v;}}if(result['--optimize']&&result['--no-optimize'])throw Error('CONFLICTING_OPTIMIZER_OPTIONS');return result;}
const readJson=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
async function outputDirectory(root,requested){
 return studyOutputDirectory(root,requested,{category:'pcb-routing'});
}
async function implementationHash(){return pcbImplementationFingerprint(fileURLToPath(new URL('./',import.meta.url)),{directories:['pcb-routing'],files:['pcb-route.mjs','lib/pcb-study.mjs','providers/easyeda-pro/routing-input.mjs','providers/easyeda-pro/routing-provider.mjs','providers/easyeda-pro/routing-native.js','providers/easyeda-pro/source-invariant.mjs']});}
export async function main(args=process.argv.slice(2),{log=value=>console.log(JSON.stringify(value))}={}){
 const o=options(args);if(o['--help']){console.log(help);return;}
 const mode=o['--mode']??'prepare';if(mode==='runtime'){const runtime=await ensureRuntime({runtimeFile:o['--runtime'],install:!!o['--install']});log({status:'runtime-ready',...runtime});return runtime;}
 if(!['prepare','plan','run'].includes(mode))throw Error('INVALID_ROUTING_MODE');if(!o['--project-root'])throw Error('PROJECT_ROOT_REQUIRED');
 const root=await fs.realpath(o['--project-root']),selection={...(o.nets.length?{nets:o.nets}:{}),...(o.roles.length?{roles:o.roles}:{})};let prepared;
 if(o['--prepared']){prepared=await readJson(path.resolve(o['--prepared'],'prepared.json'));if(prepared.projectRoot!==root||prepared.implementationHash!==await implementationHash())throw Error('PREPARED_INPUT_STALE');}
 else{
  const directory=await outputDirectory(root,o['--output']),policy=await readJson(path.resolve(root,o['--policy']??'design/PCB_ROUTING_EXECUTION.v2.json'));
  let snapshot,padRead,windowId=o['--window-id'];
  if(o['--from']){const dir=path.resolve(o['--from']);snapshot=legacySnapshot(await readJson(path.join(dir,'export-result.json')),await readJson(path.join(dir,'pad-map-inspect-with-footprints.json')));padRead=snapshot;}
  else if(o['--snapshot']){const r=await readJson(path.resolve(o['--snapshot']));snapshot=r.result??r;padRead=snapshot;}
  else{windowId??=await activeWindow();if(!policy.projectUuid||!policy.pcbUuid)throw Error('POLICY_EDA_TARGET_REQUIRED');snapshot=await executeNative({directory,windowId,mode:'capture',input:{target:{project:policy.projectUuid,document:policy.pcbUuid}}});padRead=snapshot;if(snapshot.physicalDrcCount)throw Error('BASELINE_PHYSICAL_DRC');if(snapshot.activeTransaction&&!snapshot.activeTransaction.saved&&snapshot.activeTransaction.status!=='rolled-back')throw Error('UNRESOLVED_ROUTING_TRANSACTION');}
  if(!snapshot.sourceInvariantHash)throw Error('SNAPSHOT_FINGERPRINT_REQUIRED');
  const board=normalizeBoard(snapshot,padRead,policy);let escapes={seeds:[],traceSeeds:[]};try{escapes=await readJson(path.resolve(root,o['--escapes']??'design/PCB_ROUTING_SEEDS.v1.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
  prepared={schemaVersion:1,projectRoot:root,directory,windowId,board,policy,escapes,implementationHash:await implementationHash()};await fs.writeFile(path.join(directory,'prepared.json'),JSON.stringify(prepared));
 }
 const tasks=compileTasks(prepared.board,prepared.policy,selection),summary={status:'prepared',target:prepared.board.target,preparedDirectory:prepared.directory,tasks:tasks.map(t=>({id:t.id,net:t.net,role:t.role,status:t.status,layers:t.layers,widthMil:t.width,padCount:t.requiredPadIds?.length,reason:t.reason}))};
 if(mode!=='run'){log(summary);return summary;}
 const directory=await outputDirectory(root,o['--output']??path.relative(root,path.join(prepared.directory,'run-'+Date.now()))),windowId=o['--window-id']??prepared.windowId;
 const runtime=tasks.some(t=>t.status==='pending')?await ensureRuntime({runtimeFile:o['--runtime'],install:!o['--no-install']}):null;
 const settings={...(o['--heap']?{heap:o['--heap']}:{}),...(o['--passes']?{maxPasses:Number(o['--passes'])}:{}),...(o['--timeout-ms']?{timeoutMs:Number(o['--timeout-ms'])}:{}),...(o['--optimize']?{optimize:true}:{}),...(o['--no-optimize']?{optimize:false}:{}),fanout:!!o['--fanout']};
 const result=await runWorkflow({board:prepared.board,policy:prepared.policy,directory,runtime,selection,escapes:prepared.escapes,apply:!!o['--apply'],windowId,reworkNets:o.rework,settings,log});log({status:result.status,saved:result.saved,counts:result.counts,totalSeconds:result.totalSeconds,reportFile:result.reportFile,candidateFile:result.candidateFile,issues:result.issues});return result;
}
if(isDirectExecution(import.meta.url)){main().catch(error=>{console.error(JSON.stringify({status:'failed',error:error.message,receiptFile:error.receiptFile}));process.exitCode=1;});}
