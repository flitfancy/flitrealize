import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareLayoutInputs } from '../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { inspectCandidate } from '../scripts/pcb-layout/pcb-layout-solver-core.mjs';
import { cpSatSettings, compileSemanticCpSatProblem, decodeCpSatCandidate, executeCpSat, runCpsatLayout } from '../scripts/pcb-layout/pcb-layout-cpsat.mjs';
import { compileOpenBlockProblem, scopeOpenLayoutModel } from '../scripts/pcb-layout/pcb-layout-cpsat-open.mjs';
import { scopeLayoutModel } from '../scripts/pcb-layout/pcb-layout-scope.mjs';
import { convertSemanticInputs } from '../scripts/pcb-layout/pcb-layout-semantic.mjs';
import { createRigidBlock, createRigidBlockAtlas, compileRigidBlockProblem, filterRigidBlockCopperChannels, verifyRigidBlockPacking, runRigidBlockPacking } from '../scripts/pcb-layout/pcb-layout-blocks.mjs';
import { prepareFixture, filterRelation, addIntent } from './helpers/pcb-layout-prepare-fixture.mjs';

const runtime = { pythonPath: process.env.FLITREALIZE_CPSAT_PYTHON };
const runtimeSkip = !runtime.pythonPath && 'Set FLITREALIZE_CPSAT_PYTHON to an OR-Tools Python runtime.';
function prepared(configure = () => {}) {
  const fixture = addIntent(prepareFixture(), filterRelation());
  fixture.config.hard.boardBounds = { minX: -100, minY: -100, maxX: 400, maxY: 300 };
  configure(fixture);
  const result = prepareLayoutInputs(fixture); assert.equal(result.state.ready, true, JSON.stringify(result.diagnostics));
  return result.model;
}
const box = (x, y, r = 10) => ({ minX: x-r, maxX: x+r, minY: y-r, maxY: y+r });
const padShape = b => ({ kind: 'polygon', layers: ['front'], points: [[b.minX, b.minY], [b.minX, b.maxY], [b.maxX, b.maxY], [b.maxX, b.minY]] });
function atlas() {
  const group = (id, fixed) => ({ id, rotations: [0], base: fixed ? { x: 30, y: 30 } : { x: 0, y: 0 }, fixed,
    parts: [{ ref: id, x: 0, y: 0, rotation: 0, body: box(0, 0) }], pads: [{ id: id+'-pad', owner: id, net: 'LINK', x: 0, y: 0, bbox: box(0, 0, 2) }],
    copper: [{ id: id+'-pad', owner: id, net: 'LINK', shape: padShape(box(0, 0, 2)) }], localVerification: { copperVerified: true } });
  const a = group('coreA', true), b = group('coreB', false);
  a.copper.push({ id: 'preserved-local-wire', net: 'LOCAL_A', shape: { kind: 'capsule', a: [20, 0], b: [70, 0], radius: 3, layers: ['front'] } });
  b.allowedTransforms = [{ x: 80, y: 30, rotation: 0 }, { x: 80, y: 70, rotation: 0 }];
  return { sourceHash: 'synthetic-atlas', board: { minX: 0, minY: 0, maxX: 200, maxY: 200 }, groups: [a, b], expectedRefs: ['coreA', 'coreB'], bodyGapMil: 8, copperGapMil: 4, copperEdgeMil: 2, netWeights: { LINK: 1 }, excludeNets: [] };
}

test('semantic conversion covers all parts once and leaves hard rules untouched', () => {
  const model = prepared(), hard = structuredClone(model.config.hard), semantic = convertSemanticInputs(model);
  assert.equal(semantic.groups.length, 1); assert.deepEqual(semantic.groups[0].members, ['C1', 'U1']);
  assert.equal(semantic.groups[0].type, 'flexible'); assert.equal(semantic.groups[0].normalizedWeight, 1);
  assert.deepEqual(model.config.hard, hard); assert.equal(semantic.policy.hardRules, 'unchanged');
});

test('CP-SAT refuses obsolete refinement parameters instead of accepting ignored controls', () => {
  for (const key of ['refineRounds', 'neighborhoodSize', 'refineRadiusMil']) assert.throws(() => cpSatSettings({ [key]: 1 }), /UNSUPPORTED_REFINEMENT_SETTINGS/);
  assert.deepEqual(Object.keys(cpSatSettings()).sort(), ['displacementWeight', 'resolutionMil', 'seed', 'timeLimitSeconds', 'workers']);
});

test('role inference is activated by external patterns and association weights', () => {
  const fixture = prepareFixture();
  fixture.contract.components[0].role = 'alpha rail controller'; fixture.contract.components[1].role = 'alpha rail bypass';
  fixture.contract.components[0].pins.push({ number: '2' }, { number: '3' }); fixture.contract.components[1].pins.push({ number: '2' });
  fixture.contract.nets.push({ name: 'RETURN', kind: 'ground', endpoints: [{ component: 'U1', pin: '2' }, { component: 'C1', pin: '2' }] }, { name: 'SIGNAL', kind: 'signal', endpoints: [{ component: 'U1', pin: '3' }] });
  for (const [owner, number, net, dx] of [['U1', '2', 'RETURN', 4], ['U1', '3', 'SIGNAL', -4], ['C1', '2', 'RETURN', 4]]) {
    const pose = fixture.snapshot.components.find(c => c.ref === owner), x = pose.x + dx;
    fixture.snapshot.pads.push({ id: owner+':'+number, owner, number, net, x, y: 0, bbox: box(x, 0, 2), layer: 1 });
  }
  const result = prepareLayoutInputs(fixture); assert.equal(result.state.ready, true, JSON.stringify(result.diagnostics));
  assert.equal(convertSemanticInputs(result.model).inferredLinks.length, 0);
  const semantic = convertSemanticInputs(result.model, { roles: { bypass: ['rail bypass'] }, associationWeights: { direct: 4, block: 2, role: 1 } });
  assert.equal(semantic.inferredLinks.length, 1); assert.equal(semantic.inferredLinks[0].net, 'SUPPLY');
  assert.deepEqual(semantic.groups[0].members, ['C1', 'U1']); assert.equal(semantic.policy.associationWeights.direct, 4);
});

test('fresh CP-SAT model retains explicit hard constraints and has zero pose bias', () => {
  const model = prepared(), before = structuredClone(model.snapshot), { problem } = compileSemanticCpSatProblem(model, { resolutionMil: .5 });
  assert.equal(problem.noInitialHints, true); assert.equal(problem.settings.displacementWeight, 0);
  assert.ok(problem.entities.every(e => e.fixed || e.base.x === 0 && e.base.y === 0));
  assert.ok(problem.entities.every(e => !Object.hasOwn(e, 'preferredVariant')));
  assert.deepEqual(problem.board, model.config.hard.boardBounds); assert.equal(problem.pairs[0].gapMil, model.mechanical.clearanceMil);
  assert.deepEqual(model.snapshot, before);
});

test('CP-SAT decoder rejects another source and out-of-domain variants', () => {
  const model = prepared(), { problem } = compileSemanticCpSatProblem(model), placements = problem.entities.map(e => ({ ref: e.ref, dx: 0, dy: 0, variant: 0 }));
  assert.throws(() => decodeCpSatCandidate(model, problem, { status: 'FEASIBLE', sourceHash: 'other', placements }), /RESULT_IDENTITY/);
  placements[0].variant = 999999;
  assert.throws(() => decodeCpSatCandidate(model, problem, { status: 'FEASIBLE', sourceHash: model.snapshot.sourceHash, placements }), /RESULT_POSE/);
});

test('open block study uses a local gauge and keeps its explicit internal limits', () => {
  const model = prepared(); model.limits.push({ id: 'local-cap', left: [model.pads[0]], right: [model.pads[1]], maxMil: 100 });
  const before = structuredClone(model.config.hard), result = compileOpenBlockProblem(model, { refs: ['U1', 'C1'], gaugeRef: 'U1', computationalCoordinateMil: 500 });
  assert.equal(result.problem.openPlacement, true); assert.deepEqual(result.problem.board, {});
  assert.equal(result.model.config.hard.boardBounds, null); assert.equal(result.model.fixed.get('U1').x, 0);
  assert.equal(result.problem.limits[0].maxMil, 100); assert.equal(result.problem.settings.displacementWeight, 0);
  assert.deepEqual(model.config.hard, before);
});

test('public scope projection preserves the board by default and compiles open space directly', () => {
  const full = prepared(), scoped = scopeLayoutModel(full, { refs: ['U1'] });
  assert.equal(inspectCandidate(scoped).validation.valid, true); assert.deepEqual(scoped.config.hard.boardBounds, full.config.hard.boardBounds);
  assert.deepEqual(scoped.couplingModel.blocks[0].components, ['U1']); assert.equal(scoped.modelScope.wholeBoard, false);
  const { model, problem } = compileOpenBlockProblem(full, { refs: ['U1', 'C1'], gaugeRef: 'U1' });
  assert.equal(model.board.bounds, null); assert.deepEqual(problem.board, {}); assert.equal(problem.coverage.scope.placementMode, 'open');
  assert.ok(problem.entities.every(entity => entity.variants.every(variant => variant.labels.length === 0 && variant.side === null)));
  assert.equal(problem.coverage.hard.includes('board'), false);
});

test('open study preserves selected native locks and refuses their explicit release', async () => {
  const full = prepared(fixture => { fixture.snapshot.components.find(c => c.ref === 'C1').locked = true; });
  const before = structuredClone(full.snapshot), spec = { refs: ['U1', 'C1'], gaugeRef: 'U1', computationalCoordinateMil: 500 };
  const { model, problem } = compileOpenBlockProblem(full, spec, { timeLimitSeconds: 2, workers: 1, resolutionMil: .5 });
  assert.deepEqual(model.fixed.get('C1'), { ref: 'C1', x: 150, y: 0, rotation: 0 });
  assert.equal(problem.entities.find(e => e.ref === 'C1').fixed, true);
  assert.deepEqual(problem.coverage.scope.nativeLockedRefs, ['C1']);
  assert.throws(() => compileOpenBlockProblem(full, { ...spec, releaseFixedRefs: ['C1'] }), /NATIVE_LOCK_RELEASE_FORBIDDEN C1/);
  if (runtime.pythonPath) {
    const result = await executeCpSat(problem, runtime), candidate = decodeCpSatCandidate(model, problem, result);
    assert.equal(candidate.validation.valid, true); assert.equal(candidate.plan.components.find(c => c.ref === 'C1').x, 150);
  }
  assert.deepEqual(full.snapshot, before);
});

test('open study preserves ordinary hard.fixed poses by default', () => {
  const full = prepared(fixture => { fixture.config.hard.fixed = [{ ref: 'C1', x: 150, y: 0, rotation: 0 }]; });
  const { model, problem } = compileOpenBlockProblem(full, { refs: ['U1', 'C1'], gaugeRef: 'U1' });
  assert.deepEqual(model.fixed.get('C1'), full.fixed.get('C1'));
  assert.deepEqual(problem.entities.find(e => e.ref === 'C1').base, { x: 150, y: 0 });
  assert.deepEqual(problem.coverage.scope.preservedFixedRefs, ['C1']);
  assert.deepEqual(problem.coverage.scope.releasedFixedRefs, []);
  assert.equal(problem.coverage.scope.boardBoundaryReleased, true);
});

test('open study releases ordinary hard.fixed only when explicitly requested', async () => {
  const full = prepared(fixture => { fixture.config.hard.fixed = [{ ref: 'C1', x: 150, y: 0, rotation: 0 }]; });
  const { model, problem } = compileOpenBlockProblem(full, { refs: ['U1', 'C1'], gaugeRef: 'U1', releaseFixedRefs: ['C1'], computationalCoordinateMil: 500 }, { timeLimitSeconds: 2, workers: 1, resolutionMil: .5 });
  assert.equal(model.fixed.has('C1'), false); assert.equal(problem.entities.find(e => e.ref === 'C1').fixed, false);
  assert.deepEqual(problem.coverage.scope.releasedFixedRefs, ['C1']); assert.equal(full.fixed.get('C1').x, 150);
  if (runtime.pythonPath) {
    const result = await executeCpSat(problem, runtime), candidate = decodeCpSatCandidate(model, problem, result);
    assert.equal(candidate.validation.valid, true); assert.notEqual(candidate.plan.components.find(c => c.ref === 'C1').x, 150);
  }
});

test('open study refuses hard.fixed releases that also have an explicit mechanical lock', () => {
  const full = prepared(fixture => {
    fixture.config.hard.fixed = [{ ref: 'C1', x: 150, y: 0, rotation: 0 }]; fixture.mechanical.lockedDesignators = ['C1'];
  });
  assert.deepEqual(full.lockProvenance.get('C1'), ['hard.fixed', 'mechanical.lockedDesignators']);
  const spec = { refs: ['U1', 'C1'], gaugeRef: 'U1' }, retained = compileOpenBlockProblem(full, spec);
  assert.equal(retained.model.fixed.get('C1').x, 150); assert.deepEqual(retained.problem.coverage.scope.mechanicalLockedRefs, ['C1']);
  assert.throws(() => compileOpenBlockProblem(full, { ...spec, releaseFixedRefs: ['C1'] }), /MECHANICAL_LOCK_RELEASE_FORBIDDEN C1/);
  const scoped = scopeOpenLayoutModel(full, { refs: ['U1'], gaugeRef: 'U1' });
  assert.equal(scoped.lockProvenance.has('C1'), false); assert.ok([...scoped.lockProvenance.keys()].every(ref => ref === 'U1'));
  assert.deepEqual(full.lockProvenance.get('C1'), ['hard.fixed', 'mechanical.lockedDesignators']);
});

test('open study conservatively retains legacy fixed poses with unknown lock provenance', () => {
  const full = prepared(fixture => { fixture.config.hard.fixed = [{ ref: 'C1', x: 150, y: 0, rotation: 0 }]; });
  delete full.lockProvenance;
  const spec = { refs: ['U1', 'C1'], gaugeRef: 'U1' }, retained = compileOpenBlockProblem(full, spec);
  assert.equal(retained.model.fixed.get('C1').x, 150); assert.deepEqual(retained.model.lockProvenance.get('C1'), ['legacy.unknown']);
  assert.throws(() => compileOpenBlockProblem(full, { ...spec, releaseFixedRefs: ['C1'] }), /LOCK_PROVENANCE_UNKNOWN C1/);
});

test('open study rejects context and gauge changes to retained fixed poses', () => {
  const full = prepared(fixture => { fixture.config.hard.fixed = [{ ref: 'C1', x: 150, y: 0, rotation: 0 }]; });
  const spec = { refs: ['U1', 'C1'], gaugeRef: 'U1' };
  assert.throws(() => compileOpenBlockProblem(full, { ...spec, contextPlacements: [{ ref: 'C1', x: 151, y: 0, rotation: 0 }] }), /CONTEXT_FIXED_POSE_CONFLICT C1/);
  assert.throws(() => compileOpenBlockProblem(full, { ...spec, gaugeRef: 'C1', gaugePose: { x: 0, y: 0, rotation: 0 } }), /GAUGE_FIXED_POSE_CONFLICT C1/);
  const retained = compileOpenBlockProblem(full, { ...spec, gaugeRef: 'C1', contextPlacements: [{ ref: 'C1', x: 150, y: 0, rotation: 0 }] });
  assert.equal(retained.model.fixed.get('C1').x, 150); assert.equal(retained.problem.coverage.scope.gaugePose.x, 150);
});

test('rigid atlas rejects duplicate parts and wrong transform rotations', () => {
  const input = atlas(), duplicate = structuredClone(input); duplicate.groups[1].parts[0].ref = 'coreA';
  assert.throws(() => compileRigidBlockProblem(duplicate), /INVALID_RIGID_BLOCK_PAD|COVERAGE/);
  const bad = structuredClone(input); bad.groups[1].allowedTransforms[0].rotation = 90;
  assert.throws(() => compileRigidBlockProblem(bad), /TRANSFORM_DOMAIN/);
});

test('rigid blocks reject explicit non-mil units and label created data as mil', () => {
  const input = atlas(); assert.equal(compileRigidBlockProblem(input).units, 'mil');
  input.units = 'mm'; assert.throws(() => compileRigidBlockProblem(input), /INVALID_RIGID_BLOCK_UNITS/);
  input.units = 'mil'; assert.equal(compileRigidBlockProblem(input).units, 'mil');
  const model = prepared(), block = createRigidBlock(model, inspectCandidate(model), { id: 'unit-block', refs: ['U1'], rotations: [0] });
  assert.equal(block.units, 'mil');
});

test('rigid block layers use Provider purposes and require explicit legacy compatibility', () => {
  const model = prepared(fixture => { fixture.snapshot.pads[0].layer = 12; }), candidate = inspectCandidate(model);
  const block = createRigidBlock(model, candidate, { id: 'all-layer', refs: ['U1'] });
  assert.deepEqual(block.pads[0].layers, ['top-copper', 'bottom-copper']); assert.equal(block.scope.layerRepresentation, 'public-copper-purposes');
  const missing = { ...model, realization: { ...model.realization, layers: {} } };
  assert.throws(() => createRigidBlock(missing, candidate, { id: 'missing-layer', refs: ['U1'] }), /PUBLIC_COPPER_LAYERS_REQUIRED/);
  const legacy = createRigidBlock(missing, candidate, { id: 'legacy-layer', refs: ['U1'], padLayers: () => [1, 2], legacyNativeLayers: true });
  assert.equal(legacy.scope.layerRepresentation, 'legacy-native'); assert.ok(legacy.diagnostics.some(d => d.code === 'LEGACY_NATIVE_COPPER_LAYERS'));
});

test('rigid atlas derives shared board, spacing and edge rules and requires public validation', () => {
  const full = prepared(fixture => { fixture.config.hard.pinDistanceLimits = [{ a: 'U1', aPin: '1', b: 'C1', bPin: '1', net: 'SUPPLY', maxMil: 200 }]; });
  const candidate = inspectCandidate(full), groups = candidate.plan.components.map(p => createRigidBlock(full, candidate, { id: p.ref, refs: [p.ref], origin: p }));
  const { atlas: derived, model } = createRigidBlockAtlas(full, groups, { copperRules: { copperGapMil: 4, copperEdgeMil: 2, source: 'synthetic routing policy' } });
  assert.deepEqual(derived.board, full.config.hard.boardBounds); assert.equal(derived.bodyGapMil, full.mechanical.clearanceMil); assert.equal(derived.scope.wholeBoard, true);
  assert.throws(() => verifyRigidBlockPacking(derived, { U1: { x: 0, y: 0, rotation: 0 }, C1: { x: 150, y: 0, rotation: 0 } }), /PUBLIC_MODEL_REQUIRED/);
  const report = verifyRigidBlockPacking(derived, { U1: { x: 0, y: 0, rotation: 0 }, C1: { x: 250, y: 0, rotation: 0 } }, { model });
  assert.equal(report.valid, false); assert.ok(report.issues.some(issue => issue.code === 'PIN_DISTANCE_LIMIT')); assert.equal(report.scope.publicRulesVerified, false);
  const clear = verifyRigidBlockPacking(derived, { U1: { x: 0, y: 0, rotation: 0 }, C1: { x: 150, y: 0, rotation: 0 } }, { model });
  assert.equal(clear.valid, true); assert.equal(clear.scope.publicRulesVerified, true);
});

test('partial rigid atlas scopes public rule validation to its declared refs', () => {
  const full = prepared(), candidate = inspectCandidate(full), group = createRigidBlock(full, candidate, { id: 'U1', refs: ['U1'] });
  const { atlas: derived, model } = createRigidBlockAtlas(full, [group], { refs: ['U1'], copperRules: { copperGapMil: 4, copperEdgeMil: 2, source: 'synthetic routing policy' } });
  const report = verifyRigidBlockPacking(derived, { U1: { x: 0, y: 0, rotation: 0 } }, { model });
  assert.equal(report.valid, true); assert.deepEqual(report.publicValidation.scope.expectedRefs, ['U1']); assert.equal(report.publicValidation.scope.wholeBoard, false);
  const legacy = compileRigidBlockProblem(atlas()); assert.ok(legacy.diagnostics.some(d => d.code === 'LEGACY_EXPLICIT_RIGID_ATLAS'));
});

test('rigid factory rebuilds omitted real pads and their copper so obstacles cannot be bypassed', () => {
  const full = prepared(), candidate = inspectCandidate(full), groups = candidate.plan.components.map(p => createRigidBlock(full, candidate, { id: p.ref, refs: [p.ref], origin: p }));
  const missing = structuredClone(groups); missing.find(g => g.id === 'U1').pads = []; missing.find(g => g.id === 'U1').copper = [];
  const { atlas: derived, model } = createRigidBlockAtlas(full, missing, { copperRules: { copperGapMil: 4, copperEdgeMil: 2, source: 'synthetic routing policy' }, fixedCopper: [{ id: 'OTHER', net: 'OTHER', shape: { kind: 'circle', center: [0, 0], radius: 3, layers: ['top-copper'] } }] });
  assert.equal(derived.groups.find(g => g.id === 'U1').pads.length, 1); assert.equal(derived.groups.find(g => g.id === 'U1').copper.filter(c => c.type === 'pad').length, 1);
  const report = verifyRigidBlockPacking(derived, { U1: { x: 0, y: 0, rotation: 0 }, C1: { x: 150, y: 0, rotation: 0 } }, { model });
  assert.equal(report.valid, false); assert.ok(report.issues.some(issue => issue.code === 'CROSS_COPPER')); assert.equal(report.render.pads.length, model.pads.length);
  const tampered = structuredClone(derived); tampered.groups.find(g => g.id === 'U1').pads = []; tampered.groups.find(g => g.id === 'U1').copper = [];
  const caught = verifyRigidBlockPacking(tampered, { U1: { x: 0, y: 0, rotation: 0 }, C1: { x: 150, y: 0, rotation: 0 } }, { model });
  assert.equal(caught.valid, false); assert.equal(caught.publicValidation.scope.publicRulesVerified, false); assert.ok(caught.issues.some(issue => issue.code === 'PUBLIC_PAD_COVERAGE'));
});

test('rigid factory rejects conflicting pad nets, owners and local geometry', () => {
  const full = prepared(), candidate = inspectCandidate(full), original = candidate.plan.components.map(p => createRigidBlock(full, candidate, { id: p.ref, refs: [p.ref], origin: p }));
  const options = { copperRules: { copperGapMil: 4, copperEdgeMil: 2, source: 'synthetic routing policy' } };
  const badNet = structuredClone(original); badNet[0].pads[0].net = 'OTHER';
  assert.throws(() => createRigidBlockAtlas(full, badNet, options), /PAD_IDENTITY_MISMATCH/);
  const badOwner = structuredClone(original); badOwner[0].pads[0].owner = 'C1';
  assert.throws(() => createRigidBlockAtlas(full, badOwner, options), /PAD_IDENTITY_MISMATCH/);
  const badBox = structuredClone(original); badBox[0].pads[0].bbox.maxX += 1;
  assert.throws(() => createRigidBlockAtlas(full, badBox, options), /PAD_GEOMETRY_MISMATCH/);
  const badCopper = structuredClone(original); badCopper[0].copper[0].shape.points[0][0] += 1;
  assert.throws(() => createRigidBlockAtlas(full, badCopper, options), /PAD_COPPER_GEOMETRY_MISMATCH/);
});

test('rigid factory retains standalone source pads as fixed copper and verifies their render coverage', () => {
  const full = prepared(fixture => {
    fixture.snapshot.pads.push({ id: 'TP_NATIVE', owner: null, number: 'TP1', net: 'RETURN', x: 75, y: 0, bbox: box(75, 0, 2), layer: 1, locked: true });
    fixture.contract.components.push({ designator: 'TP1', role: 'test point', includeInPcb: true, pins: [{ number: '1' }] });
    fixture.contract.nets.push({ name: 'RETURN', kind: 'ground', endpoints: [{ component: 'TP1', pin: '1' }] });
  });
  const candidate = inspectCandidate(full), groups = candidate.plan.components.map(p => createRigidBlock(full, candidate, { id: p.ref, refs: [p.ref], origin: p }));
  const { atlas: derived, model } = createRigidBlockAtlas(full, groups, { copperRules: { copperGapMil: 4, copperEdgeMil: 2, source: 'synthetic routing policy' } });
  assert.deepEqual(derived.standalonePads.map(pad => pad.id), ['TP_NATIVE']); assert.ok(derived.fixedCopper.some(item => item.id === 'TP_NATIVE' && item.type === 'pad'));
  const report = verifyRigidBlockPacking(derived, { U1: { x: 75, y: 0, rotation: 0 }, C1: { x: 150, y: 0, rotation: 0 } }, { model });
  assert.equal(report.valid, false); assert.ok(report.issues.some(issue => issue.code === 'CROSS_COPPER')); assert.equal(report.render.pads.length, model.pads.length);
  const partial = createRigidBlockAtlas(full, [groups.find(g => g.id === 'U1')], { refs: ['U1'], copperRules: { copperGapMil: 4, copperEdgeMil: 2, source: 'synthetic routing policy' } });
  const local = verifyRigidBlockPacking(partial.atlas, { U1: { x: 0, y: 0, rotation: 0 } }, { model: partial.model });
  assert.equal(local.valid, true); assert.deepEqual(local.publicValidation.scope.expectedPadIds, ['U1:1']); assert.equal(local.publicValidation.scope.wholeBoard, false);
});

test('public rigid verifier rejects missing clearance rules and duplicate identities', () => {
  const input = atlas(), transforms = { coreA: { x: 30, y: 30, rotation: 0 }, coreB: { x: 80, y: 70, rotation: 0 } };
  for (const key of ['bodyGapMil', 'copperGapMil', 'copperEdgeMil']) {
    const missing = structuredClone(input); delete missing[key];
    assert.throws(() => verifyRigidBlockPacking(missing, transforms), new RegExp('INVALID_RIGID_BLOCK_RULE ' + key));
  }
  const duplicateGroup = structuredClone(input); duplicateGroup.groups[1].id = duplicateGroup.groups[0].id;
  assert.throws(() => verifyRigidBlockPacking(duplicateGroup, transforms), /INVALID_RIGID_BLOCK_ATLAS/);
  const duplicatePart = structuredClone(input); duplicatePart.groups[1].parts[0].ref = 'coreA'; duplicatePart.groups[1].pads[0].owner = 'coreA';
  assert.throws(() => verifyRigidBlockPacking(duplicatePart, transforms), /RIGID_BLOCK_COVERAGE/);
});

test('public rigid verifier rejects exact body overlap with a complete atlas', () => {
  const input = atlas(); input.groups[0].fixed = false;
  const report = verifyRigidBlockPacking(input, { coreA: { x: 50, y: 50, rotation: 0 }, coreB: { x: 50, y: 50, rotation: 0 } });
  assert.equal(report.valid, false); assert.ok(report.issues.some(issue => issue.code === 'BODY_CLEARANCE'));
});

test('exact copper verifier returns reusable local cuts and preserves scope', () => {
  const input = atlas(), report = verifyRigidBlockPacking(input, { coreA: { x: 30, y: 30, rotation: 0 }, coreB: { x: 80, y: 30, rotation: 0 } });
  assert.equal(report.valid, false); assert.equal(report.issues.filter(i => i.code === 'CROSS_COPPER').length, 1);
  assert.equal(report.cuts.length, 1); assert.equal(report.cuts[0].gapMil, 4);
  assert.deepEqual(report.cuts[0].a.box, { minX: 17, minY: -3, maxX: 73, maxY: 3 });
  assert.equal(report.scope.groundVerified, false); assert.equal(report.scope.nativeDrcRun, false);
  const clear = verifyRigidBlockPacking(input, { coreA: { x: 30, y: 30, rotation: 0 }, coreB: { x: 80, y: 70, rotation: 0 } });
  assert.equal(clear.valid, true);
});

test('rigid verifier shares top=minY edge names with the existing layout model', () => {
  const input = atlas(); input.edges = [{ ref: 'coreB', side: 'top', maxInsetMil: 21 }];
  const report = verifyRigidBlockPacking(input, { coreA: { x: 30, y: 30, rotation: 0 }, coreB: { x: 80, y: 70, rotation: 0 } });
  assert.ok(report.issues.some(i => i.code === 'EDGE_INTERFACE'));
  input.edges[0].side = 'bottom'; input.edges[0].maxInsetMil = 121;
  assert.equal(verifyRigidBlockPacking(input, { coreA: { x: 30, y: 30, rotation: 0 }, coreB: { x: 80, y: 70, rotation: 0 } }).valid, true);
});

test('runtime creates decoded candidates from cold starts with no external hints', { skip: runtimeSkip }, async () => {
  const result = await runCpsatLayout(prepared(), { timeLimitSeconds: 2, workers: 1, resolutionMil: .5 }, { candidateCount: 2, maxRuns: 2, coldSeconds: 2, runtime });
  assert.equal(result.status, 'candidates-ready', JSON.stringify(result.runs)); assert.ok(result.candidates.length >= 1);
  for (const candidate of result.candidates) { assert.equal(candidate.validation.valid, true); assert.equal(candidate.stats.externalInitialHintCount, 0); assert.equal(candidate.stats.noInitialHints, true); }
});

test('runtime solves the boardless study and exact validator accepts the result', { skip: runtimeSkip }, async () => {
  const { model, problem } = compileOpenBlockProblem(prepared(), { refs: ['U1', 'C1'], gaugeRef: 'U1', computationalCoordinateMil: 500 }, { timeLimitSeconds: 2, workers: 1, resolutionMil: .5 });
  const result = await executeCpSat(problem, runtime); assert.ok(['FEASIBLE', 'OPTIMAL'].includes(result.status), JSON.stringify(result));
  const candidate = decodeCpSatCandidate(model, problem, result); assert.equal(candidate.validation.valid, true, JSON.stringify(candidate.validation.issues));
});

test('runtime feeds exact copper conflicts back into rigid packing', { skip: runtimeSkip }, async () => {
  const result = await runRigidBlockPacking(atlas(), { timeLimitSeconds: 2, workers: 1, resolutionMil: .5 }, { runtime, feedbackRounds: 1 });
  assert.equal(result.status, 'geometry-verified', JSON.stringify(result.runs)); assert.equal(result.runs.length, 2);
  assert.equal(result.cuts.length, 1); assert.equal(result.result.transforms.coreB.y, 70);
  assert.equal(result.verification.scope.groundVerified, false);
});

test('runtime packs model-derived blocks and accepts them with the common validator', { skip: runtimeSkip }, async () => {
  const full = prepared(), candidate = inspectCandidate(full), groups = candidate.plan.components.map(p => createRigidBlock(full, candidate, { id: p.ref, refs: [p.ref], origin: p }));
  const { atlas: derived, model } = createRigidBlockAtlas(full, groups, { copperRules: { copperGapMil: 4, copperEdgeMil: 2, source: 'synthetic routing policy' } });
  const result = await runRigidBlockPacking(derived, { timeLimitSeconds: 2, workers: 1, resolutionMil: .5 }, { model, runtime });
  assert.equal(result.status, 'geometry-verified', JSON.stringify(result.verification?.issues ?? result.runs)); assert.equal(result.verification.publicValidation.valid, true);
  assert.equal(result.verification.publicValidation.scope.wholeBoard, true);
});

test('runtime derives variant edge directions and pair spacing from the public model', { skip: runtimeSkip }, async () => {
  const full = prepared(fixture => {
    const part = fixture.snapshot.components.find(p => p.ref === 'U1'); part.x -= 90; part.bbox.minX -= 90; part.bbox.maxX -= 90;
    for (const pad of fixture.snapshot.pads.filter(p => p.owner === 'U1')) { pad.x -= 90; pad.bbox.minX -= 90; pad.bbox.maxX -= 90; }
    for (const text of fixture.snapshot.items.filter(p => p.owner === 'U1')) { text.original.x -= 90; text.original.bbox.minX -= 90; text.original.bbox.maxX -= 90; }
    fixture.config.componentFeatures = [{ ref: 'U1', edge: { sides: ['left', 'right'], maxInsetMil: 0, outwardAtRotation0: 'left' } }];
    fixture.mechanical.pairClearancesMil = [{ a: 'U1', b: 'C1', hardMinMil: 12 }];
  });
  const candidate = inspectCandidate(full); assert.equal(candidate.validation.valid, true);
  const groups = candidate.plan.components.map(p => createRigidBlock(full, candidate, { id: p.ref, refs: [p.ref], origin: p }));
  const { atlas: derived, model } = createRigidBlockAtlas(full, groups, { copperRules: { copperGapMil: 4, copperEdgeMil: 2, source: 'synthetic routing policy' } });
  assert.deepEqual(derived.groups.find(g => g.id === 'U1').rotations, [0, 180]); assert.deepEqual(derived.edges[0].variantSides, [['left'], ['right']]);
  assert.ok(derived.separations.some(rule => rule.gapMil === 12));
  const result = await runRigidBlockPacking(derived, { timeLimitSeconds: 2, workers: 1, resolutionMil: .5 }, { model, runtime });
  assert.equal(result.status, 'geometry-verified', JSON.stringify(result.verification?.issues ?? result.runs)); assert.equal(result.verification.publicValidation.valid, true);
});

test('runtime feedback also separates a movable block from fixed external copper', { skip: runtimeSkip }, async () => {
  const input = atlas(); input.groups[0].copper.pop();
  input.fixedCopper = [{ id: 'fixed-bus', net: 'BUS', shape: { kind: 'capsule', a: [80, 10], b: [80, 50], radius: 2, layers: ['front'] } }];
  const result = await runRigidBlockPacking(input, { timeLimitSeconds: 2, workers: 1, resolutionMil: .5 }, { runtime, feedbackRounds: 1 });
  assert.equal(result.status, 'geometry-verified', JSON.stringify(result.runs)); assert.equal(result.runs.length, 2);
  assert.ok(result.cuts.some(c => !c.a.group || !c.b.group)); assert.equal(result.result.transforms.coreB.y, 70);
});

test('runtime screens preserved copper channels in bulk without claiming exact proof', { skip: runtimeSkip }, async () => {
  const input = atlas(); delete input.groups[1].allowedTransforms;
  const fixedCopper = [{ id: 'fixed-bus', net: 'BUS', shape: { kind: 'capsule', a: [100, 10], b: [100, 190], radius: 2, layers: ['front'] } }];
  const result = await filterRigidBlockCopperChannels(input, { gridMil: 5, clearanceMil: 4, layers: ['front'], fixedCopper }, runtime);
  const rows = result.channels.coreB.rows;
  assert.ok(rows.length > 0); assert.ok(!rows.some(([x, y]) => x === 20 && y === 20));
  assert.match(result.verification, /exact copper checks required/); assert.equal(result.atlas.fixedCopper.length, 1);
});
