import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const execute = await loadAction('pcb-ground-pours');

function createMock() {
  const pours = [];
  const poured = [];
  let sequence = 0;
  const polygon = (source) => ({
    getSource: () => structuredClone(source),
    async discretize() {
      if (source[0] !== 'R') return [];
      const [, x, y, width, height] = source;
      return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
    },
  });
  const makePoured = (pourId) => ({
    getState_PrimitiveId: () => `poured-${pourId}`,
    getState_PourPrimitiveId: () => pourId,
    getState_PourFills: () => [{ id: 'fill-1' }],
  });
  const makePour = (net, layer, source, fillMethod, preserveSilos, name, priority, lineWidth, locked) => {
    const id = `pour-${++sequence}`;
    let copper = null;
    return {
      getState_PrimitiveId: () => id,
      getState_Net: () => net,
      getState_Layer: () => layer,
      getState_PourFillMethod: () => fillMethod,
      getState_PreserveSilos: () => preserveSilos,
      getState_PourName: () => name,
      getState_PourPriority: () => priority,
      getState_LineWidth: () => lineWidth,
      getState_PrimitiveLock: () => locked,
      getState_ComplexPolygon: () => polygon(source),
      async rebuildCopperRegion() {
        if (!copper) {
          copper = makePoured(id);
          poured.push(copper);
        }
        return copper;
      },
      async getCopperRegion() { return copper; },
    };
  };
  const empty = { async getAll() { return []; } };
  const outline = {
    getState_PrimitiveId: () => 'outline-1',
    getState_Net: () => '',
    getState_Layer: () => 11,
    getState_LineWidth: () => 10,
    getState_Polygon: () => polygon(['R', 5, 1461.6929, 2322.8346, 1456.6929, 0, 118.1102]),
  };
  return {
    dmt_SelectControl: {
      async getCurrentDocumentInfo() {
        return { uuid: 'pcb-test', tabId: 'pcb-test@project-test', documentType: 3, parentProjectUuid: 'project-test' };
      },
    },
    dmt_Project: { async getCurrentProjectInfo() { return { uuid: 'project-test', name: 'test/project', friendlyName: 'Test' }; } },
    pcb_Layer: {
      async getAllLayers() {
        return [
          { id: 1, name: 'Top Layer', type: 'SIGNAL', layerStatus: 1 },
          { id: 15, name: 'GND_PLANE_L2', type: 'SIGNAL', layerStatus: 1 },
          { id: 16, name: 'GND_PLANE_L3', type: 'SIGNAL', layerStatus: 1 },
          { id: 2, name: 'Bottom Layer', type: 'SIGNAL', layerStatus: 1 },
        ];
      },
    },
    pcb_MathPolygon: { createPolygon: polygon, async discretize(value) { return value.discretize(); } },
    pcb_PrimitiveLine: empty,
    pcb_PrimitiveArc: empty,
    pcb_PrimitivePolyline: { async getAll() { return [outline]; } },
    pcb_PrimitiveVia: empty,
    pcb_PrimitiveComponent: empty,
    pcb_PrimitiveRegion: empty,
    pcb_PrimitivePour: {
      async getAll() { return [...pours]; },
      async create(net, layer, complexPolygon, fillMethod, preserveSilos, name, priority, lineWidth, locked) {
        const pour = makePour(net, layer, complexPolygon.getSource(), fillMethod, preserveSilos, name, priority, lineWidth, locked);
        pours.push(pour);
        return pour;
      },
      async get(id) { return pours.find((item) => item.getState_PrimitiveId() === id); },
      async delete(ids) {
        const list = Array.isArray(ids) ? ids : [ids];
        for (let index = pours.length - 1; index >= 0; index -= 1) {
          if (list.includes(pours[index].getState_PrimitiveId())) pours.splice(index, 1);
        }
        for (let index = poured.length - 1; index >= 0; index -= 1) {
          if (list.includes(poured[index].getState_PourPrimitiveId())) poured.splice(index, 1);
        }
        return true;
      },
    },
    pcb_PrimitivePoured: { async getAll() { return [...poured]; } },
  };
}

const eda = createMock();
const inspected = await execute(eda, { mode: 'inspect' });
assert.equal(inspected.status, 'inspected');
assert.equal(inspected.state.outline.selected.kind, 'polyline');

const plan = {
  schemaVersion: 1,
  expectedDocumentUuid: 'pcb-test',
  expectedInspectionFingerprint: inspected.state.inspectionFingerprint,
  expectedOutlineFingerprint: inspected.state.outline.fingerprint,
  net: 'GND',
  layerIds: [15],
  fillMethod: 'solid',
  preserveSilos: false,
  pourNamePrefix: 'FLITREALIZE_GND',
  priority: 1,
  lineWidth: 10,
  primitiveLock: false,
};

const planned = await execute(eda, { mode: 'plan', plan });
assert.equal(planned.status, 'planned');
assert.deepEqual(planned.plan.polygonSource, ['R', 5, 1461.6929, 2322.8346, 1456.6929, 0, 118.1102]);

const applied = await execute(eda, { mode: 'apply', plan });
assert.equal(applied.status, 'applied');
assert.equal(applied.createdPours.length, 1);
assert.equal(applied.createdPoured[0].fillCount, 1);
assert.equal(applied.before.invariantFingerprint, applied.after.invariantFingerprint);

const verified = await execute(eda, { mode: 'verify', plan, expectedPourIds: applied.createdPourIds });
assert.equal(verified.status, 'verified');
assert.deepEqual(verified.issues, []);

const rolledBack = await execute(eda, applied.rollbackRequest);
assert.equal(rolledBack.status, 'rolled-back');
assert.equal(rolledBack.after.pours.length, 0);

process.stdout.write('pcb-ground-pours tests passed\n');
