import assert from 'node:assert/strict';
import { loadAction } from './helpers/action-harness.mjs';

const action = await loadAction('schematic-no-connect', 'easyeda-pro');
const identity = { expectedDocumentUuid: 'sch-1', expectedProjectUuid: 'project-1' };
const items = [{ designator: 'U1', pin: '1' }, { designator: 'U1', pin: '2' }];

function fixture() {
  const state = { documentUuid: 'sch-1', values: [false, false], wires: [], calls: [], duplicate: false, modifyHook: null };
  const pins = state.values.map((_, index) => ({
    getState_PinNumber: () => String(index + 1),
    getState_PinName: () => 'NC',
    getState_NoConnected: () => state.values[index],
    getState_X: () => 100 + index * 10,
    getState_Y: () => 200,
  }));
  const component = { getState_Designator: () => 'U1', getState_PrimitiveId: () => 'component-1' };
  const eda = {
    dmt_SelectControl: { async getCurrentDocumentInfo() {
      return { uuid: state.documentUuid, parentProjectUuid: 'project-1', documentType: 1 };
    } },
    sch_PrimitiveComponent: {
      async getAll() { return state.duplicate ? [component, component] : [component]; },
      async getAllPinsByPrimitiveId() { return pins; },
    },
    sch_PrimitiveWire: { async getAll() { return state.wires; } },
    sch_PrimitivePin: { async modify(pin, property) {
      const index = pins.indexOf(pin);
      state.calls.push({ index, noConnected: property.noConnected, documentUuid: state.documentUuid });
      if (state.modifyHook) return state.modifyHook(index, property, pin);
      state.values[index] = property.noConnected;
      return pin;
    } },
  };
  return { eda, state, pins };
}
async function plan(eda, selected = items) {
  return action(eda, { mode: 'plan', ...identity, items: selected });
}

const normal = fixture();
const planned = await plan(normal.eda);
assert.equal(planned.status, 'planned');
assert.equal(planned.pins[0].actualNoConnected, false);
assert.match(planned.planFingerprint, /^fnv1a32-/);
const applied = await action(normal.eda, planned.applyRequest);
assert.equal(applied.status, 'applied');
assert.equal(applied.changedCount, 2);
assert.deepEqual(normal.state.values, [true, true]);
assert.equal((await action(normal.eda, { mode: 'verify', ...identity, items })).status, 'verified');
const noOp = await action(normal.eda, (await plan(normal.eda)).applyRequest);
assert.equal(noOp.changedCount, 0);
const rollback = await action(normal.eda, applied.rollbackRequest);
assert.equal(rollback.status, 'rolled-back');
assert.deepEqual(normal.state.values, [false, false]);

// Empty NC intent still produces an explicit executed and verified no-op stage.
const empty = fixture();
assert.equal((await action(empty.eda, (await plan(empty.eda, [])).applyRequest)).changedCount, 0);
assert.equal(empty.state.calls.length, 0);

// Neither unplanned writes nor implicit document selection can mutate pins.
await assert.rejects(() => action(empty.eda, { mode: 'apply', items }), (e) => e.code === 'DOCUMENT_IDENTITY_REQUIRED');
await assert.rejects(() => action(empty.eda, { mode: 'apply', ...identity, items }), (e) => e.code === 'INVALID_APPLY_REQUEST');
assert.equal(empty.state.calls.length, 0);

for (const kind of ['pin', 'wire', 'intent']) {
  const stale = fixture();
  const old = await plan(stale.eda);
  if (kind === 'pin') stale.state.values[1] = true;
  if (kind === 'wire') stale.state.wires.push({
    getState_PrimitiveId: () => 'wire-1', getState_Net: () => 'SIGNAL', getState_Line: () => [100, 200, 110, 200],
  });
  if (kind === 'intent') old.applyRequest.request.items[1].noConnected = false;
  await assert.rejects(() => action(stale.eda, old.applyRequest), (e) => e.code === 'STALE_PLAN');
  assert.equal(stale.state.calls.length, 0);
}

const changedAfterApply = fixture();
const staleRollback = await action(changedAfterApply.eda, (await plan(changedAfterApply.eda)).applyRequest);
changedAfterApply.state.values[1] = false;
await assert.rejects(() => action(changedAfterApply.eda, staleRollback.rollbackRequest), (e) => e.code === 'STALE_ROLLBACK');
assert.equal(changedAfterApply.state.calls.length, 2);

// A provider may commit the second write and then throw; restore both attempted pins.
const throwsAfterWrite = fixture();
throwsAfterWrite.state.modifyHook = (index, property, pin) => {
  throwsAfterWrite.state.values[index] = property.noConnected;
  if (index === 1 && property.noConnected) throw new Error('lost reply after write');
  return pin;
};
const recovered = await action(throwsAfterWrite.eda, (await plan(throwsAfterWrite.eda)).applyRequest);
assert.equal(recovered.status, 'rolled-back');
assert.equal(recovered.error.message, 'lost reply after write');
assert.equal(recovered.attempted.length, 2);
assert.equal(recovered.recovery.restored, true);
assert.deepEqual(throwsAfterWrite.state.values, [false, false]);

const recoveryFailure = fixture();
recoveryFailure.state.modifyHook = (index, property, pin) => {
  if (!property.noConnected) return false;
  recoveryFailure.state.values[index] = true;
  if (index === 1) throw new Error('write reply failed');
  return pin;
};
const incomplete = await action(recoveryFailure.eda, (await plan(recoveryFailure.eda)).applyRequest);
assert.equal(incomplete.status, 'rollback-incomplete');
assert.equal(incomplete.recovery.restored, false);
assert.equal(incomplete.recovery.failures.length, 2);
assert.deepEqual(incomplete.pins.map((pin) => pin.noConnected), [true, true]);

// A switched document blocks later writes AND recovery into the wrong schematic.
const switched = fixture();
switched.state.modifyHook = (index, property, pin) => {
  switched.state.values[index] = property.noConnected;
  switched.state.documentUuid = 'other-sch';
  return pin;
};
const interrupted = await action(switched.eda, (await plan(switched.eda)).applyRequest);
assert.equal(interrupted.status, 'rollback-incomplete');
assert.equal(interrupted.error.code, 'DOCUMENT_MISMATCH');
assert.equal(switched.state.calls.length, 1);
assert.equal(interrupted.recovery.failures[0].code, 'DOCUMENT_MISMATCH');

const duplicate = fixture();
duplicate.state.duplicate = true;
await assert.rejects(() => plan(duplicate.eda), (e) => e.code === 'COMPONENT_MATCH_FAILED');
const unreadable = fixture();
unreadable.state.values[0] = undefined;
await assert.rejects(() => plan(unreadable.eda), (e) => e.code === 'PIN_STATE_UNAVAILABLE');
assert.equal(unreadable.state.calls.length, 0);

process.stdout.write('schematic-no-connect tests passed\n');
