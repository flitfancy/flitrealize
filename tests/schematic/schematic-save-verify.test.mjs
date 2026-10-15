import assert from 'node:assert/strict';

import { loadAction } from '../helpers/action-harness.mjs';

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
assert.equal(eda.drcCount, 1, 'plan retains a DRC baseline without saving');

const verified = await saveVerifyAction(eda, {
  mode: 'verify',
  expectedDocumentUuid: 'doc-save',
  expectedInspectionFingerprint: planned.state.inspectionFingerprint,
});
assert.equal(verified.status, 'verified');
assert.equal(verified.readOnly, true);
assert.equal(verified.saved, null);
assert.equal(verified.saveChecked, false);
assert.equal(eda.saveCount, 0, 'verify must not save the document');
assert.equal(eda.drcCount, 2);

const withoutDrc = await saveVerifyAction(eda, {
  mode: 'verify', expectedDocumentUuid: 'doc-save', runDrc: false,
});
assert.equal(withoutDrc.status, 'verified');
assert.deepEqual(withoutDrc.issues, []);
assert.equal(withoutDrc.drc.skipped, true);
assert.equal(withoutDrc.saved, null);
assert.equal(withoutDrc.saveChecked, false);
assert.equal(eda.drcCount, 2, 'skipped DRC is neither run nor reported as failed');
assert.equal(eda.saveCount, 0);

const applied = await saveVerifyAction(eda, planned.applyRequest);
assert.equal(applied.status, 'applied');
assert.equal(applied.readOnly, false);
assert.equal(applied.saved, true);
assert.equal(eda.saveCount, 1);
assert.equal(eda.drcCount, 3);

const failingEda = createMockEda(false);
const failingPlan = await saveVerifyAction(failingEda, { mode: 'plan' });
const failingApply = await saveVerifyAction(failingEda, failingPlan.applyRequest);
assert.equal(failingApply.status, 'apply-failed');
assert.ok(failingApply.issues.some((issue) => issue.code === 'DRC_FAILED'));

for (const [raw, passed, count] of [[[], true, 0], [[{ type: 'warn', count: 4 }], false, 4], [[{ type: 'warn', rule: 'dangling', primitives: [] }], false, 1], [undefined, null, undefined]]) {
  const detailed = createMockEda();
  detailed.sch_Drc.check = async () => raw;
  const result = await saveVerifyAction(detailed, { mode: 'verify', expectedDocumentUuid: 'doc-save' });
  assert.equal(result.drc.passed, passed);
  assert.equal(result.status, passed === true ? 'verified' : 'verify-failed');
  if (count !== undefined) assert.equal(result.drc.counts.warn, count);
}

process.stdout.write('schematic-save-verify tests passed\n');

const source = '{"type":"COMPONENT","id":"comp-1"}||{"x":100,"y":200}|';
const oldIssue = { type: 'warn', rule: 'old-clearance', primitives: ['comp-1'], measured: 4, required: 6 };
for (const [name, current, accepted] of [
  ['identical old item', [oldIssue], true],
  ['resolved old item', [], true],
  ['same count different object', [{ ...oldIssue, primitives: ['other'] }], false],
  ['same count different rule', [{ ...oldIssue, rule: 'short' }], false],
  ['worsened measurement', [{ ...oldIssue, measured: 3 }], false],
  ['unproven changed measurement', [{ ...oldIssue, measured: 5 }], false],
  ['new duplicate', [oldIssue, oldIssue], false],
]) {
  const mock = createMockEda();
  mock.sys_FileManager = { async getDocumentSource() { return source; } };
  mock.sch_Drc.check = async () => [oldIssue];
  const plan = await saveVerifyAction(mock, { mode: 'plan', expectedDocumentUuid: 'doc-save', executionSource: source });
  mock.sch_Drc.check = async () => current;
  const result = await saveVerifyAction(mock, plan.applyRequest);
  assert.equal(result.saved, true, name);
  assert.equal(result.status, accepted ? 'applied' : 'apply-failed', name);
  assert.equal(result.drc.comparison.passed, accepted, name);
  if (current.length) assert.equal(result.drc.passed, false, 'strict zero remains separate from increment acceptance');
}
for (const raw of [[{ type: 'warn', count: 1 }], [{ type: 'warn', rule: 'missing-objects', primitives: [] }]]) {
  const mock = createMockEda(); mock.sys_FileManager = { getDocumentSource: async () => source }; mock.sch_Drc.check = async () => raw;
  const plan = await saveVerifyAction(mock, { mode: 'plan' });
  const result = await saveVerifyAction(mock, plan.applyRequest);
  assert.equal(result.status, 'apply-failed', 'identical incomplete evidence must remain strict');
  assert.equal(result.drc.comparison.coverage, 'strict-zero');
}
{
  const mock = createMockEda(); mock.sch_Drc.check = async () => [oldIssue];
  const result = await saveVerifyAction(mock, { mode: 'verify', expectedDocumentUuid: 'doc-save' });
  assert.equal(result.status, 'verify-failed', 'a new verify does not invent the old baseline');
}
{
  const mock = createMockEda();
  const original = mock.sch_Document.save;
  mock.sch_Document.save = async () => { await original(); mock.sch_PrimitiveComponent.getAll = async () => { throw new Error('readback unavailable'); }; return true; };
  const plan = await saveVerifyAction(mock, { mode: 'plan' });
  const result = await saveVerifyAction(mock, plan.applyRequest);
  assert.equal(result.saved, true);
  assert.equal(result.status, 'apply-failed');
  assert.equal(result.drc.passed, null);
}
