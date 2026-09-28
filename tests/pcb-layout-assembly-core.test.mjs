import test from 'node:test';
import assert from 'node:assert/strict';
import { compileModel, inspectCandidate, buildCandidate } from '../scripts/pcb-layout/pcb-layout-solver-core.mjs';
import { layoutInputModel } from '../scripts/pcb-layout/pcb-layout-input-model.mjs';
import { assemblyRuntime } from '../scripts/pcb-layout/pcb-layout-assembly-policy.mjs';

const box = (x, y, r = 10) => ({ minX: x - r, maxX: x + r, minY: y - r, maxY: y + r });
function fixture(secondX = 150) {
  const components = ['A', 'B'].map((ref, i) => ({ id: ref + ':', ref, x: i * secondX, y: 0, rotation: 0, bbox: box(i * secondX, 0), footprint: { name: 'fixture' }, layer: 1 }));
  const snapshot = { source: 'assembly-core', sourceHash: 7, components,
    pads: components.map(c => ({ id: c.id + '1', owner: c.ref, number: '1', net: 'N', x: c.x, y: c.y, bbox: box(c.x, c.y, 2), layer: 1 })),
    items: components.map(c => ({ id: c.id + 'label', owner: c.ref, parentId: c.id, type: 'attribute', text: c.ref, fontSize: 10, lineWidth: 1, width: 20, height: 10,
      original: { x: c.x - 10, y: 25, rotation: 0, alignMode: 3, bbox: { minX: c.x - 10, maxX: c.x + 10, minY: 25, maxY: 35 } } })) };
  const contract = { components: components.map(c => ({ designator: c.ref, role: 'test' })), blocks: [{ id: 'sample', components: ['A', 'B'] }],
    nets: [{ name: 'N', kind: 'signal', endpoints: components.map(c => ({ component: c.ref, pin: '1' })) }] };
  const config = {
    scoringMode: 'simple-v1', hard: { boardBounds: null, fixed: [], preserveRotations: false },
    groups: [{ id: 'sense', links: [{ a: 'A', b: 'B', nets: ['N'] }] }], connectivity: { excludeNets: [], includeTestPads: false },
    comparisonWeights: { sense: 1, uniformity: .08 }, search: { iterations: 2, gridMil: 5, maxMoveStepMil: 5 },
    assemblyRules: { schemaVersion: 1, profile: { id: 'test', label: 'Test' }, source: { title: 'Test', url: 'https://example.test' },
      rules: [{ id: 'fixture', footprintNames: ['fixture'], marginMm: .254 }], overrides: [], independentPads: { marginMm: 0, basis: 'Bare pads' } },
    spacingPolicy: { schemaVersion: 2, mode: 'active', source: 'assembly-courtyard', geometry: 'physical', bandRatios: { rejectBelow: .75, neutralMin: .9, neutralMax: 1.2 }, requirements: [] }
  };
  return { snapshot, contract, config, mechanical: { clearanceMil: 8 } };
}
const modelFor = f => compileModel(f.snapshot, f.contract, f.config, f.mechanical);
const noRepair = { maxRelocationMil: 0, relocatableRefs: [] };

test('schema 2 physical spacing and its input receipt do not depend on refdes side', () => {
  const f = fixture(), model = modelFor(f), before = inspectCandidate(model);
  const after = buildCandidate(model, f.snapshot.components, undefined, { A: 'right', B: 'left' }, noRepair);
  assert.ok(after.validation.valid, JSON.stringify(after.validation.issues));
  assert.notDeepEqual(after.plan.labels.map(l => l.bbox), before.plan.labels.map(l => l.bbox));
  assert.deepEqual(after.metrics.geometry.physical, before.metrics.geometry.physical);
  assert.equal(after.metrics.spacingPolicy.penalty, before.metrics.spacingPolicy.penalty);
  assert.deepEqual(after.metrics.spacingPolicy.neighbors.map(n => [n.ratio, n.hardMinMil]), before.metrics.spacingPolicy.neighbors.map(n => [n.ratio, n.hardMinMil]));
  assert.equal(after.comparisonScore, before.comparisonScore);
  assert.equal(model.mechanical.pairClearancesMil, undefined, 'physical pair requirements must not become label-bundle clearance');
  const receipt = layoutInputModel(model);
  assert.equal(receipt.board.spacingPolicy.source, 'assembly-courtyard');
  assert.equal(receipt.board.spacingPolicy.geometry, 'physical');
  assert.equal(receipt.board.assemblyPolicy.coverage.mappedComponents, 2);
  assert.ok(receipt.geometry.views.includes('physical'));
});

test('quarter-turn candidates rotate directional courtyards consistently with the injected native runtime', () => {
  const f = fixture();
  f.config.assemblyRules.overrides = [{ ref: 'A', basis: 'Directional test', marginMm: { xMinus: 0, xPlus: .508, yMinus: 0, yPlus: 0 } }];
  const model = modelFor(f), original = inspectCandidate(model);
  const candidate = buildCandidate(model, f.snapshot.components.map(c => ({ ...c, rotation: c.ref === 'A' ? 90 : 0 })), undefined, {}, noRepair);
  assert.ok(candidate.validation.valid, JSON.stringify(candidate.validation.issues));
  const originalCourt = original.metrics.assemblyPolicy.courtyards.find(c => c.ref === 'A').bbox;
  const rotatedCourt = candidate.metrics.assemblyPolicy.courtyards.find(c => c.ref === 'A').bbox;
  assert.equal(originalCourt.maxX, 30); assert.equal(originalCourt.maxY, 10);
  assert.equal(rotatedCourt.maxX, 10); assert.equal(rotatedCourt.maxY, 30);
  const native = new Function('return (' + assemblyRuntime.toString() + ')')();
  const observed = native(model.assemblyPolicy, candidate.plan.components, candidate.metrics.geometry.pads);
  assert.ok(observed.valid);
  assert.deepEqual(observed.courtyards, candidate.metrics.assemblyPolicy.courtyards);
});

test('multiple declared physical requirements for one pair merge by maximum without inflating label clearance', () => {
  const f = fixture();
  f.config.spacingPolicy.requirements = [
    { id: 'assembly-access', refs: ['A', 'B'], purpose: 'assembly', hardMinimumMil: 25 },
    { id: 'thermal-input', refs: ['B', 'A'], purpose: 'declared separation', hardMinimumMil: 40 }
  ];
  const model = modelFor(f), candidate = inspectCandidate(model);
  assert.deepEqual(model.assemblyPolicy.pairClearancesMil, [{ a: 'A', b: 'B', hardMinMil: 40 }]);
  assert.equal(model.mechanical.pairClearancesMil, undefined);
  assert.equal(candidate.metrics.spacingPolicy.neighbors[0].hardMinMil, 40);
  assert.ok(candidate.validation.valid);
  const moved = buildCandidate(model, f.snapshot.components.map(c => ({ ...c, x: c.ref === 'B' ? 50 : 0 })), undefined, {}, noRepair);
  assert.equal(moved.validation.valid, false);
  assert.ok(moved.validation.issues.some(i => i.code === 'ASSEMBLY_PHYSICAL_CLEARANCE'));
});

test('locked courtyard conflicts remain rejected even though the 8 mil label floor passes', () => {
  const f = fixture(35); f.snapshot.components.forEach(c => { c.locked = true; });
  const model = modelFor(f), candidate = buildCandidate(model, f.snapshot.components, undefined, {}, { maxRelocationMil: 80 });
  assert.equal(candidate.plan.counts.moved, 0);
  assert.equal(candidate.validation.valid, false);
  assert.ok(candidate.validation.minimumGapMil >= 8);
  assert.ok(candidate.validation.issues.some(i => i.code === 'ASSEMBLY_COURTYARD_OVERLAP'));
});
