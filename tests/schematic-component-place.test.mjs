import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const placeAction = await loadAction('schematic-component-place', 'easyeda-pro');

function createMockEda({ directIdentity = true, supplierCanonicalValue = null } = {}) {
  let sequence = 0;
  const created = [];
  return {
    _created: created,
    lib_Device: {
      async getByLcscIds() {
        return supplierCanonicalValue === null ? [] : [{ supplierId: 'C123', manufacturerId: 'MPN-1', otherProperty: { Value: supplierCanonicalValue } }];
      },
    },
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
        let otherProperty = {};
        const comp = {
          getState_PrimitiveId: () => id,
          getState_Designator: () => designator,
          getState_OtherProperty: () => ({ ...otherProperty }),
          getState_X: () => x,
          getState_Y: () => y,
          getState_Rotation: () => rotation ?? 0,
          getState_Mirror: () => mirror ?? false,
          getState_AddIntoBom: () => addIntoBom ?? true,
          getState_AddIntoPcb: () => addIntoPcb ?? true,
          getState_ComponentType: () => 0,
          getState_ManufacturerId: () => supplierCanonicalValue === null ? null : 'MPN-1',
          getState_SupplierId: () => supplierCanonicalValue === null ? null : 'C123',
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
        if (state.otherProperty) {
          const originalOtherProperty = component.getState_OtherProperty();
          component.getState_OtherProperty = () => ({ ...originalOtherProperty, ...state.otherProperty });
        }
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
      { designator: 'U1', value: 'DEVICE-1', position: { x: 2000, y: 3000 }, rotation: 0, mirror: false, includeInBom: true, includeInPcb: true, bindings: { easyedaPro: { libraryUuid: 'lib-1', deviceUuid: 'dev-1' } } },
      { designator: 'U2', value: 'DEVICE-2', position: { x: 4000, y: 3000 }, rotation: 0, mirror: false, includeInBom: true, includeInPcb: true, bindings: { easyedaPro: { libraryUuid: 'lib-1', deviceUuid: 'dev-2' } } },
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
assert.deepEqual(eda1._created.map((item) => item.getState_OtherProperty().Value), ['DEVICE-1', 'DEVICE-2']);
assert.equal(applyResult.verification.value, 'verified');
assert.ok(applyResult.rollbackRequest);

const catalogEda = createMockEda({ supplierCanonicalValue: '1.18kΩ' });
const catalogPlan = await placeAction(catalogEda, {
  mode: 'plan',
  expectedDocumentUuid: 'sch-place-uuid',
  plan: {
    kind: 'flitrealize.schematic-placement-plan',
    schemaVersion: 1,
    targetProvider: 'easyeda-pro',
    components: [
      { designator: 'R1', value: '1.18k 1%', position: { x: 100, y: 200 }, bindings: { easyedaPro: { libraryUuid: 'lib-r', deviceUuid: 'dev-r' } } },
    ],
  },
});
const catalogApply = await placeAction(catalogEda, catalogPlan.applyRequest);
assert.equal(catalogApply.status, 'applied');
assert.equal(catalogEda._created[0].getState_OtherProperty().Value, '1.18kΩ');
assert.equal(catalogApply.verification.value, 'verified');
assert.equal(catalogApply.created[0].value, '1.18kΩ');
assert.equal(catalogApply.created[0].requestedValue, '1.18k 1%');
assert.equal(catalogApply.created[0].valueResolution.source, 'supplier-catalog');

// Many exact IC/switch catalog records intentionally have no Value property;
// their Name uses Manufacturer Part. Keep the Contract MPN in that case.
const catalogWithoutValue = createMockEda({ supplierCanonicalValue: 'unused' });
catalogWithoutValue.lib_Device.getByLcscIds = async () => [{
  supplierId: 'C123', manufacturerId: 'MPN-1', otherProperty: { Name: '={Manufacturer Part}' },
}];
const noValuePlan = await placeAction(catalogWithoutValue, {
  mode: 'plan', expectedDocumentUuid: 'sch-place-uuid',
  plan: { items: [{ designator: 'SW1', value: 'MK-12C02-G020', libraryUuid: 'lib-switch', uuid: 'switch-1', x: 100, y: 200 }] },
});
const noValueApply = await placeAction(catalogWithoutValue, noValuePlan.applyRequest);
assert.equal(noValueApply.status, 'applied');
assert.equal(noValueApply.created[0].value, 'MK-12C02-G020');
assert.equal(noValueApply.created[0].valueResolution.source, 'contract-fallback-no-catalog-value');
assert.equal(catalogWithoutValue._created[0].getState_OtherProperty().Value, 'MK-12C02-G020');
assert.equal((await placeAction(catalogWithoutValue, {
  mode: 'verify', expectedDocumentUuid: 'sch-place-uuid', created: noValueApply.created,
})).status, 'verified');
await catalogWithoutValue.sch_PrimitiveComponent.modify('placed-1', { otherProperty: { Value: 'wrong-switch' } });
assert.equal((await placeAction(catalogWithoutValue, {
  mode: 'verify', expectedDocumentUuid: 'sch-place-uuid', created: noValueApply.created,
})).status, 'mismatch');

// A nonempty supplier Value is not sufficient: verify the exact value recorded
// after catalog resolution, including on later independent readback.
await catalogEda.sch_PrimitiveComponent.modify('placed-1', { otherProperty: { Value: '2kΩ' } });
const changedCatalogValue = await placeAction(catalogEda, {
  mode: 'verify', expectedDocumentUuid: 'sch-place-uuid', created: catalogApply.created,
});
assert.equal(changedCatalogValue.status, 'mismatch');
assert.equal(changedCatalogValue.issues[0].code, 'COMPONENT_MISSING_OR_CHANGED');
await assert.rejects(() => placeAction(catalogEda, catalogApply.rollbackRequest), (e) => e.code === 'STALE_ROLLBACK');

for (const failure of ['missing-api', 'lookup-error', 'no-match', 'ambiguous', 'empty-value']) {
  const failedCatalog = createMockEda({ supplierCanonicalValue: '1.18kΩ' });
  const originalLookup = failedCatalog.lib_Device.getByLcscIds;
  if (failure === 'missing-api') delete failedCatalog.lib_Device.getByLcscIds;
  if (failure === 'lookup-error') failedCatalog.lib_Device.getByLcscIds = async () => { throw new Error('catalog offline'); };
  if (failure === 'no-match') failedCatalog.lib_Device.getByLcscIds = async () => [];
  if (failure === 'ambiguous') failedCatalog.lib_Device.getByLcscIds = async () => [...await originalLookup(), ...await originalLookup()];
  if (failure === 'empty-value') failedCatalog.lib_Device.getByLcscIds = async () => [{ supplierId: 'C123', manufacturerId: 'MPN-1', otherProperty: { Value: '' } }];
  const failedPlan = await placeAction(failedCatalog, { mode: 'plan', expectedDocumentUuid: 'sch-place-uuid', plan: catalogPlan.plan });
  const failedApply = await placeAction(failedCatalog, failedPlan.applyRequest);
  assert.equal(failedApply.status, 'rolled-back', failure);
  assert.match(failedApply.error.code, /^SUPPLIER_VALUE_/);
  assert.equal(failedCatalog._created.length, 0, failure);
  assert.equal(failedApply.verification, undefined);
}

// Detect a late provider write that changes Value after the immediate modify
// readback; do not let the presence of a supplier ID bypass the final invariant.
const lateValueChange = createMockEda({ supplierCanonicalValue: '1.18kΩ' });
const originalGetAll = lateValueChange.sch_PrimitiveComponent.getAll;
lateValueChange.sch_PrimitiveComponent.getAll = async () => {
  const values = await originalGetAll();
  if (values.length) values[0].getState_OtherProperty = () => ({ Value: 'wrong-nonempty-value' });
  return values;
};
const latePlan = await placeAction(lateValueChange, { mode: 'plan', expectedDocumentUuid: 'sch-place-uuid', plan: catalogPlan.plan });
const lateApply = await placeAction(lateValueChange, latePlan.applyRequest);
assert.equal(lateApply.status, 'rolled-back');
assert.equal(lateApply.error.code, 'POST_APPLY_INVARIANT_FAILED');
assert.equal(lateValueChange._created.length, 0);

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
      { designator: 'J1', value: 'CONNECTOR-1', position: { x: 1000, y: 1200 }, rotation: 0, mirror: false, includeInBom: true, includeInPcb: true, bindings: { easyedaPro: { libraryUuid: 'lib-j1', deviceUuid: 'device-j1' } } },
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
