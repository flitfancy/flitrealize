import {withTimeout} from '../helpers/async-resources.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fineFixture } from '../helpers/pcb-fine-recovery-fixture.mjs';
import { applyFineLayout, resumeFineSave, verifyFineLayout } from '../../scripts/pcb-layout/fine/workflow.mjs';
import { readLayoutApplyReceipt } from '../../scripts/pcb-layout/pcb-layout-execution.mjs';
import { applyLayout } from '../../scripts/pcb-layout/pcb-layout-execution.mjs';
import { verifyFineReadback } from '../../scripts/pcb-layout/fine/audit.mjs';
import { buildGeometryViews } from '../../scripts/pcb-layout/pcb-layout-geometry-views.mjs';
import { main as publicMain } from '../../scripts/pcb-layout.mjs';

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function apply(fixture) { return applyFineLayout({ ...fixture.input, routingReceipt: fixture.routingReceipt, options: fixture.f.options() }); }

test('normal application binds offline route evidence to the immutable native receipt and saves once', async t => {
  const fixture = await fineFixture(t, { requiredRouting: true }), { f } = fixture, result = await apply(fixture);
  assert.equal(result.status, 'verified'); assert.equal(result.state.saved, true); assert.equal(f.control.saves, 1);
  const receipt = await read(result.execution.resumeSaveReport), evidence = receipt.acceptanceEvidence;
  assert.equal(evidence.routing.required, true); assert.equal(evidence.candidateHash, fixture.solved.candidate.candidateHash);
  const route = await read(path.join(f.projectRoot, evidence.routing.receipt.file));
  assert.equal(route.status, 'passed'); assert.equal(route.nativeWrites, 0);
  assert.equal(f.routing.Line.length, 0); assert.equal(f.routing.Via.length, 0);
  const metadata = await readLayoutApplyReceipt({ ...f.options(), resumeSave: result.execution.resumeSaveReport }, { readOnly: true });
  assert.equal(metadata.save.saved, true);
});

test('known save failure reuses its bound route without repeating apply or route search', async t => {
  const fixture = await fineFixture(t, { requiredRouting: true }), { f } = fixture;
  f.control.saveResult = false;
  const first = await apply(fixture), original = await fs.readFile(first.execution.resumeSaveReport, 'utf8'), modifications = f.control.modifications.length;
  assert.equal(first.status, 'save-failed'); assert.equal(first.state.saved, false);
  f.control.saveResult = true;
  const recovered = await resumeFineSave({ ...fixture.input, options: f.options(), resumeSave: first.execution.resumeSaveReport });
  assert.equal(recovered.status, 'verified'); assert.equal(recovered.state.saved, true);
  assert.equal(f.calls.filter(p => p === 'apply').length, 1); assert.equal(f.control.modifications.length, modifications);
  assert.deepEqual(f.calls.slice(-3), ['verify', 'save', 'verify']);
  assert.equal(await fs.readFile(first.execution.resumeSaveReport, 'utf8'), original);
  const metadata = await readLayoutApplyReceipt({ ...f.options(), resumeSave: first.execution.resumeSaveReport }, { readOnly: true });
  assert.equal(metadata.save.saved, true, 'later recovery save is found through the shared completed marker');
});

test('saved but failed readback uses only verify, preserves saving fact, and cannot save again', async t => {
  const fixture = await fineFixture(t), { f } = fixture;
  f.control.afterSave = () => { f.pads[1].Net = 'unexpected'; };
  const first = await apply(fixture);
  assert.equal(first.status, 'verify-after-save-failed'); assert.equal(first.state.saved, true);
  const history = await fs.readFile(first.execution.reportFile, 'utf8'), before = f.calls.length;
  const failed = await verifyFineLayout({ ...fixture.input, options: f.options(), receiptFile: first.execution.resumeSaveReport });
  assert.equal(failed.status, 'verification-failed'); assert.equal(failed.state.saved, true); assert.equal(failed.state.nativeWrites, 0);
  assert.deepEqual(f.calls.slice(before), ['verify']); assert.equal(f.control.saves, 1);
  f.pads[1].Net = fixture.inputs.snapshot.pads[1].net;
  const checked = await verifyFineLayout({ ...fixture.input, options: f.options(), receiptFile: first.execution.reportFile });
  assert.equal(checked.status, 'verified'); assert.equal(checked.state.saved, true); assert.equal(f.control.saves, 1);
  assert.equal(await fs.readFile(first.execution.reportFile, 'utf8'), history, 'read-only verification does not rewrite history');
  await assert.rejects(resumeFineSave({ ...fixture.input, options: f.options(), resumeSave: first.execution.resumeSaveReport }), /LAYOUT_ALREADY_SAVED/);
});

test('unknown save remains unknown after matching read-only verification, and its marker stays intact', async t => {
  const fixture = await fineFixture(t, { requiredRouting: true }), { f } = fixture;
  f.control.beforePhase = ({ phase }) => { if (phase === 'save') throw Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }); };
  const first = await apply(fixture), marker = await fs.readFile(first.execution.saveAttemptFile, 'utf8');
  assert.equal(first.state.saved, null); assert.equal(first.status, 'outcome-unknown');
  f.control.beforePhase = null;
  const checked = await verifyFineLayout({ ...fixture.input, options: f.options(), receiptFile: first.execution.resumeSaveReport });
  assert.equal(checked.status, 'verified'); assert.equal(checked.state.saved, null);
  assert.equal(checked.state.savePending, true); assert.equal(checked.state.saveUnsettled, true);
  assert.equal(await fs.readFile(first.execution.saveAttemptFile, 'utf8'), marker);
  await assert.rejects(resumeFineSave({ ...fixture.input, options: f.options(), resumeSave: first.execution.resumeSaveReport }), /SAVE_RECOVERY_UNRESOLVED/);
  assert.equal(f.calls.filter(p => p === 'apply').length, 1); assert.equal(f.calls.filter(p => p === 'save').length, 1);
});

test('unknown apply has no successful receipt and cannot enter either recovery or verification', async t => {
  const fixture = await fineFixture(t), { f } = fixture;
  f.control.beforePhase = ({ phase }) => { if (phase === 'apply') throw Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }); };
  const first = await apply(fixture), calls = f.calls.length;
  assert.equal(first.state.saved, null); assert.equal(first.execution.applyState, 'unknown');
  for (const [run, key] of [[resumeFineSave, 'resumeSave'], [verifyFineLayout, 'receiptFile']]) await assert.rejects(run({ ...fixture.input, options: f.options(), [key]: first.execution.reportFile }), /SUCCESSFUL_APPLY_REQUIRED/);
  assert.equal(f.calls.length, calls); assert.equal(f.control.saves, 0);
});

test('a changed live source blocks known save recovery before any save or apply', async t => {
  const fixture = await fineFixture(t, { requiredRouting: true }), { f } = fixture;
  f.control.saveResult = false; const first = await apply(fixture), saves = f.control.saves, changes = f.control.modifications.length;
  f.pads[1].Net = 'manual-edit'; f.control.saveResult = true;
  const recovered = await resumeFineSave({ ...fixture.input, options: f.options(), resumeSave: first.execution.resumeSaveReport });
  assert.equal(recovered.status, 'verify-failed'); assert.equal(recovered.state.saved, false);
  assert.equal(f.control.saves, saves); assert.equal(f.control.modifications.length, changes);
});

test('changed route evidence cannot be replaced by an explicit fresh object during recovery', async t => {
  const fixture = await fineFixture(t, { requiredRouting: true }), { f } = fixture;
  f.control.saveResult = false; const first = await apply(fixture), receipt = await read(first.execution.resumeSaveReport);
  const file = path.join(f.projectRoot, receipt.acceptanceEvidence.routing.receipt.file), route = await read(file);
  route.copper.segments = []; await fs.writeFile(file, JSON.stringify(route));
  const count = f.calls.length;
  for (const supplied of [undefined, fixture.routingReceipt]) await assert.rejects(resumeFineSave({ ...fixture.input, routingReceipt: supplied, options: f.options(), resumeSave: first.execution.resumeSaveReport }), /FINE_ROUTING_EVIDENCE_CHANGED/);
  assert.equal(f.calls.length, count); assert.equal(f.control.saves, 1);
});

test('candidate, request and native acceptance metadata changes stop before transport', async t => {
  const fixture = await fineFixture(t, { requiredRouting: true }), { f } = fixture;
  f.control.saveResult = false; const first = await apply(fixture), count = f.calls.length;
  const candidate = structuredClone(fixture.solved.candidate); candidate.plan.components[0].x += 1;
  await assert.rejects(resumeFineSave({ ...fixture.input, candidate, options: f.options(), resumeSave: first.execution.resumeSaveReport }), /FINE_CANDIDATE_CHANGED/);
  const request = structuredClone(fixture.request); request.routing.policy.nets[0].defaultWireWidthMil += 1;
  await assert.rejects(resumeFineSave({ ...fixture.input, request, options: f.options(), resumeSave: first.execution.resumeSaveReport }), /FINE_INPUTS_CHANGED/);
  const native = await read(first.execution.resumeSaveReport); native.acceptanceEvidence.routing.receipt.hash = 'changed';
  await fs.writeFile(first.execution.resumeSaveReport, JSON.stringify(native));
  await assert.rejects(resumeFineSave({ ...fixture.input, options: f.options(), resumeSave: first.execution.resumeSaveReport }), /APPLY_RECEIPT_MISMATCH/);
  assert.equal(f.calls.length, count);
});

test('concurrent recovery keeps the shared save marker and blocks a second request', async t => {
  const fixture = await fineFixture(t), { f } = fixture;
  f.control.saveResult = false; const first = await apply(fixture); f.control.saveResult = true;
  let release, entered; const pending = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  f.control.beforePhase = async ({ phase }) => { if (phase === 'verify') { entered(); await pending; } };
  const recovering = resumeFineSave({ ...fixture.input, options: f.options(), resumeSave: first.execution.resumeSaveReport });
  let done;
  try {
    await withTimeout(Promise.race([ready,recovering.then(()=>{throw Error('Recovery finished before the fixture checkpoint');})]),'Recovery checkpoint');
  const second = await resumeFineSave({ ...fixture.input, options: f.options(), resumeSave: first.execution.resumeSaveReport });
  assert.equal(second.status, 'blocked'); assert.equal(second.execution.error.code, 'SAVE_RECOVERY_UNRESOLVED');
  } finally { release(); done = await withTimeout(recovering,'Recovery completion'); }
  assert.equal(done.state.saved, true); assert.equal(f.control.saves, 2); assert.equal(f.calls.filter(p => p === 'apply').length, 1);
});

test('the whole batch still fails when another pad changes after the first component moved', async t => {
  const fixture = await fineFixture(t), { f } = fixture;
  f.control.afterComponentModify = () => { f.pads[1].Net = 'unexpected'; };
  const result = await apply(fixture), count = f.calls.length;
  assert.equal(f.components[0].X, fixture.solved.candidate.plan.components[0].x);
  assert.notEqual(result.status, 'verified'); assert.equal(f.control.saves, 0);
  await assert.rejects(resumeFineSave({ ...fixture.input, options: f.options(), resumeSave: result.execution.reportFile }), /SUCCESSFUL_APPLY_REQUIRED/);
  assert.equal(f.calls.length, count);
});

test('readback uses equivalent signed angles while a real pose or net difference remains a failure', async t => {
  const fixture = await fineFixture(t), model = fixture.solved.prepared.model, plan = structuredClone(fixture.solved.candidate.plan);
  for (const component of plan.components) component.rotation = -90;
  for (const label of plan.labels) label.rotation = -90;
  const geometry = buildGeometryViews(model.geometryModel, plan.components, plan.labels, plan.testPads);
  const actual = { placements: plan.components.map(p => ({ ...p, rotation: 270 })), labels: plan.labels.map(p => ({ ...p, rotation: 270 })), pads: model.snapshot.pads.map(p => ({ ...p, bbox: geometry.pads.find(g => g.id === p.id).bbox })), outlines: model.snapshot.outlines, routing: model.snapshot.routing };
  assert.equal(verifyFineReadback(model, plan, actual).verified, true);
  actual.placements[0].rotation = 180; assert.throws(() => verifyFineReadback(model, plan, actual), /FINE_READBACK_COMPONENT/);
  actual.placements[0].rotation = 270; actual.pads[0].net = 'changed'; assert.throws(() => verifyFineReadback(model, plan, actual), /FINE_READBACK_PAD/);
});

test('fine readback uses circular tolerance at zero and still rejects real or invalid angles',async t=>{
  const f=await fineFixture(t),model=f.solved.prepared.model,plan=structuredClone(f.solved.candidate.plan);
  const geometry=buildGeometryViews(model.geometryModel,plan.components,plan.labels,plan.testPads);
  const actual={placements:plan.components.map(c=>({...c,rotation:359.999999})),labels:plan.labels.map(l=>({...l,rotation:359.999999})),pads:model.snapshot.pads.map(p=>({...p,bbox:geometry.pads.find(g=>g.id===p.id).bbox})),outlines:model.snapshot.outlines,routing:model.snapshot.routing};
  assert.ok(plan.components.every(c=>c.rotation===0)&&plan.labels.every(l=>l.rotation===0));
  assert.equal(verifyFineReadback(model,plan,actual).verified,true);
  for(const value of [.03,null,NaN]){actual.placements[0].rotation=value;assert.throws(()=>verifyFineReadback(model,plan,actual),/FINE_READBACK_COMPONENT/);}
  actual.placements[0].rotation=0;actual.labels[0].rotation=.03;
  assert.throws(()=>verifyFineReadback(model,plan,actual),/FINE_READBACK_LABEL/);
});

test('public stages reuse application.json and verify without apply/save; legacy shim keeps the same help', async t => {
  const fixture = await fineFixture(t, { requiredRouting: true }), { f } = fixture, common = { log: () => {}, executionOptions: { transport: f.transport } };
  const previousHome = process.env.FLITREALIZE_HOME;
  process.env.FLITREALIZE_HOME = path.join(f.projectRoot, 'unregistered-mock-host');
  t.after(() => { if (previousHome === undefined) delete process.env.FLITREALIZE_HOME; else process.env.FLITREALIZE_HOME = previousHome; });
  f.control.saveResult = false;
  const first = await publicMain(['fine', '--stage', 'apply', '--project-root', f.projectRoot, '--from', fixture.solveDirectory, '--window-id', 'window', '--routing-receipt', path.join(f.projectRoot, 'route/fine-routing-receipt.json'), '--output', 'application'], common);
  assert.equal(first.state.saved, false); process.exitCode = 0;
  f.control.saveResult = true;
  const recovered = await publicMain(['--mode', 'fine', '--stage', 'resume-save', '--project-root', f.projectRoot, '--from', fixture.solveDirectory, '--window-id', 'window', '--resume-save', 'application/application.json', '--output', 'recovery'], common);
  assert.equal(recovered.state.saved, true);
  const count = f.calls.length;
  const verified = await publicMain(['fine', '--stage', 'verify', '--project-root', f.projectRoot, '--from', fixture.solveDirectory, '--window-id', 'window', '--receipt', 'recovery/application.json', '--output', 'verification'], common);
  assert.equal(verified.state.saved, true); assert.equal(verified.state.nativeWrites, 0); assert.deepEqual(f.calls.slice(count), ['verify']);
  assert.equal((await read(path.join(f.projectRoot, 'verification/verification.json'))).kind, 'flitrealize.fine-layout.verification');
  assert.equal(f.calls.filter(p => p === 'apply').length, 1); assert.equal(f.control.saves, 2);
});

test('matching read-only geometry does not turn a known failed save into success', async t => {
  const fixture = await fineFixture(t), { f } = fixture;
  f.control.saveResult = false; const first = await apply(fixture);
  const verified = await verifyFineLayout({ ...fixture.input, options: f.options(), receiptFile: first.execution.resumeSaveReport });
  assert.equal(verified.status, 'verified'); assert.equal(verified.state.saved, false); assert.equal(f.control.saves, 1);
});

test('legacy immutable receipts require explicit route proof and keep their original marker identity', async t => {
  const fixture = await fineFixture(t, { requiredRouting: true }), { f } = fixture;
  f.control.saveResult = false;
  const first = await applyFineLayout({ ...fixture.input, routingReceipt: fixture.routingReceipt, options: f.options(), execution: options => applyLayout({ ...options, acceptanceEvidence: undefined }) });
  const oldBytes = await fs.readFile(first.execution.resumeSaveReport, 'utf8');
  assert.equal((await read(first.execution.resumeSaveReport)).acceptanceEvidence, undefined);
  await assert.rejects(resumeFineSave({ ...fixture.input, options: f.options(), resumeSave: first.execution.resumeSaveReport }), /FINE_REQUIRED_ROUTING_NOT_VERIFIED/);
  f.control.saveResult = true;
  const recovered = await resumeFineSave({ ...fixture.input, routingReceipt: fixture.routingReceipt, options: f.options(), resumeSave: first.execution.resumeSaveReport });
  assert.equal(recovered.state.saved, true); assert.equal(f.calls.filter(p => p === 'apply').length, 1);
  assert.equal(await fs.readFile(first.execution.resumeSaveReport, 'utf8'), oldBytes);
});

test('read-only target mismatch stays failed and does not erase an already saved fact', async t => {
  const fixture = await fineFixture(t), { f } = fixture, first = await apply(fixture), count = f.control.modifications.length;
  f.control.document = { ...f.control.document, uuid: 'different-target' };
  const checked = await verifyFineLayout({ ...fixture.input, options: f.options(), receiptFile: first.execution.resumeSaveReport });
  assert.equal(checked.status, 'verification-failed'); assert.equal(checked.state.saved, true);
  assert.equal(f.control.saves, 1); assert.equal(f.control.modifications.length, count);
});

test('a later unknown save remains null when another recovery is blocked by the existing marker', async t => {
  const fixture = await fineFixture(t), { f } = fixture;
  f.control.saveResult = false; const first = await apply(fixture);
  f.control.beforePhase = ({ phase }) => { if (phase === 'save') throw Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }); };
  const unknown = await resumeFineSave({ ...fixture.input, options: f.options(), resumeSave: first.execution.resumeSaveReport });
  assert.equal(unknown.state.saved, null);
  f.control.beforePhase = null;
  const blocked = await resumeFineSave({ ...fixture.input, options: f.options(), resumeSave: first.execution.resumeSaveReport });
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.state.saved, null); assert.equal(blocked.execution.saveState, 'unknown');
  assert.equal(f.control.saves, 1); assert.equal(f.calls.filter(p => p === 'save').length, 2);
});

test('non-geometric source changes after save stay failed verification with the original save fact', async t => {
  const fixture = await fineFixture(t), { f } = fixture;
  f.control.afterSave = () => { f.attributes[0].DisplayOrder = 2; };
  const first = await apply(fixture);
  assert.equal(first.status, 'verify-after-save-failed'); assert.equal(first.state.saved, true);
  assert.equal(f.components[0].X, fixture.solved.candidate.plan.components[0].x);
  const checked = await verifyFineLayout({ ...fixture.input, options: f.options(), receiptFile: first.execution.resumeSaveReport });
  assert.equal(checked.status, 'verification-failed'); assert.equal(checked.state.saved, true);
  assert.match(checked.verification.error.message, /SOURCE_CHANGED_RECONCILE/); assert.equal(f.control.saves, 1);
});

test('missing bound route evidence blocks both recovery and read-only acceptance before transport', async t => {
  const fixture = await fineFixture(t, { requiredRouting: true }), { f } = fixture;
  f.control.saveResult = false; const first = await apply(fixture), receipt = await read(first.execution.resumeSaveReport);
  await fs.unlink(path.join(f.projectRoot, receipt.acceptanceEvidence.routing.receipt.file));
  const count = f.calls.length;
  await assert.rejects(resumeFineSave({ ...fixture.input, routingReceipt: fixture.routingReceipt, options: f.options(), resumeSave: first.execution.resumeSaveReport }), /FINE_ROUTING_EVIDENCE_UNAVAILABLE/);
  await assert.rejects(verifyFineLayout({ ...fixture.input, options: f.options(), receiptFile: first.execution.resumeSaveReport }), /FINE_ROUTING_EVIDENCE_UNAVAILABLE/);
  assert.equal(f.calls.length, count); assert.equal(f.control.saves, 1);
});

test('the latest bound workflow supplies the saved fact and blocks resaving even without its cache marker', async t => {
  const fixture = await fineFixture(t), { f } = fixture;
  f.control.saveResult = false; const first = await apply(fixture); f.control.saveResult = true;
  const recovered = await resumeFineSave({ ...fixture.input, options: f.options(), resumeSave: first.execution.resumeSaveReport });
  const wrapper = path.join(f.projectRoot, 'recovered-application.json'); await fs.writeFile(wrapper, JSON.stringify(recovered));
  const pending = recovered.execution.saveAttemptFile, completed = pending.replace(/\.pending\.json$/, '.saved.json');
  await fs.unlink(completed);
  const checked = await verifyFineLayout({ ...fixture.input, options: f.options(), receiptFile: wrapper });
  assert.equal(checked.state.saved, true); assert.equal(checked.status, 'verified');
  await assert.rejects(resumeFineSave({ ...fixture.input, options: f.options(), resumeSave: wrapper }), /LAYOUT_ALREADY_SAVED/);
  assert.equal(f.control.saves, 2); assert.equal(f.calls.filter(p => p === 'apply').length, 1);
});

function outsideEdit(f){const l=f.attributes[1];l.X+=5;l.bbox.minX+=5;l.bbox.maxX+=5;l.DisplayOrder=7;return l.X;}
test('known failed saving resumes against the actual write baseline and retains outside edits',async t=>{
 const fixture=await fineFixture(t),{f}=fixture,x=outsideEdit(f);f.control.saveResult=false;
 const first=await apply(fixture);assert.equal(first.status,'save-failed');assert.ok(first.preservedChanges.some(c=>c.id===f.attributes[1].PrimitiveId));
 const receipt=await read(first.execution.resumeSaveReport),original=await fs.readFile(first.execution.resumeSaveReport,'utf8'),changes=f.control.modifications.length;
 assert.equal(receipt.snapshot.items[1].original.x,x-5);assert.equal(receipt.writeBaseline.items[1].original.x,x);
 f.control.saveResult=true;const resumed=await resumeFineSave({...fixture.input,options:f.options(),resumeSave:first.execution.resumeSaveReport});
 assert.equal(resumed.status,'verified',resumed.execution.error?.message);assert.equal(resumed.state.saved,true);assert.equal(f.attributes[1].X,x);assert.equal(f.attributes[1].DisplayOrder,7);
 assert.equal(f.control.modifications.length,changes);assert.deepEqual(f.calls.slice(-3),['verify','save','verify']);assert.equal(await fs.readFile(first.execution.resumeSaveReport,'utf8'),original);
});

test('partial application retains the outside baseline but cannot obtain a successful recovery receipt',async t=>{
 const fixture=await fineFixture(t),{f}=fixture,x=outsideEdit(f);f.control.failModifyId=f.attributes[0].PrimitiveId;
 const first=await apply(fixture);assert.equal(first.execution.applyState,'partial-failed');assert.equal(f.attributes[1].X,x);assert.equal(f.attributes[1].DisplayOrder,7);assert.equal(f.control.saves,0);
 const count=f.calls.length;await assert.rejects(resumeFineSave({...fixture.input,options:f.options(),resumeSave:first.execution.reportFile}),/SUCCESSFUL_APPLY_REQUIRED/);assert.equal(f.calls.length,count);
});

for(const phase of ['apply','save'])test('an unknown '+phase+' after real Mock execution preserves edits and never replays',async t=>{
 const fixture=await fineFixture(t),{f}=fixture,x=outsideEdit(f);
 const transport=async request=>{const reply=await f.transport(request);if(request.phase===phase)throw Object.assign(Error('lost reply after execution'),{code:'ETIMEDOUT'});return reply;};
 const first=await applyFineLayout({...fixture.input,options:{...f.options(),transport}});
 assert.equal(first.status,'outcome-unknown');assert.equal(first.state.saved,null);assert.equal(f.components[0].X,fixture.solved.candidate.plan.components[0].x);assert.equal(f.attributes[1].X,x);assert.equal(f.attributes[1].DisplayOrder,7);
 const changes=f.control.modifications.length,saves=f.control.saves,calls=f.calls.length;
 await assert.rejects(resumeFineSave({...fixture.input,options:f.options(),resumeSave:first.execution.resumeSaveReport??first.execution.reportFile}),phase==='apply'?/SUCCESSFUL_APPLY_REQUIRED/:/SAVE_RECOVERY_UNRESOLVED/);
 assert.equal(f.control.modifications.length,changes);assert.equal(f.control.saves,saves);assert.equal(f.calls.length,calls);
 if(phase==='save'){const checked=await verifyFineLayout({...fixture.input,options:f.options(),receiptFile:first.execution.resumeSaveReport});assert.equal(checked.status,'verified');assert.equal(checked.state.saved,null);assert.equal(checked.state.saveUnsettled,true);assert.equal(f.control.saves,1);}
});
