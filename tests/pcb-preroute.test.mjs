import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preparePrerouteInput, copperIslands } from '../scripts/pcb-routing/preroute/prepare.mjs';
import { verifyPreroute } from '../scripts/pcb-routing/preroute/verify.mjs';
import { validatePrerouteInput, routingConfig } from '../scripts/pcb-routing/preroute/schema.mjs';

const python = process.env.PCB_PREROUTE_PYTHON;
const script = fileURLToPath(new URL('../scripts/pcb-routing/preroute/preroute.py', import.meta.url));
function pad(id, owner, net, x, y, layers = [1]) {
  return { id, owner, number: '1', net, shape: { kind: 'polygon', points: [[x - 5, y - 5], [x + 5, y - 5], [x + 5, y + 5], [x - 5, y + 5]], layers } };
}
function sample(overrides = {}) {
  const board = { boardMil: [200, 160], pads: [pad('a', 'SOURCE', 'LINK', 40, 80), pad('b', 'LOAD', 'LINK', 160, 80)], segments: [], vias: [], ...overrides };
  return preparePrerouteInput({ board, policy: { layers: [{ id: 1 }, { id: 2 }], clearances: { ordinaryCopperMil: 7 },
    nets: [{ net: 'LINK', defaultWireWidthMil: 6, preroute: { sourceOwners: ['SOURCE'] } }] },
    options: { copperEdgeMil: 10, gridMil: 2, routing: { maxSeconds: 2, maxVisited: 10000 } } });
}
async function job(mode, input, extra = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pcb-preroute-test-'));
  try {
    const file = path.join(dir, 'input.json');
    await fs.writeFile(file, JSON.stringify(input));
    const result = spawnSync(python, [script, '--mode', mode, '--input', file, '--output', dir, '--no-arrays', ...extra], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    const files = {};
    for (const name of ['route-result.json', 'fanout-result.json', 'diagnosis.json', 'ground-space.json', 'ground-link-plan.json']) {
      try { files[name] = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { manifest, files };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('prepare uses explicit source/branch ownership and policy copper clearance', () => {
  const input = preparePrerouteInput({
    board: { boardMil: [300, 180], pads: [pad('load', 'U_MCU', 'RAIL', 40, 80), pad('source', 'X_SUPPLY', 'RAIL', 150, 80), pad('sense', 'R_MEASURE', 'RAIL', 240, 80)], segments: [], vias: [] },
    policy: { layers: [1, 2], clearances: { ordinaryCopperMil: 9 }, nets: [{ net: 'RAIL', defaultWireWidthMil: 24,
      preroute: { sourcePadIds: ['source'], localWidthMil: 8, branches: [{ owners: ['R_MEASURE'], widthMil: 5, role: 'sense' }] } }] }, options: { copperEdgeMil: 8 } });
  const rule = input.nets[0];
  assert.equal(input.clearanceMil, 9);
  assert.deepEqual(rule.components[rule.rootIndex].pads, ['source']);
  assert.equal(rule.components.find(c => c.pads.includes('sense')).widthMil, 5);
  assert.equal(rule.components.find(c => c.pads.includes('load')).widthMil, 24);
});

test('source selectors must identify exactly one actual island', () => {
  assert.throws(() => preparePrerouteInput({ board: { boardMil: [200, 160], pads: [pad('a', 'A', 'N', 40, 80), pad('b', 'B', 'N', 160, 80)], segments: [], vias: [] },
    policy: { nets: [{ net: 'N', defaultWireWidthMil: 6, preroute: { sourceOwners: ['MISSING'] } }] } }), /source-must-identify-one-island/);
});

test('an existing mixed source island retains main/sense roles and uses the main bridge width', () => {
  const input = preparePrerouteInput({
    board: { boardMil: [300, 160], pads: [pad('source', 'SUPPLY', 'RAIL', 40, 80), pad('sense', 'MEASURE', 'RAIL', 80, 80), pad('load', 'LOAD', 'RAIL', 240, 80)],
      segments: [{ id: 'existing', net: 'RAIL', layer: 1, width: 6, x1: 40, y1: 80, x2: 80, y2: 80 }], vias: [] },
    policy: { nets: [{ net: 'RAIL', defaultWireWidthMil: 30, preroute: { sourceOwners: ['SUPPLY'], branches: [
      { owners: ['SUPPLY'], widthMil: 30, role: 'main', allowedLayers: [1, 2] },
      { padIds: ['sense'], widthMil: 6, role: 'sense', allowedLayers: [1] },
      { all: true, widthMil: 8, role: 'fallback', allowedLayers: [1] },
    ] } }] } });
  const net = input.nets[0], source = net.components[net.rootIndex];
  assert.deepEqual(source.pads, ['source', 'sense']);
  assert.equal(source.widthMil, 30);
  assert.equal(source.role, 'main');
  assert.deepEqual(source.allowedLayers, [1, 2]);
  assert.deepEqual(source.matchedRoles.map(r => [r.role, r.widthMil, r.padIds]), [['main', 30, ['source']], ['sense', 6, ['sense']]]);
  assert.deepEqual(source.sourcePadIds, ['source']);
  assert.deepEqual(source.sourceOwners, ['SUPPLY']);
  const load = net.components.find(c => c.pads.includes('load'));
  assert.equal(load.widthMil, 8);
  assert.equal(load.matchedRoles[0].source, 'fallback-branch');
});

test('contradictory declarations on the same pad are rejected', () => {
  const board = { boardMil: [200, 160], pads: [pad('source', 'SUPPLY', 'RAIL', 40, 80), pad('load', 'LOAD', 'RAIL', 160, 80)], segments: [], vias: [] };
  const policy = { nets: [{ net: 'RAIL', defaultWireWidthMil: 30, preroute: { branches: [
    { owners: ['SUPPLY'], widthMil: 30, role: 'main', allowedLayers: [1, 2] },
    { padIds: ['source'], widthMil: 6, role: 'sense', allowedLayers: [1] },
  ] } }] };
  assert.throws(() => preparePrerouteInput({ board, policy }), /conflicting-pad-branch:RAIL:source/);
  policy.nets[0].preroute.branches[1] = { padIds: ['source'], widthMil: 30, role: 'main', allowedLayers: [2, 1] };
  assert.doesNotThrow(() => preparePrerouteInput({ board, policy }));
});

test('explicit unsupported units are rejected without implicit shape conversion', () => {
  const board = { units: 'mm', boardMil: [200, 160], pads: [pad('a', 'SOURCE', 'LINK', 40, 80)], segments: [], vias: [] };
  const policy = { units: 'mm', nets: [{ net: 'LINK', defaultWireWidthMil: 6 }] };
  assert.throws(() => preparePrerouteInput({ board, policy }), /board\.units-must-be-mil/);
  const legacy = sample();
  assert.equal(legacy.units, 'mil');
  delete legacy.units;
  assert.doesNotThrow(() => validatePrerouteInput(legacy));
  legacy.units = 'mm';
  assert.throws(() => validatePrerouteInput(legacy), /units-must-be-mil/);
});

test('conflicting board and policy unit declarations are rejected', () => {
  const board = { units: 'mil', boardMil: [200, 160], pads: [pad('a', 'SOURCE', 'LINK', 40, 80)], segments: [], vias: [] };
  const policy = { units: 'mm', nets: [{ net: 'LINK', defaultWireWidthMil: 6 }] };
  assert.throws(() => preparePrerouteInput({ board, policy }), /policy\.units-must-be-mil/);
  board.units = 'mm'; policy.units = 'mil';
  assert.throws(() => preparePrerouteInput({ board, policy }), /board\.units-must-be-mil/);
});

test('ground-plane roles are delegated and four-layer inputs are rejected', () => {
  const input = preparePrerouteInput({ board: { boardMil: [100, 100], pads: [pad('g', 'G', 'RETURN', 50, 50)], segments: [], vias: [] },
    policy: { nets: [{ net: 'RETURN', defaultWireWidthMil: 20, roles: [{ name: 'ground_plane' }] }] } });
  assert.equal(input.nets.length, 0);
  assert.deepEqual(input.delegatedNets, [{ net: 'RETURN', status: 'delegated-ground-plane' }]);
  input.routing.layerIds = [1, 15, 16, 2];
  assert.throws(() => validatePrerouteInput(input), /two-layer-backend/);
});

test('pre-routing excludes explicitly reserved layers by default and rejects contradictory allowed lists', () => {
  const board = { boardMil: [200, 160], pads: [pad('a', 'SOURCE', 'LINK', 40, 80), pad('b', 'LOAD', 'LINK', 160, 80)], segments: [], vias: [] };
  const policy = { layers: [{ id: 1 }, { id: 2, signalRoutingAllowed: false }], nets: [{ net: 'LINK', defaultWireWidthMil: 6 }] };
  const input = preparePrerouteInput({ board, policy }); assert.deepEqual(input.nets[0].allowedLayers, [1]); assert.deepEqual(input.nets[0].components[0].allowedLayers, [1]);
  assert.deepEqual(input.ruleCoverage.reservedAutoRoutingLayers, [2]); assert.equal(input.ruleCoverage.mainViaTransitionTopologyVerified, false);
  policy.nets[0].primaryAutoLayers = [1, 2]; assert.throws(() => preparePrerouteInput({ board, policy }), /reserved-auto-routing-layer/);
  delete policy.nets[0].primaryAutoLayers; policy.nets[0].preroute = { branches: [{ all: true, allowedLayers: [2] }] };
  assert.throws(() => preparePrerouteInput({ board, policy }), /reserved-auto-routing-layer/);
});

test('island construction respects declared via layer span', () => {
  const input = sample({ pads: [pad('a', 'SOURCE', 'LINK', 80, 80, [1]), pad('b', 'LOAD', 'LINK', 80, 80, [2])] });
  const via = { id: 'top-only', net: 'LINK', x: 80, y: 80, hole: 4, diameter: 10, layers: [1] };
  assert.equal(copperIslands({ net: 'LINK', pads: input.pads, segments: [], vias: [via] }).length, 2);
  via.layers.push(2);
  assert.equal(copperIslands({ net: 'LINK', pads: input.pads, segments: [], vias: [via] }).length, 1);
});

test('verifier rejects clearance, unjustified connectivity, and excessive narrow escape', () => {
  const input = sample();
  const bad = { segments: [{ id: 'short', net: 'LINK', layer: 1, width: 6, x1: 40, y1: 80, x2: 60, y2: 80 }], vias: [], nets: [{ net: 'LINK', status: 'candidate-connected' }] };
  assert.ok(verifyPreroute({ input, candidate: bad }).issues.some(i => i.code === 'CONNECTIVITY_CLAIM'));
  const tooThin = { segments: [{ ...bad.segments[0], x2: 160, width: 2 }], vias: [], nets: [] };
  assert.ok(verifyPreroute({ input, candidate: tooThin }).issues.some(i => i.code === 'DECLARED_WIDTH'));
  const escaped = { segments: [{ ...bad.segments[0], kind: 'bounded-power-escape', escapePadId: 'a', escapeGroupId: 'escape', x2: 120 }], vias: [], nets: [] };
  assert.ok(verifyPreroute({ input, candidate: escaped }).issues.some(i => i.code === 'ESCAPE_TOO_LONG'));
  input.pads.push({ ...input.pads[0], id: 'obstacle', net: 'OTHER', bbox: { minX: 90, minY: 70, maxX: 110, maxY: 90 },
    shape: { kind: 'polygon', points: [[90,70],[110,70],[110,90],[90,90]], layers: [1] },
    shapes: [{ kind: 'polygon', points: [[90,70],[110,70],[110,90],[90,90]], layers: [1] }],
    contactShapes: [{ kind: 'polygon', points: [[90,70],[110,70],[110,90],[90,90]], layers: [1] }] });
  const crossing = { segments: [{ ...bad.segments[0], x2: 160 }], vias: [], nets: [] };
  assert.ok(verifyPreroute({ input, candidate: crossing }).issues.some(i => i.code === 'COPPER_CLEARANCE'));
});

test('via-in-pad exception requires explicit matching confirmed evidence', () => {
  const input = sample();
  const candidate = { segments: [], vias: [{ id: 'in-pad', net: 'LINK', x: 40, y: 80, hole: 12, diameter: 24, layers: [1, 2] }], nets: [] };
  assert.ok(verifyPreroute({ input, candidate }).issues.some(i => i.code === 'DRILL_PAD'));
  input.verification.viaInPadExceptions = [{ viaId: 'in-pad', padId: 'a', confirmed: true }];
  assert.ok(!verifyPreroute({ input, candidate }).issues.some(i => i.code === 'DRILL_PAD'));
});

test('Python imports read only bundled resources and do not execute jobs', { skip: !python }, () => {
  const code = "import sys;sys.path.insert(0,sys.argv[1]);import preroute;print('import-only')";
  const result = spawnSync(python, ['-c', code, path.dirname(script)], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'import-only');
});

test('JS and Python share default parameters and reject unsupported units and layers', { skip: !python }, () => {
  const defaultsCode = "import json,sys;sys.path.insert(0,sys.argv[1]);from defaults import routing_config;print(json.dumps(dict(zip(['routing','via'],routing_config(json.loads(sys.stdin.read()))))))";
  const defaultsInput = { clearanceMil: 9, via: { holeMil: 10 }, routing: { bottomWeight: 1.2 } };
  const defaultsResult = spawnSync(python, ['-c', defaultsCode, path.dirname(script)], { input: JSON.stringify(defaultsInput), encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(defaultsResult.status, 0, defaultsResult.stderr);
  assert.deepEqual(JSON.parse(defaultsResult.stdout), routingConfig(defaultsInput));
  const validateCode = "import json,sys;sys.path.insert(0,sys.argv[1]);from router import validate_input\ntry:\n validate_input(json.loads(sys.stdin.read()));print(json.dumps({'accepted':True}))\nexcept ValueError as error_value:\n print(json.dumps({'accepted':False,'error':str(error_value)}))";
  for (const mutate of [input => delete input.units, input => { input.units = 'mm'; }, input => { input.routing.layerIds = [1,15,16,2]; }, input => { input.via.holeMil = input.via.diameterMil; }]) {
    const input = sample(); mutate(input);
    let accepted = true;
    try { validatePrerouteInput(input); } catch { accepted = false; }
    const result = spawnSync(python, ['-c', validateCode, path.dirname(script)], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).accepted, accepted);
  }
});

test('two-layer A* small sample is independently verified', { skip: !python }, async () => {
  const input = sample();
  const { files } = await job('route', input);
  const candidate = files['route-result.json'];
  assert.equal(candidate.nets[0].status, 'candidate-connected');
  assert.ok(candidate.segments.length > 0);
  assert.equal(verifyPreroute({ input, candidate }).status, 'independently-verified');
});

test('A* reports its configured budget and honors top-only routing', { skip: !python }, async () => {
  const input = sample();
  input.routing.maxVisited = 1;
  input.nets[0].allowedLayers = [1];
  const { files } = await job('route', input);
  assert.equal(files['route-result.json'].nets[0].status, 'partial-or-blocked');
  assert.equal(files['route-result.json'].nets[0].failures[0].reason, 'search-budget');
  assert.deepEqual(files['route-result.json'].vias, []);
});

test('a power bridge uses a bounded narrow escape through adjacent-pad spacing', { skip: !python }, async () => {
  const input = preparePrerouteInput({ board: { boardMil: [200, 160], segments: [], vias: [],
    pads: [pad('source', 'SRC', 'POWER', 40, 80), pad('load', 'LOAD', 'POWER', 160, 80),
      pad('upper', 'OBSTACLE', 'FOREIGN', 40, 63), pad('lower', 'OBSTACLE', 'FOREIGN', 40, 97)] },
    policy: { nets: [{ net: 'POWER', defaultWireWidthMil: 30, preroute: { sourcePadIds: ['source'], localWidthMil: 8, escapeMaxOutsideMil: 40 } }] },
    options: { clearanceMil: 6, copperEdgeMil: 10, gridMil: 2, routing: { maxSeconds: 2, maxVisited: 10000 } } });
  const { files } = await job('route', input);
  const candidate = files['route-result.json'];
  assert.equal(candidate.nets[0].status, 'candidate-connected');
  assert.ok(candidate.segments.some(s => s.kind === 'bounded-power-escape' && s.width === 8 && s.escapePadId === 'source'));
  assert.ok(candidate.segments.some(s => s.width === 30));
  assert.equal(verifyPreroute({ input, candidate }).status, 'independently-verified');
});

test('a top-layer wall requires two verified layer transitions', { skip: !python }, async () => {
  const wall = { id: 'wall', owner: 'WALL', net: 'FOREIGN', shape: { kind: 'polygon', points: [[94, 0], [106, 0], [106, 160], [94, 160]], layers: [1] } };
  const input = sample({ pads: [pad('a', 'SOURCE', 'LINK', 40, 80), pad('b', 'LOAD', 'LINK', 160, 80), wall] });
  const { files } = await job('route', input);
  const candidate = files['route-result.json'];
  assert.equal(candidate.nets[0].status, 'candidate-connected');
  assert.equal(candidate.vias.length, 2);
  assert.ok(candidate.segments.some(s => s.layer === 2));
  assert.equal(verifyPreroute({ input, candidate }).status, 'independently-verified');
});

test('fanout uses only explicit requests and verifies source contact', { skip: !python }, async () => {
  const input = sample();
  input.fanoutRequests = [{ padId: 'a', normal: [1, 0], widthMil: 6, depthsMil: [24, 32], tangentsMil: [0] }];
  const { files } = await job('fanout', input);
  const candidate = files['fanout-result.json'];
  assert.equal(candidate.records.length, 1);
  assert.equal(candidate.records[0].padId, 'a');
  assert.equal(candidate.vias.length, 1);
  assert.equal(verifyPreroute({ input, candidate }).status, 'independently-verified');
});

test('diagnosis/cut probes and configurable ground net remain potential-space reports', { skip: !python }, async () => {
  const input = sample();
  input.diagnostics = { nets: ['LINK'], maxReachablePoints: 50, cutProbes: [{ net: 'LINK', padId: 'a', removeNets: ['FOREIGN'] }] };
  const diagnostic = (await job('diagnose', input)).files['diagnosis.json'];
  assert.equal(diagnostic.records.length, 2);
  assert.equal(diagnostic.cutProbes[0].remove, 'FOREIGN');
  input.pads.push({ ...input.pads[0], id: 'return', net: 'RETURN', x: 100, y: 120, bbox: { minX: 95, minY: 115, maxX: 105, maxY: 125 },
    shape: { kind: 'polygon', points: [[95,115],[105,115],[105,125],[95,125]], layers: [1, 2] },
    shapes: [{ kind: 'polygon', points: [[95,115],[105,115],[105,125],[95,125]], layers: [1, 2] }],
    contactShapes: [{ kind: 'polygon', points: [[95,115],[105,115],[105,125],[95,125]], layers: [1, 2] }] });
  input.ground = { net: 'RETURN', coreWidthBenchmarkMil: 12, transitionRadiusMm: 1, optimizePlaneLinks: false };
  const ground = await job('ground', input);
  assert.equal(ground.files['ground-space.json'].coreWidthBenchmarkMil, 12);
  assert.equal(ground.files['ground-space.json'].transitionRadiusMm, 1);
  assert.equal(ground.manifest.groundPads, 1);
  assert.equal(ground.manifest.potentialReachableGroundPads, 1);
  assert.equal(ground.files['ground-link-plan.json'].continuousSpaceInfeasibilityProven, false);
  assert.equal(ground.manifest.groundCopperCreated, false);
});
