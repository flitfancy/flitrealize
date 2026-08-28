import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const placeAction = await loadAction('schematic-component-place', 'easyeda-pro');

function createMockEda() {
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
        const comp = {
          getState_PrimitiveId: () => id,
          getState_Designator: () => `U${sequence}`,
          getState_X: () => x,
          getState_Y: () => y,
          getState_Rotation: () => rotation ?? 0,
          getState_Mirror: () => mirror ?? false,
          getState_AddIntoBom: () => addIntoBom ?? true,
          getState_AddIntoPcb: () => addIntoPcb ?? true,
          getState_ComponentType: () => 0,
          getState_LibraryUuid: () => component.libraryUuid,
          getState_Uuid: () => component.uuid,
        };
        created.push(comp);
        return comp;
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
  plan: {
    expectedDocumentUuid: 'sch-place-uuid',
    items: [
      { libraryUuid: 'lib-1', uuid: 'dev-1', x: 2000, y: 3000 },
      { libraryUuid: 'lib-1', uuid: 'dev-2', x: 4000, y: 3000 },
    ],
  },
});
assert.equal(planResult.status, 'planned');
assert.equal(planResult.analysis.applyReady, true);
assert.equal(planResult.analysis.itemCount, 2);
assert.ok(planResult.applyRequest);

// Test apply mode
const applyResult = await placeAction(eda1, {
  mode: 'apply',
  plan: {
    expectedDocumentUuid: 'sch-place-uuid',
    items: [
      { libraryUuid: 'lib-1', uuid: 'dev-1', x: 2000, y: 3000 },
      { libraryUuid: 'lib-1', uuid: 'dev-2', x: 4000, y: 3000 },
    ],
  },
  expectedPlanFingerprint: planResult.analysis.planFingerprint,
});
assert.equal(applyResult.status, 'applied');
assert.equal(applyResult.created.length, 2);
assert.equal(applyResult.created[0].primitiveId, 'placed-1');
assert.equal(applyResult.created[1].primitiveId, 'placed-2');
assert.ok(applyResult.rollbackRequest);

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
    items: [{ libraryUuid: 'lib-1', uuid: 'dev-1', x: 0, y: 0 }],
  },
});
assert.equal(mismatchResult.analysis.applyReady, false);
assert.ok(mismatchResult.analysis.globalIssues.some((i) => i.code === 'DOCUMENT_MISMATCH'));

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
