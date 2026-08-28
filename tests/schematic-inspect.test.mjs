import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const inspectAction = await loadAction('schematic-inspect', 'easyeda-pro');

function createMockEda() {
  return {
    dmt_SelectControl: {
      async getCurrentDocumentInfo() {
        return { uuid: 'sch-test-uuid', tabId: 'sch-test@project', documentType: 1, parentProjectUuid: 'project-test' };
      },
    },
    sch_PrimitiveComponent: {
      async getAll() {
        return [
          {
            getState_PrimitiveId: () => 'comp-1',
            getState_Designator: () => 'U1',
            getState_X: () => 2000,
            getState_Y: () => 3000,
            getState_Rotation: () => 0,
            getState_Mirror: () => false,
            getState_AddIntoBom: () => true,
            getState_AddIntoPcb: () => true,
            getState_ComponentType: () => 0,
            getState_LibraryUuid: () => 'lib-uuid-1',
            getState_Uuid: () => 'dev-uuid-1',
          },
          {
            getState_PrimitiveId: () => 'comp-2',
            getState_Designator: () => 'R1',
            getState_X: () => 4000,
            getState_Y: () => 3000,
            getState_Rotation: () => 90,
            getState_Mirror: () => false,
            getState_AddIntoBom: () => true,
            getState_AddIntoPcb: () => true,
            getState_ComponentType: () => 0,
            getState_LibraryUuid: () => 'lib-uuid-2',
            getState_Uuid: () => 'dev-uuid-2',
          },
        ];
      },
    },
    sch_PrimitiveWire: {
      async getAll() {
        return [
          {
            getState_PrimitiveId: () => 'wire-1',
            getState_Net: () => 'VCC',
            getState_LineWidth: () => 6,
            getState_LineType: () => 'solid',
            getState_Points: () => [[2000, 3000], [4000, 3000]],
          },
        ];
      },
    },
    sch_Net: {
      async getAllNetsName() {
        return ['VCC', 'GND', 'NET1'];
      },
    },
  };
}

// Test inspect mode
const inspectResult = await inspectAction(createMockEda(), { mode: 'inspect' });
assert.equal(inspectResult.status, 'inspected');
assert.equal(inspectResult.readOnly, true);
assert.equal(inspectResult.schemaVersion, 1);
assert.equal(inspectResult.state.document.uuid, 'sch-test-uuid');
assert.equal(inspectResult.state.componentCount, 2);
assert.equal(inspectResult.state.wireCount, 1);
assert.equal(inspectResult.state.nets.length, 3);
assert.ok(inspectResult.state.inspectionFingerprint.startsWith('fnv1a32-'));

// Verify component summaries
assert.equal(inspectResult.state.components[0].primitiveId, 'comp-1');
assert.equal(inspectResult.state.components[0].designator, 'U1');
assert.equal(inspectResult.state.components[0].x, 2000);
assert.equal(inspectResult.state.components[1].designator, 'R1');
assert.equal(inspectResult.state.components[1].rotation, 90);

// Verify wire summaries
assert.equal(inspectResult.state.wires[0].primitiveId, 'wire-1');
assert.equal(inspectResult.state.wires[0].net, 'VCC');

// Verify coverage
assert.equal(inspectResult.state.coverage.document, 'ok');
assert.equal(inspectResult.state.coverage.components, 'ok');
assert.equal(inspectResult.state.coverage.wires, 'ok');
assert.equal(inspectResult.state.coverage.nets, 'ok');

// Test with unsupported APIs
const emptyEda = {
  dmt_SelectControl: {
    async getCurrentDocumentInfo() {
      return { uuid: 'empty', tabId: 'empty@project', documentType: 1, parentProjectUuid: 'project' };
    },
  },
};
const emptyResult = await inspectAction(emptyEda, { mode: 'inspect' });
assert.equal(emptyResult.state.componentCount, 0);
assert.equal(emptyResult.state.wireCount, 0);
assert.equal(emptyResult.state.nets.length, 0);
assert.equal(emptyResult.state.coverage.components, 'unsupported');

process.stdout.write('schematic-inspect tests passed\n');
