import test from 'node:test';
import assert from 'node:assert/strict';
import { compileModel, buildCandidate, buildEdgeCandidate, validatePlan, measure, runSearch, score, translatedSnapshot } from '../scripts/pcb-layout/pcb-layout-solver-core.mjs';
import { compileEdgeRules, checkEdges, availableEdges, projectEdges } from '../scripts/pcb-layout/pcb-layout-edge.mjs';
import { transformPoint, transformBox, transformLabel } from '../scripts/pcb-layout/pcb-layout-geometry.mjs';
import { configureWeights } from '../scripts/pcb-layout/pcb-layout-weights.mjs';

function fixture() {
  const snapshot = { source: 'fixture', sourceHash: 42, components: [], pads: [], items: [] };
  const contract = { components: [], blocks: [], nets: [{ name: 'N', endpoints: [] }, { name: 'GND', endpoints: [] }] };
  const box = (x, y, w, h) => ({ minX: x - w / 2, maxX: x + w / 2, minY: y - h / 2, maxY: y + h / 2 });
  for (const [ref, x] of [['U1', 0], ['U2', 180], ['J5', 400]]) {
    const id = ref + ':part:';
    snapshot.components.push({ ref, id, x, y: 0, rotation: 0, locked: false, footprint: { name: 'fixture' }, bbox: box(x, 0, 40, 30) });
    contract.components.push({ designator: ref });
    for (const [pin, dx, net] of [['1', ref === 'U2' ? 6 : -4, 'N'], ['2', 0, 'GND'], ['3', 4, 'N']]) {
      snapshot.pads.push({ id: id + pin, owner: ref, number: pin, net, x: x + dx, y: 0, bbox: box(x + dx, 0, 2, 2) });
      contract.nets.find(n => n.name === net).endpoints.push({ component: ref, pin });
    }
    snapshot.items.push({ id: id + 'label', parentId: id, owner: ref, type: 'attribute', text: ref, width: 20, height: 10, fontSize: 10, lineWidth: 1, original: { x: x - 10, y: 25, rotation: 0, alignMode: 3, bbox: box(x, 30, 20, 10) } });
  }
  const config = { hard: { boardBounds: null, preserveRotations: true, fixed: [{ ref: 'J5', x: 400, y: 0, rotation: 0 }], pinDistanceLimits: [] }, groups: [{ id: 'sense', label: 'sense', links: [{ a: 'U1', aPin: '1', b: 'U2', bPin: '1', nets: ['N'] }] }], connectivity: { excludeNets: ['GND'], includeTestPads: false }, comparisonWeights: { sense: 1 }, search: { iterations: 60, gridMil: 5, maxMoveStepMil: 40, initialTemperature: .001 } };
  const mechanical = { clearanceMil: 8, lockedDesignators: ['J5'], localSearchMaxComponents: 6, localSearchMaxNodes: 4096 };
  return { snapshot, contract, config, mechanical };
}
const modelFor = f => compileModel(f.snapshot, f.contract, f.config, f.mechanical);

test('optional uniformity stays disabled unless explicitly weighted', () => {
  const f = fixture();
  f.config.search.profiles = [{ name: 'uniform', weightMultipliers: { uniformity: 2.5 } }];
  const c = configureWeights(f.config, { weights: { sense: 1 } });
  assert.equal(c.search.profiles[0].weights.uniformity ?? 0, 0);
  const enabled = configureWeights(f.config, { weights: { sense: 1 } }, ['uniformity=0.08']);
  assert.equal(enabled.search.profiles[0].weights.uniformity, .2);
  f.config.search.profiles[0].weightMultipliers = { unknown: 1 };
  assert.throws(() => configureWeights(f.config, { weights: { sense: 1 } }), /INVALID_PROFILE_MULTIPLIER/);
});

test('default scoring uses geometry and explicit historical scoring is not executed', () => {
  const f = fixture(), original = structuredClone(f.config), model = modelFor(f);
  assert.equal(model.config.scoringMode, 'simple-v1');
  assert.equal(model.scoreReferences.mode, 'geometry');
  assert.deepEqual(f.config, original);
  const currentScore = score(model, model.baselineMetrics);
  f.config.scoringMode = 'simple-v1'; f.config.scoringReference = { mode: 'geometry' };
  const explicit = modelFor(f);
  assert.equal(score(explicit, explicit.baselineMetrics), currentScore);
  f.config.scoringMode = 'legacy-v1';
  assert.throws(() => modelFor(f), /INVALID_SCORING_MODE/);
  f.config.scoringMode = 'simple-v1'; f.config.scoringReference.mode = 'legacy-baseline';
  assert.throws(() => modelFor(f), /INVALID_SCORING_REFERENCE/);
});

test('uniform spacing search is reproducible, improves its objective and preserves locks', () => {
  const f = fixture();
  f.config.spatial = { uniformity: { targetMil: 25, toleranceMil: 10 } };
  f.config.comparisonWeights.uniformity = 1;
  f.config.search.spacingMoveProbability = .8;
  const model = modelFor(f), profile = { name: 'uniform', label: 'uniform', seed: 412, weights: f.config.comparisonWeights };
  const a = runSearch(model, profile, 100), b = runSearch(model, profile, 100);
  assert.deepEqual(a, b);
  assert.ok(a.stats.spacingProposals > 0 && a.stats.spacingAccepted > 0 && a.stats.spacingLabelTrials > 0, JSON.stringify(a.stats));
  assert.ok(a.metrics.spatial.penalties.uniformity < model.baselineMetrics.spatial.penalties.uniformity);
  assert.ok(a.validation.valid && a.validation.minimumGapMil >= 8 - .001);
  assert.equal(a.plan.components.find(c => c.ref === 'J5').x, 400);
  const zero = runSearch(model, { ...profile, weights: { ...profile.weights, uniformity: 0 } }, 10);
  assert.equal(zero.stats.spacingProposals, 0);
  f.config.spatial.uniformity.targetMil = 12;
  assert.throws(() => modelFor(f), /UNIFORMITY_BAND_BELOW_HARD_CLEARANCE/);
});

test('measures the specified physical sense pins rather than centres or the nearest same-net pin', () => {
  const m = modelFor(fixture());
  assert.equal(m.baselineMetrics.details[0].mil, 190);
  assert.deepEqual(m.baselineMetrics.details[0].endpoints, [{ x: -4, y: 0 }, { x: 186, y: 0 }]);
});
test('rejects a real pad/contract net mismatch instead of silently scoring another pin', () => {
  const f = fixture(); f.snapshot.pads[0].net = 'WRONG';
  assert.throws(() => modelFor(f), /PIN_NET_MISMATCH/);
});
test('candidate deltas always refer to the original real board through multiple iterations', () => {
  const m = modelFor(fixture());
  const first = buildCandidate(m, m.snapshot.components.map(c => ({ ...c, x: c.ref === 'U2' ? 120 : c.x })));
  const second = buildCandidate(m, first.plan.components.map(c => ({ ...c, x: c.ref === 'U2' ? 100 : c.x })), first.plan);
  assert.ok(first.validation.valid && second.validation.valid);
  assert.equal(second.plan.components.find(c => c.ref === 'U2').dx, -80);
  assert.equal(second.plan.sourceHash, 42);
  assert.equal(second.metrics.details[0].mil, 110);
  assert.deepEqual(second.metrics, measure(m, second.plan.components, second.plan.labels));
});
test('a fixed mechanical interface cannot be moved even when the electrical score improves', () => {
  const m = modelFor(fixture());
  const c = buildCandidate(m, m.snapshot.components.map(c => ({ ...c, x: c.ref === 'J5' ? 300 : c.x })));
  assert.equal(c.validation.valid, false);
  assert.ok(c.validation.issues.some(i => i.code === 'FIXED_POSITION_CHANGED'));
});
test('uses final mechanical positions and detects invalid execution deltas or hidden geometry', () => {
  const m = modelFor(fixture());
  const c = buildCandidate(m, m.snapshot.components.map(c => ({ ...c, x: c.ref === 'U2' ? 20 : c.x })));
  assert.ok(c.validation.valid);
  assert.deepEqual(c.metrics, measure(m, c.plan.components, c.plan.labels));
  c.plan.components[0].dx = 999;
  c.plan.bundles = [];
  const checked = validatePlan(m, c.plan);
  assert.equal(checked.valid, false);
  assert.ok(checked.issues.some(i => i.code === 'PLAN_DELTA_OR_BODY_INVALID'));
  assert.ok(checked.issues.some(i => i.code === 'PLAN_BUNDLE_COUNT'));
});
test('explicit pin distance limits are hard conditions separate from objective weights', () => {
  const f = fixture(); f.config.hard.pinDistanceLimits.push({ id: 'maximum-sense-length', a: 'U1', aPin: '1', b: 'U2', bPin: '1', net: 'N', maxMil: 150 });
  const m = modelFor(f), c = buildCandidate(m, m.snapshot.components);
  assert.equal(c.validation.valid, false);
  assert.ok(c.validation.issues.some(i => i.code === 'PIN_DISTANCE_LIMIT'));
});
test('fixed seeds reproduce the same feasible candidate and preserve the source snapshot', () => {
  const f = fixture(), before = structuredClone(f.snapshot), m = modelFor(f), profile = { name: 'test', label: 'test', seed: 1234, weights: f.config.comparisonWeights };
  const a = runSearch(m, profile), b = runSearch(m, profile);
  assert.ok(a.validation.valid);
  assert.deepEqual(a, b);
  assert.ok(a.comparisonScore < score(m, m.baselineMetrics));
  assert.deepEqual(f.snapshot, before);
});

test('quarter turns transform asymmetric geometry around the native origin and round trip', () => {
  const from = { x: 100, y: 200, rotation: 90 }, p = { x: 110, y: 220 }, box = { minX: 105, maxX: 112, minY: 201, maxY: 229 };
  assert.deepEqual(transformPoint(p, from, { ...from, rotation: 180 }), { x: 80, y: 210 });
  for (const delta of [90, 180, 270]) {
    const to = { x: 300, y: -400, rotation: from.rotation + delta };
    assert.deepEqual(transformPoint(transformPoint(p, from, to), to, from), p);
    assert.deepEqual(transformBox(transformBox(box, from, to), to, from), box);
  }
  assert.throws(() => transformPoint(p, from, { ...from, rotation: 135 }), /quarter-turn/);
});

test('rotating a component changes its specified pad metric and preserves label occupancy without a silk penalty', () => {
  const f = fixture(); f.config.hard.preserveRotations = false;
  const m = modelFor(f), c = buildCandidate(m, f.snapshot.components.map(p => ({ ...p, rotation: p.ref === 'U2' ? 180 : 0 })));
  assert.ok(c.validation.valid);
  assert.equal(c.metrics.details[0].mil, 178);
  assert.equal(c.plan.counts.rotated, 1);
  assert.equal(c.metrics.silkRelocatedCount, 0);
  const label = c.plan.labels.find(l => l.owner === 'U2');
  assert.equal(label.rotation, 0);
  assert.equal(label.bbox.maxY, -25);
  assert.deepEqual(c.metrics, measure(m, c.plan.components, c.plan.labels));
  for (const rotation of [90, 180, 270]) {
    const old = f.snapshot.items[0].original, next = transformLabel(old, f.snapshot.components[0], { ...f.snapshot.components[0], rotation });
    assert.ok([0, 90].includes(next.rotation));
    assert.equal(next.x, next.rotation ? next.bbox.maxX : next.bbox.minX);
    assert.equal(next.y, next.bbox.minY);
  }
});

test('fixed and native locked components reject rotation while per-part angle choices are honored', () => {
  const f = fixture(); f.config.hard.preserveRotations = false; f.config.hard.allowedRotationDeltasByRef = { U2: [0, 180] }; f.snapshot.components[0].locked = true;
  const m = modelFor(f);
  assert.deepEqual(m.allowedRotations.get('U1'), [0]);
  assert.deepEqual(m.allowedRotations.get('J5'), [0]);
  assert.deepEqual(m.allowedRotations.get('U2'), [0, 180]);
  for (const ref of ['J5', 'U1', 'U2']) {
    const trial = buildCandidate(m, f.snapshot.components.map(c => ({ ...c, rotation: c.ref === ref ? 90 : c.rotation })));
    assert.equal(trial.validation.valid, false);
  }
});

test('explicit silk side proposals report relative relocation without changing its score', () => {
  const f = fixture(), m = modelFor(f), c = buildCandidate(m, f.snapshot.components, undefined, { U1: 'top' });
  assert.ok(c.validation.valid);
  assert.equal(c.plan.counts.moved, 0);
  assert.equal(c.plan.components.find(p => p.ref === 'U1').side, 'top');
  assert.equal(c.metrics.silkRelocatedCount, 1);
  assert.equal(score(m, c.metrics), score(m, m.baselineMetrics));
  assert.throws(() => score(m, c.metrics, { sense: 1, silk: .3 }), /INVALID_WEIGHTS/);
  const next = buildCandidate(m, c.plan.components.map(p => ({ ...p, y: p.ref === 'U1' ? 10 : p.y })), c.plan);
  assert.equal(next.metrics.silkRelocatedCount, 1);
});

test('base weights and CLI overrides feed every search profile; invalid weights are rejected', () => {
  const f = fixture(); f.config.search.profiles = [{ name: 'a', weightMultipliers: {} }, { name: 'b', weightMultipliers: { sense: 2 } }];
  const c = configureWeights(f.config, { weights: { sense: 1, connectivity: 2, uniformity: .1 } }, ['sense=3', 'uniformity=0']);
  assert.equal(c.comparisonWeights.sense, 3);
  assert.equal(c.search.profiles[0].weights.sense, 3);
  assert.equal(c.search.profiles[1].weights.sense, 6);
  assert.equal(c.search.profiles[1].weights.uniformity, 0);
  for (const override of ['sense=-1', 'sense=NaN', 'sense=Infinity', 'typo=1', 'sense=', 'sense= ']) assert.throws(() => configureWeights(f.config, { weights: { sense: 1 } }, [override]), /INVALID_/);
  assert.throws(() => configureWeights(f.config, { weights: { sense: 0, uniformity: 1 } }), /NO_OBJECTIVE/);
});

test('joint rotation and silk search is seeded, feasible and records both proposal types', () => {
  const f = fixture(); f.config.hard.preserveRotations = false; Object.assign(f.config.search, { rotationMoveProbability: .3, silkMoveProbability: .3 });
  const m = modelFor(f), profile = { name: 'joint', seed: 987, weights: { sense: 1 } };
  const a = runSearch(m, profile, 150), b = runSearch(m, profile, 150);
  assert.ok(a.validation.valid && a.stats.rotationProposals > 0 && a.stats.silkProposals > 0);
  assert.deepEqual(a, b);
  assert.deepEqual(a.metrics, measure(m, a.plan.components, a.plan.labels));
});

test('edge conditions use physical body extents, not component origin or distant silkscreen', () => {
  const cs = [{ ref: 'J1', x: -100, y: 0, rotation: 0, body: { minX: -10, maxX: 10, minY: -10, maxY: 10 } }, { ref: 'U1', x: 100, y: 0, rotation: 0, body: { minX: -30, maxX: 30, minY: -30, maxY: 30 } }];
  const rules = compileEdgeRules([{ ref: 'J1' }], new Map(cs.map(c => [c.ref, c])));
  assert.equal(checkEdges(rules, cs).details[0].satisfied, false);
  cs[0].body.minY = -30;
  assert.equal(checkEdges(rules, cs).details[0].side, 'top');
  assert.equal(checkEdges(rules, cs).issues.length, 0);
  rules[0].sides = ['right'];
  assert.equal(checkEdges(rules, cs).issues.length, 1);
});

test('outward direction rotates with the connector while arbitrary header sides remain available', () => {
  for (const [rotation, side] of [[0, 'top'], [90, 'right'], [180, 'bottom'], [270, 'left']]) assert.deepEqual(availableEdges({ sides: ['left', 'right', 'top', 'bottom'], outwardAtRotation0: 'top' }, rotation), [side]);
  assert.deepEqual(availableEdges({ sides: ['left', 'top'] }, 180), ['left', 'top']);
  const f = fixture(); f.config.hard.preserveRotations = false;
  f.config.componentFeatures = [{ ref: 'U2', edge: { outwardAtRotation0: 'top' } }];
  const m = modelFor(f), projected = projectEdges(m, f.snapshot.components, { U2: 'left' });
  assert.equal(projected.find(c => c.ref === 'U2').rotation, 270);
  const candidate = buildEdgeCandidate(m, f.snapshot.components, undefined, {}, { U2: 'left' });
  assert.ok(candidate.validation.valid);
  assert.equal(candidate.validation.edge.details[0].side, 'left');
});

test('block membership comes from Contract and the distance constraint moves with its peer components', () => {
  const f = fixture(); f.contract.blocks = [{ id: 'sense-block', components: ['U1', 'U2'] }];
  f.config.componentFeatures = [{ ref: 'U2', block: { maxDistanceMil: 190 } }];
  const m = modelFor(f);
  const far = buildCandidate(m, f.snapshot.components.map(c => ({ ...c, x: c.ref === 'U2' ? 205 : c.x })));
  assert.ok(far.validation.issues.some(i => i.code === 'BLOCK_DISTANCE_EXCEEDED'));
  const together = buildCandidate(m, f.snapshot.components.map(c => ({ ...c, x: c.ref === 'J5' ? c.x : c.x + 40 })));
  assert.ok(together.validation.valid);
  assert.equal(together.validation.block.details[0].distanceMil, 180);
  assert.equal(together.validation.block.details[0].maxDistanceMil, 190);
});

test('edge and block constraints must hold together and fixed-position conflicts remain errors', () => {
  const f = fixture(); f.contract.blocks = [{ id: 'b', components: ['U1', 'U2'] }];
  f.config.componentFeatures = [{ ref: 'U2', edge: { sides: ['right'] }, block: { maxDistanceMil: 50 } }];
  const m = modelFor(f), c = buildEdgeCandidate(m, f.snapshot.components);
  assert.ok(c.validation.edge.details[0].satisfied);
  assert.equal(c.validation.valid, false);
  assert.ok(c.validation.issues.some(i => i.code === 'BLOCK_DISTANCE_EXCEEDED'));
  f.config.componentFeatures = [{ ref: 'J5', edge: { sides: ['left'] } }];
  const fixed = modelFor(f), before = structuredClone(f.snapshot.components), result = buildEdgeCandidate(fixed, f.snapshot.components);
  assert.equal(result.validation.valid, false);
  assert.deepEqual(f.snapshot.components, before);
  assert.equal(result.plan.components.find(c => c.ref === 'J5').x, 400);
});

test('invalid feature fields, side names and ambiguous block membership fail before searching', () => {
  for (const feature of [{ ref: 'missing', edge: true }, { ref: 'U1', edge: { sides: ['middle'] } }, { ref: 'U1', block: { maxDistanceMil: 10 } }, { ref: 'U1', extraUnknownRule: true }]) {
    const f = fixture(); f.config.componentFeatures = [feature]; assert.throws(() => modelFor(f), /INVALID_|BLOCK/);
  }
});

test('explicit edge proposals participate in seeded search and every accepted result satisfies all features', () => {
  const f = fixture(); f.config.hard.preserveRotations = false; f.config.search.edgeMoveProbability = .25;
  f.contract.blocks = [{ id: 'b', components: ['U1', 'U2'] }];
  f.config.componentFeatures = [{ ref: 'U2', edge: true, block: { maxDistanceMil: 230 } }];
  const m = modelFor(f), profile = { name: 'edge', seed: 321, weights: { sense: 1 } };
  const a = runSearch(m, profile, 120), b = runSearch(m, profile, 120);
  assert.ok(a.validation.valid && a.stats.edgeProposals > 0);
  assert.deepEqual(a, b);
});

test('explicit anchor selection and fixed upper bounds survive repeated baseline recompilation', () => {
  const f = fixture(); f.contract.blocks = [{ id: 'logic', components: ['U1','U2','J5'] }];
  f.config.componentFeatures = [{ ref: 'J5', block: { anchors: ['U2'], maxDistanceMil: 230 } }];
  const m = modelFor(f);
  assert.deepEqual(m.blockRules[0].anchors, ['U2']);
  assert.equal(m.blockRules[0].maxDistanceMil, 230);
  const changed = translatedSnapshot(m, f.snapshot.components.map(c => ({ ...c, x: c.ref === 'U2' ? 160 : c.x })));
  const again = compileModel(changed, f.contract, f.config, f.mechanical);
  assert.equal(again.blockRules[0].maxDistanceMil, 230);
  assert.ok(buildCandidate(again, changed.components).validation.issues.some(i => i.code === 'BLOCK_DISTANCE_EXCEEDED'));
});

test('hard spatial conditions remain checked without a corresponding soft score', () => {
  const f = fixture();
  f.config.spatial = { relations: [{ id: 'near', a: 'U1', b: 'U2', metric: 'origin-manhattan', category: 'proximity', band: { idealMaxMil: 100, hardMaxMil: 150, scaleMil: 100 } }] };
  const m = modelFor(f), c = buildCandidate(m, f.snapshot.components);
  assert.equal(c.validation.valid, false);
  assert.ok(c.validation.issues.some(i => i.code === 'SPATIAL_DISTANCE_LIMIT'));
});

test('a blocked turn can let a nearby component yield within a strict radius', () => {
  const f = fixture(); f.config.hard.preserveRotations = false;
  f.snapshot.components[0].bbox = { minX:-40,maxX:40,minY:-10,maxY:10 };
  let m = modelFor(f);
  f.snapshot = translatedSnapshot(m, f.snapshot.components.map(c => c.ref === 'U2' ? { ...c, x:0,y:60 } : c));
  m = modelFor(f);
  const target = f.snapshot.components.map(c => c.ref === 'U1' ? { ...c, rotation:90 } : c);
  const rejected = buildCandidate(m,target,undefined,{}, { maxRelocationMil:0 });
  assert.equal(rejected.validation.valid,false);
  const repaired = buildCandidate(m,target,undefined,{}, { maxRelocationMil:20,relocatableRefs:['U2'] });
  assert.ok(repaired.validation.valid,JSON.stringify(repaired.validation.issues));
  const u2 = repaired.plan.components.find(c=>c.ref==='U2');
  assert.ok(u2.dx || u2.dy);
  assert.ok(Math.max(Math.abs(u2.dx),Math.abs(u2.dy))<=20);
  assert.equal(repaired.plan.components.find(c=>c.ref==='U1').rotation,90);
  assert.equal(repaired.plan.components.find(c=>c.ref==='J5').x,400);
});

test('group/joint proposals and all archived alternatives are reproducible and fully validated', () => {
  const f = fixture(); f.config.hard.preserveRotations = false;
  f.config.spatial = {localGroups:[{id:'local',refs:['U1','U2']}]};
  Object.assign(f.config.search,{groupMoveProbability:.35,jointMoveProbability:.4,jointRepairRadiusMil:30,archiveSize:6});
  const m=modelFor(f),p={name:'sample',label:'sample',seed:1234,weights:f.config.comparisonWeights};
  const a=runSearch(m,p,150),b=runSearch(m,p,150);
  assert.deepEqual(a,b);
  assert.ok(a.stats.groupProposals>0 && a.stats.jointProposals>0);
  assert.ok(a.stats.groupsAccepted>0 && a.stats.jointAccepted>0);
  assert.ok(a.alternatives.length>=1 && a.alternatives.length<=6);
  for(const c of [a,...a.alternatives]) {
    assert.equal(validatePlan(m,c.plan).valid,true);
    assert.equal(c.plan.components.find(c=>c.ref==='J5').x,400);
    assert.deepEqual(c.metrics,measure(m,c.plan.components,c.plan.labels,c.plan.bundles));
  }
});
