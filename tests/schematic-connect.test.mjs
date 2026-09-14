import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runSchematicConnect } from '../scripts/schematic-connect.mjs';
import { connectFixture } from './helpers/connect-fixture.mjs';

const options = fixture => ({ projectRoot: fixture.root, inputFile: fixture.inputFile, invoke: fixture.invoke });
const apply = fixture => runSchematicConnect({ ...options(fixture), apply: true });
const mutations = eda => eda.calls.filter(call => call.mutates).map(call => call.action);
const explain = result => JSON.stringify(result.error || result, null, 2);

test('default connect planning uses live source evidence and never writes EDA', async t => {
  const f = await connectFixture(t);
  const result = await runSchematicConnect(options(f));
  assert.equal(result.status, 'planned', explain(result));
  assert.equal(result.ok, true);
  assert.equal(result.readOnly, true);
  assert.deepEqual(result.pending, { wires: 2, markers: 2, noConnect: 2 });
  assert.deepEqual(mutations(f.eda), []);
  assert.equal(f.eda.wires.length, 0);
  assert.equal(f.eda.saveCount, 0);
});

test('apply creates wires, hidden-name markers and NC before complete reflow, strict save and final audit', async t => {
  const f = await connectFixture(t, { reflow: true });
  const result = await apply(f);
  assert.equal(result.status, 'connected-saved', explain(result));
  assert.equal(result.ok, true);
  assert.deepEqual(mutations(f.eda), ['schematic-wire-create', 'schematic-net-flag', 'schematic-no-connect', 'schematic-reflow', 'schematic-save-verify']);
  assert.equal(f.eda.wires.length, 2);
  assert.equal(f.eda.markers.length, 2);
  assert(f.eda.markers.every(marker => marker.visible === false));
  assert(f.eda.parts.every(part => part.pins[1].noConnected === true));
  assert.equal(result.saved, true);
  assert.equal(result.checks.drc.passed, true);
  assert.equal(result.checks.reflow.status, 'verified');
  assert.equal(result.checks.noConnect.status, 'verified');
  assert.deepEqual(f.eda.drcArgs, [true, false, true]);
  assert.equal(f.eda.calls.at(-1).action, 'schematic-inspect');
  const audit = JSON.parse(await readFile(join(result.runDir, 'saved-audit.json'), 'utf8'));
  assert.equal(audit.verified, true);
  assert(await readFile(join(result.runDir, 'before.esch'), 'utf8'));
});

test('a repeated apply preserves existing wires and markers without duplicate creation', async t => {
  const f = await connectFixture(t);
  const first = await apply(f);
  assert.equal(first.ok, true, explain(first));
  const beforeIds = [...f.eda.wires, ...f.eda.markers].map(row => row.id);
  const planned = await runSchematicConnect(options(f));
  assert.equal(planned.ok, true, explain(planned));
  assert.deepEqual(planned.pending, { wires: 0, markers: 0, noConnect: 0 });
  const beforeNcApplies = f.eda.calls.filter(call => call.action === 'schematic-no-connect' && call.mode === 'apply').length;
  const beforeNcWrites = f.eda.ncWrites;
  const repeated = await apply(f);
  assert.equal(repeated.ok, true, explain(repeated));
  assert.equal(f.eda.wireCreates, 2);
  assert.equal(f.eda.markerCreates, 2);
  assert.deepEqual([...f.eda.wires, ...f.eda.markers].map(row => row.id), beforeIds);
  assert.equal(repeated.checks.noConnect.status, 'verified');
  assert.equal(repeated.checks.noConnect.declaredCount, 2);
  assert.equal(f.eda.calls.filter(call => call.action === 'schematic-no-connect' && call.mode === 'apply').length, beforeNcApplies);
  assert.equal(f.eda.ncWrites, beforeNcWrites);
});

test('an empty NC set is still assessed and recorded; omitted reflow stays explicit', async t => {
  const f = await connectFixture(t, { withNc: false });
  const result = await apply(f);
  assert.equal(result.ok, true, explain(result));
  assert.equal(result.checks.noConnect.status, 'not-applicable');
  assert.equal(result.checks.noConnect.declaredCount, 0);
  assert.equal(f.eda.ncWrites, 0);
  assert.equal(result.checks.reflow.status, 'not-requested');
  assert.equal(f.eda.reflowCount, 0);
});

test('a missing marker on an existing named stub is repaired without another wire', async t => {
  const f = await connectFixture(t);
  assert.equal((await apply(f)).ok, true);
  const retainedMarker = f.eda.markers[1].id;
  f.eda.markers.splice(0, 1);
  const result = await apply(f);
  assert.equal(result.ok, true, explain(result));
  assert.equal(f.eda.wireCreates, 2);
  assert.equal(f.eda.markerCreates, 3);
  assert.equal(f.eda.markers.length, 2);
  assert(f.eda.markers.some(marker => marker.id === retainedMarker));
});

test('more than 30 endpoints are replanned against each preceding batch', async t => {
  const f = await connectFixture(t, { count: 31, withNc: false });
  const result = await apply(f);
  assert.equal(result.ok, true, explain(result));
  assert.equal(f.eda.wires.length, 31);
  assert.equal(f.eda.markers.length, 31);
  assert.equal(mutations(f.eda).filter(action => action === 'schematic-wire-create').length, 2);
  assert.equal(mutations(f.eda).filter(action => action === 'schematic-net-flag').length, 2);
});

test('a wrong target or changed source blocks writes before creating objects', async t => {
  const wrong = await connectFixture(t);
  wrong.eda.document.uuid = 'unrelated-schematic';
  const failed = await apply(wrong);
  assert.equal(failed.ok, false);
  assert.equal(wrong.eda.wireCreates, 0);
  const stale = await connectFixture(t);
  let inspections = 0;
  const invoke = async (action, request, context) => {
    if (action === 'schematic-inspect' && ++inspections === 2) stale.eda.note = 'user edited between planning and write';
    return stale.invoke(action, request, context);
  };
  const blocked = await runSchematicConnect({ ...options(stale), invoke, apply: true });
  assert.equal(blocked.error.code, 'STALE_SCHEMATIC');
  assert.equal(stale.eda.wireCreates, 0);
  assert.equal(stale.eda.saveCount, 0);
});

test('a Contract pin assigned both NC and a network blocks all mutation', async t => {
  const f = await connectFixture(t);
  f.contract.nets[0].endpoints.push({ component: 'U1', pin: '2' });
  await f.writeContract();
  const result = await apply(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONNECTIONS_BLOCKED');
  assert(result.checks.connections.diagnostics.some(diagnostic => diagnostic.code === 'PIN_INTENT_CONFLICT'));
  assert.deepEqual(mutations(f.eda), []);
});

test('saving successfully with failed strict DRC never reports the schematic complete', async t => {
  const f = await connectFixture(t);
  f.eda.drcResult = [{ type: 'warn', count: 1 }];
  const result = await apply(f);
  assert.equal(result.ok, false);
  assert.equal(result.saved, true);
  assert.equal(result.checks.drc.passed, false);
  assert.equal(result.status, 'blocked');
  assert.equal(f.eda.saveCount, 1);
  assert.equal(f.eda.drcCount, 1);
});

test('a lost mutation reply stops the run and retains its active ownership file', async t => {
  const f = await connectFixture(t);
  const invoke = async (action, request, context) => {
    const record = await f.invoke(action, request, context);
    if (action === 'schematic-wire-create' && request.mode === 'apply') throw new Error('transport reply lost');
    return record;
  };
  const lost = await runSchematicConnect({ ...options(f), invoke, apply: true });
  assert.equal(lost.status, 'outcome-unknown');
  assert.equal(lost.ok, false);
  assert.equal(f.eda.wires.length, 2, 'the write happened even though the response was lost');
  assert.equal(f.eda.markerCreates, 0);
  assert.equal(f.eda.saveCount, 0);
  assert((await readdir(join(f.root, 'evidence', 'schematic-connect'))).some(name => name.endsWith('.active.json')));
  const retry = await apply(f);
  assert.equal(retry.ok, false);
  assert.equal(retry.error.code, 'UNRESOLVED_RUN');
  assert.equal(f.eda.wireCreates, 2);
});

test('an Action reporting an uncertain partial create keeps the workflow blocked against retry', async t => {
  const f = await connectFixture(t);
  const create = f.eda.sch_PrimitiveWire.create;
  f.eda.sch_PrimitiveWire.create = async (...args) => {
    await create(...args);
    throw new Error('provider created a wire but lost its ID response');
  };
  const result = await apply(f);
  assert.equal(result.status, 'outcome-unknown', explain(result));
  assert.equal(result.ok, false);
  assert.equal(f.eda.wires.length, 1);
  assert.equal(f.eda.markerCreates, 0);
  const retried = await apply(f);
  assert.equal(retried.error.code, 'UNRESOLVED_RUN');
  assert.equal(f.eda.wires.length, 1);
});

test('save-time changes outside component geometry invalidate the final source evidence', async t => {
  const f = await connectFixture(t);
  f.eda.afterSave = () => { f.eda.note = 'source changed while saving'; };
  const result = await apply(f);
  assert.equal(result.ok, false);
  assert.equal(result.saved, true);
  assert.equal(result.checks.drc.passed, true);
  assert.equal(result.error.code, 'SAVE_CHANGED_SOURCE');
});

test('existing manually routed wires are not replaced by the isolated-stub workflow', async t => {
  const f = await connectFixture(t);
  const manual = { id: 'manual-wire', net: 'SENSE', points: [20, 100, 60, 100, 60, 120], color: null, lineWidth: null, lineType: null, visible: true };
  f.eda.wires.push(manual);
  const result = await apply(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONNECTIONS_BLOCKED');
  assert(result.checks.connections.diagnostics.some(diagnostic => diagnostic.code === 'EXISTING_TOPOLOGY_UNSUPPORTED'));
  assert.deepEqual(f.eda.wires, [manual]);
  assert.equal(f.eda.wireCreates, 0);
});

test('check verifies a completed schematic without saving or mutating it', async t => {
  const f = await connectFixture(t);
  assert.equal((await apply(f)).ok, true);
  const before = mutations(f.eda).length;
  const checked = await runSchematicConnect({ ...options(f), check: true });
  assert.equal(checked.status, 'checked', explain(checked));
  assert.equal(checked.ok, true);
  assert.equal(checked.readOnly, true);
  assert.equal(checked.saved, null);
  assert.equal(mutations(f.eda).length, before);
  assert.equal(f.eda.saveCount, 1);
  assert.equal(f.eda.drcCount, 2);
});
