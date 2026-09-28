import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, symlink, unlink, realpath, access } from 'node:fs/promises';
import { join } from 'node:path';
import { applyLayout, inspectLayout, resumeLayoutSave, verifyLayout } from '../scripts/pcb-layout/pcb-layout-execution.mjs';
import { fixture } from './helpers/pcb-layout-execution-fixture.mjs';
import { compileAssemblyPolicy } from '../scripts/pcb-layout/pcb-layout-assembly-policy.mjs';

async function ready(t) { const f = await fixture(t); f.snapshot = await inspectLayout(f.options()); f.proposed = f.plan(f.snapshot); return f; }
test('report paths use filesystem identity across directory aliases', async t => {
  const f = await fixture(t), alias = f.projectRoot + '-alias';
  await symlink(f.projectRoot, alias, 'junction');
  t.after(() => unlink(alias));
  for (const [index, root] of [alias, await realpath(f.projectRoot)].entries()) {
    const reportDir = join(alias, 'nested', 'report-' + index);
    const result = await inspectLayout({ ...f.options(), projectRoot: root, reportDir });
    assert.equal(result.status, 'inspected');
    await access(join(f.projectRoot, 'nested', 'report-' + index, 'layout-inspect-result.json'));
  }
  assert.equal(f.control.saves, 0);
});

test('a report directory escaping through a junction is rejected before creation or transport', async t => {
  const f = await fixture(t), outside = await fixture(t);
  const link = join(f.projectRoot, 'outside');
  await symlink(outside.projectRoot, link, 'junction');
  const reportDir = join(link, 'must-not-be-created');
  await assert.rejects(inspectLayout({ ...f.options(), reportDir }), /REPORT_OUTSIDE_PROJECT/);
  await assert.rejects(access(join(outside.projectRoot, 'must-not-be-created')), { code: 'ENOENT' });
  assert.deepEqual(f.calls, []);
});

test('native inspect is generic, reports actual inventory and does not mutate', async t => {
  const f = await ready(t);
  assert.equal(f.snapshot.components.length, 2); assert.equal(f.snapshot.items.length, 2); assert.equal(f.snapshot.pads.length, 3);
  assert.equal(f.snapshot.units, 'mil'); assert.equal(f.snapshot.coordinateSystem, 'eda-y-up'); assert.deepEqual(f.snapshot.capabilities.unsupported, []);
  assert.equal(f.control.saves, 0); assert.deepEqual(f.control.modifications, []);
});
test('apply verifies independently, saves once and verifies after save', async t => {
  const f = await ready(t), result = await applyLayout({ ...f.options(), plan: f.proposed, snapshot: f.snapshot });
  assert.equal(result.status, 'verified'); assert.equal(result.saved, true); assert.equal(result.applyState, 'applied');
  assert.deepEqual(f.calls, ['inspect', 'apply', 'verify', 'save', 'verify']); assert.equal(f.control.saves, 1);
  assert.equal(f.components[0].X, 100); assert.equal(f.pads[0].X, 100); assert.equal(f.attributes[0].ParentPrimitiveId, f.components[0].PrimitiveId);
  await assert.rejects(resumeLayoutSave({ ...f.options(), resumeSave: result.reportFile }), /LAYOUT_ALREADY_SAVED/);
});
test('post-save verification failure retains saved:true and cannot replay save', async t => {
  const f = await ready(t); f.control.afterSave = () => { f.pads[0].Net = 'changed'; };
  const result = await applyLayout({ ...f.options(), plan: f.proposed, snapshot: f.snapshot });
  assert.equal(result.status, 'verify-after-save-failed'); assert.equal(result.saved, true); assert.equal(f.control.saves, 1);
  await assert.rejects(resumeLayoutSave({ ...f.options(), resumeSave: result.resumeSaveReport }), /LAYOUT_ALREADY_SAVED/);
});
test('known save failure can resume verify/save/verify without replaying apply', async t => {
  const f = await ready(t); f.control.saveResult = false;
  const result = await applyLayout({ ...f.options(), plan: f.proposed, snapshot: f.snapshot });
  assert.equal(result.status, 'save-failed'); assert.equal(result.saved, false); const changes = f.control.modifications.length;
  f.control.saveResult = true;
  const resumed = await resumeLayoutSave({ ...f.options(), resumeSave: result.reportFile });
  assert.equal(resumed.status, 'verified'); assert.equal(resumed.saved, true); assert.equal(f.control.modifications.length, changes);
  assert.deepEqual(f.calls.slice(-3), ['verify', 'save', 'verify']);
});
test('unknown apply does not invoke verify/save and has no recovery receipt', async t => {
  const f = await ready(t); f.control.beforePhase = ({ phase }) => { if (phase === 'apply') throw Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }); };
  const result = await applyLayout({ ...f.options(), plan: f.proposed, snapshot: f.snapshot });
  assert.equal(result.status, 'outcome-unknown'); assert.equal(result.saved, null); assert.equal(result.applyState, 'unknown'); assert.equal(f.control.saves, 0);
  await assert.rejects(resumeLayoutSave({ ...f.options(), resumeSave: result.reportFile }), /SAVE_RECOVERY_UNRESOLVED/);
});
test('unknown save preserves pending marker and blocks original or copied apply receipt', async t => {
  const f = await ready(t); f.control.beforePhase = ({ phase }) => { if (phase === 'save') throw Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }); };
  const result = await applyLayout({ ...f.options(), plan: f.proposed, snapshot: f.snapshot });
  assert.equal(result.status, 'outcome-unknown'); assert.equal(result.saved, null); assert.ok(await readFile(result.saveAttemptFile, 'utf8'));
  const copy = join(f.projectRoot, 'copied-receipt.json'); await copyFile(result.resumeSaveReport, copy);
  await assert.rejects(resumeLayoutSave({ ...f.options(), resumeSave: copy }), /SAVE_RECOVERY_UNRESOLVED/);
});
test('changed scene blocks apply before the first mutation', async t => {
  const f = await ready(t); f.pads[0].Net = 'manual-edit';
  const result = await applyLayout({ ...f.options(), plan: f.proposed, snapshot: f.snapshot });
  assert.equal(result.status, 'apply-failed'); assert.match(result.error.message, /SOURCE_CHANGED_REPLAN/); assert.equal(f.control.modifications.length, 0);
});
for (const obstacle of ['locked', 'routing', 'region', 'bottom']) test(obstacle + ' is rejected before mutation, not silently omitted', async t => {
  const f = await fixture(t);
  if (obstacle === 'locked') f.components[0].PrimitiveLock = true;
  if (obstacle === 'routing') f.routing.Line.push(f.primitive({ PrimitiveId: 'line', Layer: 1 }));
  if (obstacle === 'region') f.regions.push(f.primitive({ PrimitiveId: 'region', Layer: 1, bbox: { minX: 0, minY: 0, maxX: 20, maxY: 20 } }));
  if (obstacle === 'bottom') f.components[0].Layer = 2;
  const snapshot = await inspectLayout(f.options()), result = await applyLayout({ ...f.options(), snapshot, plan: f.plan(snapshot) });
  assert.equal(result.status, 'apply-failed'); assert.equal(f.control.modifications.length, 0); assert.equal(f.control.saves, 0);
});
test('partial native write reports attempts, does not save and cannot resume-save', async t => {
  const f = await ready(t); f.control.failModifyId = f.attributes[0].PrimitiveId;
  const result = await applyLayout({ ...f.options(), plan: f.proposed, snapshot: f.snapshot });
  assert.equal(result.applyState, 'partial-failed'); assert.equal(result.saved, false); assert.equal(f.control.saves, 0); assert.equal(f.components[0].X, 100);
  await assert.rejects(resumeLayoutSave({ ...f.options(), resumeSave: result.reportFile }), /SUCCESSFUL_APPLY_REQUIRED/);
});
test('changed net, label parent or pad geometry fails independent verification', async t => {
  const f = await ready(t), result = await applyLayout({ ...f.options(), plan: f.proposed, snapshot: f.snapshot }); assert.equal(result.saved, true);
  f.pads[0].bbox.maxX += .5;
  const verified = await verifyLayout({ ...f.options(), snapshot: f.snapshot, plan: f.proposed });
  assert.equal(verified.status, 'verification-failed'); assert.ok(verified.issues.some(i => i.code === 'PAD_READBACK_FAILED'));
});
test('extra constraint hook runs before saving and after saving', async t => {
  const f = await ready(t); let n = 0;
  const result = await applyLayout({ ...f.options(), plan: f.proposed, snapshot: f.snapshot, validateReadback: () => { if (++n === 1) throw Error('edge failed'); } });
  assert.equal(result.status, 'verify-failed'); assert.equal(result.saved, false); assert.equal(f.control.saves, 0);
  const resumed = await resumeLayoutSave({ ...f.options(), resumeSave: result.reportFile, validateReadback: () => { n++; } });
  assert.equal(resumed.status, 'verified'); assert.equal(n, 3);
});
test('receipt tampering cannot bypass its original workflow identity', async t => {
  const f = await ready(t); f.control.saveResult = false;
  const result = await applyLayout({ ...f.options(), plan: f.proposed, snapshot: f.snapshot });
  const receipt = JSON.parse(await readFile(result.resumeSaveReport, 'utf8')); receipt.expectedSourceHash++;
  const altered = join(f.projectRoot, 'altered.json'); await writeFile(altered, JSON.stringify(receipt));
  await assert.rejects(resumeLayoutSave({ ...f.options(), resumeSave: altered }), /APPLY_RECEIPT_MISMATCH/);
});
test('a second known save failure remains resumable from its new workflow report', async t => {
  const f = await ready(t); f.control.saveResult = false;
  const first = await applyLayout({ ...f.options(), plan: f.proposed, snapshot: f.snapshot });
  const second = await resumeLayoutSave({ ...f.options(), resumeSave: first.reportFile });
  assert.equal(second.status, 'save-failed');
  f.control.saveResult = true;
  const third = await resumeLayoutSave({ ...f.options(), resumeSave: second.reportFile });
  assert.equal(third.status, 'verified'); assert.equal(f.calls.filter(p => p === 'apply').length, 1);
});
test('source changes after successful apply prevent resuming save', async t => {
  const f = await ready(t); f.control.saveResult = false;
  const first = await applyLayout({ ...f.options(), plan: f.proposed, snapshot: f.snapshot }), saves = f.control.saves;
  f.pads[0].Net = 'manual-change';
  const resumed = await resumeLayoutSave({ ...f.options(), resumeSave: first.reportFile });
  assert.equal(resumed.status, 'verify-failed'); assert.equal(f.control.saves, saves);
});
test('unknown readback after successful save retains saved:true', async t => {
  const f = await ready(t); f.control.beforePhase = ({ name }) => { if (name === 'verify-after-save') throw Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }); };
  const result = await applyLayout({ ...f.options(), plan: f.proposed, snapshot: f.snapshot });
  assert.equal(result.status, 'outcome-unknown'); assert.equal(result.saved, true); assert.equal(result.saveState, 'saved');
  await assert.rejects(resumeLayoutSave({ ...f.options(), resumeSave: result.resumeSaveReport }), /LAYOUT_ALREADY_SAVED|SAVE_RECOVERY_UNRESOLVED/);
});
test('wrong target, non-quarter rotation and native outline block before modifying', async t => {
  for (const mode of ['target', 'angle', 'outline']) {
    const f = await fixture(t);
    if (mode === 'outline') f.routing.Polyline.push(f.primitive({ PrimitiveId: 'outline', Layer: 11, Polygon: { getSource: () => 'outline-path' } }));
    const snapshot = await inspectLayout(f.options()), plan = f.plan(snapshot);
    if (mode === 'target') f.control.document.uuid = 'other-pcb';
    if (mode === 'angle') plan.components[0].rotation = 45;
    const result = await applyLayout({ ...f.options(), snapshot, plan });
    assert.equal(result.status, 'apply-failed'); assert.equal(f.control.modifications.length, 0);
  }
});

const assemblyFor = snapshot => compileAssemblyPolicy(snapshot, {
  schemaVersion: 1, profile: { id: 'fixture', label: 'Synthetic assembly fixture' },
  source: { title: 'Synthetic test rule', url: 'https://example.test/fixture' },
  rules: [{ id: 'generic', footprintNames: ['FIXTURE'], marginMm: .254 }],
  independentPads: { marginMm: 0, basis: 'Synthetic bare test pad' }, overrides: []
});
const offsetPad = f => {
  f.pads[0].X=3.05;f.pads[0].Y=5;
  f.pads[0].bbox={minX:2.05,maxX:4.05,minY:4,maxY:6};
};
for (const rotation of [90,180,270]) test(`native ${rotation} degree rotation transforms precise pads and rewrites automatically moved labels`, async t => {
  const f=await fixture(t);offsetPad(f);
  const snapshot=await inspectLayout(f.options()),plan=f.plan(snapshot,{firstDx:0,rotation});
  const result=await applyLayout({...f.options(),snapshot,plan});
  assert.equal(result.status,'verified',result.error?.message);assert.equal(result.saved,true);
  const radians=rotation*Math.PI/180;
  assert.ok(Math.abs(f.pads[0].X-(3.05*Math.cos(radians)-5*Math.sin(radians)))<1e-10);
  assert.ok(Math.abs(f.pads[0].Y-(3.05*Math.sin(radians)+5*Math.cos(radians)))<1e-10);
  assert.equal(f.components[0].Rotation,rotation);
  assert.equal(f.control.modifications.filter(id=>id===f.attributes[0].PrimitiveId).length,1);
  assert.equal(f.attributes[0].Rotation,plan.labels[0].rotation);
  assert.ok(Math.abs(f.attributes[0].X-plan.labels[0].x)<1e-10);
  assert.ok(Math.abs(f.attributes[0].Y-plan.labels[0].y)<1e-10);
  assert.equal(f.control.saves,1);
});
test('pure rotation is blocked by routed copper before any mutation',async t=>{
  const f=await fixture(t);f.routing.Line.push(f.primitive({PrimitiveId:'trace',Layer:1}));
  const snapshot=await inspectLayout(f.options()),plan=f.plan(snapshot,{firstDx:0,rotation:90});
  const result=await applyLayout({...f.options(),snapshot,plan});
  assert.equal(result.status,'apply-failed');assert.match(result.error.message,/ROUTED_BOARD_MOVE_UNSUPPORTED/);
  assert.equal(f.control.modifications.length,0);assert.equal(f.control.saves,0);
});
test('rounded pad coordinate getters preserve sub-mil geometry, while a real 0.02 mil bbox offset is rejected',async t=>{
  for(const broken of [false,true]){
    const f=await fixture(t);offsetPad(f);f.control.roundPadReadback=true;
    const snapshot=await inspectLayout(f.options());assert.equal(snapshot.pads[0].x,3.1);assert.equal(snapshot.pads[0].bbox.minX,2.05);
    if(broken)f.control.padBboxOffsetAfterMove=.02;
    const plan=f.plan(snapshot,{firstDx:0,rotation:180}),result=await applyLayout({...f.options(),snapshot,plan});
    if(broken){assert.equal(result.applyState,'apply-verification-failed');assert.equal(result.saved,false);assert.equal(f.control.saves,0);const report=JSON.parse(await readFile(join(result.reportDir,'layout-apply-result.json'),'utf8'));assert.ok(report.response.result.after.issues.some(i=>i.code==='PAD_READBACK_FAILED'));}
    else {assert.equal(result.status,'verified',result.error?.message);assert.equal(result.saved,true);assert.equal(f.control.saves,1);}
  }
});
test('forged planned body bounds cannot conceal an assembly conflict before mutation',async t=>{
  const f=await ready(t),options=f.options(),plan=f.plan(f.snapshot,{firstDx:0});
  options.config.assemblyPolicy=assemblyFor(f.snapshot);
  plan.components[1].x=35;plan.components[1].body={minX:990,maxX:1010,minY:990,maxY:1010};
  const result=await applyLayout({...options,snapshot:f.snapshot,plan});
  assert.equal(result.status,'apply-failed');assert.match(result.error.message,/PLAN_GEOMETRY_ISSUES.*ASSEMBLY_COURTYARD_OVERLAP/);
  assert.equal(f.control.modifications.length,0);assert.equal(f.control.saves,0);
});
test('actual body geometry after movement is checked before saving',async t=>{
  const f=await ready(t),options=f.options();options.config.assemblyPolicy=assemblyFor(f.snapshot);f.control.bodyBboxExpandAfterMove=200;
  const result=await applyLayout({...options,snapshot:f.snapshot,plan:f.proposed});
  assert.equal(result.applyState,'apply-verification-failed');assert.equal(result.saved,false);assert.equal(f.control.saves,0);
  const report=JSON.parse(await readFile(join(result.reportDir,'layout-apply-result.json'),'utf8'));
  assert.ok(report.response.result.after.issues.some(i=>i.code==='COMPONENT_READBACK_FAILED'));
  assert.ok(report.response.result.after.issues.some(i=>i.code==='ASSEMBLY_COURTYARD_OVERLAP'));
});
test('missing serialized assembly helper blocks the native operation before mutation',async t=>{
  const f=await ready(t),options=f.options();options.config.assemblyPolicy=assemblyFor(f.snapshot);
  const transport=request=>f.transport({...request,code:request.code.replace('const assemblyRuntime=(', 'const omittedAssemblyRuntime=(')});
  const result=await applyLayout({...options,transport,snapshot:f.snapshot,plan:f.proposed});
  assert.equal(result.status,'apply-failed');assert.match(result.error.message,/ASSEMBLY_RUNTIME_MISSING/);
  assert.equal(f.control.modifications.length,0);assert.equal(f.control.saves,0);
});
test('independent verification uses actual owned and standalone pad bounds for assembly',async t=>{
  const f=await ready(t),options=f.options();options.config.assemblyPolicy=assemblyFor(f.snapshot);
  const result=await applyLayout({...options,snapshot:f.snapshot,plan:f.proposed});assert.equal(result.status,'verified');
  const originalBox={...f.pads[0].bbox};f.pads[0].bbox.maxX=285;
  let verified=await verifyLayout({...f.options(),config:options.config,snapshot:f.snapshot,plan:f.proposed});
  assert.equal(verified.status,'verification-failed');assert.equal(verified.assembly.physical.find(p=>p.ref==='U1').bbox.maxX,285);
  assert.ok(verified.issues.some(i=>i.code==='ASSEMBLY_COURTYARD_OVERLAP'));
  f.pads[0].bbox=originalBox;f.pads[2].X=119;f.pads[2].bbox={minX:117,maxX:121,minY:-2,maxY:2};
  verified=await verifyLayout({...f.options(),config:options.config,snapshot:f.snapshot,plan:f.proposed});
  assert.ok(verified.issues.some(i=>i.code==='ASSEMBLY_COURTYARD_OVERLAP'&&[i.a,i.b].includes('TP1')));
  assert.equal(f.control.saves,1);
});

test('native ownership uses explicit global pin IDs, even for non-prefix children and prefix-looking standalone pads',async t=>{
  const f=await fixture(t);f.pads[0].PrimitiveId='unrelated-global-pad-id';f.pads[2].PrimitiveId=f.components[0].PrimitiveId+'looks-like-a-child';
  const snapshot=await inspectLayout(f.options());
  assert.equal(snapshot.pads[0].owner,'U1');assert.equal(snapshot.pads[0].parentComponentId,f.components[0].PrimitiveId);
  assert.equal(snapshot.pads[2].owner,null);assert.equal(snapshot.pads[2].parentComponentId,null);
  assert.deepEqual(snapshot.padOwnership,{status:'verified',source:'native-component-pins',queriedComponents:2,ownedPads:2,standalonePads:1,methods:{instance:2,class:0}});
  const options=f.options();options.config.assemblyPolicy=assemblyFor(snapshot);
  const result=await applyLayout({...options,snapshot,plan:f.plan(snapshot)});
  assert.equal(result.status,'verified',result.error?.message);assert.equal(f.pads[0].X,100);assert.equal(f.pads[2].X,500);
  assert.equal(result.verification.testPads.length,1);assert.equal(result.verification.testPads[0].id,f.pads[2].PrimitiveId);
});
test('class pin query is used only when the component pin query is unavailable',async t=>{
  const f=await fixture(t);delete f.components[0].getAllPins;
  const snapshot=await inspectLayout(f.options());
  assert.deepEqual(snapshot.padOwnership.methods,{instance:1,class:1});assert.equal(snapshot.pads[0].owner,'U1');
});
test('missing both ownership APIs fails explicitly without guessing ID prefixes',async t=>{
  const f=await fixture(t);for(const c of f.components)delete c.getAllPins;delete f.eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId;
  await assert.rejects(inspectLayout(f.options()),/PAD_OWNERSHIP_API_UNAVAILABLE/);
  assert.equal(f.control.modifications.length,0);assert.equal(f.control.saves,0);
});
test('failed component query does not silently fall back or label unqueried pads standalone',async t=>{
  const f=await fixture(t);f.control.pinQuery=c=>{throw Error('query unavailable '+c.Designator);};
  await assert.rejects(inspectLayout(f.options()),/PAD_OWNERSHIP_QUERY_FAILED/);
  assert.ok(f.control.pinQueries.every(q=>q.method==='instance'));
});
for(const defect of ['wrong-parent','unknown-flat-id','wrong-net','duplicate-claim','missing-claim','flat-parent-mismatch','duplicate-flat-id'])test(`ownership cross-check rejects ${defect}`,async t=>{
  const f=await fixture(t);
  if(defect==='flat-parent-mismatch')f.pads[0].ParentComponentPrimitiveId=f.components[1].PrimitiveId;
  else if(defect==='duplicate-flat-id')f.pads[2].PrimitiveId=f.pads[0].PrimitiveId;
  else f.control.pinQuery=(c,pins)=>{
    if(c.Designator!=='U1')return pins;
    if(defect==='missing-claim')return [];
    if(defect==='duplicate-claim'){delete c.getState_Pads;return [pins[0],pins[0]];}
    const changed=defect==='wrong-parent'?['getState_ParentComponentPrimitiveId',()=>f.components[1].PrimitiveId]:defect==='unknown-flat-id'?['getState_PrimitiveId',()=> 'missing-global-id']:['getState_Net',()=> 'wrong-net'];
    return [new Proxy(pins[0],{get(o,k){return k===changed[0]?changed[1]:o[k];}})];
  };
  await assert.rejects(inspectLayout(f.options()),/PAD_|DUPLICATE_OR_INVALID_PAD_ID/);
  assert.equal(f.control.modifications.length,0);
});
test('ownership changing during native apply is caught before save even when the new component query is internally consistent',async t=>{
  const f=await ready(t);f.control.afterComponentModify=()=>{f.ownership.set(f.pads[0],f.components[1].PrimitiveId);f.pads[0].ParentComponentPrimitiveId=f.components[1].PrimitiveId;};
  const result=await applyLayout({...f.options(),snapshot:f.snapshot,plan:f.proposed});
  assert.equal(result.applyState,'apply-verification-failed');assert.equal(result.saved,false);assert.equal(f.control.saves,0);
  const report=JSON.parse(await readFile(join(result.reportDir,'layout-apply-result.json'),'utf8'));
  assert.ok(report.response.result.after.issues.some(i=>i.code==='PAD_OWNER_CHANGED'));
});
test('native geometry preserves null and complex JSON shapes, while missing and throwing getters remain distinguishable',async t=>{
  const f=await fixture(t);f.pads[0].Pad=['POLYGON',{points:[[1,2],[3,4]],closed:true}];delete f.pads[0].HoleOffsetX;f.pads[0].getState_HoleRotation=()=>{throw Error('unsupported hole rotation');};
  const snapshot=await inspectLayout(f.options()),g=snapshot.pads[0].nativeGeometry;
  assert.equal(g.source,'native-readback');assert.equal(g.coordinateSystem,'eda-y-up');assert.deepEqual(g.observedPose,{x:0,y:0,rotation:0});
  assert.deepEqual(g.fields.pad,{status:'ok',value:['POLYGON',{points:[[1,2],[3,4]],closed:true}]});
  assert.deepEqual(g.fields.hole,{status:'ok',value:null});assert.deepEqual(g.fields.holeOffsetX,{status:'unavailable'});assert.match(g.fields.holeRotation.error,/unsupported hole rotation/);assert.equal(g.fields.holeRotation.status,'error');
  assert.deepEqual(g.fields.metallization,{status:'ok',value:false});
  assert.doesNotThrow(()=>JSON.stringify(snapshot));assert.equal(f.control.modifications.length,0);
});
test('optional geometry metadata cannot alter assembly or placement outcomes and readback poses remain actual',async t=>{
  const f=await fixture(t);f.pads[0].Pad=['RECT',100000,100000];f.pads[0].Hole=['ROUND',99999];f.pads[0].HoleOffsetY=80000;
  const snapshot=await inspectLayout(f.options()),options=f.options();options.config.assemblyPolicy=assemblyFor(snapshot);
  const result=await applyLayout({...options,snapshot,plan:f.plan(snapshot,{firstDx:100,rotation:90})});
  assert.equal(result.status,'verified',result.error?.message);assert.deepEqual(snapshot.pads[0].nativeGeometry.observedPose,{x:0,y:0,rotation:0});
  assert.deepEqual(result.verification.pads[0].nativeGeometry.observedPose,{x:100,y:0,rotation:90});
  assert.equal(result.verification.assembly.physical.find(p=>p.ref==='U1').bbox.maxX,105);
});
test('native netlist and names are optional observations with explicit unavailable/error/ok outcomes',async t=>{
  for(const mode of ['unavailable','error','invalid','ok']){
    const f=await fixture(t);
    if(mode==='error')f.eda.pcb_Net={getNetlist:async()=>{throw Error('netlist failed');},getAllNetsName:async()=>{throw Error('names failed');}};
    if(mode==='invalid')f.eda.pcb_Net={getNetlist:async()=>null,getAllNetsName:async()=>['N0',9]};
    if(mode==='ok')f.eda.pcb_Net={getNetlist:async()=>'{"version":"fixture","components":{}}',getAllNetsName:async()=>['N0','N1']};
    const snapshot=await inspectLayout(f.options()),expected=mode==='invalid'?'error':mode;
    assert.equal(snapshot.nativeNetlist.status,expected);assert.equal(snapshot.nativeNetNames.status,expected);
    assert.equal(snapshot.nativeNetlist.source,'pcb_Net.getNetlist');assert.equal(snapshot.nativeNetNames.source,'pcb_Net.getAllNetsName');
    if(mode==='ok'){assert.equal(snapshot.nativeNetlist.raw,'{"version":"fixture","components":{}}');assert.deepEqual(snapshot.nativeNetNames.value,['N0','N1']);}
    else {assert.equal(Object.hasOwn(snapshot.nativeNetlist,'raw'),false);assert.equal(Object.hasOwn(snapshot.nativeNetNames,'value'),false);}
    assert.equal(f.control.modifications.length,0);assert.equal(f.control.saves,0);
  }
});
test('readback carries native network and ownership observations for the host audit hook',async t=>{
  const f=await fixture(t);f.eda.pcb_Net={getNetlist:async()=>'{"components":{}}',getAllNetsName:async()=>['N0','N1']};
  const snapshot=await inspectLayout(f.options());let audits=0;
  const result=await applyLayout({...f.options(),snapshot,plan:f.plan(snapshot),validateReadback:actual=>{audits++;assert.equal(actual.nativeNetlist.status,'ok');assert.equal(actual.nativeNetNames.status,'ok');assert.equal(actual.padOwnership.status,'verified');assert.equal(actual.padOwnership.queriedComponents,actual.placements.length);}});
  assert.equal(result.status,'verified');assert.equal(audits,2);
});
test('source mutation during optional netlist reading rejects the whole snapshot',async t=>{
  const f=await fixture(t);f.eda.pcb_Net={getNetlist:async()=>{f.pads[0].Net='concurrent-edit';return '{}';}};
  await assert.rejects(inspectLayout(f.options()),/SOURCE_CHANGED_DURING_READ/);
  assert.equal(f.control.modifications.length,0);
});
