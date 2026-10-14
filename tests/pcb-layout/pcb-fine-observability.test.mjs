import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareFixture, addIntent, filterRelation } from '../helpers/pcb-layout-prepare-fixture.mjs';
import { prepareLayoutInputs } from '../../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { normalizeFineRequest } from '../../scripts/pcb-layout/fine/request.mjs';
import { compileFineProblem } from '../../scripts/pcb-layout/fine/compile.mjs';
import { auditFineCandidate } from '../../scripts/pcb-layout/fine/audit.mjs';
import { createFineTiming } from '../../scripts/pcb-layout/fine/common.mjs';
import { solveFineLayout } from '../../scripts/pcb-layout/fine/workflow.mjs';
import { main } from '../../scripts/pcb-layout/fine/cli.mjs';
import { fineRoutingRequest } from '../../scripts/pcb-layout/fine/routing.mjs';

async function temporaryDirectory(t,prefix){const directory=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}

function inputs(multi=false){
  const f=addIntent(prepareFixture(),filterRelation());f.config.hard.boardBounds={minX:-50,minY:-50,maxX:500,maxY:240};
  if(multi){f.contract.components[0].bindings={easyedaPro:{pinMap:{'1':['A6','B6']}}};f.snapshot.pads[0].number='A6';const p=structuredClone(f.snapshot.pads[0]);p.id='U1:B6';p.number='B6';p.x=5;p.bbox={minX:3,maxX:7,minY:-2,maxY:2};f.snapshot.pads.push(p);}
  return f;
}
const request=(extra={})=>({schemaVersion:1,blockId:'supply',fixedRefs:['U1'],labels:{mode:'joint'},region:{mode:'available-space',basis:'Synthetic regression board permission'},relationSelection:'scope',...extra});
function compiled(f=inputs(),r=request()){const prepared=prepareLayoutInputs(f);assert.equal(prepared.state.ready,true,JSON.stringify(prepared.diagnostics));const scope=normalizeFineRequest(prepared.model,r);return {scope,...compileFineProblem(scope)};}
const baselineResult=c=>({status:'FEASIBLE',sourceHash:c.scope.model.snapshot.sourceHash,placements:c.problem.entities.map(e=>({ref:e.ref,dx:0,dy:0,variant:e.preferredVariant??0})),solver:{wallSeconds:0}});

test('JU1 DP A6/B6-style mapping keeps both pads through replacement, caps and independent audit',()=>{
  const f=inputs(true);f.contract.extensions.pcbLayout.relations[0].maxDistanceMil=147;
  const c=compiled(f,request({relations:[{relationId:'supply-filter',merge:'replace-objective',weight:2}]})),link=c.problem.links.find(l=>l.id==='fine-soft:supply-filter');
  assert.deepEqual(link.left.map(p=>p.id),['U1:1','U1:B6']);assert.ok(c.problem.limits.some(l=>l.maxMil===147&&l.left.length===2));
  const audit=auditFineCandidate(c.scope,c,c.baseline.plan),r=audit.relations[0];assert.equal(r.afterMil,145);assert.equal(r.measurement.maximumPairMil,150);assert.equal(r.measurement.pairs.length,2);assert.equal(r.passed,true);assert.match(r.acceptanceScope,/not all-pad connectivity/);assert.match(r.measurement.connectivity,/not-evaluated/);
});
test('a multi-pad reference cannot be silently narrowed to one pad',()=>{
  assert.throws(()=>compiled(inputs(true),request({relations:[{relationId:'supply-filter',from:{padId:'U1:1'}}]})),/FINE_BASE_ENDPOINT_CONFLICT/);
});
test('every mapped physical pad participates in network identity checking',()=>{
  const f=inputs(true);f.snapshot.pads[2].net='WRONG';const p=prepareLayoutInputs(f);assert.equal(p.state.ready,false);assert.equal(p.state.identity,'mismatch');
});
test('the routing handoff keeps both required physical pads rather than the nearest one',()=>{
  const f=inputs(true);f.config.hard.boardBounds={minX:0,minY:0,maxX:500,maxY:240};
  for(const c of f.snapshot.components){c.x+=40;c.y+=60;for(const k of ['minX','maxX'])c.bbox[k]+=40;for(const k of ['minY','maxY'])c.bbox[k]+=60;}
  for(const p of f.snapshot.pads){p.x+=40;p.y+=60;for(const k of ['minX','maxX'])p.bbox[k]+=40;for(const k of ['minY','maxY'])p.bbox[k]+=60;}
  for(const l of f.snapshot.items){l.original.x+=40;l.original.y+=60;for(const k of ['minX','maxX'])l.original.bbox[k]+=40;for(const k of ['minY','maxY'])l.original.bbox[k]+=60;}
  const c=compiled(f,request({routing:{required:true,nets:['SUPPLY'],policy:{layers:[{id:1,purpose:'top-copper'},{id:2,purpose:'bottom-copper'}],nets:[{net:'SUPPLY',defaultWireWidthMil:2,preroute:{sourceOwners:['U1'],allowedLayers:[1]}}]},options:{clearanceMil:2,copperEdgeMil:0,gridMil:2}}}));
  const study=fineRoutingRequest(c.scope,c.baseline.plan);assert.equal(study.board.pads.length,3);assert.ok(study.board.pads.some(p=>p.id==='U1:1'));assert.ok(study.board.pads.some(p=>p.id==='U1:B6'));
});
test('timing distinguishes not-run phases and exposes nested inclusive/exclusive samples',()=>{
  let ms=0;const timing=createFineTiming({now:()=>ms});timing.sync('reconstruction',()=>{ms+=5;timing.sync('audit',()=>{ms+=2;});ms+=3;});
  const p=timing.snapshot();assert.equal(p.phases.reconstruction.seconds,.01);assert.equal(p.phases.reconstruction.exclusiveSeconds,.008);assert.equal(p.phases.audit.seconds,.002);assert.equal(p.phases.labelSolve.status,'not-run');assert.equal(p.phases.labelSolve.seconds,null);assert.equal(p.events[1].parent,p.events[0].id);
});
test('timing records thrown stages and leaves subsequent stages unexecuted',()=>{
  let ms=0;const timing=createFineTiming({now:()=>ms});assert.throws(()=>timing.sync('scope',()=>{ms+=4;throw Object.assign(Error('bad'),{code:'TEST'});}),/bad/);
  const p=timing.snapshot();assert.equal(p.phases.scope.status,'failed');assert.equal(p.phases.scope.seconds,.004);assert.equal(p.phases.compile.seconds,null);
});
test('bounded solver exhaustion preserves completed timing and marks labels/audit not-run',async t=>{
  const directory=await temporaryDirectory(t,'fine-time-budget-'),s=await solveFineLayout({inputs:inputs(),request:request(),directory,executor:async()=>({status:'UNKNOWN'})});
  assert.equal(s.result.status,'budget-exhausted');const p=JSON.parse(await readFile(join(directory,'timing.json'),'utf8'));assert.equal(p.phases.bodySolve.status,'completed');assert.equal(p.phases.labelSolve.status,'not-run');assert.equal(p.phases.audit.seconds,null);assert.equal(p.phases.inputRead.status,'not-run');
});
test('CLI read failures preserve original error, failure stage and timing without a candidate',async t=>{
  const root=await temporaryDirectory(t,'fine-time-read-');await writeFile(join(root,'request.json'),JSON.stringify(request()));
  await assert.rejects(main(['--stage','solve','--project-root',root,'--inputs','missing.json','--request','request.json','--output','evidence/read-failure'],{log:()=>{}}),/ENOENT/);
  const p=JSON.parse(await readFile(join(root,'evidence/read-failure/timing.json'),'utf8')),failure=JSON.parse(await readFile(join(root,'evidence/read-failure/failure.json'),'utf8'));assert.equal(p.phases.inputRead.status,'failed');assert.equal(p.phases.prepare.seconds,null);assert.equal(failure.failedPhase,'inputRead');assert.equal(failure.nativeWrites,0);
});
test('scope errors preserve timing before compilation or solving',async t=>{
  const directory=await temporaryDirectory(t,'fine-time-scope-');await assert.rejects(solveFineLayout({inputs:inputs(),request:request({blockId:'unknown'}),directory}),/FINE_UNKNOWN_BLOCK/);
  const p=JSON.parse(await readFile(join(directory,'timing.json'),'utf8'));assert.equal(p.phases.prepare.status,'completed');assert.equal(p.phases.scope.status,'failed');assert.equal(p.phases.compile.seconds,null);assert.equal(p.phases.bodySolve.seconds,null);
});
test('optional preview reuses comparison rendering and writes real before/after SVG files',async t=>{
  const f=inputs(),r=request(),c=compiled(f,r),directory=await temporaryDirectory(t,'fine-preview-');
  const s=await solveFineLayout({inputs:f,request:r,directory,preview:true,executor:async()=>baselineResult(c)});
  assert.equal(s.result.status,'candidate-passed');assert.equal(s.result.rendering.status,'completed',JSON.stringify(s.result.rendering));
  for(const name of ['before.svg','after.svg'])assert.match(await readFile(join(directory,name),'utf8'),/xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  const p=JSON.parse(await readFile(join(directory,'timing.json'),'utf8'));assert.equal(p.phases.preview.status,'completed');assert.ok(p.events.some(e=>e.name==='files'&&e.parent!==null));
});
