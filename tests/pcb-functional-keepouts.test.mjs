import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const execute = await loadAction('pcb-functional-keepouts', 'easyeda-pro');

function createMock() {
  const regions = [];
  let sequence = 0;
  const polygon = (source) => ({ getSource: () => structuredClone(source) });
  const makeRegion = (layer, source, ruleTypes, name, lineWidth, locked) => {
    const id = `region-${++sequence}`;
    return {
      getState_PrimitiveId: () => id,
      getState_RegionName: () => name,
      getState_Layer: () => layer,
      getState_RuleType: () => [...ruleTypes],
      getState_LineWidth: () => lineWidth,
      getState_PrimitiveLock: () => locked,
      getState_ComplexPolygon: () => polygon(source),
    };
  };
  const empty = { async getAll() { return []; } };
  return {
    dmt_SelectControl: {
      async getCurrentDocumentInfo() {
        return { uuid: 'pcb-test', tabId: 'pcb-test@project-test', documentType: 3, parentProjectUuid: 'project-test' };
      },
    },
    pcb_MathPolygon: { createPolygon: polygon },
    pcb_PrimitiveLine: empty,
    pcb_PrimitiveArc: empty,
    pcb_PrimitivePolyline: empty,
    pcb_PrimitiveVia: empty,
    pcb_PrimitiveComponent: empty,
    pcb_PrimitivePour: empty,
    pcb_PrimitiveRegion: {
      async getAll() { return [...regions]; },
      async create(layer, complexPolygon, ruleTypes, name, lineWidth, locked) {
        const region = makeRegion(layer, complexPolygon.getSource(), ruleTypes, name, lineWidth, locked);
        regions.push(region);
        return region;
      },
      async get(id) { return regions.find((item) => item.getState_PrimitiveId() === id); },
      async delete(ids) {
        const list = Array.isArray(ids) ? ids : [ids];
        for (let index = regions.length - 1; index >= 0; index -= 1) {
          if (list.includes(regions[index].getState_PrimitiveId())) regions.splice(index, 1);
        }
        return true;
      },
    },
  };
}

const eda = createMock();
const inspected = await execute(eda, { mode: 'inspect' });
assert.equal(inspected.status, 'inspected');
assert.equal(inspected.state.regions.length, 0);

const plan = {
  schemaVersion: 1,
  expectedDocumentUuid: 'pcb-test',
  expectedInspectionFingerprint: inspected.state.inspectionFingerprint,
  regions: [
    { name: 'MIC_U6_SOUND_PORT', layer: 12, ruleTypes: [5, 6, 7, 8], polygonSource: ['CIRCLE', 700, 1348.15, 40], primitiveLock: true },
    { name: 'MIC_U7_SOUND_PORT', layer: 12, ruleTypes: [5, 6, 7, 8], polygonSource: ['CIRCLE', 2114.975, 1343.15, 40], primitiveLock: true },
  ],
};

const planned = await execute(eda, { mode: 'plan', plan });
assert.equal(planned.status, 'planned');
assert.equal(planned.plan.regions.length, 2);

const applied = await execute(eda, { mode: 'apply', plan });
assert.equal(applied.status, 'applied');
assert.equal(applied.createdRegionIds.length, 2);
assert.equal(applied.createdRegions[0].primitiveLock, true);
assert.equal(applied.before.protectedFingerprint, applied.after.protectedFingerprint);

const verified = await execute(eda, { mode: 'verify', plan, expectedRegionIds: applied.createdRegionIds });
assert.equal(verified.status, 'verified');
assert.deepEqual(verified.issues, []);

const rolledBack = await execute(eda, applied.rollbackRequest);
assert.equal(rolledBack.status, 'rolled-back');
assert.equal(rolledBack.after.regions.length, 0);

process.stdout.write('pcb-functional-keepouts tests passed\n');
