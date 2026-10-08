import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskBudget, createRoutingCheckpoint, restoreRoutingCheckpoint } from '../scripts/pcb-routing/task-budget.mjs';
import { createViaSpaceScanner, copperFits } from '../scripts/pcb-routing/via-space.mjs';
import { chooseJointEscapes, runSourceEscapes } from '../scripts/pcb-routing/source-escapes.mjs';
import { createCopperPathGraph, criticalRouteMetrics } from '../scripts/pcb-routing/copper-path.mjs';
import { stripRoles, stripNetworks, repairGate, optimizationGate, repairNeighborhoods, runLocalRepair } from '../scripts/pcb-routing/local-repair.mjs';
import { planTransitionSeeds, compareTransitions, protectRoleCopper } from '../scripts/pcb-routing/transition-planner.mjs';

const budget = () => createTaskBudget({ totalMs: 10000 });
const pad = (id, net, x, y, layer, ref = 'ICsmall', pin = id, radius = 1) => ({ id, net, x, y, layer, ref, pin, shapes: [{ kind: 'circle', center: [x, y], radius, layers: [layer] }] });
const wire = (net, layer, x1, y1, x2, y2, width = 2) => ({ net, layer, x1, y1, x2, y2, width });
const via = (net, x, y, layers = [3, 9], diameter = 4, hole = 2) => ({ net, x, y, layers, diameter, hole });
const board = (layers = [3, 9]) => ({ layers, outline: [[-40, -40], [140, -40], [140, 80], [-40, 80]], pads: [pad('a', 'RAIL_NEW', 0, 0, layers[0]), pad('z', 'RAIL_NEW', 100, 0, layers[0], 'terminalB')], segments: [], vias: [] });
const geometry = { copperClearanceMil: 1, drillToPadClearanceMil: 1, drillToDrillClearanceMil: 1, boardEdgeClearanceMil: 1 };
const scanOptions = { searchRadiusMil: 20, gridStepMil: 5, viaDiameterMil: 4, holeDiameterMil: 2, traceWidthMil: 2, sourceLayer: 3, maxResults: 100, ...geometry };

test('shared budget persists consumption and frozen rules/options during resume', () => {
  let time = 10;
  const b = createTaskBudget({ totalMs: 100, now: () => time });
  time = 40; assert.equal(b.remainingMs(), 70);
  const input = { board: board(), policy: { nets: [] }, options: { weights: { main: 3 }, releasedReservationNets: ['X'] } };
  const checkpoint = createRoutingCheckpoint({ input, state: { escapes: [1], reservations: [2] }, budget: b, attempts: [{ error: 'prior' }] });
  time = 1000;
  const restored = restoreRoutingCheckpoint(checkpoint, { input, now: () => time });
  assert.equal(restored.budget.remainingMs(), 70); assert.deepEqual(restored.state, { escapes: [1], reservations: [2] });
  assert.deepEqual(restored.input.options, input.options);
  const changed = structuredClone(input); changed.options.weights.main = 4;
  assert.throws(() => restoreRoutingCheckpoint(checkpoint, { input: changed }), /INPUT_CHANGED/);
  time += 71; assert.throws(() => restored.budget.assertRemaining(), /BUDGET_EXHAUSTED/);
});

test('2-layer scanner uses explicit names/layers and small package geometry', () => {
  const b = board();
  const report = createViaSpaceScanner(b)('a', { ...scanOptions, budget: budget() });
  assert.ok(report.legalCount > 0); assert.ok(report.candidates.every(c => c.trace.layer === 3 && c.via.layers.join(',') === '3,9'));
  assert.throws(() => createViaSpaceScanner({ ...b, outline: undefined }), /OUTLINE_REQUIRED/);
  assert.throws(() => createViaSpaceScanner(b)('a', { ...scanOptions, sourceLayer: 1, budget: budget() }), /LAYER_MISMATCH/);
  assert.throws(() => createViaSpaceScanner(b)('a', { sourceLayer: 3, budget: budget() }), /PARAMETERS_REQUIRED/);
});

test('4-layer scanner checks inner copper and separately checks source sweep', () => {
  const b = board([3, 7, 8, 9]); b.pads.push(pad('inner', 'FOREIGN', 10, 0, 7, 'innerPackage'));
  let report = createViaSpaceScanner(b)('a', { ...scanOptions, budget: budget() });
  assert.equal(report.candidates.some(c => c.xMil === 10 && c.yMil === 0), false); assert.ok(report.rejectedMetal > 0);
  b.pads = b.pads.filter(p => p.id !== 'inner'); b.pads.push(pad('lead-blocker', 'OTHER_SIGNAL', 5, 0, 3, 'tinyQFN'));
  report = createViaSpaceScanner(b)('a', { ...scanOptions, budget: budget() });
  assert.equal(report.candidates.some(c => c.xMil === 10 && c.yMil === 0), false); assert.ok(report.rejectedTrace > 0);
});

test('same-net copper allowance never exempts drill-to-drill spacing', () => {
  const b = board(); b.vias.push(via('RAIL_NEW', 10, 0, b.layers, 10, 8));
  const report = createViaSpaceScanner(b)('a', { ...scanOptions, allowSameNetCopper: true, drillToDrillClearanceMil: 3, budget: budget() });
  assert.equal(report.candidates.some(c => c.xMil === 15 && c.yMil === 0), false); assert.ok(report.rejectedDrill > 0);
  const candidate = { segments: [], vias: [via('RAIL_NEW', 15, 0, b.layers)] };
  assert.equal(copperFits(b, candidate, { ...geometry, drillToDrillClearanceMil: 3 }).passed, false);
});

test('joint MRV assignment preserves source identities and chooses a compatible set', () => {
  const candidate = (x, cost) => ({ net: 'SIG', cost, segments: [], vias: [via('SIG', x, 0)] });
  const result = chooseJointEscapes([{ id: 'A', candidates: [candidate(0, 1), candidate(20, 2)] }, { id: 'B', candidates: [candidate(0, 1)] }], [3, 9], { clearanceMil: 1, drillToDrillClearanceMil: 1, budget: budget() });
  assert.equal(result.totalCost, 3); assert.equal(result.optimalWithinDomains, true);
  assert.equal(result.chosen.find(c => c.domainId === 'A').vias[0].x, 20);
  assert.equal(result.chosen.find(c => c.domainId === 'B').vias[0].x, 0);
});

test('joint source domains remain independent and same-net drill clearance is enforced', () => {
  const candidate = x => ({ cost: 1, segments: [], vias: [via('same', x, 0, [3, 9], 2, 1)] });
  const result = chooseJointEscapes([{ id: 'main', candidates: [candidate(0)] }, { id: 'branch', candidates: [candidate(5)] }], [3, 9], { clearanceMil: 0, drillToDrillClearanceMil: 5, budget: budget() });
  assert.equal(result.chosen, null); assert.equal(result.reason, 'NO_COMPATIBLE_SET');
});

test('multi-source scan uses independent explicit roles on renamed packages', () => {
  const b = board(); b.pads[1] = pad('b', 'CLOCK_A', 50, 0, 3, 'QFNother', '2');
  const report = runSourceEscapes({ board: b, sources: [{ id: 'rail', taskKey: 'RAIL_NEW:low_current_branch', padId: 'a' }, { id: 'clock', taskKey: 'CLOCK_A:signal', padId: 'b' }], scanOptions: { ...scanOptions, searchRadiusMil: 10 }, clearanceMil: 1, drillToDrillClearanceMil: 1, budget: budget() });
  assert.equal(report.assignment.chosen.length, 2);
  assert.deepEqual(new Set(report.assignment.chosen.map(c => c.taskKey)), new Set(['RAIL_NEW:low_current_branch', 'CLOCK_A:signal']));
});

test('actual copper path includes junctions, pad contacts and explicit layer changes', () => {
  const b = board([3, 7, 8, 9]); b.pads[1] = pad('z', 'RAIL_NEW', 100, 20, 9, 'CONNECTOR', '7');
  b.segments = [wire('RAIL_NEW', 3, 0, 0, 100, 0), wire('RAIL_NEW', 9, 100, 0, 100, 20)]; b.vias = [via('RAIL_NEW', 100, 0, b.layers)];
  const path = createCopperPathGraph(b, 'RAIL_NEW').shortest('a', 'z');
  assert.equal(path.connected, true); assert.ok(path.layerChanges >= 1); assert.ok(Math.abs(path.projectionLengthMm - 120 * .0254) < .02);
  const metrics = criticalRouteMetrics(b, { pairs: [{ id: 'power-output', net: 'RAIL_NEW', from: { ref: 'ICsmall', pin: 'a' }, to: 'CONNECTOR.7', preferWide: true, normalWidthMil: 2 }], groups: [{ id: 'external-path', pairIds: ['power-output'] }] });
  assert.equal(metrics.groups[0].connected, true); assert.equal(metrics.groundReturnClosed, false); assert.equal(metrics.thermalVerified, false); assert.equal(metrics.emiVerified, false);
});

test('non-spanning via cannot provide an absent layer connection', () => {
  const b = board([3, 7, 8, 9]); b.pads[1] = pad('z', 'RAIL_NEW', 100, 20, 9);
  b.segments = [wire('RAIL_NEW', 3, 0, 0, 100, 0), wire('RAIL_NEW', 9, 100, 0, 100, 20)]; b.vias = [via('RAIL_NEW', 100, 0, [3, 7])];
  assert.equal(createCopperPathGraph(b, 'RAIL_NEW').shortest('a', 'z').connected, false);
  assert.throws(() => createCopperPathGraph({ ...b, layers: undefined }, 'RAIL_NEW'), /LAYERS_REQUIRED/);
});

test('overlapping pads transfer copper without malformed polygon point arrays', () => {
  const b = board(); b.pads = [pad('a', 'N', 0, 0, 3, 'A', '1', 3), pad('z', 'N', 4, 0, 3, 'B', '1', 3)];
  const path = createCopperPathGraph(b, 'N').shortest('a', 'z');
  assert.equal(path.connected, true); assert.ok(Number.isFinite(path.projectionLengthMm));
});
test('an intermediate pad crosses layers only when plating is explicitly declared', () => {
  const b = board(); b.pads[1] = pad('z', 'RAIL_NEW', 100, 0, 9);
  const bridge = pad('middle', 'RAIL_NEW', 50, 0, 3); bridge.shapes.push({ kind: 'circle', center: [50, 0], radius: 1, layers: [9] }); b.pads.push(bridge);
  b.segments = [wire('RAIL_NEW', 3, 0, 0, 50, 0), wire('RAIL_NEW', 9, 50, 0, 100, 0)];
  assert.equal(createCopperPathGraph(b, 'RAIL_NEW').shortest('a', 'z').connected, false);
  bridge.plated = true; assert.equal(createCopperPathGraph(b, 'RAIL_NEW').shortest('a', 'z').connected, true);
});

const repairState = () => {
  const b = board(), shared = wire('RAIL_NEW', 3, 10, 0, 20, 0), unique = wire('RAIL_NEW', 3, 20, 0, 30, 0), foreign = wire('OTHER', 9, 10, 30, 30, 30), sharedVia = via('RAIL_NEW', 20, 0);
  b.segments = [shared, unique, foreign]; b.vias = [sharedVia]; b.approvedEscapeSegments = [shared, unique]; b.mainEscapeSegments = { RAIL_NEW: [shared, unique] };
  return { board: b, policy: {}, accepted: [{ task: { id: 'RAIL_NEW:main:0', net: 'RAIL_NEW', role: 'main' }, candidate: { segments: [shared, unique], vias: [sharedVia] } }, { task: { id: 'RAIL_NEW:branch:1', net: 'RAIL_NEW', role: 'branch' }, candidate: { segments: [shared], vias: [sharedVia] } }] };
};
test('role rip-up retains shared copper and removes withdrawn escape authorizations', () => {
  const state = repairState(), out = stripRoles(state, ['RAIL_NEW:main']);
  assert.equal(out.board.segments.length, 2); assert.equal(out.board.vias.length, 1);
  assert.equal(out.board.approvedEscapeSegments.length, 0); assert.equal(out.board.mainEscapeSegments.RAIL_NEW, undefined); assert.equal(state.board.segments.length, 3);
  const netOut = stripNetworks(state, ['RAIL_NEW']); assert.equal(netOut.board.segments.length, 1); assert.equal(netOut.accepted.length, 0); assert.deepEqual(netOut.board.mainEscapeSegments, {});
  state.board.segments[1].locked = true; assert.throws(() => stripRoles(state, ['RAIL_NEW:main']), /LOCKED/);
});
test('explicit escape role ownership can retain another role permission on shared copper', () => {
  const state = repairState(); state.board.approvedEscapeSegments[0] = { ...state.board.approvedEscapeSegments[0], taskId: 'RAIL_NEW:branch:1' };
  const out = stripRoles(state, ['RAIL_NEW:main']);
  assert.equal(out.board.approvedEscapeSegments.length, 1); assert.equal(out.board.approvedEscapeSegments[0].taskId, 'RAIL_NEW:branch:1');
});
test('repair gates preserve existing roles, pads and copper outside the scoped role', () => {
  const state = repairState(), initial = stripRoles(state, ['RAIL_NEW:main']);
  const before = { tasks: [{ id: 'old:0', net: 'OLD', role: 'signal', connected: true }], connectedTasks: 1 }, after = { tasks: [...before.tasks, { id: 'new:0', connected: true }], connectedTasks: 2, audit: { passed: true } };
  assert.equal(repairGate(before, after, state.board, state.board, ['RAIL_NEW'], { protectedState: initial }).passed, true);
  const broken = structuredClone(state.board); broken.segments = broken.segments.filter(s => s.net === 'RAIL_NEW');
  assert.equal(repairGate(before, after, state.board, broken, ['RAIL_NEW'], { protectedState: initial }).passed, false);
  const missingShared = structuredClone(state.board); missingShared.segments.shift();
  assert.ok(repairGate(before, after, state.board, missingShared, ['RAIL_NEW'], { protectedState: initial }).issues.includes('REMOVED_PROTECTED_SHARED_COPPER'));
});
test('configured path gate rejects any protected path regression', () => {
  const b = board(), before = { tasks: [], routeMetrics: { pairs: [{ id: 'target', connected: true, scoredPathMm: 10 }, { id: 'other', connected: true, scoredPathMm: 5 }] } }, after = { tasks: [], audit: { passed: true }, routeMetrics: { pairs: [{ id: 'target', connected: true, scoredPathMm: 8 }, { id: 'other', connected: true, scoredPathMm: 7 }] } };
  assert.deepEqual(optimizationGate(before, after, b, b, ['RAIL_NEW'], 'target', { maxPathRegressionMm: 0, minTargetImprovementMm: .1 }).issues, ['CRITICAL_PATH_REGRESSION:other']);
  assert.deepEqual(repairNeighborhoods([{ net: 'A' }, { net: 'B' }], { maxBlockers: 2, maxCombinationSize: 2 }), [[], ['A'], ['B'], ['A', 'B']]);
});
test('net repair replay compiles the complete role set with one shared task budget', async () => {
  const b = board(), state = { board: b, accepted: [], policy: { nets: [{ net: 'RAIL_NEW', endpoints: [{ endpoint: 'source', padId: 'a' }, { endpoint: 'load', padId: 'z' }], roles: [{ name: 'load_current_main', endpoints: ['source', 'load'], widthMil: 4, allowedLayers: [3, 9], viaTransition: { sourceLayer: 3, targetLayer: 9 } }, { name: 'low_current_branch', endpoints: ['source'], widthMil: 2, allowedLayers: [3, 9] }], via: { holeMil: 2, diameterMil: 4, minParallelLoadVias: 1 } }] } };
  const shared = budget(); let replayedRoles;
  const result = await runLocalRepair({ state, failed: { net: 'RAIL_NEW', role: 'load_current_main' }, options: { ranking: { proximityMil: 20, directWeight: 3 }, search: { maxBlockers: 0, maxCombinationSize: 0 } }, budget: shared,
    reroute: async ({ tasks, budget: received }) => { assert.equal(received, shared); replayedRoles = tasks.map(task => task.role); return structuredClone(state); },
    evaluate: async () => ({ tasks: [], connectedTasks: 0, audit: { passed: true } }), gate: () => ({ passed: true, issues: [] }) });
  assert.deepEqual(replayedRoles, ['load_current_main', 'low_current_branch']); assert.equal(result.accepted, true);
});

const transitionTask = { id: 'RAIL_NEW:load_current_main:0', net: 'RAIL_NEW', role: 'load_current_main', requiredPadIds: ['a'], width: 4, localWidth: 2, layers: [3, 9], via: { diameterMil: 4, holeMil: 2 }, clearance: 1 };
const transitionOptions = { geometry, sourceLayers: { a: 3 }, fineWidthsMil: { a: 1 }, directions: [[1, 0], [0, 1]], neckExtensionsMil: [1, 2], targetExtensionsMil: [8, 12], anchorLengthMil: 3, maxExposedNarrowLengthMil: 80, maxCandidatesPerSource: 5, transitLayer: 9, viaCount: 1, scan: { searchRadiusMil: 15, gridStepMil: 5, maxResults: 20, allowSameNetCopper: true } };
test('same-layer and via seeds validate small source neck and real target-layer copper', () => {
  const b = board();
  const same = planTransitionSeeds({ board: b, task: transitionTask, method: 'same-layer', options: transitionOptions, budget: budget() });
  assert.equal(same.vias.length, 0); assert.ok(same.segments.some(s => s.width === 1)); assert.ok(same.segments.some(s => s.width === 4));
  const changed = planTransitionSeeds({ board: b, task: transitionTask, method: 'through-via', options: transitionOptions, budget: budget() });
  assert.equal(changed.vias.length, 1); assert.ok(changed.segments.some(s => s.layer === 9 && s.width === 4)); assert.deepEqual(changed.vias[0].layers, b.layers);
});
test('transition comparison checks both methods under one budget and keeps all allowed via layers', async () => {
  const methods = [], budgets = new Set(), b = board();
  const result = await compareTransitions({ board: b, policy: {}, task: transitionTask, options: { seedOptions: transitionOptions, methods: [{ method: 'same-layer', variants: 1 }, { method: 'through-via', variants: 1 }] }, budget: budget(), solve: async ({ task, seeds, method, budget: shared }) => {
    methods.push(method); budgets.add(shared); if (method === 'through-via') assert.deepEqual(task.layers, [3, 9]); return { segments: seeds.segments, vias: seeds.vias };
  }, validate: async () => ({ passed: true, issues: [] }), evaluate: async ({ method }) => ({ cost: method === 'same-layer' ? 10 : 2 }) });
  assert.deepEqual(methods, ['same-layer', 'through-via']); assert.equal(budgets.size, 1); assert.equal(result.selected.method, 'through-via'); assert.equal(result.attempts.length, 2);
});
test('load role protects previously routed thin branch instead of treating it as a trunk', () => {
  const b = board(); b.segments.push(wire('RAIL_NEW', 3, 0, 0, 40, 0, 1));
  const protectedBoard = protectRoleCopper(b, transitionTask);
  assert.ok(protectedBoard.segments.some(s => s.net !== 'RAIL_NEW')); assert.equal(b.segments[0].net, 'RAIL_NEW');
});
test('transition work stops at the shared budget rather than granting a new method budget', async () => {
  let time = 0;
  const shared = createTaskBudget({ totalMs: 10, now: () => time }); let calls = 0;
  const result = await compareTransitions({ board: board(), policy: {}, task: transitionTask, options: { seedOptions: transitionOptions, methods: [{ method: 'same-layer', variants: 1 }, { method: 'through-via', variants: 1 }] }, budget: shared,
    solve: async ({ seeds }) => { calls++; time = 11; return { segments: seeds.segments, vias: seeds.vias }; }, validate: async () => ({ passed: true }), evaluate: async () => ({ cost: 1 }) });
  assert.equal(result.timedOut, true); assert.equal(calls, 1); assert.equal(result.selected, null); assert.equal(result.budget.consumedMs, 10);
});
