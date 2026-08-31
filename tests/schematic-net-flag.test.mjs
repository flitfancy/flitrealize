import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const netFlagAction = await loadAction('schematic-net-flag', 'easyeda-pro');

function createMockEda() {
  let sequence = 0;
  const components = [];
  function create(kind, net, x, y, rotation, mirror) {
    const id = `flag-${++sequence}`;
    const component = {
      getState_PrimitiveId: () => id, getState_Designator: () => '',
      getState_Net: () => net, getState_ComponentType: () => kind,
      getState_X: () => x, getState_Y: () => y,
      getState_Rotation: () => rotation, getState_Mirror: () => mirror,
    };
    components.push(component);
    return component;
  }
  return {
    dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: 'doc-flags', documentType: 1, parentProjectUuid: 'project' }; } },
    sch_PrimitiveComponent: {
      async getAll() { return [...components]; },
      async createNetFlag(identification, net, x, y, rotation, mirror) { return create(`flag:${identification}`, net, x, y, rotation, mirror); },
      async createNetPort(direction, net, x, y, rotation, mirror) { return create(`port:${direction}`, net, x, y, rotation, mirror); },
      async delete(ids) {
        const selected = new Set(ids);
        for (let index = components.length - 1; index >= 0; index -= 1) {
          if (selected.has(components[index].getState_PrimitiveId())) components.splice(index, 1);
        }
        return true;
      },
    },
  };
}

const eda = createMockEda();
const planned = await netFlagAction(eda, {
  mode: 'plan',
  expectedDocumentUuid: 'doc-flags',
  items: [
    { kind: 'netFlag', identification: 'Ground', net: 'GND', x: 100, y: 200, rotation: 0, mirror: false },
    { kind: 'netPort', direction: 'OUT', net: 'VOUT', x: 300, y: 200, rotation: 180, mirror: false },
  ],
});
assert.equal(planned.status, 'planned');
assert.equal(planned.analysis.itemCount, 2);
assert.ok(planned.applyRequest);

const applied = await netFlagAction(eda, planned.applyRequest);
assert.equal(applied.status, 'applied');
assert.equal(applied.created.length, 2);
assert.equal(applied.saved, false);

const verified = await netFlagAction(eda, {
  mode: 'verify', expectedDocumentUuid: 'doc-flags', created: applied.created,
});
assert.equal(verified.status, 'verified');

const rolledBack = await netFlagAction(eda, applied.rollbackRequest);
assert.equal(rolledBack.status, 'rolled-back');

const mismatch = await netFlagAction(eda, {
  mode: 'plan', expectedDocumentUuid: 'wrong-document',
  items: [{ kind: 'netFlag', identification: 'Power', net: 'VCC', x: 0, y: 0 }],
});
assert.equal(mismatch.status, 'planned-with-blockers');
assert.ok(mismatch.analysis.globalIssues.some((issue) => issue.code === 'DOCUMENT_MISMATCH'));

await assert.rejects(
  () => netFlagAction(eda, { mode: 'apply', items: [] }),
  (error) => error.code === 'INVALID_APPLY_REQUEST',
);

process.stdout.write('schematic-net-flag tests passed\n');
