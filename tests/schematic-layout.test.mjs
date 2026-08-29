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

const catalog = {
  U1: { role: 'main-ic', pinCount: 4 },
  R1: { role: 'passive', near: 'U1' },
  C1: { role: 'passive', near: 'U1' },
  U2: { role: 'main-ic', pinCount: 4 },
  R2: { role: 'passive', near: 'U2' },
};

// Test inspect mode
const inspectResult = await layoutAction(null, { mode: 'inspect', contract, catalog });
assert.equal(inspectResult.status, 'inspected');
assert.equal(inspectResult.blockCount, 2);
assert.equal(inspectResult.componentCount, 5);
assert.equal(inspectResult.catalogCoverage.cataloged, 5);
assert.equal(inspectResult.catalogCoverage.inferred, 0);

// Test generate mode
const genResult = await layoutAction(null, { mode: 'generate', contract, catalog });
assert.equal(genResult.status, 'generated');
assert.equal(genResult.placementCount, 5);
assert.equal(genResult.netCount, 5);
assert.ok(genResult.snapshot);
assert.equal(genResult.snapshot.kind, 'flitrealize.schematic-snapshot');
assert.equal(genResult.snapshot.schemaVersion, 1);
assert.equal(genResult.snapshot.components.length, 5);
assert.equal(genResult.snapshot.nets.length, 5);

// Verify block ordering: block-a (signal) and block-b (power-output) should be ordered
const u1 = genResult.snapshot.components.find(c => c.designator === 'U1');
const u2 = genResult.snapshot.components.find(c => c.designator === 'U2');
assert.ok(u1.position.x !== u2.position.x, 'U1 and U2 should be in different columns');

// Verify R2 connects to U2's FB pin → should be placed to the right
const r2 = genResult.snapshot.components.find(c => c.designator === 'R2');
assert.ok(r2.position.x >= u2.position.x, `R2.x=${r2.position.x} should be near U2.x=${u2.position.x}`);

// Verify R1 is near U1 (same x column or adjacent)
const r1 = genResult.snapshot.components.find(c => c.designator === 'R1');
assert.ok(Math.abs(r1.position.x - u1.position.x) <= 400, `R1.x=${r1.position.x} should be near U1.x=${u1.position.x}`);

// Verify pins have net assignments
const u1Pin1 = u1.pins.find(p => p.number === '1');
assert.equal(u1Pin1.net, 'VBUS');
const u2Pin2 = u2.pins.find(p => p.number === '2');
assert.equal(u2Pin2.net, 'GND');

// Verify fingerprints exist
assert.ok(genResult.snapshot.fingerprints.document.startsWith('fnv1a32-'));
assert.ok(genResult.fingerprint.startsWith('fnv1a32-'));

// Test signal flow ordering: connector block should come before power block
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
    },
  ],
};
const flowResult = await layoutAction(null, { mode: 'generate', contract: flowContract, catalog });
assert.equal(flowResult.status, 'generated');
const j1 = flowResult.snapshot.components.find(c => c.designator === 'J1');
const u2Flow = flowResult.snapshot.components.find(c => c.designator === 'U2');
assert.ok(j1.position.x < u2Flow.position.x, `Connector J1.x=${j1.position.x} should be left of U2.x=${u2Flow.position.x} (signal flow)`);
assert.deepEqual(flowResult.sortedBlockOrder, ['usb-input', 'power-stage']);

// Test inspect mode shows block flow types
const flowInspect = await layoutAction(null, { mode: 'inspect', contract: flowContract, catalog });
assert.ok(flowInspect.blockFlowTypes.some(b => b.flowType === 'connector'));
assert.ok(flowInspect.blockFlowTypes.some(b => b.flowType === 'power-output'));

// Test with inferred roles (no catalog)
const inferredResult = await layoutAction(null, { mode: 'generate', contract, catalog: {} });
assert.equal(inferredResult.status, 'generated');
assert.equal(inferredResult.placementCount, 5);

// Test missing contract
await assert.rejects(
  () => layoutAction(null, { mode: 'generate' }),
  (error) => error.code === 'INVALID_INPUT',
);

process.stdout.write('schematic-layout tests passed\n');
