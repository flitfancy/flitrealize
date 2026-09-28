import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFixture } from './helpers/pcb-layout-prepare-fixture.mjs';
import { prepareLayoutInputs } from '../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { inspectCandidate, runSearch, translatedSnapshot } from '../scripts/pcb-layout/pcb-layout-solver-core.mjs';

function observedFixture() {
  const f = prepareFixture();
  f.snapshot.padOwnership = {status:'verified',source:'native-component-pins',queriedComponents:2,ownedPads:2,standalonePads:0};
  for (const p of f.snapshot.pads) {
    p.parentComponentId = f.snapshot.components.find(c=>c.ref===p.owner).id;
    p.ownershipSource = 'native-component-pins';
    p.nativeGeometry = {source:'native-readback',coordinateSystem:'eda-y-up',observedPose:{x:p.x,y:p.y,rotation:0},fields:{pad:{status:'ok',value:['RECT',4,4]},hole:{status:'ok',value:null},rotation:{status:'ok',value:0},holeOffsetX:{status:'unavailable'},holeOffsetY:{status:'unavailable'},holeRotation:{status:'unavailable'},metallization:{status:'ok',value:false}}};
  }
  f.snapshot.nativeNetlist = {status:'ok',source:'pcb_Net.getNetlist',raw:JSON.stringify({version:'2.0.0',components:Object.fromEntries(f.snapshot.components.map(c=>[c.id,{props:{Designator:c.ref},pinInfoMap:{one:{number:'1',net:'SUPPLY'}}}]))})};
  f.snapshot.nativeNetNames = {status:'ok',source:'pcb_Net.getAllNetsName',value:['SUPPLY']};
  return f;
}

test('additional native observations preserve source data and do not change bbox placement or scoring',()=>{
  const plain=prepareLayoutInputs(prepareFixture()),f=observedFixture(),before=structuredClone(f),rich=prepareLayoutInputs(f);
  assert.equal(rich.state.ready,true,JSON.stringify(rich.diagnostics));assert.deepEqual(f,before);
  assert.equal(rich.receipt.preparation.nativeChecks.network.status,'matched');
  const geometry=rich.receipt.nativeObservations.geometry;
  assert.equal(geometry.padsWithObservations,2);assert.equal(geometry.fields.hole.ok,2);assert.equal(geometry.fields.holeOffsetX.unavailable,2);
  const baseline=inspectCandidate(rich.model),simple=inspectCandidate(plain.model);
  assert.deepEqual(baseline.plan,simple.plan);assert.equal(baseline.comparisonScore,simple.comparisonScore);
  const profile=f.config.search.profiles[0];
  const a=runSearch(plain.model,profile,6),b=runSearch(rich.model,profile,6);
  for(const key of ['components','labels','testPads'])assert.deepEqual(a.plan[key],b.plan[key]);
  assert.equal(a.comparisonScore,b.comparisonScore);
  const predicted=translatedSnapshot(rich.model,f.snapshot.components.map(c=>({...c,x:c.x+20})));
  assert.ok(predicted.pads.every(p=>p.nativeGeometry===undefined));
  assert.ok(rich.model.snapshot.pads.every(p=>p.nativeGeometry));
});

test('explicit parent identity is checked and cannot be repaired by a reference prefix',()=>{
  const f=observedFixture();f.snapshot.pads[0].parentComponentId=f.snapshot.components[1].id;
  const bad=prepareLayoutInputs(f);assert.equal(bad.state.ready,false);assert.ok(bad.diagnostics.some(d=>d.code==='PAD_PARENT_MISMATCH'));
  const missing=observedFixture();delete missing.snapshot.pads[0].owner;
  assert.ok(prepareLayoutInputs(missing).diagnostics.some(d=>d.code==='INCOMPLETE_NATIVE_OWNERSHIP'));
});

test('native netlist mismatch blocks preparation while unavailable extra evidence stays explicitly uncovered',()=>{
  const f=observedFixture(),raw=JSON.parse(f.snapshot.nativeNetlist.raw);
  Object.values(raw.components)[0].pinInfoMap.one.net='OTHER';f.snapshot.nativeNetlist.raw=JSON.stringify(raw);
  const mismatch=prepareLayoutInputs(f);assert.equal(mismatch.state.ready,false);assert.equal(mismatch.receipt.preparation.nativeChecks.network.status,'mismatch');assert.equal(mismatch.state.identity,'mismatch');
  const legacy=prepareLayoutInputs(prepareFixture());assert.equal(legacy.state.ready,true);assert.equal(legacy.receipt.preparation.nativeChecks.ownership.status,'provided');assert.notEqual(legacy.receipt.preparation.nativeChecks.network.status,'matched');
});
