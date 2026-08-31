import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const geometryAction = await loadAction('pcb-component-geometry', 'easyeda-pro');

function createMockEda() {
  const component = {
    getState_PrimitiveId: () => 'U1-native', getState_Designator: () => 'U1',
    getState_Footprint: () => ({ uuid: 'footprint-1', name: 'QFN' }),
    getState_Layer: () => 1, getState_X: () => 10, getState_Y: () => 20,
    getState_Rotation: () => 90, getState_Pads: () => ['1'],
  };
  const pad = {
    getState_PrimitiveId: () => 'pad-1', getState_PadNumber: () => '1',
    getState_Net: () => 'GND', getState_Layer: () => 1,
    getState_X: () => 10, getState_Y: () => 20, getState_Rotation: () => 0,
    getState_Pad: () => ({ shape: 'rect' }), getState_Hole: () => null,
    getState_HoleOffsetX: () => 0, getState_HoleOffsetY: () => 0,
    getState_HoleRotation: () => 0, getState_Metallization: () => true,
  };
  const footprintSource = `${JSON.stringify({ type: 'PAD', id: 'pad-source' })}||${JSON.stringify({ x: 10, y: 20 })}|`;
  const documentSource = `${JSON.stringify({ type: 'PRIMITIVE', id: 'U1-native-1' })}||${JSON.stringify({})}|`;
  return {
    dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: 'pcb-doc', tabId: 'pcb@project', documentType: 3, parentProjectUuid: 'project' }; } },
    pcb_PrimitiveComponent: { async getAll() { return [component]; } },
    pcb_PrimitivePad: { async getAll() { return [pad]; } },
    pcb_Primitive: { async getPrimitivesBBox() { return { minX: 5, minY: 15, maxX: 15, maxY: 25 }; } },
    sys_FileManager: {
      async getDocumentFootprintSources() { return [{ footprintUuid: 'footprint-1', documentSource: footprintSource }]; },
      async getDocumentSource() { return documentSource; },
    },
  };
}

const result = await geometryAction(createMockEda(), { designators: ['U1'], expectedDocumentUuid: 'pcb-doc' });
assert.equal(result.status, 'inspected');
assert.equal(result.readOnly, true);
assert.equal(result.components.length, 1);
assert.equal(result.components[0].bbox.status, 'ok');
assert.equal(result.components[0].nearbyPads.length, 1);
assert.equal(result.components[0].footprintSource.parsedRecordCount, 1);
assert.equal(result.components[0].footprintSource.geometryRecords[0].type, 'PAD');

await assert.rejects(
  () => geometryAction(createMockEda(), { designators: ['MISSING'] }),
  (error) => error.code === 'COMPONENT_NOT_FOUND',
);

process.stdout.write('pcb-component-geometry tests passed\n');
