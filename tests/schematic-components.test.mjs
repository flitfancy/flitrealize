import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runComponentBatch } from '../scripts/schematic-components.mjs';
import { batchFixture, mockComponents } from './helpers/component-batch-fixture.mjs';
import { loadAction } from './helpers/action-harness.mjs';

const options = fixture => ({ projectRoot: fixture.root, inputFile: fixture.inputFile, invoke: fixture.invoke });
const resume = (fixture, runDir, apply = true) => runComponentBatch({ projectRoot: fixture.root, resume: runDir, invoke: fixture.invoke, apply });
const journal = async runDir => JSON.parse(await readFile(join(runDir, 'transaction.json'), 'utf8'));

test('plan uses real audit/binding/layout Actions, backs up source and never mutates EDA', async t => {
  const f = await batchFixture(t);
  const result = await runComponentBatch(options(f));
  assert.equal(result.status, 'planned');
  assert.equal(result.pendingCount, 5);
  assert.equal(f.eda.createCount, 0);
  assert.equal(f.eda.saveCount, 0);
  assert(f.eda.calls.some(c => c.action === 'schematic-resolve-bindings'));
  assert(f.eda.calls.some(c => c.action === 'schematic-layout'));
  assert(await readFile(join(result.runDir, 'before.esch'), 'utf8'));
});

test('apply validates representative, places chunks, saves separately and repeated resume is a no-op', async t => {
  const f = await batchFixture(t, 8);
  const result = await runComponentBatch({ ...options(f), apply: true });
  assert.equal(result.status, 'placed-saved');
  assert.equal(result.placedCount, 8);
  assert.equal(f.eda.saveCount, 1);
  assert.equal(f.eda.drcCount, 0, 'unconnected component placement must not claim whole schematic DRC');
  const batches = (await journal(result.runDir)).attempts.filter(a => a.action === 'schematic-component-place' && a.mode === 'apply');
  assert.deepEqual(batches.map(a => a.result.created.length), [1, 3, 3, 1]);
  const again = await resume(f, result.runDir);
  assert.equal(again.status, 'already-completed');
  assert.equal(f.eda.createCount, 8);
  assert.equal(f.eda.saveCount, 1);
});

test('known partial failure resumes only missing items and retains earlier chunk IDs', async t => {
  const f = await batchFixture(t, 6);
  f.eda.failCreateAt = 4;
  let runDir;
  await assert.rejects(runComponentBatch({ ...options(f), apply: true }), error => { runDir = error.runDir; return error.code === 'ACTION_NOT_COMPLETED'; });
  assert.deepEqual(f.eda.records.map(row => row.designator), ['R1', 'R2', 'R3']);
  const preserved = f.eda.records.map(row => row.id);
  f.eda.failCreateAt = null;
  const result = await resume(f, runDir);
  assert.equal(result.placedCount, 6);
  assert.deepEqual(f.eda.records.slice(0, 3).map(row => row.id), preserved);
  assert.equal(new Set(f.eda.records.map(row => row.designator)).size, 6);
});

test('a lost reply never triggers a blind retry even if a component exists', async t => {
  const f = await batchFixture(t);
  let runDir;
  const invoke = async (...args) => {
    const result = await f.invoke(...args);
    if (args[0] === 'schematic-component-place' && args[1].mode === 'apply') throw new Error('reply lost');
    return result;
  };
  await assert.rejects(runComponentBatch({ ...options(f), invoke, apply: true }), error => { runDir = error.runDir; return /reply lost/.test(error.message); });
  const count = f.eda.createCount;
  await assert.rejects(resume(f, runDir), error => error.code === 'IN_FLIGHT_OUTCOME_UNKNOWN');
  await assert.rejects(runComponentBatch({ ...options(f), apply: true }), error => error.code === 'UNFINISHED_BATCH');
  assert.equal(f.eda.createCount, count);
});

test('a completed durable Action report allows recovery after wrapper lost its reply', async t => {
  const f = await batchFixture(t);
  let runDir, interrupted = false;
  const invoke = async (action, input, context) => {
    const result = await f.invoke(action, input, context);
    if (!interrupted && action === 'schematic-component-place' && input.mode === 'apply') {
      interrupted = true;
      await writeFile(context.reportFile, JSON.stringify({ action, mode: input.mode, response: { success: true, result } }));
      throw new Error('wrapper interrupted after durable result');
    }
    return result;
  };
  await assert.rejects(runComponentBatch({ ...options(f), invoke, apply: true }), error => { runDir = error.runDir; return true; });
  assert.equal(f.eda.records.length, 1);
  await resume(f, runDir);
  assert.equal(f.eda.createCount, 5);
});

test('save failure retains all placement receipts; resume saves without recreating components', async t => {
  const f = await batchFixture(t);
  f.eda.saveResult = false;
  let runDir;
  await assert.rejects(runComponentBatch({ ...options(f), apply: true }), error => { runDir = error.runDir; return error.code === 'ACTION_NOT_COMPLETED'; });
  assert.equal(f.eda.records.length, 5);
  f.eda.saveResult = true;
  const result = await resume(f, runDir);
  assert.equal(result.saved, true);
  assert.equal(f.eda.createCount, 5);
  assert.equal(f.eda.saveCount, 2);
});

test('changed target or input blocks apply after a plan', async t => {
  const f = await batchFixture(t);
  const planned = await runComponentBatch(options(f));
  f.eda.document.parentProjectUuid = 'another-project';
  await assert.rejects(resume(f, planned.runDir), error => error.code === 'TARGET_MISMATCH');
  f.eda.document.parentProjectUuid = 'project-batch';
  await writeFile(f.inputFile, JSON.stringify({ ...f.input, batchSize: 2 }));
  await assert.rejects(resume(f, planned.runDir), error => error.code === 'INPUT_CHANGED');
  assert.equal(f.eda.createCount, 0);
});

test('manual geometry changes or unknown new objects are not adopted or overwritten', async t => {
  const f = await batchFixture(t);
  const done = await runComponentBatch({ ...options(f), apply: true });
  f.eda.records[0].x += 10;
  await assert.rejects(resume(f, done.runDir), error => error.code === 'CREATED_COMPONENT_CHANGED');
  assert.equal(f.eda.saveCount, 1);
  f.eda.records[0].x -= 10;
  f.eda.records.push({ ...f.eda.records[0], id: 'user-object', designator: 'R99' });
  await assert.rejects(resume(f, done.runDir), error => error.code === 'UNACCOUNTED_COMPONENTS');
});

test('read failures are not empty schematics and early designator failures retain ownership', async t => {
  const action = await loadAction('schematic-component-place', 'easyeda-pro');
  const eda = mockComponents();
  eda.readError = true;
  await assert.rejects(action(eda, { mode: 'inspect' }), error => error.code === 'STATE_READ_FAILED');
  eda.readError = false;
  const plan = await action(eda, { mode: 'plan', expectedDocumentUuid: 'sch-batch', expectedProjectUuid: 'project-batch',
    plan: { items: [{ designator: 'R1', libraryUuid: 'lib', uuid: 'dev', x: 0, y: 0 }] } });
  eda.modifyFailure = true;
  const failure = await action(eda, plan.applyRequest);
  assert.equal(failure.status, 'rolled-back');
  assert.equal(failure.createdBeforeFailure.length, 1);
  assert.equal(eda.records.length, 0, 'tracked creation is removed even when assigning designator failed');
});

test('project switch during create does not modify or roll back in the new document', async () => {
  const action = await loadAction('schematic-component-place', 'easyeda-pro');
  const eda = mockComponents();
  const plan = await action(eda, { mode: 'plan', expectedDocumentUuid: 'sch-batch', expectedProjectUuid: 'project-batch',
    plan: { items: [{ designator: 'R1', libraryUuid: 'lib', uuid: 'dev', x: 0, y: 0 }] } });
  eda.afterCreate = () => { eda.document.uuid = 'other'; };
  const result = await action(eda, plan.applyRequest);
  assert.equal(result.status, 'rollback-incomplete');
  assert.equal(eda.records[0].designator, 'AUTO1');
  assert.equal(eda.records.length, 1);
});

test('save reports an unexpected document change instead of successful completion', async () => {
  const action = await loadAction('schematic-save-verify', 'easyeda-pro');
  const eda = mockComponents();
  const planned = await action(eda, { mode: 'plan', expectedDocumentUuid: 'sch-batch', expectedProjectUuid: 'project-batch', runDrc: false });
  eda.afterSave = () => { eda.document.uuid = 'another-document'; };
  const result = await action(eda, planned.applyRequest);
  assert.equal(result.status, 'apply-failed');
  assert(result.issues.some(issue => issue.code === 'SAVE_READBACK_CHANGED'));
});

test('plan cannot overwrite a preexisting designator; rejected inputs do not create components', async t => {
  const f = await batchFixture(t);
  f.eda.records.push({ id: 'old', designator: 'R1', x: 0, y: 0, rotation: 0, mirror: false, addIntoBom: true, addIntoPcb: true, libraryUuid: 'fixture-library', uuid: 'fixture-device' });
  await assert.rejects(runComponentBatch(options(f)), error => error.code === 'DESIGNATOR_ALREADY_EXISTS');
  assert.equal(f.eda.createCount, 0);
  assert.equal(f.eda.records[0].id, 'old');
  assert(!(await readdir(join(f.root, 'evidence'))).includes('.schematic-components.lock'));
});

test('a resume without apply remains EDA read-only', async t => {
  const f = await batchFixture(t);
  f.eda.failCreateAt = 3;
  let runDir;
  await assert.rejects(runComponentBatch({ ...options(f), apply: true }), error => { runDir = error.runDir; return true; });
  const before = f.eda.createCount;
  const result = await resume(f, runDir, false);
  assert.equal(result.status, 'planned');
  assert.equal(result.confirmedCreatedCount, 2);
  assert.equal(f.eda.createCount, before);
  assert.equal(f.eda.saveCount, 0);
});

test('an existing process lock is not silently stolen', async t => {
  const f = await batchFixture(t);
  const planned = await runComponentBatch(options(f));
  await writeFile(join(f.root, 'evidence', '.schematic-components.lock'), '{"pid":123}');
  await assert.rejects(resume(f, planned.runDir), error => error.code === 'BATCH_LOCKED');
  assert.equal(f.eda.createCount, 0);
});

test('source change after completion invalidates old save evidence', async t => {
  const f = await batchFixture(t);
  const done = await runComponentBatch({ ...options(f), apply: true });
  f.eda.note = 'user changed a non-component object';
  await assert.rejects(resume(f, done.runDir), error => error.code === 'COMPLETED_SOURCE_CHANGED');
  assert.equal(f.eda.saveCount, 1);
});

test('a provider returning a preexisting ID cannot cause modification or rollback deletion of that object', async () => {
  const action = await loadAction('schematic-component-place', 'easyeda-pro');
  const eda = mockComponents();
  eda.records.push({ id: 'old-id', designator: 'X1', libraryUuid: 'lib', uuid: 'dev', x: 0, y: 0, rotation: 0, mirror: false, addIntoBom: true, addIntoPcb: true });
  const planned = await action(eda, { mode: 'plan', expectedDocumentUuid: 'sch-batch', expectedProjectUuid: 'project-batch',
    plan: { items: [{ designator: 'R1', libraryUuid: 'lib', uuid: 'dev', x: 0, y: 0 }] } });
  eda.sch_PrimitiveComponent.create = async () => eda.sch_PrimitiveComponent.get('old-id');
  const result = await action(eda, planned.applyRequest);
  assert.equal(result.error.code, 'CREATE_ID_NOT_NEW');
  assert.equal(eda.records.length, 1);
  assert.equal(eda.records[0].designator, 'X1');
});

test('format-only input changes preserve frozen byte evidence and can resume partial placement', async t => {
  const f = await batchFixture(t);
  f.eda.failCreateAt = 3;
  let runDir;
  await assert.rejects(runComponentBatch({ ...options(f), apply: true }), error => { runDir = error.runDir; return true; });
  const original = await journal(runDir);
  const snapshot = await readFile(join(runDir, 'input.snapshot.json'), 'utf8');
  await writeFile(f.inputFile, JSON.stringify(Object.fromEntries(Object.entries(f.input).reverse()), null, 2) + '\n');
  await writeFile(join(f.root, 'contract.json'), JSON.stringify(f.contract, null, 2) + '\n');
  const inspected = await resume(f, runDir, false);
  assert.equal(inspected.status, 'planned');
  assert(inspected.reconciliation.integrity.sources.every(file => file.integrity === 'current' && !file.byteMatch));
  f.eda.failCreateAt = null;
  const done = await resume(f, runDir);
  assert.equal(done.status, 'placed-saved');
  assert.equal(f.eda.records.length, 5);
  assert.deepEqual((await journal(runDir)).sources, original.sources, 'raw fingerprints are not refreshed to hide changes');
  assert.equal(await readFile(join(runDir, 'input.snapshot.json'), 'utf8'), snapshot);
});

test('source and toolchain changes remain inspectable and a settled batch can close for replanning', async t => {
  const f = await batchFixture(t);
  f.eda.failCreateAt = 3;
  let runDir;
  await assert.rejects(runComponentBatch({ ...options(f), apply: true }), error => { runDir = error.runDir; return true; });
  await writeFile(f.inputFile, JSON.stringify({ ...f.input, batchSize: 2 }));
  const old = await journal(runDir);
  old.toolchain[0].sha256 = '0'.repeat(64); // Represents a run made by an older installed script.
  await writeFile(join(runDir, 'transaction.json'), JSON.stringify(old));
  const existing = structuredClone(f.eda.records), beforeCalls = f.eda.calls.length;
  const inspected = await resume(f, runDir, false);
  assert.equal(inspected.status, 'needs-reconciliation');
  assert(inspected.reconciliation.issues.some(issue => issue.code === 'INPUT_CHANGED'));
  assert(inspected.reconciliation.issues.some(issue => issue.code === 'TOOLCHAIN_CHANGED'));
  assert(f.eda.calls.slice(beforeCalls).some(call => call.mode === 'inspect'));
  assert.equal(inspected.saved, null);
  assert.equal(inspected.saveChecked, false);
  await assert.rejects(resume(f, runDir), error => error.code === 'INPUT_CHANGED');
  await writeFile(f.inputFile, JSON.stringify(f.input));
  await assert.rejects(resume(f, runDir), error => error.code === 'TOOLCHAIN_CHANGED');
  const closed = await runComponentBatch({ projectRoot: f.root, resume: runDir, invoke: f.invoke, close: true });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.reconciliation.canResume, false);
  assert.equal(closed.saved, null);
  assert.deepEqual(f.eda.records, existing);
  assert.equal(f.eda.saveCount, 0);
  assert(!(await readdir(join(f.root, 'evidence'))).includes('.schematic-components-active.json'));
  await assert.rejects(resume(f, runDir), error => error.code === 'BATCH_CLOSED');
  await writeFile(f.inputFile, JSON.stringify({ ...f.input, designators: ['R3', 'R4', 'R5'], batchSize: 2 }));
  assert.equal((await runComponentBatch(options(f))).pendingCount, 3);
});

test('unknown writes are reported read-only and cannot be closed even when sources change', async t => {
  const f = await batchFixture(t);
  const invoke = async (...args) => {
    const result = await f.invoke(...args);
    if (args[0] === 'schematic-component-place' && args[1].mode === 'apply') throw new Error('reply lost');
    return result;
  };
  let runDir;
  await assert.rejects(runComponentBatch({ ...options(f), invoke, apply: true }), error => { runDir = error.runDir; return true; });
  await writeFile(f.inputFile, '{invalid changed input');
  const inspected = await resume(f, runDir, false);
  assert.equal(inspected.reconciliation.canClose, false);
  assert(inspected.reconciliation.issues.some(issue => issue.code === 'IN_FLIGHT_OUTCOME_UNKNOWN'));
  assert(inspected.reconciliation.issues.some(issue => issue.code === 'UNACCOUNTED_COMPONENTS'));
  await assert.rejects(runComponentBatch({ projectRoot: f.root, resume: runDir, invoke: f.invoke, close: true }), error => error.code === 'IN_FLIGHT_OUTCOME_UNKNOWN');
  assert((await readdir(join(f.root, 'evidence'))).includes('.schematic-components-active.json'));
  assert.equal(f.eda.createCount, 1);
});

test('unrelated baseline moves and owned changes are reported without adopting or overwriting objects', async t => {
  const f = await batchFixture(t);
  const old = { id: 'old', designator: 'R99', x: 9000, y: 9000, rotation: 0, mirror: false, addIntoBom: true, addIntoPcb: true, libraryUuid: 'lib', uuid: 'dev' };
  f.eda.records.push(old);
  const planned = await runComponentBatch(options(f));
  old.x += 100;
  const inspected = await resume(f, planned.runDir, false);
  assert.equal(inspected.status, 'needs-reconciliation');
  assert.equal(inspected.reconciliation.issues[0].code, 'BASELINE_CHANGED');
  assert.equal(inspected.reconciliation.issues[0].components[0].current.x, old.x);
  await assert.rejects(resume(f, planned.runDir), error => error.code === 'BASELINE_CHANGED');
  const closed = await runComponentBatch({ projectRoot: f.root, resume: planned.runDir, invoke: f.invoke, close: true });
  assert.equal(closed.status, 'closed');
  assert.deepEqual(f.eda.records, [old]);
  assert.equal(f.eda.createCount, 0);
  const done = await runComponentBatch({ ...options(f), apply: true });
  f.eda.records[1].x += 100;
  const ownedChanged = await resume(f, done.runDir, false);
  assert(ownedChanged.reconciliation.issues.some(issue => issue.code === 'CREATED_COMPONENT_CHANGED'));
  await assert.rejects(resume(f, done.runDir), error => error.code === 'CREATED_COMPONENT_CHANGED');
});

test('legacy runs without frozen input snapshots still permit readback and safe close after input drift', async t => {
  const f = await batchFixture(t);
  const planned = await runComponentBatch(options(f));
  const old = await journal(planned.runDir);
  for (const file of old.sources) { delete file.snapshotFile; delete file.semanticSha256; delete file.designators; }
  await writeFile(join(planned.runDir, 'transaction.json'), JSON.stringify(old));
  await writeFile(f.inputFile, JSON.stringify({ ...f.input, batchSize: 2 }));
  const inspected = await resume(f, planned.runDir, false);
  assert.equal(inspected.status, 'needs-reconciliation');
  assert.equal(inspected.reconciliation.document.uuid, 'sch-batch');
  await assert.rejects(resume(f, planned.runDir), error => error.code === 'INPUT_CHANGED');
  assert.equal((await runComponentBatch({ projectRoot: f.root, resume: planned.runDir, invoke: f.invoke, close: true })).status, 'closed');
  assert.equal(f.eda.createCount, 0);
});

test('changing an unselected Contract component does not invalidate the selected placement intent', async t => {
  const f = await batchFixture(t);
  await writeFile(f.inputFile, JSON.stringify({ ...f.input, designators: ['R1', 'R2'] }));
  const planned = await runComponentBatch(options(f));
  f.contract.components[4].identity.value = 'unrelated revision';
  await writeFile(join(f.root, 'contract.json'), JSON.stringify(f.contract));
  const inspected = await resume(f, planned.runDir, false);
  assert.equal(inspected.reconciliation.integrity.sources[1].integrity, 'current');
  assert.equal(inspected.reconciliation.integrity.sources[1].byteMatch, false);
  const done = await resume(f, planned.runDir);
  assert.equal(done.status, 'placed-saved');
  assert.deepEqual(f.eda.records.map(row => row.designator), ['R1', 'R2']);
});
