import assert from 'node:assert/strict';
import test from 'node:test';

import { loadAction } from '../helpers/action-harness.mjs';

const executeAction = await loadAction('pcb-layer-stack', 'easyeda-pro');

function createMockEda() {
  const writes = [];
  let documentUuid = 'pcb-test';
  const layers = [
    { id: 1, name: 'TopLayer', type: 'SIGNAL', color: '#FF0000', transparency: 0, locked: false },
    { id: 2, name: 'BottomLayer', type: 'SIGNAL', color: '#0000FF', transparency: 0, locked: false },
  ];
  return {
    layers, writes,
    selectDocument(uuid) { documentUuid = uuid; },
    dmt_SelectControl: {
      async getCurrentDocumentInfo() {
        return { uuid: documentUuid, tabId: `${documentUuid}@project-test`, documentType: 3, parentProjectUuid: 'project-test' };
      },
    },
    dmt_Project: {
      async getCurrentProjectInfo() {
        return { uuid: 'project-test', name: 'test/project', friendlyName: 'Test Project' };
      },
    },
    pcb_Layer: {
      async getAllLayers() {
        return structuredClone(layers);
      },
      async getCurrentPhysicalStackingConfiguration() {
        return { name: 'mock', layerCount: layers.filter((layer) => layer.id === 1 || layer.id === 2 || layer.id >= 15).length, list: [] };
      },
      async setTheNumberOfCopperLayers(count) {
        writes.push({ method: 'setTheNumberOfCopperLayers', count });
        const desiredInner = count - 2;
        for (let index = layers.length - 1; index >= 0; index -= 1) {
          if (layers[index].id >= 15) layers.splice(index, 1);
        }
        for (let index = 0; index < desiredInner; index += 1) {
          layers.push({ id: 15 + index, name: `Inner${index + 1}`, type: 'SIGNAL', color: '#00AA00', transparency: 0, locked: false });
        }
        layers.sort((left, right) => left.id - right.id);
        return true;
      },
      async modifyLayer(id, property) {
        writes.push({ method: 'modifyLayer', id, property: structuredClone(property) });
        const layer = layers.find((item) => item.id === id);
        if (!layer) return false;
        Object.assign(layer, property);
        return true;
      },
    },
  };
}

const eda = createMockEda();
const inspected = await executeAction(eda, { mode: 'inspect' });
assert.equal(inspected.status, 'inspected');
assert.equal(inspected.state.copperLayerCount, 2);

const plan = {
  schemaVersion: 1,
  expectedDocumentUuid: 'pcb-test',
  copperLayerCount: 4,
  physicalStackSource: 'test-only',
  layers: [
    { id: 1, role: 'signal' },
    { id: 15, name: 'GND_REF_L2', type: 'SIGNAL', role: 'reference-plane', net: 'GND' },
    { id: 16, name: 'ROUTING_L3', type: 'SIGNAL', role: 'mixed' },
    { id: 2, role: 'signal' },
  ],
};

const planned = await executeAction(eda, { mode: 'plan', plan });
assert.equal(planned.status, 'planned');
assert.equal(planned.planeFollowUp.length, 1);

const applied = await executeAction(eda, { mode: 'apply', plan });
assert.equal(applied.status, 'applied');
assert.equal(applied.after.copperLayerCount, 4);
assert.equal(applied.after.layers[1].name, 'GND_REF_L2');
assert.equal(applied.saved, false);

const verified = await executeAction(eda, { mode: 'verify', plan });
assert.equal(verified.status, 'verified');
assert.deepEqual(verified.issues, []);

const rolledBack = await executeAction(eda, {
  mode: 'rollback',
  snapshot: applied.before,
  expectedCurrentFingerprint: applied.after.fingerprint,
});
assert.equal(rolledBack.status, 'rolled-back');
assert.equal(rolledBack.restoredState.copperLayerCount, 2);

for (const fault of ['name', 'type', 'count', 'document']) {
  test(`old layer rollback refuses changed ${fault} before any write`, async () => {
    const mock = createMockEda();
    const applied = await executeAction(mock, { mode: 'apply', plan });
    if (fault === 'name') mock.layers.find(layer => layer.id === 15).name = 'USER_LAYER';
    if (fault === 'type') mock.layers.find(layer => layer.id === 15).type = 'PLANE';
    if (fault === 'count') await mock.pcb_Layer.setTheNumberOfCopperLayers(6);
    if (fault === 'document') mock.selectDocument('another-pcb');
    const before = structuredClone(mock.layers);
    mock.writes.length = 0;
    await assert.rejects(executeAction(mock, { mode: 'rollback', snapshot: applied.before,
      expectedCurrentFingerprint: applied.after.fingerprint }),
    { code: fault === 'document' ? 'DOCUMENT_MISMATCH' : 'STALE_ROLLBACK' });
    assert.deepEqual(mock.writes, []);
    assert.deepEqual(mock.layers, before);
  });
}

for (const reply of ['false', 'throw-after-write']) {
  test(`partial layer apply restores the baseline after ${reply}`, async () => {
    const mock = createMockEda(), modify = mock.pcb_Layer.modifyLayer;
    const before = (await executeAction(mock, { mode: 'inspect' })).state;
    let injected = false;
    mock.pcb_Layer.modifyLayer = async (id, property) => {
      if (!injected && id === 16) {
        injected = true;
        if (reply === 'false') return false;
        await modify(id, property);
        throw Error('Reply lost after the second layer changed');
      }
      return modify(id, property);
    };
    const result = await executeAction(mock, { mode: 'apply', plan });
    assert.equal(result.status, 'rolled-back');
    assert.equal(result.saved, false);
    assert.equal(result.restoredState.fingerprint, before.fingerprint);
    assert.deepEqual(result.restoreIssues, []);
    assert.ok(mock.writes.some(write => write.method === 'modifyLayer' && write.id === 15));
    assert.ok(mock.writes.some(write => write.method === 'setTheNumberOfCopperLayers' && write.count === 2));
  });
}

test('failed recovery never reports a completed rollback', async () => {
  const mock = createMockEda(), setCount = mock.pcb_Layer.setTheNumberOfCopperLayers;
  mock.pcb_Layer.modifyLayer = async () => false;
  mock.pcb_Layer.setTheNumberOfCopperLayers = async count => count === 2 ? false : setCount(count);
  const result = await executeAction(mock, { mode: 'apply', plan });
  assert.equal(result.status, 'rollback-incomplete');
  assert.equal(result.saved, false);
  assert.ok(result.restoreIssues.some(issue => issue.code === 'RESTORE_LAYER_COUNT_FAILED'));
  assert.ok(result.restoreIssues.some(issue => issue.code === 'RESTORE_FINGERPRINT_MISMATCH'));
});

process.stdout.write('pcb-layer-stack tests passed\n');
