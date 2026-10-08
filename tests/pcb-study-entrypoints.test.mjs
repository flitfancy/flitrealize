import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {executeHostAction,loadManifest,resolveActionRequest,summarizeExecution} from '../scripts/action-runner.mjs';
import {runPrerouteStudy,studyOutputDirectory} from '../scripts/pcb-preroute.mjs';
import {preparePrerouteInput} from '../scripts/pcb-routing/preroute/prepare.mjs';
import {buildRouteConflictGraph,selectCompatibleRoutes} from '../scripts/pcb-routing/route-composition.mjs';
import {createTaskBudget} from '../scripts/pcb-routing/task-budget.mjs';

const pad=(id,net,x)=>({id,owner:'PORT_'+id,number:'1',net,x,y:40,bbox:{minX:x-5,maxX:x+5,minY:35,maxY:45},shape:{kind:'polygon',points:[[x-5,35],[x+5,35],[x+5,45],[x-5,45]],layers:[1]}});
function request(){return{mode:'prepare',board:{units:'mil',boardMil:[150,80],pads:[pad('A','SIGNAL',20),pad('B','SIGNAL',120)],segments:[],vias:[],parts:[],keepouts:[],fanouts:[]},policy:{units:'mil',clearances:{ordinaryCopperMil:6},nets:[{net:'SIGNAL',defaultWireWidthMil:6,roles:[{name:'ordinary_signal'}],preroute:{allowedLayers:[1,2]}}]},options:{via:{diameterMil:24,holeMil:12},copperEdgeMil:0}};}
test('host prepare/verify entrypoints really execute and use the Action completion contract',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pcb-study-host-'));
 try{
  const manifest=await loadManifest(),input={...request(),output:'evidence/prepare'},descriptor=resolveActionRequest(manifest,'pcb-preroute',input),response=await executeHostAction(descriptor,input,{projectRoot:root});
  assert.equal(summarizeExecution(response,descriptor).ok,true);
  const prepared=JSON.parse(await fs.readFile(path.join(root,'evidence/prepare/input.json'),'utf8'));
  const verify={mode:'verify',prerouteInput:prepared,candidate:{segments:[{id:'wire',net:'SIGNAL',layer:1,width:6,x1:20,y1:40,x2:120,y2:40}],vias:[],nets:[]},output:'evidence/verify'};
  const vd=resolveActionRequest(manifest,'pcb-preroute',verify),vr=await executeHostAction(vd,verify,{projectRoot:root});assert.equal(summarizeExecution(vr,vd).ok,true);
  const failed=structuredClone(verify);failed.candidate.segments=[];failed.output='evidence/failed';
  const fd=resolveActionRequest(manifest,'pcb-preroute',failed),fr=await executeHostAction(fd,failed,{projectRoot:root});
  // A geometry inspection may succeed while listing an unconnected network.
  assert.equal(fr.result.nativeWrites,0);assert.ok(fr.result.summary.remaining.length);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('block verify has its own registered file and rejects missing physical rules',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pcb-block-host-'));
 try{
  const manifest=await loadManifest();assert.notEqual(manifest.actions['pcb-block-layout'].file,manifest.actions['pcb-functional-layout'].file);
  const atlas={sourceHash:1,units:'mil',board:{minX:0,minY:0,maxX:100,maxY:100},bodyGapMil:6,copperGapMil:6,copperEdgeMil:0,groups:[{id:'g',rotations:[0],base:{x:0,y:0},fixed:true,parts:[{ref:'P',x:20,y:20,rotation:0,body:{minX:10,minY:10,maxX:30,maxY:30}}],pads:[],copper:[]}]};
  const input={mode:'verify',atlas,transforms:{g:{x:0,y:0,rotation:0}}},d=resolveActionRequest(manifest,'pcb-block-layout',input),r=await executeHostAction(d,input,{projectRoot:root});assert.equal(summarizeExecution(r,d).ok,true);
  const bad=structuredClone(input);delete bad.atlas.bodyGapMil;await assert.rejects(executeHostAction(d,bad,{projectRoot:root}),/INVALID_RIGID_BLOCK_RULE/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('output containment and explicit units are checked before a job runs',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pcb-study-guard-'));
 try{
  await assert.rejects(studyOutputDirectory(root,'../outside'),/OUTSIDE_PROJECT/);
  const r=request();r.policy.units='mm';await assert.rejects(runPrerouteStudy(r,{directory:path.join(root,'job')}),/UNITS_MUST_BE_MIL/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('public block pads reuse pad copper and explicit layer purposes without copying coordinates',async()=>{
 const sample=JSON.parse(await fs.readFile(new URL('../assets/pcb-routing/preroute-request.json',import.meta.url),'utf8'));
 const original=structuredClone(sample),prepared=preparePrerouteInput(sample);
 assert.deepEqual(sample,original);assert.deepEqual(prepared.routing.layerIds,[11,22]);assert.deepEqual(prepared.pads[0].shape.layers,[11]);
 assert.equal(prepared.pads[0].x,sample.board.pads[0].x);assert.equal(prepared.pads[0].owner,'P_SOURCE');
 const copperOnly=structuredClone(sample);delete copperOnly.board.pads;
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pcb-copper-only-'));
 try{const result=await runPrerouteStudy(copperOnly,{directory:path.join(root,'prepared')});assert.equal(result.input.pads.length,2);}
 finally{await fs.rm(root,{recursive:true,force:true});}
 delete sample.policy.layers;
 assert.throws(()=>preparePrerouteInput(sample),/PUBLIC_LAYER_MAP_REQUIRED/);
});
test('composition honors the shared exhausted budget before building or launching a solver',async()=>{
 const budget=createTaskBudget({totalMs:1,consumedMs:1,now:()=>0});
 assert.throws(()=>buildRouteConflictGraph({budget}),/TASK_BUDGET_EXHAUSTED/);
 await assert.rejects(selectCompatibleRoutes({}, {budget}),/TASK_BUDGET_EXHAUSTED/);
});
test('block CLI reports rejected geometry through exit code as well as the saved result',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pcb-block-status-'));
 try{
  const part=ref=>({id:ref,rotations:[0],base:{x:0,y:0},fixed:true,parts:[{ref,x:20,y:20,rotation:0,body:{minX:10,minY:10,maxX:30,maxY:30}}],pads:[],copper:[]});
  const request={atlas:{sourceHash:1,units:'mil',board:{minX:0,minY:0,maxX:100,maxY:100},bodyGapMil:6,copperGapMil:6,copperEdgeMil:0,groups:[part('A'),part('B')]},transforms:{A:{x:0,y:0,rotation:0},B:{x:0,y:0,rotation:0}}};
  const file=path.join(root,'request.json');await fs.writeFile(file,JSON.stringify(request));
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/pcb-block-layout.mjs',import.meta.url)),'--project-root',root,'--input',file,'--mode','verify','--output','evidence/check'],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,1,result.stdout+result.stderr);assert.equal(JSON.parse(result.stdout.trim()).status,'failed');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('shipped open-block request consumes a prepared directory through the real CLI', {skip:!process.env.FLITREALIZE_CPSAT_PYTHON},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pcb-block-example-'));
 try{
  await fs.cp(fileURLToPath(new URL('../assets/pcb-layout/minimal-project',import.meta.url)),root,{recursive:true});
  const run=(script,args)=>spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/'+script,import.meta.url)),'--project-root',root,...args],{encoding:'utf8',windowsHide:true,timeout:15000});
  const prepared=run('pcb-layout.mjs',['--mode','prepare','--snapshot',path.join(root,'snapshot.json')]);assert.equal(prepared.status,0,prepared.stderr);
  const directory=JSON.parse(prepared.stdout.trim().split('\n').at(-1)).report;
  const opened=run('pcb-block-layout.mjs',['--mode','open','--input',fileURLToPath(new URL('../assets/pcb-layout/block-open-request.json',import.meta.url)),'--prepared',directory,'--python',process.env.FLITREALIZE_CPSAT_PYTHON,'--output','evidence/open']);
  assert.equal(opened.status,0,opened.stderr);assert.equal(JSON.parse(opened.stdout.trim().split('\n').at(-1)).candidates,1);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
