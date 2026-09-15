import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const executeAction = await loadAction('pcb-board-outline', 'easyeda-pro');

function createMockEda({ existing = [] } = {}) {
  const outlines = existing.map((item) => ({ ...item }));
  const created = [];
  const target = {
    uuid: 'pcb-outline-test',
    documentType: 3,
    parentProjectUuid: 'project-outline-test',
  };
  return {
    outlines,
    created,
    dmt_SelectControl: {
      async getCurrentDocumentInfo() {
        return { ...target, tabId: `${target.uuid}@${target.parentProjectUuid}` };
      },
    },
    dmt_Project: {
      async getCurrentProjectInfo() {
        return { uuid: target.parentProjectUuid, name: 'test/outline', friendlyName: 'Outline Test' };
      },
    },
    pcb_PrimitivePolyline: {
      async getAll(layer) {
        if (layer !== 11) return [];
        return outlines.map((item) => item.object);
      },
      async create(net, layer, polygon, width, locked) {
        const source = polygon.getSource();
        const object = {
          getState_PrimitiveId: () => `outline-${created.length + 1}`,
          getState_Layer: () => layer,
          getState_LineWidth: () => width,
          getState_Polygon: () => ({ getSource: () => source }),
        };
        const record = { object, primitiveId: `outline-${created.length + 1}`, layer, width, source, net, locked };
        outlines.push(record);
        created.push(record);
        return object;
      },
      async delete(objectOrRecord) {
        const id = typeof objectOrRecord?.getState_PrimitiveId === 'function'
          ? objectOrRecord.getState_PrimitiveId()
          : objectOrRecord?.primitiveId;
        const index = outlines.findIndex((item) => item.primitiveId === id || item.object === objectOrRecord);
        if (index < 0) return false;
        outlines.splice(index, 1);
        return true;
      },
    },
    pcb_MathPolygon: {
      createPolygon(source) {
        return { getSource: () => source };
      },
    },
    pcb_Document: {
      async save() {
        return true;
      },
    },
  };
}

const target = {
  expectedProjectUuid: 'project-outline-test',
  expectedDocumentUuid: 'pcb-outline-test',
};

const empty = createMockEda();
const inspected = await executeAction(empty, { mode: 'inspect', ...target });
assert.equal(inspected.status, 'inspected');
assert.equal(inspected.count, 0);

const planned = await executeAction(empty, {
  mode: 'plan',
  ...target,
  rect: { originX: 0, originY: 0, widthMil: 1000, heightMil: 500 },
  lineWidthMil: 10,
});
assert.equal(planned.status, 'planned');
assert.equal(planned.applyRequest.mode, 'apply');
assert.deepEqual(planned.plan.path.slice(0, 3), [0, 0, 'L']);

const applied = await executeAction(empty, planned.applyRequest);
assert.equal(applied.status, 'applied');
assert.equal(applied.outline.layer, 11);
assert.equal(applied.outline.lineWidthMil, 10);
assert.ok(Array.isArray(applied.outline.source) && applied.outline.source.length >= 10);

const verified = await executeAction(empty, { mode: 'verify', ...target });
assert.equal(verified.status, 'verified');

const saved = await executeAction(empty, { mode: 'save', ...target });
assert.equal(saved.status, 'applied');
assert.equal(saved.saved, true);

const occupied = createMockEda({
  existing: [{
    primitiveId: 'old-outline',
    layer: 11,
    lineWidthMil: 10,
    source: [0, 0, 'L', 10, 0, 10, 10, 0, 10, 0, 0],
    object: {
      getState_PrimitiveId: () => 'old-outline',
      getState_Layer: () => 11,
      getState_LineWidth: () => 10,
      getState_Polygon: () => ({ getSource: () => [0, 0, 'L', 10, 0, 10, 10, 0, 10, 0, 0] }),
    },
  }],
});
await assert.rejects(
  async () => executeAction(occupied, {
    mode: 'plan',
    ...target,
    rect: { originX: 0, originY: 0, widthMil: 1000, heightMil: 500 },
  }),
  (error) => error?.code === 'OUTLINE_ALREADY_EXISTS',
);

const replaced = await executeAction(occupied, {
  mode: 'apply',
  ...target,
  replace: true,
  rect: { originX: 0, originY: 0, widthMil: 2000, heightMil: 800 },
  lineWidthMil: 10,
});
assert.equal(replaced.status, 'applied');
assert.deepEqual(replaced.removedIds, ['old-outline']);
assert.equal(replaced.outline.lineWidthMil, 10);

process.stdout.write('pcb-board-outline tests passed\n');
