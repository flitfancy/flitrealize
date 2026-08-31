import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const placeAction = await loadAction('schematic-component-place', 'easyeda-pro');

function createMockEda({ directIdentity = true } = {}) {
  let sequence = 0;
  const created = [];
  return {
    _created: created,
    dmt_SelectControl: {
      async getCurrentDocumentInfo() {
        return { uuid: 'sch-place-uuid', tabId: 'sch-place@project', documentType: 1, parentProjectUuid: 'project-test' };
      },
    },
    sch_PrimitiveComponent: {
      async getAll() {
        return [...created];
      },
      async create(component, x, y, subPartName, rotation, mirror, addIntoBom, addIntoPcb) {
        const id = `placed-${++sequence}`;
        let designator = `AUTO${sequence}`;
        const comp = {
          getState_PrimitiveId: () => id,
          getState_Designator: () => designator,
          getState_X: () => x,
          getState_Y: () => y,
          getState_Rotation: () => rotation ?? 0,
          getState_Mirror: () => mirror ?? false,
          getState_AddIntoBom: () => addIntoBom ?? true,
          getState_AddIntoPcb: () => addIntoPcb ?? true,
          getState_ComponentType: () => 0,
          getState_LibraryUuid: () => directIdentity ? component.libraryUuid : null,
          getState_Uuid: () => directIdentity ? component.uuid : null,
          getState_Component: () => ({
            libraryUuid: component.libraryUuid,
            uuid: directIdentity ? component.uuid : `symbol-${component.uuid}`,
          }),
        };
        created.push(comp);
        return comp;
      },
      async modify(id, state) {
        const component = created.find((item) => item.getState_PrimitiveId() === id);
        if (!component) return false;
        const original = component.getState_Designator;
        component.getState_Designator = () => state.designator ?? original();
        return true;
      },
      async get(id) {
        return created.find((item) => item.getState_PrimitiveId() === id) ?? null;
      },
      async delete(ids) {
        const idSet = new Set(Array.isArray(ids) ? ids : [ids]);
        for (let i = created.length - 1; i >= 0; i--) {
          if (idSet.has(created[i].getState_PrimitiveId())) created.splice(i, 1);
        }
        return true;
      },
    },
  };
}

// Test inspect mode
const eda1 = createMockEda();
const inspectResult = await placeAction(eda1, { mode: 'inspect' });
assert.equal(inspectResult.status, 'inspected');
assert.equal(inspectResult.state.componentCount, 0);

// Test plan mode
const planResult = await placeAction(eda1, {
  mode: 'plan',
  expectedDocumentUuid: 'sch-place-uuid',
  plan: {
    kind: 'flitrealize.schematic-placement-plan',
    schemaVersion: 1,
    targetProvider: 'easyeda-pro',
    components: [
      { designator: 'U1', position: { x: 2000, y: 3000 }, rotation: 0, mirror: false, includeInBom: true, includeInPcb: true, bindings: { easyedaPro: { libraryUuid: 'lib-1', deviceUuid: 'dev-1' } } },
      { designator: 'U2', position: { x: 4000, y: 3000 }, rotation: 0, mirror: false, includeInBom: true, includeInPcb: true, bindings: { easyedaPro: { libraryUuid: 'lib-1', deviceUuid: 'dev-2' } } },
    ],
    fingerprints: { plan: 'fnv1a32-source' },
  },
});
assert.equal(planResult.status, 'planned');
assert.equal(planResult.analysis.applyReady, true);
assert.equal(planResult.analysis.itemCount, 2);
assert.ok(planResult.applyRequest);

const blockedSource = await placeAction(eda1, {
  mode: 'plan',
  expectedDocumentUuid: 'sch-place-uuid',
  plan: {
    kind: 'flitrealize.schematic-placement-plan',
    schemaVersion: 1,
    targetProvider: 'easyeda-pro',
    components: [
      { designator: 'U3', position: { x: 6000, y: 3000 }, rotation: 0, mirror: false, includeInBom: true, includeInPcb: true, bindings: { easyedaPro: { libraryUuid: 'lib-1', deviceUuid: 'dev-3' } } },
    ],
    diagnostics: [{ severity: 'error', code: 'LAYOUT_OVERLAP', message: 'U3 overlaps another symbol' }],
    fingerprints: { plan: 'fnv1a32-blocked-source' },
  },
});
assert.equal(blockedSource.analysis.applyReady, false);
assert.ok(blockedSource.analysis.globalIssues.some((issue) => issue.code === 'SOURCE_PLACEMENT_PLAN_BLOCKED'));

// Test apply mode
const applyResult = await placeAction(eda1, planResult.applyRequest);
assert.equal(applyResult.status, 'applied');
assert.equal(applyResult.created.length, 2);
assert.equal(applyResult.created[0].primitiveId, 'placed-1');
assert.equal(applyResult.created[1].primitiveId, 'placed-2');
assert.deepEqual(applyResult.created.map((item) => item.designator), ['U1', 'U2']);
assert.ok(applyResult.rollbackRequest);

// EasyEDA may expose a symbol/component UUID through getState_Component() while
// omitting the placed Provider device UUID. That is unknown identity coverage,
// not a mismatch with the library device requested by the placement plan.
const edaComponentStateOnly = createMockEda({ directIdentity: false });
const componentStatePlan = await placeAction(edaComponentStateOnly, {
  mode: 'plan',
  expectedDocumentUuid: 'sch-place-uuid',
  plan: {
    kind: 'flitrealize.schematic-placement-plan',
    schemaVersion: 1,
    targetProvider: 'easyeda-pro',
    components: [
      { designator: 'J1', position: { x: 1000, y: 1200 }, rotation: 0, mirror: false, includeInBom: true, includeInPcb: true, bindings: { easyedaPro: { libraryUuid: 'lib-j1', deviceUuid: 'device-j1' } } },
    ],
    fingerprints: { plan: 'fnv1a32-component-state-only' },
  },
});
const componentStateApply = await placeAction(edaComponentStateOnly, componentStatePlan.applyRequest);
assert.equal(componentStateApply.status, 'applied');
assert.equal(componentStateApply.verification.providerDeviceIdentity, 'unknown');
assert.equal(componentStateApply.verification.providerDeviceIdentityUnknownCount, 1);

// Test verify mode after apply
const verifyResult = await placeAction(eda1, {
  mode: 'verify',
  expectedDocumentUuid: 'sch-place-uuid',
  created: applyResult.created,
});
assert.equal(verifyResult.status, 'verified');

// Test rollback mode
const rollbackResult = await placeAction(eda1, {
  mode: 'rollback',
  expectedDocumentUuid: 'sch-place-uuid',
  expectedCurrentFingerprint: applyResult.afterInspectionFingerprint,
  expectedRestoredFingerprint: applyResult.beforeInspectionFingerprint,
  created: applyResult.created,
});
assert.equal(rollbackResult.status, 'rolled-back');

// Test plan with document mismatch
const mismatchResult = await placeAction(eda1, {
  mode: 'plan',
  plan: {
    expectedDocumentUuid: 'wrong-uuid',
    items: [{ designator: 'U1', libraryUuid: 'lib-1', uuid: 'dev-1', x: 0, y: 0 }],
  },
});
assert.equal(mismatchResult.analysis.applyReady, false);
assert.ok(mismatchResult.analysis.globalIssues.some((i) => i.code === 'DOCUMENT_MISMATCH'));

const duplicateResult = await placeAction(eda1, {
  mode: 'plan',
  plan: {
    expectedDocumentUuid: 'sch-place-uuid',
    items: [
      { designator: 'U1', libraryUuid: 'lib-1', uuid: 'dev-1', x: 0, y: 0 },
      { designator: 'U1', libraryUuid: 'lib-1', uuid: 'dev-2', x: 100, y: 0 },
    ],
  },
});
assert.equal(duplicateResult.analysis.applyReady, false);
assert.ok(duplicateResult.analysis.globalIssues.some((issue) => issue.code === 'DUPLICATE_PLAN_DESIGNATOR'));

// Test invalid plan rejected
await assert.rejects(
  () => placeAction(eda1, { mode: 'plan', plan: null }),
  (error) => error.code === 'INVALID_PLAN',
);
await assert.rejects(
  () => placeAction(eda1, { mode: 'plan', plan: { items: [{ x: 0 }] } }),
  (error) => error.code === 'INVALID_PLAN_ITEM',
);

process.stdout.write('schematic-component-place tests passed\n');
