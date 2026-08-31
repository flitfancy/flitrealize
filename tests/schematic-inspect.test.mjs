import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const inspectAction = await loadAction('schematic-inspect', 'easyeda-pro');

function createMockEda(componentX = 2000) {
  const components = [
    {
      getState_PrimitiveId: () => 'comp-1', getState_Designator: () => 'U1',
      getState_X: () => componentX, getState_Y: () => 3000, getState_Rotation: () => 0, getState_Mirror: () => false,
      getState_AddIntoBom: () => true, getState_AddIntoPcb: () => true, getState_ComponentType: () => 0,
      getState_LibraryUuid: () => 'lib-uuid-1', getState_Uuid: () => 'dev-uuid-1',
    },
    {
      getState_PrimitiveId: () => 'comp-2', getState_Designator: () => 'R1',
      getState_X: () => 4000, getState_Y: () => 3000, getState_Rotation: () => 90, getState_Mirror: () => false,
      getState_AddIntoBom: () => true, getState_AddIntoPcb: () => true, getState_ComponentType: () => 0,
      getState_LibraryUuid: () => 'lib-uuid-2', getState_Uuid: () => 'dev-uuid-2',
    },
  ];
  return {
    dmt_SelectControl: {
      async getCurrentDocumentInfo() {
        return { uuid: 'sch-test-uuid', tabId: 'sch-test@project', documentType: 1, parentProjectUuid: 'project-test' };
      },
    },
    sch_PrimitiveComponent: {
      async getAll() { return components; },
      async getAllPinsByPrimitiveId(id) {
        const x = id === 'comp-1' ? componentX + 100 : 3900;
        return [{
          getState_PrimitiveId: () => `${id}-pin-1`,
          getState_PinNumber: () => '1',
          getState_PinName: () => 'IN',
          getState_X: () => x,
          getState_Y: () => 3000,
          getState_Rotation: () => 0,
          getState_NoConnect: () => false,
        }];
      },
    },
    sch_PrimitiveWire: {
      async getAll() {
        return [{
          getState_PrimitiveId: () => 'wire-1', getState_Net: () => 'VCC',
          getState_LineWidth: () => 6, getState_LineType: () => 0,
          getState_Line: () => [2100, 3000, 3900, 3000],
        }];
      },
    },
    sch_Net: { async getAllNetsName() { return ['VCC', 'GND', 'NET1']; } },
  };
}

const inspectResult = await inspectAction(createMockEda(), { mode: 'inspect' });
assert.equal(inspectResult.status, 'inspected-with-gaps');
assert.equal(inspectResult.readOnly, true);
assert.equal(inspectResult.schemaVersion, 2);
assert.equal(inspectResult.snapshot.kind, 'flitrealize.schematic-snapshot');
assert.equal(inspectResult.snapshot.document.nativeId, 'sch-test-uuid');
assert.equal(inspectResult.snapshot.components.length, 2);
assert.equal(inspectResult.snapshot.nets.length, 3);
assert.equal(inspectResult.snapshot.components[0].designator, 'U1');
assert.deepEqual(inspectResult.snapshot.components[0].position, { x: 2000, y: 3000 });
assert.deepEqual(inspectResult.snapshot.components[0].pins[0].position, { x: 2100, y: 3000 });
assert.equal(inspectResult.snapshot.components[0].pins[0].number, '1');
assert.deepEqual(inspectResult.snapshot.extensions.easyedaPro.wires[0].points, [{ x: 2100, y: 3000 }, { x: 3900, y: 3000 }]);
assert.ok(inspectResult.snapshot.coverage.unknown.includes('net-endpoints'));
assert.ok(inspectResult.snapshot.fingerprints.document.startsWith('fnv1a32-'));

const movedResult = await inspectAction(createMockEda(2200), { mode: 'inspect' });
assert.notEqual(movedResult.snapshot.fingerprints.components, inspectResult.snapshot.fingerprints.components);
assert.notEqual(movedResult.snapshot.fingerprints.document, inspectResult.snapshot.fingerprints.document);

const emptyEda = {
  dmt_SelectControl: {
    async getCurrentDocumentInfo() {
      return { uuid: 'empty', tabId: 'empty@project', documentType: 1, parentProjectUuid: 'project' };
    },
  },
};
const emptyResult = await inspectAction(emptyEda, { mode: 'inspect' });
assert.equal(emptyResult.status, 'inspected-with-gaps');
assert.equal(emptyResult.state.componentCount, 0);
assert.equal(emptyResult.state.coverage.components, 'unsupported');

process.stdout.write('schematic-inspect tests passed\n');
