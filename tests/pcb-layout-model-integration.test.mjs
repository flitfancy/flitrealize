import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { compileModel, inspectCandidate, buildCandidate, measure, runSearch } from '../scripts/pcb-layout/pcb-layout-solver-core.mjs';
import { compileSpatial, evaluateSpatial } from '../scripts/pcb-layout/pcb-layout-spatial.mjs';
import { buildGeometryViews } from '../scripts/pcb-layout/pcb-layout-geometry-views.mjs';
import { evaluateBlockCoupling } from '../scripts/pcb-layout/pcb-layout-block-coupling.mjs';
import { layoutInputModel } from '../scripts/pcb-layout/pcb-layout-input-model.mjs';
import { evaluateSpacingPolicy } from '../scripts/pcb-layout/pcb-layout-spacing-evaluation.mjs';

const box = (x, y, r = 10) => ({ minX: x - r, minY: y - r, maxX: x + r, maxY: y + r });
function fixture() {
  const components = ['A', 'B'].map((ref, i) => ({ id: ref + ':', ref, x: i * 150, y: 0, rotation: 0, bbox: box(i * 150, 0), footprint: { name: 'fixture' } }));
  const snapshot = { source: 'model-fixture', sourceHash: 7, components, pads: components.map(c => ({ id: c.id + '1', owner: c.ref, number: '1', net: 'N', x: c.x, y: c.y, bbox: box(c.x, c.y, 2) })), items: components.map(c => ({ id: c.id + 'label', owner: c.ref, parentId: c.id, type: 'attribute', text: c.ref, fontSize: 10, lineWidth: 1, width: 20, height: 10, original: { x: c.x - 10, y: 25, rotation: 0, alignMode: 3, bbox: { minX: c.x - 10, maxX: c.x + 10, minY: 25, maxY: 35 } } })) };
  const contract = { components: components.map(c => ({ designator: c.ref, role: 'test role' })), blocks: components.map(c => ({ id: 'block-' + c.ref, purpose: 'test', components: [c.ref] })), nets: [{ name: 'N', kind: 'signal', endpoints: components.map(c => ({ component: c.ref, pin: '1' })) }] };
  const config = { hard: { boardBounds: null, fixed: [], preserveRotations: false }, groups: [{ id: 'sense', links: [{ a: 'A', b: 'B', nets: ['N'] }] }], connectivity: { excludeNets: [], includeTestPads: false }, comparisonWeights: { sense: 1 }, search: { iterations: 2, gridMil: 5, maxMoveStepMil: 5 }, blockCoupling: { schemaVersion: 1, relations: [{ id: 'A-B', kind: 'signal', from: { ref: 'A', pin: '1' }, to: { ref: 'B', pin: '1' }, net: 'N' }] }, geometryViews: { schemaVersion: 1, envelopes: [{ id: 'access-A', ref: 'A', kind: 'operation', coordinateSystem: 'component-local-zero', box: { minX: 15, maxX: 50, minY: -10, maxY: 10 } }] } };
  return { snapshot, contract, config, mechanical: { clearanceMil: 8, expectedProjectUuid: 'project', expectedDocumentUuid: 'pcb' } };
}
const modelFor = f => compileModel(f.snapshot, f.contract, f.config, f.mechanical);

const ratioPolicy = () => ({ schemaVersion: 2, mode: 'active', source: 'assembly-courtyard', geometry: 'physical', bandRatios: { rejectBelow: .75, neutralMin: .9, neutralMax: 1.2 }, requirements: [] });
function withSpacing(f, hardMinMil = 37.5) {
  f.config.spacingPolicy = ratioPolicy();
  f.config.assemblyRules = { schemaVersion: 1, profile: { id: 'test', label: 'Test' }, source: { title: 'Synthetic test', url: 'https://example.test' },
    rules: [{ id: 'sample', footprintNames: ['fixture'], marginMm: hardMinMil / 2 * .0254 }], overrides: [], independentPads: { marginMm: 0, basis: 'Bare pads' } };
  return f;
}

test('retired class spacing cannot enter model inspection or relayout as physical spacing', () => {
  const f = fixture(); f.config.spacingPolicy = { schemaVersion: 1, mode: 'active', geometry: 'placement', classes: [], assignments: [] };
  const before = structuredClone(f);
  assert.throws(() => modelFor(f), /UNSUPPORTED_SPACING_POLICY_VERSION/);
  assert.deepEqual(f, before);
});

test('physical ratios reach collision repair, hard validation and a single neutral scoring term', () => {
  const f = withSpacing(fixture());
  f.config.comparisonWeights.uniformity = 1;
  f.config.spatial = { uniformity: { targetMil: 25, toleranceMil: 10 }, relations: [{ id: 'legacy-gap', a: 'A', b: 'B', category: 'spacing', metric: 'bundle-gap', band: { hardMinMil: 8, idealMinMil: 12, idealMaxMil: 20, scaleMil: 10 } }] };
  const model = modelFor(f);
  assert.equal(model.mechanical.pairClearancesMil, undefined, 'physical requirements must not inflate label-bundle limits');
  const neutral = buildCandidate(model, f.snapshot.components.map(c => ({ ...c, x: c.ref === 'B' ? 70 : c.x })), undefined, {}, { maxRelocationMil: 0, relocatableRefs: [] });
  assert.ok(neutral.validation.valid);
  assert.equal(neutral.metrics.spacingPolicy.neighbors[0].ratio, 1);
  assert.equal(neutral.metrics.spacingPolicy.neighbors[0].hardMinMil, 37.5);
  assert.equal(neutral.metrics.spatial.penalties.uniformity, 0);
  assert.equal(neutral.metrics.spatial.penalties.spacing, 0);
  assert.equal(neutral.metrics.spatial.uniformity, null);
  assert.equal(neutral.metrics.spatial.relations[0].scored, false);
  const tight = buildCandidate(model, f.snapshot.components.map(c => ({ ...c, x: c.ref === 'B' ? 55 : c.x })), undefined, {}, { maxRelocationMil: 0, relocatableRefs: [] });
  assert.equal(tight.validation.valid, false);
  assert.ok(tight.validation.minimumGapMil >= 8);
  const repaired = buildCandidate(model, f.snapshot.components.map(c => ({ ...c, x: c.ref === 'B' ? 55 : c.x })), undefined, {}, { maxRelocationMil: 30 });
  assert.equal(repaired.validation.valid, true);
  assert.ok(repaired.validation.minimumGapMil >= 37.5);
});

test('ratio-directed search uses physical per-pair neutral boundaries', () => {
  const f = withSpacing(fixture()); f.config.comparisonWeights.uniformity = 1;
  Object.assign(f.config.search, { spacingMoveProbability: .8, initialTemperature: .001 });
  const model = modelFor(f), c = runSearch(model, { name: 'ratio', label: 'ratio', seed: 456, weights: f.config.comparisonWeights }, 30);
  assert.ok(c.validation.valid);
  assert.ok(c.stats.spacingProposals > 0);
  assert.ok(c.validation.minimumGapMil >= 37.5);
  assert.ok(c.metrics.spacingPolicy.penalty <= model.baselineMetrics.spacingPolicy.penalty);
});

test('diagonal spacing uses one distance definition for both rejection and neutral scoring', () => {
  const model = modelFor(withSpacing(fixture(), 15)), policy = model.spacingPolicy;
  const physical = [{ ref: 'A', bbox: box(0, 0) }, { ref: 'B', bbox: box(40, 40) }];
  const geometry = { physical, assemblyPolicy: { courtyards: physical.map(p => ({ ref: p.ref, bbox: { minX: p.bbox.minX - 7.5, minY: p.bbox.minY - 7.5, maxX: p.bbox.maxX + 7.5, maxY: p.bbox.maxY + 7.5 } })) } };
  const result = evaluateSpacingPolicy(policy, geometry, ['A', 'B']);
  assert.equal(result.issues.length, 0);
  assert.equal(result.neighbors[0].kind, 'bridge');
  assert.equal(result.neighbors[0].distanceMil, 20);
  assert.equal(result.neighbors[0].ratio, 1);
  assert.equal(result.penalty, 0);
});

test('three-level receipt preserves logical membership and observes cross-block pins without extra scoring', () => {
  const f = fixture(), model = modelFor(f), candidate = inspectCandidate(model), receipt = layoutInputModel(model);
  assert.equal(receipt.blocks.length, 2); assert.equal(receipt.components[1].blockId, 'block-B');
  assert.equal(receipt.relationships.crossBlockNets.length, 1);
  assert.equal(candidate.metrics.coupling.relations[0].distanceMil, 150);
  assert.equal(candidate.metrics.coupling.relations[0].status, 'observed');
  assert.equal(candidate.comparisonScore, 7.5); assert.equal(receipt.review.decisionOwner, 'user');
  assert.equal(candidate.metrics.geometry.operation.length, 1);
});

test('model inspection reports actual overlapping geometry without silently repairing positions', () => {
  const f = fixture(); f.snapshot.components[1].x = 0; f.snapshot.components[1].bbox = box(0, 0);
  const before = structuredClone(f.snapshot), inspected = inspectCandidate(modelFor(f));
  assert.equal(inspected.validation.valid, false);
  assert.equal(inspected.plan.components[1].x, 0);
  assert.equal(inspected.plan.counts.moved, 0);
  assert.deepEqual(f.snapshot, before);
});

test('a selected geometry view changes zone checks: silkscreen is not a footprint or a pad obstacle', () => {
  const f = fixture(), model = modelFor(f), candidate = inspectCandidate(model), geometry = candidate.metrics.geometry;
  const zone = { id: 'label-only', mode: 'keepout', box: { minX: -5, maxX: 5, minY: 26, maxY: 34 } };
  for (const kind of ['footprint', 'pads', 'silkscreen', 'placement']) {
    const rules = compileSpatial({ zones: [{ ...zone, geometry: kind }] }, model.components);
    const result = evaluateSpatial(rules, candidate.plan.components, candidate.plan.bundles, geometry);
    assert.equal(result.issues.length, ['silkscreen', 'placement'].includes(kind) ? 1 : 0);
  }
});

test('an explicit operation envelope can drive keepout checks while ordinary bundle clearance still passes', () => {
  const f = fixture();
  f.config.spatial = { zones: [{ id: 'access-keepout', envelopeId: 'access-A', geometry: 'footprint', mode: 'keepout' }] };
  const model = modelFor(f);
  const candidate = buildCandidate(model, f.snapshot.components.map(c => ({ ...c, x: c.ref === 'B' ? 35 : c.x })));
  assert.equal(candidate.validation.valid, false);
  assert.ok(candidate.validation.issues.some(i => i.code === 'SPATIAL_KEEPOUT'));
  assert.ok(candidate.validation.minimumGapMil >= 8);
});

test('new geometry and cross-block limits are explicit and cannot silently degrade to an empty check', () => {
  const f = fixture(); f.config.blockCoupling.relations[0].maxDistanceMil = 100;
  const candidate = inspectCandidate(modelFor(f));
  assert.ok(candidate.validation.issues.some(i => i.code === 'BLOCK_COUPLING_DISTANCE_LIMIT'));
  const model = modelFor(f);
  const rules = compileSpatial({ relations: [{ id: 'assembly-gap', a: 'A', b: 'B', metric: 'geometry-gap', geometryA: 'assembly', geometryB: 'footprint', category: 'spacing', band: { hardMinMil: 5, scaleMil: 10 } }] }, model.components);
  const result = evaluateSpatial(rules, candidate.plan.components, candidate.plan.bundles, candidate.metrics.geometry);
  assert.equal(result.issues[0].code, 'GEOMETRY_MODEL_UNAVAILABLE');
  assert.equal(result.relations[0].distanceMil, null);
});

test('partially declared operation geometry is not mistaken for complete board coverage', () => {
  const f = fixture(), model = modelFor(f), candidate = inspectCandidate(model);
  const zone = { id: 'B-region', mode: 'keepout', geometry: 'operation', box: box(150, 0) };
  const checked = evaluateSpatial(compileSpatial({ zones: [zone] }, model.components), candidate.plan.components, candidate.plan.bundles, candidate.metrics.geometry);
  assert.equal(checked.issues[0].code, 'GEOMETRY_MODEL_UNAVAILABLE');
  assert.deepEqual(checked.zones[0].coverage.missingRefs, ['B']);
  assert.equal(checked.zones[0].occupiedFraction, null);
  const explicit = evaluateSpatial(compileSpatial({ zones: [{ ...zone, targetRefs: ['A'] }] }, model.components), candidate.plan.components, candidate.plan.bundles, candidate.metrics.geometry);
  assert.equal(explicit.issues.length, 0);
  assert.deepEqual(explicit.zones[0].coverage.requestedRefs, ['A']);
});
