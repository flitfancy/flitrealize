import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const layoutAction = await loadAction('schematic-layout');

// Minimal contract fixture
const contract = {
  kind: 'flitrealize.schematic-contract',
  schemaVersion: 1,
  project: { id: 'test-project', revision: 'r1', title: 'Test' },
  blocks: [
    {
      id: 'block-a',
      purpose: 'Input stage',
      components: ['U1', 'R1', 'C1'],
    },
    {
      id: 'block-b',
      purpose: 'Power stage',
      components: ['U2', 'R2'],
    },
  ],
  powerDomains: [],
  interfaces: [],
  components: [
    {
      designator: 'U1',
      role: 'main-ic',
      identity: { selection: 'exact', manufacturer: 'TI', mpn: 'BQ25616' },
      footprint: { selection: 'exact', name: 'WQFN-24' },
      pinMapCoverage: 'critical',
      pins: [
        { number: '1', function: 'IN', classification: 'power-in' },
        { number: '2', function: 'GND', classification: 'ground' },
        { number: '3', function: 'SW', classification: 'signal' },
        { number: '4', function: 'OUT', classification: 'power-out' },
      ],
      includeInBom: true,
      includeInPcb: true,
    },
    {
      designator: 'R1',
      role: 'passive',
      identity: { selection: 'generic', value: '10k' },
      footprint: { selection: 'policy', policy: '0402' },
      pinMapCoverage: 'complete',
      pins: [
        { number: '1', function: 'terminal', classification: 'passive' },
        { number: '2', function: 'terminal', classification: 'passive' },
      ],
      includeInBom: true,
      includeInPcb: true,
    },
    {
      designator: 'C1',
      role: 'passive',
      identity: { selection: 'generic', value: '100nF' },
      footprint: { selection: 'policy', policy: '0402' },
      pinMapCoverage: 'complete',
      pins: [
        { number: '1', function: 'terminal', classification: 'passive' },
        { number: '2', function: 'terminal', classification: 'passive' },
      ],
      includeInBom: true,
      includeInPcb: true,
    },
    {
      designator: 'U2',
      role: 'main-ic',
      identity: { selection: 'exact', manufacturer: 'ADI', mpn: 'LTC3119' },
      footprint: { selection: 'exact', name: 'QFN-28' },
      pinMapCoverage: 'critical',
      pins: [
        { number: '1', function: 'VIN', classification: 'power-in' },
        { number: '2', function: 'GND', classification: 'ground' },
        { number: '3', function: 'VOUT', classification: 'power-out' },
        { number: '4', function: 'FB', classification: 'signal' },
      ],
      includeInBom: true,
      includeInPcb: true,
    },
    {
      designator: 'R2',
      role: 'passive',
      identity: { selection: 'generic', value: '100k' },
      footprint: { selection: 'policy', policy: '0402' },
      pinMapCoverage: 'complete',
      pins: [
        { number: '1', function: 'terminal', classification: 'passive' },
        { number: '2', function: 'terminal', classification: 'passive' },
      ],
      includeInBom: true,
      includeInPcb: true,
    },
  ],
  nets: [
    { name: 'VBUS', kind: 'power', endpoints: [{ component: 'U1', pin: '1' }] },
    { name: 'GND', kind: 'ground', endpoints: [{ component: 'U1', pin: '2' }, { component: 'U2', pin: '2' }] },
    { name: 'SYS', kind: 'power', endpoints: [{ component: 'U1', pin: '4' }, { component: 'U2', pin: '1' }] },
    { name: 'VOUT', kind: 'power', endpoints: [{ component: 'U2', pin: '3' }] },
    { name: 'FB', kind: 'signal', endpoints: [{ component: 'U2', pin: '4' }, { component: 'R2', pin: '1' }] },
  ],
  constraints: [],
  exceptions: [],
};

for (const component of contract.components) {
  component.bindings = {
    easyedaPro: {
      libraryUuid: `lib-${component.designator}`,
      deviceUuid: `dev-${component.designator}`,
    },
  };
}

const catalog = {
  U1: { role: 'main-ic', pinCount: 24, symbol: { width: 300, height: 500 } },
  R1: { role: 'passive', near: 'U1', symbol: { width: 120, height: 80 } },
  C1: { role: 'passive', near: 'U1', symbol: { width: 120, height: 80 } },
  U2: { role: 'main-ic', pinCount: 28, symbol: { width: 320, height: 560 } },
  R2: { role: 'passive', near: 'U2', symbol: { width: 120, height: 80 } },
};

// Test inspect mode
const inspectResult = await layoutAction(null, { mode: 'inspect', contract, catalog });
assert.equal(inspectResult.status, 'inspected');
assert.equal(inspectResult.blockCount, 2);
assert.equal(inspectResult.componentCount, 5);
assert.equal(inspectResult.catalogCoverage.cataloged, 5);
assert.equal(inspectResult.catalogCoverage.explicitGeometry, 5);
assert.deepEqual(inspectResult.blockOrder, ['block-a', 'block-b']);

// Test generate mode
const genResult = await layoutAction(null, { mode: 'generate', contract, catalog });
assert.equal(genResult.status, 'generated');
assert.equal(genResult.placementCount, 5);
assert.equal(genResult.netCount, 5);
assert.ok(genResult.placementPlan);
assert.equal(genResult.placementPlan.kind, 'flitrealize.schematic-placement-plan');
assert.equal(genResult.placementPlan.schemaVersion, 1);
assert.equal(genResult.placementPlan.components.length, 5);
assert.equal(genResult.placementPlan.targetProvider, 'easyeda-pro');

// Verify block ordering: block-a (signal) and block-b (power-output) should be ordered
const u1 = genResult.placementPlan.components.find(c => c.designator === 'U1');
const u2 = genResult.placementPlan.components.find(c => c.designator === 'U2');
assert.ok(u1.position.x !== u2.position.x, 'U1 and U2 should be in different columns');

// Verify R2 connects to U2's FB pin → should be placed to the right
const r2 = genResult.placementPlan.components.find(c => c.designator === 'R2');
assert.ok(r2.position.x >= u2.position.x, `R2.x=${r2.position.x} should be near U2.x=${u2.position.x}`);

// Verify R1 is near U1 (same x column or adjacent)
const r1 = genResult.placementPlan.components.find(c => c.designator === 'R1');
assert.ok(Math.abs(r1.position.x - u1.position.x) <= 400, `R1.x=${r1.position.x} should be near U1.x=${u1.position.x}`);

// Verify fingerprints exist
assert.ok(genResult.placementPlan.fingerprints.plan.startsWith('fnv1a32-'));
assert.ok(genResult.placementPlan.fingerprints.bindings.startsWith('fnv1a32-'));
assert.ok(genResult.planFingerprint.startsWith('fnv1a32-'));

// The generated symbol rectangles must respect the configured clearance.
const rectangles = genResult.placementPlan.components.map((component) => ({
  designator: component.designator,
  minX: component.position.x - component.extensions.layout.width / 2,
  maxX: component.position.x + component.extensions.layout.width / 2,
  minY: component.position.y - component.extensions.layout.height / 2,
  maxY: component.position.y + component.extensions.layout.height / 2,
}));
for (let left = 0; left < rectangles.length; left += 1) {
  for (let right = left + 1; right < rectangles.length; right += 1) {
    const a = rectangles[left];
    const b = rectangles[right];
    const separated = a.maxX + 40 <= b.minX || b.maxX + 40 <= a.minX || a.maxY + 40 <= b.minY || b.maxY + 40 <= a.minY;
    assert.ok(separated, `${a.designator} and ${b.designator} must not overlap`);
  }
}

// Contract block order is authoritative by default.
const flowContract = {
  ...contract,
  blocks: [
    { id: 'power-stage', purpose: 'Buck-boost converter', components: ['U2', 'R2'] },
    { id: 'usb-input', purpose: 'USB-C input connector', components: ['J1'] },
  ],
  components: [
    ...contract.components,
    {
      designator: 'J1', role: 'connector',
      identity: { selection: 'exact' }, footprint: { selection: 'exact' },
      pinMapCoverage: 'complete', pins: [{ number: '1', function: 'VBUS', classification: 'power-in' }],
      includeInBom: true, includeInPcb: true,
      bindings: { easyedaPro: { libraryUuid: 'lib-J1', deviceUuid: 'dev-J1' } },
    },
  ],
};
const flowResult = await layoutAction(null, { mode: 'generate', contract: flowContract, catalog });
assert.equal(flowResult.status, 'generated');
const j1 = flowResult.placementPlan.components.find(c => c.designator === 'J1');
const u2Flow = flowResult.placementPlan.components.find(c => c.designator === 'U2');
assert.ok(u2Flow.position.x < j1.position.x, 'Default layout must preserve Contract block order');
assert.deepEqual(flowResult.sortedBlockOrder, ['power-stage', 'usb-input']);

// An explicit layout block order may override the Contract presentation order.
const reordered = await layoutAction(null, {
  mode: 'generate', contract: flowContract, catalog,
  layout: { blockOrder: ['usb-input', 'power-stage'] },
});
const reorderedJ1 = reordered.placementPlan.components.find(c => c.designator === 'J1');
const reorderedU2 = reordered.placementPlan.components.find(c => c.designator === 'U2');
assert.ok(reorderedJ1.position.x < reorderedU2.position.x);
assert.deepEqual(reordered.sortedBlockOrder, ['usb-input', 'power-stage']);

// Test with inferred roles (no catalog)
const inferredResult = await layoutAction(null, { mode: 'generate', contract, catalog: {} });
assert.equal(inferredResult.status, 'generated');
assert.equal(inferredResult.placementCount, 5);

const missingBindingContract = structuredClone(contract);
delete missingBindingContract.components[0].bindings;
const missingBindingResult = await layoutAction(null, { mode: 'generate', contract: missingBindingContract, catalog });
assert.equal(missingBindingResult.status, 'generated-with-blockers');
assert.ok(missingBindingResult.diagnostics.some((item) => item.code === 'PROVIDER_BINDING_MISSING'));

const externalBindingResult = await layoutAction(null, {
  mode: 'generate',
  contract: missingBindingContract,
  catalog,
  providerBindings: {
    U1: { libraryUuid: 'resolved-lib-U1', deviceUuid: 'resolved-dev-U1' },
  },
});
assert.equal(externalBindingResult.status, 'generated');
assert.equal(
  externalBindingResult.placementPlan.components.find((component) => component.designator === 'U1').bindings.easyedaPro.deviceUuid,
  'resolved-dev-U1',
);

const staleBindingResult = await layoutAction(null, {
  mode: 'generate',
  contract,
  catalog,
  bindingFingerprint: 'fnv1a32-stale',
});
assert.equal(staleBindingResult.status, 'generated-with-blockers');
assert.ok(staleBindingResult.diagnostics.some((item) => item.code === 'BINDING_FINGERPRINT_MISMATCH'));

const extraBindingResult = await layoutAction(null, {
  mode: 'generate',
  contract,
  catalog,
  providerBindings: { U99: { libraryUuid: 'lib-U99', deviceUuid: 'dev-U99' } },
});
assert.equal(extraBindingResult.status, 'generated-with-blockers');
assert.ok(extraBindingResult.diagnostics.some((item) => item.code === 'PROVIDER_BINDING_COMPONENT_UNKNOWN'));

// Test missing contract
await assert.rejects(
  () => layoutAction(null, { mode: 'generate' }),
  (error) => error.code === 'INVALID_INPUT',
);

process.stdout.write('schematic-layout tests passed\n');
