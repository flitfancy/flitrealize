import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fineFixture} from './helpers/pcb-fine-recovery-fixture.mjs';
import {adoptFineLayout,applyFineLayout,resumeFineSave,verifyFineLayout} from '../scripts/pcb-layout/fine/workflow.mjs';
import {prepareLayoutInputs} from '../scripts/pcb-layout/pcb-layout-prepare.mjs';
import {normalizeFineRequest} from '../scripts/pcb-layout/fine/request.mjs';
import {compileFineProblem} from '../scripts/pcb-layout/fine/compile.mjs';
import {compileFineLabels} from '../scripts/pcb-layout/fine/labels.mjs';
import {digest} from '../scripts/pcb-layout/fine/common.mjs';
import {main as publicMain} from '../scripts/pcb-layout.mjs';

async function existingPlan(t){
  const fixture=await fineFixture(t),plan=structuredClone(fixture.solved.candidate.plan),request=structuredClone(fixture.request);
  const fixedLabel=plan.labels.find(l=>l.owner==='U2');fixedLabel.x+=20;fixedLabel.bbox.minX+=20;fixedLabel.bbox.maxX+=20;
  request.labels.additionalOwnerRefs=['U2'];
  return {...fixture,plan,request};
}
test('adoption preserves reviewed poses, reconstructs native geometry and issues an offline application contract',async t=>{
  const f=await existingPlan(t),before=digest(f.inputs),original=digest(f.plan),directory=path.join(f.f.projectRoot,'adopt');
  const adopted=await adoptFineLayout({inputs:f.inputs,request:f.request,plan:f.plan,directory,provenance:{sourceFileHash:'original-file-proof'}});
  assert.equal(adopted.result.status,'candidate-passed',JSON.stringify(adopted.result.audit));
  assert.equal(adopted.result.audit.nativeEligible,true);assert.equal(adopted.result.solverStatus,'not-run');
  assert.deepEqual(adopted.candidate.plan.components.map(c=>[c.id,c.x,c.y,c.rotation]),f.plan.components.map(c=>[c.id,c.x,c.y,c.rotation]));
  assert.deepEqual(adopted.candidate.plan.labels.map(l=>[l.id,l.x,l.y,l.rotation,l.bbox]),f.plan.labels.map(l=>[l.id,l.x,l.y,l.rotation,l.bbox]));
  assert.equal(digest(f.inputs),before);assert.equal(digest(f.plan),original);assert.equal(adopted.result.provenance.externalPlanHash,original);
  assert.equal(adopted.result.provenance.sourceFileHash,'original-file-proof');assert.equal(adopted.result.source.mode,'adopted-complete-plan');
  assert.equal(adopted.result.state.nativeWrites,0);assert.equal(adopted.result.state.saved,false);
  const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json')));
  assert.equal(manifest.candidateFileHash,digest(adopted.candidate));assert.equal(manifest.resultHash,digest(adopted.result));
});
test('label-only permission keeps fixed bodies and pads fixed and rejects unstated outside text movement',async t=>{
  const f=await existingPlan(t),without=structuredClone(f.request);delete without.labels.additionalOwnerRefs;
  const rejected=await adoptFineLayout({inputs:f.inputs,request:without,plan:f.plan});
  assert.equal(rejected.result.status,'candidate-rejected');assert.equal(rejected.candidate,null);assert.equal(rejected.result.audit.outsideLabelChanges.length,1);
  const scope=normalizeFineRequest(prepareLayoutInputs(f.inputs).model,f.request),compiled=compileFineProblem(scope),labelStage=compileFineLabels(scope,f.plan,compiled.problem.settings);
  assert.equal(compiled.problem.entities.find(e=>e.ref==='U2').fixed,true);
  assert.ok(labelStage.items.some(l=>l.owner==='U2'));assert.ok(!compiled.problem.zones.some(z=>z.id==='fine-context-label:'+f.plan.labels.find(l=>l.owner==='U2').id));
  const moved=structuredClone(f.plan);moved.components.find(c=>c.ref==='U2').x+=20;delete moved.components.find(c=>c.ref==='U2').body;
  const invalid=await adoptFineLayout({inputs:f.inputs,request:f.request,plan:moved});
  assert.equal(invalid.result.status,'candidate-rejected');assert.deepEqual(invalid.result.audit.outsidePoseChanges,['U2']);
});
test('adoption rejects stale sources, incomplete inventory, changed identities and forged glyph/body geometry before transport',async t=>{
  const f=await existingPlan(t);
  for(const [edit,code]of [
    [p=>p.sourceHash++,'FINE_PLAN_SOURCE_CHANGED'],[p=>p.components.pop(),'FINE_PLAN_INVENTORY'],[p=>p.labels.pop(),'FINE_PLAN_INVENTORY'],
    [p=>p.components[0].ref='wrong','FINE_PLAN_COMPONENT_IDENTITY'],[p=>p.components[0].body.minX--,'FINE_PLAN_COMPONENT_GEOMETRY'],
    [p=>p.labels[0].text='wrong','FINE_PLAN_LABEL_IDENTITY'],[p=>p.labels[0].fontSize++,'FINE_PLAN_LABEL_IDENTITY'],[p=>p.labels[0].bbox.maxX--,'FINE_PLAN_LABEL_GEOMETRY'],
    [p=>p.testPads[0].net='wrong','FINE_STANDALONE_CHANGED'],[p=>p.boardBounds.maxX++,'FINE_PLAN_BOARD_CHANGED'],[p=>p.issues.push({code:'existing-failure'}),'FINE_PLAN_HAS_ISSUES']
  ]){
    const plan=structuredClone(f.plan);edit(plan);
    await assert.rejects(adoptFineLayout({inputs:f.inputs,request:f.request,plan}),new RegExp(code));
  }
  const request=structuredClone(f.request);request.labels.mode='joint';
  await assert.rejects(adoptFineLayout({inputs:f.inputs,request,plan:f.plan}),/FINE_SEPARATE_LABEL_SCOPE_REQUIRED/);
  f.inputs.snapshot.items.find(l=>l.owner==='U2').locked=true;
  await assert.rejects(adoptFineLayout({inputs:f.inputs,request:f.request,plan:f.plan}),/FINE_LOCKED_LABEL_OWNER/);
  assert.equal(f.f.calls.filter(p=>p==='apply'||p==='save').length,0);
});
test('adopted plans use the original apply, save recovery and read-only verify chain without replay',async t=>{
  const f=await existingPlan(t),adopted=await adoptFineLayout({inputs:f.inputs,request:f.request,plan:f.plan});
  const input={inputs:f.inputs,request:f.request,candidate:adopted.candidate,result:adopted.result};
  f.f.control.saveResult=false;
  const first=await applyFineLayout({...input,options:f.f.options()});assert.equal(first.status,'save-failed',JSON.stringify(first));
  assert.equal(first.state.native,'applied');assert.equal(first.state.saved,false);assert.equal(f.f.calls.filter(p=>p==='apply').length,1);
  f.f.control.saveResult=true;
  const saved=await resumeFineSave({...input,options:f.f.options(),resumeSave:first.execution.resumeSaveReport});
  assert.equal(saved.status,'verified',JSON.stringify(saved));assert.equal(saved.state.saved,true);assert.equal(f.f.calls.filter(p=>p==='apply').length,1);
  const saves=f.f.control.saves;
  const checked=await verifyFineLayout({...input,options:f.f.options(),receiptFile:saved.execution.reportFile});
  assert.equal(checked.status,'verified',JSON.stringify(checked));assert.equal(checked.state.saved,true);assert.equal(checked.state.nativeWrites,0);
  assert.equal(f.f.control.saves,saves);assert.equal(f.f.calls.filter(p=>p==='apply').length,1);
});
test('public adopt accepts an existing plan wrapper and forwards the SAME saved report to public apply/verify',async t=>{
  const f=await existingPlan(t),root=f.f.projectRoot;
  for(const[file,value]of [['inputs.json',f.inputs],['request.json',f.request],['selected.json',{id:'reviewed',sourceHash:f.plan.sourceHash,plan:f.plan,nativeApplied:true}]])await fs.writeFile(path.join(root,file),JSON.stringify(value));
  const output=[];
  const adopted=await publicMain(['fine','--stage','adopt','--project-root',root,'--inputs','inputs.json','--request','request.json','--plan-file','selected.json','--output','public-adopt'],{log:value=>output.push(value)});
  assert.equal(adopted.state.saved,false);assert.equal(adopted.source.mode,'adopted-complete-plan');assert.equal(output.at(-1).nativeWrites,0);
  const saved=await publicMain(['fine','--stage','apply','--project-root',root,'--from','public-adopt','--window-id',f.f.options().windowId,'--output','public-apply'],{log:()=>{},executionOptions:{transport:f.f.transport}});
  assert.equal(saved.status,'verified',JSON.stringify(saved));assert.equal(saved.state.saved,true);
  const checked=await publicMain(['fine','--stage','verify','--project-root',root,'--from','public-adopt','--window-id',f.f.options().windowId,'--receipt','public-apply/application.json','--output','public-verify'],{log:()=>{},executionOptions:{transport:f.f.transport}});
  assert.equal(checked.status,'verified');assert.equal(checked.state.saved,true);assert.equal(f.f.calls.filter(p=>p==='apply').length,1);assert.equal(f.f.control.saves,1);
});
