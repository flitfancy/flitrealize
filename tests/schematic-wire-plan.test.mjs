import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const wirePlanAction = await loadAction('schematic-wire-plan');

const contract = {
  kind: 'flitrealize.schematic-contract',
  schemaVersion: 1,
  project: { id: 'project-test' },
  components: [
    { designator: 'U1', bindings: { easyedaPro: { pinMap: { SIGNAL: ['1'] } } } },
    { designator: 'U2', bindings: { easyedaPro: { pinMap: { SIGNAL: ['1'] } } } },
  ],
  nets: [{
    name: 'SIG',
    endpoints: [
      { component: 'U1', pin: 'SIGNAL' },
      { component: 'U2', pin: 'SIGNAL' },
    ],
  }],
};

function snapshot(u1PinX = 110) {
  return {
    kind: 'flitrealize.schematic-snapshot',
    schemaVersion: 1,
    provider: 'easyeda-pro',
    project: { id: 'project-test', nativeId: 'project-native' },
    document: { id: 'doc-test', nativeId: 'doc-native', type: 'schematic' },
    components: [
      {
        designator: 'U1', nativeId: 'comp-1', position: { x: 100, y: 100 }, rotation: 0, mirror: false,
        pins: [{ number: '1', nativeId: 'pin-u1-1', position: { x: u1PinX, y: 100 }, noConnect: false }],
      },
      {
        designator: 'U2', nativeId: 'comp-2', position: { x: 200, y: 100 }, rotation: 0, mirror: false,
        pins: [{ number: '1', nativeId: 'pin-u2-1', position: { x: 190, y: 100 }, noConnect: false }],
      },
    ],
    fingerprints: { document: 'fnv1a32-live' },
  };
}

const generated = await wirePlanAction(null, { mode: 'generate', contract, snapshot: snapshot(), stubLength: 8 });
assert.equal(generated.status, 'generated');
assert.equal(generated.wirePlan.kind, 'flitrealize.schematic-wire-plan');
assert.equal(generated.wirePlan.document.nativeId, 'doc-native');
assert.equal(generated.wirePlan.wires.length, 2);
assert.equal(generated.wirePlan.wires[0].endpoint.pin, 'SIGNAL');
assert.equal(generated.wirePlan.wires[0].endpoint.providerPin, '1');
assert.deepEqual(generated.wirePlan.wires[0].points, [{ x: 110, y: 100 }, { x: 118, y: 100 }]);
assert.deepEqual(generated.wirePlan.wires[1].points, [{ x: 190, y: 100 }, { x: 182, y: 100 }]);
assert.ok(generated.planFingerprint.startsWith('fnv1a32-'));

const halfGridSnapshot = snapshot(122.5);
halfGridSnapshot.components[0].position = { x: 100, y: 99.5 };
halfGridSnapshot.components[0].pins[0].position = { x: 122.5, y: 99.5 };
const halfGrid = await wirePlanAction(null, {
  mode: 'generate', contract, snapshot: halfGridSnapshot, stubLength: 40, grid: 10,
});
assert.deepEqual(halfGrid.wirePlan.wires[0].points, [
  { x: 122.5, y: 99.5 },
  { x: 160, y: 99.5 },
]);

const moved = await wirePlanAction(null, { mode: 'generate', contract, snapshot: snapshot(120), stubLength: 8 });
assert.notEqual(moved.sourceGeometryFingerprint, generated.sourceGeometryFingerprint);

const incompleteContract = {
  ...contract,
  components: [{ designator: 'U1', bindings: { easyedaPro: { pinMap: { SIGNAL: ['99'] } } } }],
  nets: [{ name: 'SIG', endpoints: [{ component: 'U1', pin: 'SIGNAL' }] }],
};
const incomplete = await wirePlanAction(null, { mode: 'generate', contract: incompleteContract, snapshot: snapshot() });
assert.equal(incomplete.status, 'generated-with-blockers');
assert.equal(incomplete.unresolved[0].code, 'PIN_NOT_REALIZED');

const contractWithoutProviderBinding = {
  ...contract,
  components: [{ designator: 'U1' }],
  nets: [{ name: 'SIG', endpoints: [{ component: 'U1', pin: 'SIGNAL' }] }],
};
const placementPlan = {
  kind: 'flitrealize.schematic-placement-plan',
  schemaVersion: 1,
  targetProvider: 'easyeda-pro',
  components: [{ designator: 'U1', bindings: { easyedaPro: { pinMap: { SIGNAL: ['1'] } } } }],
  fingerprints: { plan: 'fnv1a32-placement', bindings: 'fnv1a32-bindings' },
};
const fromPlacementPlan = await wirePlanAction(null, {
  mode: 'generate', contract: contractWithoutProviderBinding, snapshot: snapshot(), placementPlan,
});
assert.equal(fromPlacementPlan.status, 'generated');
assert.equal(fromPlacementPlan.wirePlan.wires[0].endpoint.providerPin, '1');
assert.equal(fromPlacementPlan.wirePlan.source.placementPlanFingerprint, 'fnv1a32-placement');
assert.equal(fromPlacementPlan.wirePlan.source.bindingFingerprint, 'fnv1a32-bindings');

const segmentSnapshot = snapshot();
segmentSnapshot.extensions = {
  easyedaPro: {
    wires: [{ primitiveId: 'wire-existing', net: 'SIG', points: [{ x: 105, y: 100 }, { x: 115, y: 100 }] }],
  },
};
const segmentContact = await wirePlanAction(null, {
  mode: 'generate', contract: contractWithoutProviderBinding, snapshot: segmentSnapshot, placementPlan, connectionTolerance: 0.01,
});
assert.equal(segmentContact.existingEndpointCount, 1);
assert.equal(segmentContact.wirePlan.wires.length, 0);

process.stdout.write('schematic-wire-plan tests passed\n');
