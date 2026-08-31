import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const wirePlanAction = await loadAction('schematic-wire-plan');
const wireCreateAction = await loadAction('schematic-wire-create', 'easyeda-pro');

const contract = {
  kind: 'flitrealize.schematic-contract',
  schemaVersion: 1,
  project: { id: 'project-test' },
  components: [{ designator: 'U1', bindings: { easyedaPro: { pinMap: { SIGNAL: ['1'] } } } }],
  nets: [{ name: 'SIG', endpoints: [{ component: 'U1', pin: 'SIGNAL' }] }],
};

function sourceSnapshot(componentX = 100) {
  return {
    kind: 'flitrealize.schematic-snapshot', schemaVersion: 1, provider: 'easyeda-pro',
    project: { id: 'project-test', nativeId: 'project-native' },
    document: { id: 'doc-test', nativeId: 'doc-wire', type: 'schematic' },
    components: [{
      designator: 'U1', nativeId: 'comp-1', position: { x: componentX, y: 100 }, rotation: 0, mirror: false,
      pins: [{ number: '1', nativeId: 'pin-1', position: { x: componentX + 10, y: 100 }, noConnect: false, extensions: { easyedaPro: { rotation: 0 } } }],
    }],
    fingerprints: { document: 'fnv1a32-snapshot' },
  };
}

function createMockEda(componentX = 100, reverseReadback = false) {
  let sequence = 0;
  const wires = [];
  const createdLines = [];
  const component = {
    getState_PrimitiveId: () => 'comp-1', getState_Designator: () => 'U1',
    getState_X: () => componentX, getState_Y: () => 100,
    getState_Rotation: () => 0, getState_Mirror: () => false,
  };
  return {
    _createdLines: createdLines,
    dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: 'doc-wire', documentType: 1, parentProjectUuid: 'project-native' }; } },
    sch_PrimitiveComponent: {
      async getAll() { return [component]; },
      async getAllPinsByPrimitiveId() {
        return [{
          getState_PrimitiveId: () => 'pin-1', getState_PinNumber: () => '1',
          getState_X: () => componentX + 10, getState_Y: () => 100,
          getState_Rotation: () => 0, getState_NoConnect: () => false,
        }];
      },
    },
    sch_PrimitiveWire: {
      async getAll() { return [...wires]; },
      async get(ids) {
        if (Array.isArray(ids)) return wires.filter((wire) => ids.includes(wire.getState_PrimitiveId()));
        return wires.find((wire) => wire.getState_PrimitiveId() === ids) ?? null;
      },
      async create(line, net, color, lineWidth, lineType) {
        createdLines.push(line);
        const id = `wire-${++sequence}`;
        const points = [];
        for (let index = 0; index + 1 < line.length; index += 2) points.push([line[index], line[index + 1]]);
        const storedLine = reverseReadback ? points.reverse().flat() : line;
        const wire = {
          getState_PrimitiveId: () => id, getState_Net: () => net,
          getState_Line: () => storedLine, getState_LineWidth: () => lineWidth ?? 1,
          getState_LineType: () => lineType ?? 0,
        };
        wires.push(wire);
        return wire;
      },
      async delete(ids) {
        const selected = new Set(ids);
        for (let index = wires.length - 1; index >= 0; index -= 1) {
          if (selected.has(wires[index].getState_PrimitiveId())) wires.splice(index, 1);
        }
        return true;
      },
    },
  };
}

const generated = await wirePlanAction(null, { mode: 'generate', contract, snapshot: sourceSnapshot(), stubLength: 8 });
const eda = createMockEda();
const planned = await wireCreateAction(eda, { mode: 'plan', plan: generated.wirePlan });
assert.equal(planned.status, 'planned');
assert.equal(planned.analysis.applyReady, true);

const applied = await wireCreateAction(eda, planned.applyRequest);
assert.equal(applied.status, 'applied');
assert.deepEqual(eda._createdLines[0], [110, 100, 118, 100], 'EasyEDA create receives a flat polyline');
assert.equal(applied.created.length, 1);

const verified = await wireCreateAction(eda, {
  mode: 'verify', expectedDocumentUuid: 'doc-wire', created: applied.created,
});
assert.equal(verified.status, 'verified');

const rolledBack = await wireCreateAction(eda, applied.rollbackRequest);
assert.equal(rolledBack.status, 'rolled-back');

const reverseEda = createMockEda(100, true);
const reversePlanned = await wireCreateAction(reverseEda, { mode: 'plan', plan: generated.wirePlan });
const reverseApplied = await wireCreateAction(reverseEda, reversePlanned.applyRequest);
assert.equal(reverseApplied.status, 'applied', 'Provider may normalize an undirected wire by reversing its point order');
const reverseVerified = await wireCreateAction(reverseEda, {
  mode: 'verify', expectedDocumentUuid: 'doc-wire', created: reverseApplied.created,
});
assert.equal(reverseVerified.status, 'verified');

const stale = await wireCreateAction(createMockEda(105), { mode: 'plan', plan: generated.wirePlan });
assert.equal(stale.analysis.applyReady, false);
assert.ok(stale.analysis.globalIssues.some((issue) => issue.code === 'SOURCE_GEOMETRY_STALE'));

process.stdout.write('schematic-wire-create tests passed\n');
