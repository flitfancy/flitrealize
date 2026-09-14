import assert from 'node:assert/strict';
import test from 'node:test';
import { planConnections } from '../scripts/lib/schematic-connect-plan.mjs';

function fixture() {
  const contract = {
    kind: 'flitrealize.schematic-contract', schemaVersion: 1, project: { id: 'portable-fixture' },
    components: [
      { designator: 'U1', pins: [{ number: 'OUT', classification: 'signal' }, { number: 'NC', classification: 'no-connect' }], bindings: { easyedaPro: { pinMap: { OUT: ['1'], NC: ['2'] } } } },
      { designator: 'J9', pins: [{ number: '1', classification: 'signal' }] },
    ],
    nets: [{ name: 'SENSE', kind: 'signal', endpoints: [{ component: 'U1', pin: 'OUT' }, { component: 'J9', pin: '1' }] }],
  };
  const snapshot = {
    kind: 'flitrealize.schematic-snapshot', schemaVersion: 1, provider: 'easyeda-pro',
    project: { id: 'portable-native', nativeId: 'portable-native' }, document: { id: 'page-x', nativeId: 'page-x' },
    capturedAt: '2026-09-12T00:00:00.000Z', fingerprints: { document: 'snapshot-x' },
    components: [
      { designator: 'U1', nativeId: 'part-a', value: 'SomeIC', position: { x: 0, y: 0 }, pins: [
        { number: '1', nativeId: 'a1', position: { x: 10, y: 0 }, noConnect: false },
        { number: '2', nativeId: 'a2', position: { x: 0, y: -10 }, noConnect: false },
      ] },
      { designator: 'J9', nativeId: 'part-b', value: 'Header', position: { x: 100, y: 0 }, pins: [
        { number: '1', nativeId: 'b1', position: { x: 90, y: 0 }, noConnect: false },
      ] },
    ],
    extensions: { easyedaPro: { sourceEvidence: 'ok', sourceFingerprint: 'source-x', wires: [], markers: [] } },
  };
  return { input: { contract, expectedDocumentUuid: 'page-x', expectedProjectUuid: 'portable-native' }, snapshot };
}
function complete(f, { markers = true, nc = true } = {}) {
  const provider = f.snapshot.extensions.easyedaPro;
  provider.wires = [
    { primitiveId: 'wire-a', net: 'SENSE', points: [{ x: 10, y: 0 }, { x: 18, y: 0 }], netVisible: true, netAttrCount: 1 },
    { primitiveId: 'wire-b', net: 'SENSE', points: [{ x: 90, y: 0 }, { x: 82, y: 0 }], netVisible: true, netAttrCount: 1 },
  ];
  if (markers) provider.markers = [18, 82].map((x, index) => ({ primitiveId: `marker-${index}`, componentType: 'netport', net: 'SENSE', x, y: 0, rotation: 0, mirror: false, nameVisible: false, nameAttrCount: 1 }));
  if (nc) f.snapshot.components[0].pins[1].noConnect = true;
  return f;
}
const codes = result => result.diagnostics.map(diagnostic => diagnostic.code);

test('fresh generic design derives semantic pin mapping, flags and only declared NC without input mutation', async () => {
  const f = fixture(), before = JSON.stringify(f);
  const result = await planConnections(f.input, f.snapshot);
  assert.equal(result.applyReady, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.pending, { wires: 2, flags: 2, noConnect: 1 });
  assert.equal(result.verified, false);
  assert.deepEqual(result.wireItems[0].points, [{ x: 10, y: 0 }, { x: 18, y: 0 }]);
  assert.equal(result.wireItems[0].endpoint.providerPin, '1');
  assert.deepEqual(result.noConnectItems.map(item => `${item.designator}.${item.pin}`), ['U1.2']);
  assert.ok(result.flagItems.every(item => item.showName === false));
  assert.equal(result.scope.actualPinCount, 3);
  assert.equal(result.scope.classifiedPinCount, 3);
  assert.equal(JSON.stringify(f), before);
  assert.deepEqual(await planConnections(f.input, f.snapshot), result);
});

test('resume repairs missing markers on existing stubs and does not duplicate wires', async () => {
  const f = complete(fixture(), { markers: false });
  const result = await planConnections(f.input, f.snapshot);
  assert.equal(result.applyReady, true, JSON.stringify(result.diagnostics));
  assert.equal(result.wireItems.length, 0);
  assert.equal(result.missingFlagItems.length, 2);
  assert.equal(result.noConnectItems.length, 1);
  assert.equal(result.pendingNoConnectItems.length, 0);
  const verified = await planConnections(f.input, f.snapshot, { phase: 'verify' });
  assert.equal(verified.verified, false);
  assert.ok(codes(verified).includes('MARKERS_INCOMPLETE'));
});

test('complete snapshot verifies idempotently including a reverse point-order stub', async () => {
  const f = complete(fixture());
  f.snapshot.extensions.easyedaPro.wires[0].points.reverse();
  const result = await planConnections(f.input, f.snapshot, { phase: 'verify' });
  assert.equal(result.verified, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.pending, { wires: 0, flags: 0, noConnect: 0 });
});

test('extra provider pins need a reasoned declaration, never blanket floating-pin NC', async () => {
  const f = fixture();
  f.snapshot.components[0].pins.push({ number: 'MP1', nativeId: 'mount', position: { x: -10, y: 0 }, noConnect: false });
  let result = await planConnections(f.input, f.snapshot);
  assert.ok(codes(result).includes('UNCLASSIFIED_LIVE_PIN'));
  assert.equal(result.noConnectItems.length, 1);
  f.input.providerPinNoConnect = [{ designator: 'U1', pin: 'MP1', reason: 'Verified isolated mechanical tab in selected footprint.' }];
  result = await planConnections(f.input, f.snapshot);
  assert.equal(result.applyReady, true, JSON.stringify(result.diagnostics));
  assert.equal(result.noConnectItems.length, 2);
  f.input.providerPinNoConnect[0].pin = '1';
  result = await planConnections(f.input, f.snapshot);
  assert.ok(codes(result).includes('PIN_INTENT_CONFLICT'));
  assert.ok(codes(result).includes('PROVIDER_NC_NOT_EXTRA'));
});

test('Contract NC and net overlap blocks even when semantic aliases map to one physical pin', async () => {
  const f = fixture();
  f.input.contract.components[0].bindings.easyedaPro.pinMap.NC = ['1'];
  const result = await planConnections(f.input, f.snapshot);
  assert.equal(result.applyReady, false);
  assert.ok(codes(result).includes('PIN_INTENT_CONFLICT'));
});

test('missing components need explicit deferral and a partial scope cannot claim full-document coverage', async () => {
  const f = fixture();
  f.input.contract.components.push({ designator: 'TP7', pins: [{ number: '1', classification: 'signal' }] });
  f.input.contract.nets[0].endpoints.push({ component: 'TP7', pin: '1' });
  let result = await planConnections(f.input, f.snapshot);
  assert.ok(codes(result).includes('COMPONENT_NOT_REALIZED'));
  f.input.deferredComponents = [{ designator: 'TP7', reason: 'PCB-only test pad deferred explicitly.' }];
  result = await planConnections(f.input, f.snapshot);
  assert.equal(result.applyReady, true, JSON.stringify(result.diagnostics));
  assert.equal(result.scope.deferredComponents.length, 1);
  assert.equal(result.scope.completeContract, false);
  f.input.designators = ['U1'];
  f.input.deferredComponents = [];
  result = await planConnections(f.input, f.snapshot);
  assert.equal(result.scope.fullDocument, false);
  assert.deepEqual(result.scope.excludedLiveDesignators, ['J9']);
  assert.equal(result.wireItems.length, 1);
});

test('source evidence, Values and target identity are required before any apply', async () => {
  const f = fixture();
  f.input.expectedProjectUuid = 'other-project';
  f.snapshot.extensions.easyedaPro.sourceEvidence = 'unsupported';
  f.snapshot.components[0].value = '  ';
  const result = await planConnections(f.input, f.snapshot);
  assert.equal(result.applyReady, false);
  for (const code of ['TARGET_MISMATCH', 'CONNECTION_EVIDENCE_REQUIRED', 'COMPONENT_VALUE_EMPTY']) assert.ok(codes(result).includes(code));
});

test('duplicate labels and duplicate markers are blocking, not silently hidden or regenerated', async () => {
  const f = complete(fixture());
  f.snapshot.extensions.easyedaPro.wires[0].netAttrCount = 2;
  f.snapshot.extensions.easyedaPro.markers[0].nameVisible = true;
  f.snapshot.extensions.easyedaPro.markers.push({ ...f.snapshot.extensions.easyedaPro.markers[0], primitiveId: 'duplicate' });
  const result = await planConnections(f.input, f.snapshot);
  assert.equal(result.applyReady, false);
  for (const code of ['WIRE_LABEL_INVALID', 'MARKER_LABEL_INVALID', 'DUPLICATE_MARKER']) assert.ok(codes(result).includes(code));
  assert.equal(result.missingFlagItems.length, 0);
});

test('same-named long/manual routes do not pass as supported endpoint stubs', async () => {
  const f = complete(fixture());
  f.snapshot.extensions.easyedaPro.wires[0].points[1].x = 70;
  const result = await planConnections(f.input, f.snapshot);
  assert.equal(result.applyReady, false);
  assert.ok(codes(result).includes('EXISTING_TOPOLOGY_UNSUPPORTED'));
});

test('conflicting wire remains a blocker even when another matching wire touches the pin', async () => {
  const f = complete(fixture());
  f.snapshot.extensions.easyedaPro.wires.push({ primitiveId: 'conflict', net: 'VDD', points: [{ x: 10, y: 0 }, { x: 10, y: 20 }], netVisible: true, netAttrCount: 1 });
  const result = await planConnections(f.input, f.snapshot);
  assert.equal(result.applyReady, false);
  assert.ok(codes(result).includes('EXISTING_WIRE_NET_MISMATCH'));
});

test('new stubs crossing existing routing or another pin are blocked geometrically', async () => {
  const f = fixture();
  f.snapshot.extensions.easyedaPro.wires.push({ primitiveId: 'crossing', net: 'OTHER', points: [{ x: 14, y: -5 }, { x: 14, y: 5 }], netVisible: true, netAttrCount: 1 });
  f.snapshot.components[1].pins[0].position = { x: 16, y: 0 };
  const result = await planConnections(f.input, f.snapshot);
  assert.equal(result.applyReady, false);
  assert.ok(codes(result).includes('STUB_TOUCHES_OTHER_WIRE'));
  assert.ok(codes(result).includes('STUB_TOUCHES_OTHER_PIN'));
});

test('wired NC pins are rejected rather than marked NC to silence DRC', async () => {
  const f = fixture();
  f.snapshot.extensions.easyedaPro.wires.push({ primitiveId: 'bad-nc', net: 'SENSE', points: [{ x: 0, y: -10 }, { x: 0, y: -18 }], netVisible: true, netAttrCount: 1 });
  const result = await planConnections(f.input, f.snapshot);
  assert.equal(result.applyReady, false);
  assert.ok(codes(result).includes('NC_PIN_CONNECTED'));
});

test('full-document verification accounts for orphan wires and markers away from intended endpoints', async () => {
  const f = complete(fixture());
  f.snapshot.extensions.easyedaPro.wires.push({ primitiveId: 'orphan', net: 'SENSE', points: [{ x: 200, y: 0 }, { x: 208, y: 0 }], netVisible: true, netAttrCount: 1 });
  f.snapshot.extensions.easyedaPro.markers.push({ primitiveId: 'orphan-marker', componentType: 'netport', net: 'SENSE', x: 208, y: 0, nameVisible: false, nameAttrCount: 1 });
  const result = await planConnections(f.input, f.snapshot, { phase: 'verify' });
  assert.equal(result.verified, false);
  assert.ok(codes(result).includes('UNOWNED_WIRE'));
  assert.ok(codes(result).includes('UNOWNED_MARKER'));
});

test('one semantic pin can expand to multiple separate physical endpoints', async () => {
  const f = fixture();
  f.input.contract.components[0].bindings.easyedaPro.pinMap.OUT.push('3');
  f.snapshot.components[0].pins.push({ number: '3', nativeId: 'a3', position: { x: 10, y: 20 }, noConnect: false });
  const result = await planConnections(f.input, f.snapshot);
  assert.equal(result.applyReady, true, JSON.stringify(result.diagnostics));
  assert.equal(result.wireItems.length, 3);
  assert.equal(result.flagItems.length, 3);
});

test('invalid Contract endpoints are not silently dropped by a partial scope', async () => {
  const f = fixture();
  f.input.designators = ['U1'];
  f.input.contract.nets[0].endpoints.push({ component: 'MISSING', pin: '1' }, { component: 'J9', pin: '99' });
  const result = await planConnections(f.input, f.snapshot);
  assert.equal(result.applyReady, false);
  assert.ok(codes(result).includes('NET_COMPONENT_UNDECLARED'));
  assert.ok(codes(result).includes('NET_PIN_UNDECLARED'));
});
