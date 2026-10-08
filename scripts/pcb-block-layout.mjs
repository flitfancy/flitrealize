#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {isDirectExecution} from './lib/cli-entrypoint.mjs';
import {resolvePcbPython} from './lib/pcb-python.mjs';
import {prepareLayoutInputs} from './pcb-layout/pcb-layout-prepare.mjs';
import {compileOpenBlockProblem} from './pcb-layout/pcb-layout-cpsat-open.mjs';
import {runCpsatLayout} from './pcb-layout/pcb-layout-cpsat.mjs';
import {createRigidBlockAtlas,runRigidBlockPacking,verifyRigidBlockPacking,filterRigidBlockCopperChannels} from './pcb-layout/pcb-layout-blocks.mjs';
import {studyOutputDirectory} from './lib/pcb-study.mjs';

const help=`Offline open-block layouts and copper-preserving rigid block packing.
node scripts/pcb-block-layout.mjs --project-root DIR --input FILE --mode open|pack|verify|channels
  --prepared PREPARE_DIRECTORY_OR_INPUTS_JSON
  --output PROJECT_RELATIVE_DIR --python EXECUTABLE
open input: {bundle:<existing pcb-layout inputs.json>,spec,settings,options}
pack/channels input: {bundle,groups,copperRules,settings,options,channelPolicy}
verify also supplies transforms. Explicit legacy {atlas,...} remains diagnosed.
Results require a complete native placement/copper plan before EDA application.`;
const read=async f=>JSON.parse((await fs.readFile(f,'utf8')).replace(/^\uFEFF/,''));
export async function runBlockLayout(request,{mode=request.mode??'pack',python,log=()=>{}}={}) {
  if(mode==='open'){
    const prepared=prepareLayoutInputs(request.bundle);if(!prepared.state.ready)throw Error('BLOCK_LAYOUT_INPUT_NOT_READY');
    const {model,problem}=compileOpenBlockProblem(prepared.model,request.spec,request.settings);
    return await runCpsatLayout(model,request.settings,{...request.options,problem,coldStart:true,runtime:{pythonPath:resolvePcbPython({python})},onProgress:log});
  }
  let atlas=request.atlas,model;
  if(request.bundle){
    const prepared=prepareLayoutInputs(request.bundle);if(!prepared.state.ready)throw Error('BLOCK_LAYOUT_INPUT_NOT_READY');
    if(request.groups){if(request.atlas)throw Error('BLOCK_LAYOUT_ATLAS_AND_GROUPS_CONFLICT');({atlas,model}=createRigidBlockAtlas(prepared.model,request.groups,{refs:request.refs??[...prepared.model.components.keys()],copperRules:request.copperRules,netWeights:request.netWeights,excludeNets:request.excludeNets,fixedCopper:request.fixedCopper,legacyNativeLayers:request.legacyNativeLayers===true}));}
    else model=prepared.model;
  }else if(request.groups)throw Error('BLOCK_LAYOUT_GROUPS_REQUIRE_PREPARED_BUNDLE');
  if(mode==='pack')return await runRigidBlockPacking(atlas,request.settings,{...request.options,model,runtime:{pythonPath:resolvePcbPython({python})},onProgress:log});
  if(mode==='verify')return verifyRigidBlockPacking(atlas,request.transforms,{model});
  if(mode==='channels')return await filterRigidBlockCopperChannels(atlas,request.channelPolicy,{pythonPath:resolvePcbPython({python}),onProgress:log});
  throw Error('UNKNOWN_BLOCK_LAYOUT_MODE:'+mode);
}
export async function main(args=process.argv.slice(2),{log=value=>console.log(JSON.stringify(value))}={}) {
  const allowed=new Set(['--project-root','--input','--mode','--output','--python','--prepared']),o={};
  for(let i=0;i<args.length;i++){if(args[i]==='--help'){console.log(help);return;}const k=args[i],v=args[++i];if(!allowed.has(k)||!v||v.startsWith('--')||o[k]!==undefined)throw Error('INVALID_BLOCK_LAYOUT_ARGUMENT');o[k]=v;}
  if(!o['--project-root']||!o['--input'])throw Error('PROJECT_ROOT_AND_INPUT_REQUIRED');
  const root=await fs.realpath(o['--project-root']),request=await read(path.resolve(root,o['--input'])),directory=await studyOutputDirectory(root,o['--output']),mode=o['--mode']??request.mode??'pack';
  if(o['--prepared']){if(request.bundle)throw Error('BLOCK_LAYOUT_DUPLICATE_BUNDLE');const source=path.resolve(root,o['--prepared']);request.bundle=await read((await fs.stat(source)).isDirectory()?path.join(source,'inputs.json'):source);}
  await fs.writeFile(path.join(directory,'input.json'),JSON.stringify(request));
  const result=await runBlockLayout(request,{mode,python:o['--python'],log});await fs.writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2));
  const summary={status:result.status??'planned',mode,report:directory,candidates:result.candidates?.length,validation:result.verification?.status??result.status,nativeWrites:0,groundVerified:false,nativeDrcRun:false,requiresCompleteApplicationPlan:true};
  await fs.writeFile(path.join(directory,'summary.json'),JSON.stringify(summary,null,2));log(summary);if(['failed','verification-failed','no-candidate'].includes(summary.status))process.exitCode=1;return{...result,summary};
}
if(isDirectExecution(import.meta.url))main().catch(error=>{console.error(JSON.stringify({status:'failed',error:error.message,nativeWrites:0}));process.exitCode=1;});
