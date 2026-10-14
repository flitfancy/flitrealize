import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, symlink, unlink, realpath, access } from 'node:fs/promises';
import { join } from 'node:path';
import { applyLayout, inspectLayout, preflightLayout, resumeLayoutSave, verifyLayout } from '../../scripts/pcb-layout/pcb-layout-execution.mjs';
import { fixture } from '../helpers/pcb-layout-execution-fixture.mjs';
import { compileAssemblyPolicy } from '../../scripts/pcb-layout/pcb-layout-assembly-policy.mjs';

async function ready(t) { const f = await fixture(t); f.snapshot = await inspectLayout(f.options()); f.proposed = f.plan(f.snapshot); return f; }

function rewriteSource(f,id,edit) {
  const readSource=f.eda.sys_FileManager.getDocumentSource;
  f.eda.sys_FileManager.getDocumentSource=async()=>String(await readSource()).split('\n').map(line=>{
    const at=line.indexOf('||'),header=JSON.parse(line.slice(0,at));if(header.id!==id)return line;
    const value=JSON.parse(line.slice(at+2,-1));edit(value);
    return line.slice(0,at+2)+JSON.stringify(value)+'|';
  }).join('\n');
}

for(const field of ['Rotation','HoleRotation'])for(const mode of ['equivalent','seam','wrong-angle','outside-tolerance','missing','null','string','nonfinite','error'])test('preflight pad '+field+' dependency angle: '+mode,async t=>{
  for(const index of [0,2]){
    const f=await fixture(t),pad=f.pads[index],base=mode==='equivalent'?270:0;pad[field]=base;
    const snapshot=await inspectLayout(f.options()),plan=f.plan(snapshot);
    if(mode==='missing')delete pad[field];
    else if(mode==='error')pad['getState_'+field]=()=>{throw Error('angle getter failed');};
    else pad[field]=mode==='equivalent'?-90:mode==='seam'?360-1e-8:mode==='wrong-angle'?45:mode==='outside-tolerance'?360-1e-6:mode==='null'?null:mode==='string'?'0':NaN;
    const pre=await preflightLayout({...f.options(),snapshot,plan}),accepted=['equivalent','seam'].includes(mode);
    assert.equal(pre.status,accepted?'preflight-passed':'preflight-blocked',pre.error?.message);
    assert.deepEqual(f.control.modifications,[]);assert.equal(f.control.saves,0);
    const result=await applyLayout({...f.options(),snapshot,plan});
    if(accepted){assert.equal(result.status,'verified',result.error?.message);assert.equal(f.control.saves,1);}
    else{assert.equal(result.applyState,'blocked');assert.match(result.error.message,/PAD_BASELINE_CHANGED/);assert.deepEqual(f.control.modifications,[]);assert.equal(f.control.saves,0);}
  }
});

for(const kind of ['component','label','string','pad'])for(const mode of ['equivalent','seam','wrong-angle','outside-tolerance','missing','null','string'])test('preflight '+kind+' source dependency angle: '+mode,async t=>{
  const f=await fixture(t),base=mode==='equivalent'?270:0,options=f.options();
  if(kind==='string'){
    f.strings.push(f.primitive({PrimitiveId:'functional-label',Text:'STATE',Layer:3,PrimitiveLock:false,X:0,Y:30,Rotation:base,AlignMode:'CENTER',FontSize:4,LineWidth:1,bbox:base===270?{minX:-1,maxX:1,minY:26,maxY:34}:{minX:-4,maxX:4,minY:29,maxY:31}}));
    options.config.includeFunctionalLabels=true;options.config.functionalOwners={STATE:'U1'};
  }
  const object=kind==='component'?f.components[1]:kind==='label'?f.attributes[0]:kind==='string'?f.strings[0]:f.pads[2];
  object.Rotation=base;if(kind==='label'&&base===270)object.bbox={minX:-1,maxX:1,minY:6,maxY:14};
  options.config.lockedDesignators=['U2'];
  let current=base;rewriteSource(f,object.PrimitiveId,value=>{if(current===undefined)delete value.angle;else value.angle=current;});
  const snapshot=await inspectLayout(options),plan=f.plan(snapshot);
  current=mode==='equivalent'?-90:mode==='seam'?360-1e-8:mode==='wrong-angle'?45:mode==='outside-tolerance'?360-1e-6:mode==='missing'?undefined:mode==='null'?null:'0';
  const pre=await preflightLayout({...options,snapshot,plan}),accepted=['equivalent','seam'].includes(mode);
  assert.equal(pre.status,accepted?'preflight-passed':'preflight-blocked',pre.error?.message);
  assert.deepEqual(f.control.modifications,[]);assert.equal(f.control.saves,0);
  const result=await applyLayout({...options,snapshot,plan});
  if(accepted){assert.equal(result.status,'verified',result.error?.message);assert.equal(f.control.saves,1);assert.ok(result.preservedChanges.some(c=>c.id===object.PrimitiveId&&c.fields.includes('angle')));}
  else{assert.equal(result.applyState,'blocked');assert.match(result.error.message,/SOURCE_WRITE_DEPENDENCY_CHANGED/);assert.deepEqual(f.control.modifications,[]);assert.equal(f.control.saves,0);}
});

test('preflight angle aliases keep every non-angle dependency and unobserved record strict',async t=>{
  for(const change of ['position','bbox','net','lock','pad-shape','hole-offset','metadata','nested-angle','rule','hidden-attribute']){
    const f=await fixture(t),pad=f.pads[0];pad.Rotation=270;pad.Pad=['POLYGON',{angle:270,points:[[1,2],[3,4]]}];
    const record=(type,id,value)=>JSON.stringify({type,id})+'||'+JSON.stringify(value)+'|';
    if(change==='rule'||change==='hidden-attribute')f.control.sourceRecords=[record(change==='rule'?'RULE':'ATTR','unobserved',{parentId:f.components[0].PrimitiveId,angle:270})];
    const snapshot=await inspectLayout(f.options()),plan=f.plan(snapshot);pad.Rotation=-90;
    if(change==='position')pad.X+=1;
    if(change==='bbox')pad.bbox.maxX+=1;
    if(change==='net')pad.Net='changed-net';
    if(change==='lock')pad.PrimitiveLock=true;
    if(change==='pad-shape')pad.Pad=['RECT',5,4];
    if(change==='hole-offset')pad.HoleOffsetX=1;
    if(change==='metadata')pad.DisplayOrder=9;
    if(change==='nested-angle')pad.Pad[1].angle=-90;
    if(change==='rule'||change==='hidden-attribute')f.control.sourceRecords=[record(change==='rule'?'RULE':'ATTR','unobserved',{parentId:f.components[0].PrimitiveId,angle:-90})];
    const pre=await preflightLayout({...f.options(),snapshot,plan});assert.equal(pre.status,'preflight-blocked',change);
    const result=await applyLayout({...f.options(),snapshot,plan});assert.equal(result.applyState,'blocked',change);
    assert.deepEqual(f.control.modifications,[]);assert.equal(f.control.saves,0);
  }
});

test('an equivalent angle edit after preflight still fails the exact source fingerprint guard',async t=>{
  const f=await ready(t);f.control.beforePhase=({phase})=>{if(phase==='apply')f.pads[2].Rotation=360;};
  const result=await applyLayout({...f.options(),snapshot:f.snapshot,plan:f.proposed,validatePreflight:()=>{}});
  assert.equal(result.applyState,'blocked');assert.match(result.error.message,/SOURCE_CHANGED_AFTER_PREFLIGHT/);
  assert.deepEqual(f.control.modifications,[]);assert.equal(f.control.saves,0);
});

for(const mode of ['expected','wrong-angle','changed-content'])test('native angle and hidden owned attributes: '+mode,async t=>{
  const f=await fixture(t),component=f.components[0];component.angle=component.Rotation;
  const hidden={parentId:component.PrimitiveId,key:'Footprint',value:'unchanged',x:null,y:null,angle:0};
  const record=value=>JSON.stringify({type:'ATTR',id:'hidden-owned-attr'})+'||'+JSON.stringify(value)+'|';
  f.control.sourceRecords=[record(hidden)];
  const snapshot=await inspectLayout(f.options()),plan=f.plan(snapshot,{rotation:90});
  f.control.afterComponentModify=()=>{
    component.angle=component.Rotation;
    f.control.sourceRecords=[record({...hidden,angle:mode==='wrong-angle'?45:90,value:mode==='changed-content'?'unexpected':hidden.value})];
  };
  const result=await applyLayout({...f.options(),snapshot,plan});
  if(mode==='expected'){assert.equal(result.status,'verified',result.error?.message);assert.equal(result.saved,true);}
  else{assert.equal(result.status,'apply-failed');assert.equal(f.control.saves,0);const report=JSON.parse(await readFile(join(result.reportDir,'layout-apply-result.json')));assert.ok(report.response.result.after.issues.some(x=>x.code==='SOURCE_READBACK_CHANGED'&&x.id==='hidden-owned-attr'));}
});

for(const kind of ['component','label'])for(const mode of ['equivalent','seam','outside-tolerance','wrong-angle','missing','null','string'])test('written '+kind+' native source angle: '+mode,async t=>{
  const f=await fixture(t),actual=kind==='component'?f.components[0]:f.attributes[0];
  const targetRotation=mode==='seam'||mode==='outside-tolerance'?0:270;
  if(kind==='label'&&targetRotation===270){
    actual.Rotation=270;
    actual.bbox={minX:actual.X-1,maxX:actual.X+1,minY:actual.Y-4,maxY:actual.Y+4};
  }
  const snapshot=await inspectLayout(f.options()),plan=f.plan(snapshot,{rotation:targetRotation});
  const planned=(kind==='component'?plan.components:plan.labels).find(p=>p.id===actual.PrimitiveId);
  const readSource=f.eda.sys_FileManager.getDocumentSource;
  f.eda.sys_FileManager.getDocumentSource=async()=>{
    const source=await readSource();
    if(!f.control.modifications.includes(actual.PrimitiveId))return source;
    return source.split('\n').map(line=>{
      const at=line.indexOf('||'),header=JSON.parse(line.slice(0,at));
      if(header.id!==actual.PrimitiveId)return line;
      const value=JSON.parse(line.slice(at+2,-1));
      if(mode==='missing')delete value.angle;
      else value.angle=mode==='equivalent'?-90:mode==='seam'?360-1e-8:mode==='outside-tolerance'?360-1e-6:mode==='wrong-angle'?45:mode==='null'?null:'270';
      return line.slice(0,at+2)+JSON.stringify(value)+'|';
    }).join('\n');
  };
  const result=await applyLayout({...f.options(),snapshot,plan});
  assert.equal(actual.Rotation,planned.rotation,'SDK pose still agrees with the plan');
  if(mode==='equivalent'||mode==='seam'){
    assert.equal(planned.rotation,targetRotation);assert.equal(result.status,'verified',result.error?.message);
    assert.equal(result.saved,true);assert.equal(f.control.saves,1);
  }else{
    assert.equal(result.applyState,'apply-verification-failed');assert.equal(result.saved,false);assert.equal(f.control.saves,0);
    const report=JSON.parse(await readFile(join(result.reportDir,'layout-apply-result.json'),'utf8'));
    assert.ok(report.response.result.after.issues.some(i=>i.code==='SOURCE_READBACK_CHANGED'&&i.id===actual.PrimitiveId));
  }
});

for(const kind of ['component','label'])test('required native '+kind+' SDK angles do not default invalid values to zero',async t=>{
  for(const value of [undefined,null,NaN,'0']){
    const f=await fixture(t),object=kind==='component'?f.components[0]:f.attributes[0];object.Rotation=value;
    await assert.rejects(inspectLayout(f.options()),/NATIVE_(COMPONENT|LABEL)_ROTATION_INVALID/);
    assert.equal(f.control.saves,0);assert.deepEqual(f.control.modifications,[]);
  }
});

for(const kind of ['component','label'])test('native '+kind+' SDK readback accepts circular seam tolerance',async t=>{
  const f=await fixture(t),api=kind==='component'?f.eda.pcb_PrimitiveComponent:f.eda.pcb_PrimitiveAttribute,original=api.getAll;
  api.getAll=async()=>{const rows=await original();return !f.control.modifications.length?rows:rows.map((o,i)=>i?o:new Proxy(o,{get(target,key){return key==='getState_Rotation'?()=>360-1e-8:target[key];}}));};
  const snapshot=await inspectLayout(f.options()),result=await applyLayout({...f.options(),snapshot,plan:f.plan(snapshot)});
  assert.equal(result.status,'verified',result.error?.message);assert.equal(f.control.saves,1);
});

for(const mode of ['seam','wrong-point','wrong-parent'])test('owned ATTR circular angle and exact parent transform: '+mode,async t=>{
  const f=await fixture(t),parent=f.components[0],hidden={parentId:parent.PrimitiveId,key:'Footprint',value:'unchanged',x:3,y:4,angle:90};
  const record=v=>JSON.stringify({type:'ATTR',id:'hidden-transform'})+'||'+JSON.stringify(v)+'|';
  f.control.sourceRecords=[record(hidden)];
  const snapshot=await inspectLayout(f.options()),plan=f.plan(snapshot,{rotation:270});
  f.control.afterComponentModify=()=>{f.control.sourceRecords=[record({...hidden,parentId:mode==='wrong-parent'?'other-parent':parent.PrimitiveId,x:mode==='wrong-point'?105:104,y:-3,angle:360-1e-6})];};
  const result=await applyLayout({...f.options(),snapshot,plan});
  if(mode==='seam'){assert.equal(result.status,'verified',result.error?.message);assert.equal(f.control.saves,1);}
  else{assert.equal(result.applyState,'apply-verification-failed');assert.equal(f.control.saves,0);}
});

for(const kind of ['component','label'])for(const changed of [false,true])test('preflight '+kind+' angle alias keeps strict dependencies: '+changed,async t=>{
  const f=await fixture(t),object=kind==='component'?f.components[1]:f.attributes[0];
  const snapshot=await inspectLayout(f.options()),plan=f.plan(snapshot);object.Rotation=changed?90:360;
  const options=f.options();options.config.lockedDesignators=['U2'];
  const result=await applyLayout({...options,snapshot,plan});
  if(changed){assert.equal(result.applyState,'blocked');assert.equal(f.control.saves,0);assert.deepEqual(f.control.modifications,[]);}
  else{assert.equal(result.status,'verified',result.error?.message);assert.equal(f.control.saves,1);assert.ok(result.preservedChanges.some(c=>c.id===object.PrimitiveId&&c.fields.includes('angle')));}
});

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
test('native apply keeps a rectangular board and verifies contained geometry before saving', async t => {
  const f=await fixture(t), boardBounds={minX:-100,minY:-100,maxX:550,maxY:200};
  const polygon=[-100,-100,'L',-100,200,550,200,550,-100,-100,-100];
  f.routing.Polyline.push(f.primitive({PrimitiveId:'board',Layer:11,Polygon:{getSource:()=>polygon}}));
  const snapshot=await inspectLayout(f.options()), plan={...f.plan(snapshot),boardBounds};
  const result=await applyLayout({...f.options(),plan,snapshot});
  assert.equal(result.status,'verified',JSON.stringify(result));
  assert.equal(result.saved,true);
  assert.equal(f.control.saves,1);
  assert.deepEqual((await inspectLayout(f.options())).outlines,snapshot.outlines);
});

test('native board mismatch and proposed overflow stop all component writes', async t => {
  for(const mode of ['mismatch','overflow']) {
    const f=await fixture(t), boardBounds={minX:-100,minY:-100,maxX:550,maxY:200};
    f.routing.Polyline.push(f.primitive({PrimitiveId:'board',Layer:11,Polygon:{getSource:()=>[-100,-100,'L',-100,200,550,200,550,-100,-100,-100]}}));
    const snapshot=await inspectLayout(f.options()), plan={...f.plan(snapshot,{firstDx:mode==='overflow'?600:100}),boardBounds};
    if(mode==='mismatch') plan.boardBounds={...boardBounds,maxX:600};
    const result=await applyLayout({...f.options(),plan,snapshot});
    assert.notEqual(result.status,'verified');
    assert.equal(f.control.saves,0);assert.deepEqual(f.control.modifications,[]);
  }
});

test('a board changing after save remains a saved but failed verification', async t => {
  const f=await fixture(t),boardBounds={minX:-100,minY:-100,maxX:550,maxY:200};
  let polygon=[-100,-100,'L',-100,200,550,200,550,-100,-100,-100];
  f.routing.Polyline.push(f.primitive({PrimitiveId:'board',Layer:11,Polygon:{getSource:()=>polygon}}));
  const snapshot=await inspectLayout(f.options()),plan={...f.plan(snapshot),boardBounds};
  f.control.afterSave=()=>{polygon=[-100,-100,'L',-100,200,560,200,560,-100,-100,-100];};
  const result=await applyLayout({...f.options(),plan,snapshot});
  assert.equal(result.status,'verify-after-save-failed');
  assert.equal(result.saved,true);assert.equal(f.control.saves,1);
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
  assert.equal(result.status, 'apply-failed'); assert.match(result.error.message, /PAD_BASELINE_CHANGED/); assert.equal(f.control.modifications.length, 0);
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

test('outside body and pad poses can change safely while only the original target is written',async t=>{
 const f=await ready(t);for(const a of [f.components[1],f.pads[1],f.attributes[1]]){a.X+=40;a.bbox.minX+=40;a.bbox.maxX+=40;}
 const result=await applyLayout({...f.options(),snapshot:f.snapshot,plan:f.proposed});assert.equal(result.status,'verified',result.error?.message);
 assert.equal(f.components[1].X,340);assert.equal(f.pads[1].X,340);assert.equal(f.attributes[1].X,340);
 assert.deepEqual(f.control.modifications,[f.components[0].PrimitiveId,f.attributes[0].PrimitiveId]);assert.equal(result.preservedChanges.length,3);
 assert.equal(result.verification.writeBaseline.components[1].x,340);assert.equal(result.verification.placements[1].x,340);assert.equal(f.control.saves,1);
});

test('a new harmless unowned silkscreen string survives native apply and saved readback',async t=>{
 const f=await ready(t);f.strings.push(f.primitive({PrimitiveId:'external-silk',Layer:3,Text:'manual note',X:600,Y:100,bbox:{minX:590,maxX:610,minY:98,maxY:102}}));
 const result=await applyLayout({...f.options(),snapshot:f.snapshot,plan:f.proposed});assert.equal(result.status,'verified',result.error?.message);
 assert.equal(f.strings[0].Text,'manual note');assert.ok(result.preservedChanges.some(r=>r.id==='external-silk'));assert.equal(f.control.modifications.includes('external-silk'),false);assert.equal(f.control.saves,1);
});

test('an unowned silkscreen obstacle within the necessary target gap stops every write',async t=>{
 const f=await ready(t);f.strings.push(f.primitive({PrimitiveId:'external-silk',Layer:3,Text:'note',X:117,Y:0,bbox:{minX:116,maxX:118,minY:-1,maxY:1}}));
 const result=await applyLayout({...f.options(),snapshot:f.snapshot,plan:f.proposed});assert.equal(result.status,'apply-failed');assert.match(result.error.message,/LAYOUT_OBSTACLE_GAP/);
 assert.deepEqual(f.control.modifications,[]);assert.equal(f.control.saves,0);
});

test('metadata changes on a written object are detected by native source records even if getters agree',async t=>{
 const f=await ready(t);f.components[0].DisplayOrder=9;
 const result=await applyLayout({...f.options(),snapshot:f.snapshot,plan:f.proposed});assert.equal(result.status,'apply-failed');assert.match(result.error.message,/SOURCE_WRITE_DEPENDENCY_CHANGED/);
 assert.deepEqual(f.control.modifications,[]);assert.equal(f.control.saves,0);
});

test('source metadata changing during apply prevents saving despite matching target poses',async t=>{
 const f=await ready(t);f.control.afterComponentModify=()=>{f.attributes[1].DisplayOrder=2;};
 const result=await applyLayout({...f.options(),snapshot:f.snapshot,plan:f.proposed});assert.equal(result.applyState,'apply-verification-failed');assert.equal(f.control.saves,0);
 const report=JSON.parse(await readFile(join(result.reportDir,'layout-apply-result.json')));assert.ok(report.response.result.after.issues.some(i=>i.code==='SOURCE_READBACK_CHANGED'&&i.id===f.attributes[1].PrimitiveId));
});

for(const [kind,oldNet,newNet] of [['owned','N1','N0'],['standalone','N1','N0'],['owned','N0','N1'],['standalone','N0','N1'],['owned','','N0'],['owned','N0','']])test(`${kind} pad ${oldNet||'unassigned'} -> ${newNet||'unassigned'} changes related net membership and stops before writes`,async t=>{
 const f=await fixture(t),pad=f.pads[kind==='owned'?1:2];pad.Net=oldNet;
 const snapshot=await inspectLayout(f.options()),plan=f.plan(snapshot);pad.Net=newNet;
 const pre=await preflightLayout({...f.options(),snapshot,plan});assert.equal(pre.status,'preflight-blocked');assert.match(pre.error.message,/PAD_BASELINE_CHANGED/);
 const result=await applyLayout({...f.options(),snapshot,plan});assert.equal(result.status,'apply-failed');assert.equal(result.applyState,'blocked');assert.match(result.error.message,/PAD_BASELINE_CHANGED/);
 assert.deepEqual(f.control.modifications,[]);assert.equal(f.control.saves,0);
});

test('swapping outside related and unrelated pad nets cannot hide a new related endpoint',async t=>{
 const f=await ready(t);f.pads[1].Net='N0';f.pads[2].Net='N1';
 const result=await applyLayout({...f.options(),snapshot:f.snapshot,plan:f.proposed});assert.equal(result.status,'apply-failed');assert.match(result.error.message,/PAD_BASELINE_CHANGED component-1\/pad-1/);
 assert.deepEqual(f.control.modifications,[]);assert.equal(f.control.saves,0);
});

for(const change of ['add','remove','replace'])test('related pad '+change+' is rejected by the complete native inventory before writes',async t=>{
 const f=await ready(t);
 if(change==='add')f.pads.push(f.primitive({...f.pads[2],PrimitiveId:'new-related-pad',PadNumber:'TP2',X:700,bbox:{minX:698,maxX:702,minY:-2,maxY:2}}));
 if(change==='remove')f.pads.splice(2,1);
 if(change==='replace')f.pads[2].PrimitiveId='replacement-related-pad';
 const pre=await preflightLayout({...f.options(),snapshot:f.snapshot,plan:f.proposed});assert.equal(pre.status,'preflight-blocked');assert.match(pre.error.message,/LIVE_OBJECT_IDS pads/);
 const result=await applyLayout({...f.options(),snapshot:f.snapshot,plan:f.proposed});assert.equal(result.status,'apply-failed');assert.match(result.error.message,/LIVE_OBJECT_IDS pads/);
 assert.deepEqual(f.control.modifications,[]);assert.equal(f.control.saves,0);
});

test('an outside pad changing between unrelated nets is retained through apply, save and readback',async t=>{
 const f=await ready(t);f.pads[1].Net='N2';
 const pre=await preflightLayout({...f.options(),snapshot:f.snapshot,plan:f.proposed});assert.equal(pre.status,'preflight-passed');
 const result=await applyLayout({...f.options(),snapshot:f.snapshot,plan:f.proposed});assert.equal(result.status,'verified',result.error?.message);assert.equal(result.saved,true);
 assert.equal(f.pads[1].Net,'N2');assert.equal(result.verification.pads.find(p=>p.id===f.pads[1].PrimitiveId).net,'N2');assert.equal(result.verification.writeBaseline.pads[1].net,'N2');
 assert.ok(result.preservedChanges.some(c=>c.id===f.pads[1].PrimitiveId&&c.fields.includes('Net')));assert.deepEqual(f.control.modifications,[f.components[0].PrimitiveId,f.attributes[0].PrimitiveId]);assert.equal(f.control.saves,1);
});
