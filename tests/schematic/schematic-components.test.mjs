import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runComponentBatch } from '../../scripts/schematic-components.mjs';
import { batchFixture, mockComponents } from '../helpers/component-batch-fixture.mjs';
import { loadAction } from '../helpers/action-harness.mjs';

const options = fixture => ({ projectRoot: fixture.root, inputFile: fixture.inputFile, invoke: fixture.invoke });
const resume = (fixture, runDir, apply = true) => runComponentBatch({ projectRoot: fixture.root, resume: runDir, invoke: fixture.invoke, apply });
const journal = async runDir => JSON.parse(await readFile(join(runDir, 'transaction.json'), 'utf8'));
const explicitGeometry = async fixture => {
  fixture.input.catalog = Object.fromEntries(fixture.input.designators.map(ref => {
    const component = fixture.contract.components.find(component => component.designator === ref);
    return [ref, { symbol: { width: 20, height: 20, occupancy: { unit: 'easyeda-schematic', ...component.bindings.easyedaPro,
      value: component.identity.value || component.identity.mpn, rotation: 0, mirror: false, includesAttributes: true,
      bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 } } } }];
  }));
  await writeFile(fixture.inputFile, JSON.stringify(fixture.input));
};
const externalPart = (id = 'old', designator = 'R99', x = 9000, y = 9000) => ({ id, designator, x, y, rotation: 0, mirror: false,
  addIntoBom: true, addIntoPcb: true, libraryUuid: 'lib', uuid: 'dev' });

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
  await assert.rejects(resume(f, done.runDir), error => error.code === 'COMPLETED_SOURCE_CHANGED');
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
  await writeFile(f.inputFile, JSON.stringify({ ...f.input, designators: ['R3', 'R4', 'R5'], batchSize: 2, layout: { originX: 2000, originY: 2000 } }));
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

test('unrelated baseline moves are retained with native occupancy and exact target geometry; owned changes still block', async t => {
  const f = await batchFixture(t);
  await explicitGeometry(f);
  const old = { id: 'old', designator: 'R99', x: 9000, y: 9000, rotation: 0, mirror: false, addIntoBom: true, addIntoPcb: true, libraryUuid: 'lib', uuid: 'dev' };
  f.eda.records.push(old);
  const planned = await runComponentBatch(options(f));
  old.x += 100;
  const inspected = await resume(f, planned.runDir, false);
  assert.equal(inspected.status, 'planned');
  assert.equal(inspected.reconciliation.preservedChanges.components[0].current.x, old.x);
  const before = await journal(planned.runDir);
  const done = await resume(f, planned.runDir);
  assert.equal(done.status, 'placed-saved');
  assert.equal(f.eda.records[0], old);
  assert.equal(old.x, 9100);
  assert.equal((await journal(done.runDir)).preparedSha256, before.preparedSha256);
  assert.equal(done.preservedChanges.components[0].current.x, 9100);
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

test('unrelated added objects and source text survive placement without adoption', async t => {
  const f = await batchFixture(t);
  await explicitGeometry(f);
  const planned = await runComponentBatch(options(f));
  const added = externalPart('user-added');
  f.eda.records.push(added);
  f.eda.note = 'remote user note';
  const done = await resume(f, planned.runDir);
  assert.equal(done.status, 'placed-saved');
  assert.equal(done.placedCount, 5);
  assert.equal(f.eda.records[0], added);
  assert.equal(f.eda.note, 'remote user note');
  assert.equal(done.preservedChanges.addedComponents[0].primitiveId, added.id);
});

test('default geometry still handles unchanged batches but cannot prove an external move safe', async t => {
  const f = await batchFixture(t);
  const old = externalPart();
  f.eda.records.push(old);
  const planned = await runComponentBatch(options(f));
  old.x += 100;
  await assert.rejects(resume(f, planned.runDir), error => error.code === 'LOCAL_TARGET_GEOMETRY_UNAVAILABLE');
  assert.equal(f.eda.createCount, 0);
  old.x -= 100;
  assert.equal((await resume(f, planned.runDir)).status, 'placed-saved');
});

test('missing native occupancy refuses drift even when target dimensions are explicit', async t => {
  const f = await batchFixture(t);
  await explicitGeometry(f);
  const old = externalPart();
  f.eda.records.push(old);
  const planned = await runComponentBatch(options(f));
  old.x += 100;
  f.eda.boundsUnavailable = true;
  await assert.rejects(resume(f, planned.runDir), error => error.code === 'LOCAL_OCCUPANCY_UNAVAILABLE');
  assert.equal(f.eda.createCount, 0);
});

test('a moved or new obstacle intersecting the original target bounds blocks before writing', async t => {
  for (const kind of ['moved', 'new']) await t.test(kind, async t => {
    const f = await batchFixture(t);
    await explicitGeometry(f);
    const obstacle = externalPart();
    if (kind === 'moved') f.eda.records.push(obstacle);
    const planned = await runComponentBatch(options(f));
    const prepared = JSON.parse(await readFile(join(planned.runDir, 'prepared.json'), 'utf8'));
    const { x, y } = prepared.placementPlan.components[0].position;
    obstacle.x = x + 15; obstacle.y = y;
    if (kind === 'new') f.eda.records.push(obstacle);
    await assert.rejects(resume(f, planned.runDir), error => error.code === 'TARGET_OCCUPIED');
    assert.equal(f.eda.createCount, 0);
    assert.equal(f.eda.records[0], obstacle);
  });
});

test('a target designator added after planning cannot be mistaken for a receipt', async t => {
  const f = await batchFixture(t);
  const planned = await runComponentBatch(options(f));
  f.eda.records.push(externalPart('manual', 'R1'));
  await assert.rejects(resume(f, planned.runDir), error => error.code === 'DESIGNATOR_ALREADY_EXISTS');
  assert.equal(f.eda.createCount, 0);
});

test('owned properties and pin networks are frozen across a partial-batch resume', async t => {
  for (const change of ['property', 'network']) await t.test(change, async t => {
    const f = await batchFixture(t);
    f.eda.afterCreate = row => { row.pins = [{ number: '1', x: row.x + 10, y: row.y, net: '' }]; };
    f.eda.failCreateAt = 3;
    let runDir;
    await assert.rejects(runComponentBatch({ ...options(f), apply: true }), error => { runDir = error.runDir; return error.code === 'ACTION_NOT_COMPLETED'; });
    if (change === 'property') f.eda.records[0].otherProperty.UserSetting = 'changed';
    else f.eda.records[0].pins[0].net = 'OTHER';
    const before = f.eda.createCount;
    await assert.rejects(resume(f, runDir), error => error.code === 'CREATED_COMPONENT_CHANGED');
    assert.equal(f.eda.createCount, before);
  });
});

test('unrelated changes after invocation preflight still stop the batch', async t => {
  const f = await batchFixture(t);
  await explicitGeometry(f);
  const old = externalPart();
  f.eda.records.push(old);
  const planned = await runComponentBatch(options(f));
  old.x += 100;
  f.eda.afterCreate = () => { old.x += 100; };
  await assert.rejects(resume(f, planned.runDir), error => error.code === 'EXECUTION_SOURCE_CHANGED');
  assert.equal(f.eda.createCount, 1);
  assert.equal(f.eda.saveCount, 0);
  assert.equal(old.x, 9200);
});

test('saving cannot overwrite an accepted external move back to the original baseline', async t => {
  const f = await batchFixture(t);
  await explicitGeometry(f);
  const old = externalPart();
  f.eda.records.push(old);
  const planned = await runComponentBatch(options(f));
  old.x += 100;
  f.eda.afterSave = () => { old.x = 9000; };
  await assert.rejects(resume(f, planned.runDir), error => error.code === 'ACTION_NOT_COMPLETED');
  const transaction = await journal(planned.runDir);
  const save = transaction.attempts.findLast(attempt => attempt.action === 'schematic-save-verify' && attempt.mode === 'apply');
  assert.equal(save.result.saved, true);
  assert(save.result.issues.some(issue => issue.code === 'EXECUTION_SOURCE_CHANGED'));
  assert.equal(transaction.completedSourceSha256, undefined);
});

test('a provider that creates then throws remains unknown and cannot replay placement', async t => {
  const f = await batchFixture(t);
  const create = f.eda.sch_PrimitiveComponent.create;
  f.eda.sch_PrimitiveComponent.create = async (...args) => { await create(...args); throw new Error('lost create response'); };
  let runDir;
  await assert.rejects(runComponentBatch({ ...options(f), apply: true }), error => { runDir = error.runDir; return error.code === 'ACTION_OUTCOME_UNKNOWN'; });
  assert.equal(f.eda.records.length, 1);
  await assert.rejects(resume(f, runDir), error => error.code === 'IN_FLIGHT_OUTCOME_UNKNOWN');
  assert.equal(f.eda.createCount, 1);
  assert.equal(f.eda.saveCount, 0);
});

test('native representative bounds exceeding the declared rectangle stop scaling after one creation', async t => {
  const f = await batchFixture(t);
  await explicitGeometry(f);
  const planned = await runComponentBatch(options(f));
  f.eda.records.push(externalPart());
  f.eda.afterCreate = row => { row.bounds = { minX: row.x - 50, maxX: row.x + 50, minY: row.y - 50, maxY: row.y + 50 }; };
  await assert.rejects(resume(f, planned.runDir), error => error.code === 'LOCAL_TARGET_GEOMETRY_MISMATCH');
  assert.equal(f.eda.createCount, 1);
  assert.equal(f.eda.saveCount, 0);
});

test('rectangular symbols at native 90/270 degree rotation and explicit mirror use anchor-relative bounds', async t => {
  for (const rotation of [90, 270]) for (const mirror of [false, true]) await t.test(`${rotation}/${mirror}`, async t => {
    const f = await batchFixture(t, 1);
    await explicitGeometry(f);
    const catalog = f.input.catalog.R1;
    catalog.rotation = rotation;
    catalog.symbol.width = 80; catalog.symbol.height = 20;
    const bounds = mirror ? { minX: -30, maxX: -10, minY: -30, maxY: 50 } : { minX: 10, maxX: 30, minY: -30, maxY: 50 };
    Object.assign(catalog.symbol.occupancy, { rotation, mirror, bounds });
    // The current placement generator emits mirror=false, so mirror=true must be refused rather than inferred.
    await writeFile(f.inputFile, JSON.stringify(f.input));
    const old = externalPart(); f.eda.records.push(old);
    const planned = await runComponentBatch(options(f)); old.x += 100;
    if (mirror) {
      await assert.rejects(resume(f, planned.runDir), error => error.code === 'LOCAL_TARGET_GEOMETRY_UNAVAILABLE');
      assert.equal(f.eda.createCount, 0);
    } else {
      f.eda.afterCreate = row => { row.bounds = { minX: row.x + bounds.minX, maxX: row.x + bounds.maxX, minY: row.y + bounds.minY, maxY: row.y + bounds.maxY }; };
      assert.equal((await resume(f, planned.runDir)).status, 'placed-saved');
      assert.equal(f.eda.records[1].rotation, rotation);
    }
  });
});

test('an obstacle in an eccentric symbol footprint blocks before creation, outside the layout-centered box', async t => {
  const f = await batchFixture(t, 1);
  await explicitGeometry(f);
  f.input.catalog.R1.symbol.occupancy.bounds = { minX: 100, maxX: 120, minY: -10, maxY: 10 };
  await writeFile(f.inputFile, JSON.stringify(f.input));
  const planned = await runComponentBatch(options(f));
  const prepared = JSON.parse(await readFile(join(planned.runDir, 'prepared.json'), 'utf8'));
  const position = prepared.placementPlan.components[0].position;
  f.eda.records.push(externalPart('eccentric-obstacle', 'R99', position.x + 110, position.y));
  await assert.rejects(resume(f, planned.runDir), error => error.code === 'TARGET_OCCUPIED');
  assert.equal(f.eda.createCount, 0);
});

test('catalog width/height and mismatched units cannot certify a provider anchor', async t => {
  for (const gap of ['width-height-only', 'unit']) await t.test(gap, async t => {
    const f = await batchFixture(t);
    await explicitGeometry(f);
    if (gap === 'width-height-only') delete f.input.catalog.R1.symbol.occupancy;
    else f.input.catalog.R1.symbol.occupancy.unit = 'mil';
    await writeFile(f.inputFile, JSON.stringify(f.input));
    const old = externalPart(); f.eda.records.push(old);
    const planned = await runComponentBatch(options(f)); old.x += 100;
    await assert.rejects(resume(f, planned.runDir), error => error.code === 'LOCAL_TARGET_GEOMETRY_UNAVAILABLE');
    assert.equal(f.eda.createCount, 0);
  });
});

test('source-only unknown text or line data blocks when component inventories are unchanged', async t => {
  const f = await batchFixture(t);
  const planned = await runComponentBatch(options(f));
  const source = f.eda.sys_FileManager.getDocumentSource;
  f.eda.sys_FileManager.getDocumentSource = async () => await source() + '\nUNKNOWN_TEXT_OR_LINE';
  const inspected = await resume(f, planned.runDir, false);
  assert(inspected.reconciliation.issues.some(issue => issue.code === 'LOCAL_SOURCE_UNSUPPORTED'));
  await assert.rejects(resume(f, planned.runDir), error => error.code === 'LOCAL_SOURCE_UNSUPPORTED');
  assert.equal(f.eda.createCount, 0);
});

test('source-only remote text changes with complete native bounds are recorded and retained', async t => {
  const f = await batchFixture(t);
  await explicitGeometry(f);
  const planned = await runComponentBatch(options(f));
  f.eda.note = 'remote source-only text';
  const done = await resume(f, planned.runDir);
  assert.equal(done.status, 'placed-saved');
  assert.equal(done.preservedChanges.components.length, 0);
  assert(done.preservedChanges.sourceRecords.some(change => change.id === 'note'));
  assert.equal(f.eda.note, 'remote source-only text');
});

test('remote component bodies cannot certify attributes that extend into the target or have unknown bounds', async t => {
  for (const boundsAvailable of [true, false]) await t.test(String(boundsAvailable), async t => {
    const f = await batchFixture(t, 1);
    await explicitGeometry(f);
    f.eda.records.push(externalPart());
    const planned = await runComponentBatch(options(f));
    const prepared = JSON.parse(await readFile(join(planned.runDir, 'prepared.json'), 'utf8'));
    const { x, y } = prepared.placementPlan.components[0].position;
    const source = f.eda.sys_FileManager.getDocumentSource, bbox = f.eda.sch_Primitive.getPrimitivesBBox;
    f.eda.sys_FileManager.getDocumentSource = async () => await source() + '\n' + JSON.stringify({ type: 'ATTR', id: 'remote-attr' })
      + '||' + JSON.stringify({ parentId: 'old', key: 'Name', value: 'long remote text' }) + '|';
    f.eda.sch_Primitive.getPrimitivesBBox = async ids => ids[0] === 'remote-attr'
      ? boundsAvailable ? { minX: x - 1, maxX: x + 1, minY: y - 1, maxY: y + 1 } : null : bbox(ids);
    await assert.rejects(resume(f, planned.runDir), error => error.code === (boundsAvailable ? 'TARGET_OCCUPIED' : 'LOCAL_OCCUPANCY_UNAVAILABLE'));
    assert.equal(f.eda.createCount, 0);
  });
});

test('source settings cannot be accepted merely because they return remote bounds', async t => {
  const f = await batchFixture(t); await explicitGeometry(f);
  const planned = await runComponentBatch(options(f)), source = f.eda.sys_FileManager.getDocumentSource, bounds = f.eda.sch_Primitive.getPrimitivesBBox;
  f.eda.sys_FileManager.getDocumentSource = async () => await source() + '\n{"type":"SETTINGS","id":"settings"}||{"grid":8}|';
  f.eda.sch_Primitive.getPrimitivesBBox = async ids => ids[0] === 'settings' ? { minX: 9000, maxX: 9001, minY: 9000, maxY: 9001 } : bounds(ids);
  await assert.rejects(resume(f, planned.runDir), error => error.code === 'LOCAL_SOURCE_DEPENDENCY_CHANGED');
  assert.equal(f.eda.createCount, 0);
});
test('a new source attribute attached to a previously created object is protected on resume', async t => {
  const f = await batchFixture(t); f.eda.failCreateAt = 3; let runDir;
  await assert.rejects(runComponentBatch({ ...options(f), apply: true }), error => { runDir = error.runDir; return true; });
  const source = f.eda.sys_FileManager.getDocumentSource, id = f.eda.records[0].id;
  f.eda.sys_FileManager.getDocumentSource = async () => await source() + '\n' + JSON.stringify({ type: 'ATTR', id: 'user-new-property' }) + '||' + JSON.stringify({ parentId: id, key: 'UserProperty', value: 'keep' }) + '|';
  const count = f.eda.createCount;
  await assert.rejects(resume(f, runDir), error => error.code === 'CREATED_COMPONENT_CHANGED');
  assert.equal(f.eda.createCount, count);
});
test('contradictory durable receipts do not settle an unknown placement request', async t => {
  for (const kind of ['uncertain-result', 'unknown-envelope']) await t.test(kind, async t => {
    const f = await batchFixture(t); let runDir;
    const invoke = async (action, input, context) => {
      const result = await f.invoke(action, input, context);
      if (action === 'schematic-component-place' && input.mode === 'apply') {
        const response = kind === 'uncertain-result' ? { success: true, result: { ...result, uncertainWrite: true } }
          : { success: true, status: 'unknown', executionOutcome: 'unknown', result };
        await writeFile(context.reportFile, JSON.stringify({ action, mode: input.mode, response }));
        throw new Error('wrapper lost reply');
      }
      return result;
    };
    await assert.rejects(runComponentBatch({ ...options(f), invoke, apply: true }), error => { runDir = error.runDir; return true; });
    const count = f.eda.createCount, inspected = await resume(f, runDir, false);
    assert.equal(inspected.reconciliation.canClose, false);
    await assert.rejects(resume(f, runDir), error => error.code === 'IN_FLIGHT_OUTCOME_UNKNOWN');
    assert.equal(f.eda.createCount, count);
  });
});
