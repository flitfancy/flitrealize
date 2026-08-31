import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const saveVerifyAction = await loadAction('schematic-save-verify', 'easyeda-pro');

function createMockEda(drcPassed = true) {
  let saveCount = 0;
  let drcCount = 0;
  const component = {
    getState_PrimitiveId: () => 'comp-1', getState_Designator: () => 'U1',
    getState_X: () => 100, getState_Y: () => 200,
    getState_Rotation: () => 0, getState_Mirror: () => false,
  };
  const wire = {
    getState_PrimitiveId: () => 'wire-1', getState_Net: () => 'VCC',
    getState_Line: () => [100, 200, 150, 200], getState_LineWidth: () => 1, getState_LineType: () => 0,
  };
  return {
    get saveCount() { return saveCount; },
    get drcCount() { return drcCount; },
    dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: 'doc-save', documentType: 1, parentProjectUuid: 'project' }; } },
    sch_PrimitiveComponent: { async getAll() { return [component]; } },
    sch_PrimitiveWire: { async getAll() { return [wire]; } },
    sch_Document: { async save() { saveCount += 1; return true; } },
    sch_Drc: { async check() { drcCount += 1; return drcPassed; } },
  };
}

const eda = createMockEda();
const planned = await saveVerifyAction(eda, { mode: 'plan' });
assert.equal(planned.status, 'planned');
assert.equal(planned.readOnly, true);
assert.equal(eda.saveCount, 0);
assert.equal(eda.drcCount, 0);

const verified = await saveVerifyAction(eda, {
  mode: 'verify',
  expectedDocumentUuid: 'doc-save',
  expectedInspectionFingerprint: planned.state.inspectionFingerprint,
});
assert.equal(verified.status, 'verified');
assert.equal(verified.readOnly, true);
assert.equal(verified.saved, false);
assert.equal(eda.saveCount, 0, 'verify must not save the document');
assert.equal(eda.drcCount, 1);

const applied = await saveVerifyAction(eda, planned.applyRequest);
assert.equal(applied.status, 'applied');
assert.equal(applied.readOnly, false);
assert.equal(applied.saved, true);
assert.equal(eda.saveCount, 1);
assert.equal(eda.drcCount, 2);

const failingEda = createMockEda(false);
const failingPlan = await saveVerifyAction(failingEda, { mode: 'plan' });
const failingApply = await saveVerifyAction(failingEda, failingPlan.applyRequest);
assert.equal(failingApply.status, 'apply-failed');
assert.ok(failingApply.issues.some((issue) => issue.code === 'DRC_FAILED'));

process.stdout.write('schematic-save-verify tests passed\n');
