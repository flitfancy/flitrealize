import test from 'node:test';
import assert from 'node:assert/strict';
import { generateInitialProposals } from '../scripts/pcb-layout/pcb-layout-initial-proposals.mjs';
import { angle, transformBox, transformPoint } from '../scripts/pcb-layout/pcb-layout-geometry.mjs';
import { availableEdges } from '../scripts/pcb-layout/pcb-layout-edge.mjs';

const box = (x, y, w, h) => ({ minX: x - w / 2, maxX: x + w / 2, minY: y - h / 2, maxY: y + h / 2 });
function fixture() {
  const components = [], pads = [], blocks = [], links = [], localGroups = [], records = [];
  for (let block = 0; block < 5; block++) {
    const refs = [];
    for (let i = 0; i < 3; i++) {
      const ref = ['U', 'C', 'J'][i] + (block + 1), x = block * 700 + i * 180, y = block * 80;
      const c = { ref, id: ref + ':', x, y, rotation: 0, bbox: box(x, y, i === 0 ? 100 : 40, i === 2 ? 100 : 50) };
      components.push(c); refs.push(ref);
      pads.push({ id: c.id + '1', owner: ref, number: '1', net: 'N' + block, x, y, bbox: box(x, y, 15, 15) });
      records.push({ ref, physicalBox: c.bbox, marginMil: { xMinus: 10, xPlus: 10, yMinus: 10, yPlus: 10 } });
    }
    const n = block + 1;
    blocks.push({ id: 'block' + n, components: [...refs, 'TP' + n] });
    links.push({ a: 'U' + n, b: 'C' + n });
    localGroups.push({ id: 'group' + n, anchor: 'U' + n, refs });
    pads.push({ id: 'pad:' + n, owner: null, number: 'TP' + n, net: 'N' + block, x: 9000 + n * 100, y: -9000, bbox: box(9000 + n * 100, -9000, 20, 20) });
  }
  return {
    components: new Map(components.map(c => [c.ref, c])), pads, contract: { blocks }, config: { search: { gridMil: 5 } },
    fixed: new Map(), allowedRotations: new Map(components.map(c => [c.ref, [0, 90, 180, 270]])), assemblyPolicy: { records },
    spatialRules: { localGroups }, blockRules: [], mechanical: { clearanceMil: 8 },
    edgeRules: [1, 2, 3, 4, 5].map(n => ({ ref: 'J' + n, sides: ['left', 'right', 'top', 'bottom'], outwardAtRotation0: 'top', maxInsetMil: 0 })),
    links, connectivity: [0, 1, 2, 3, 4].map(n => ({ name: 'N' + n, pads: pads.filter(p => p.net === 'N' + n) })),
    couplingModel: { relations: [{ from: { ref: 'U1' }, to: { ref: 'U2' } }, { from: { ref: 'U2' }, to: { ref: 'U3' } }] }
  };
}

export function scatterModel(model) {
  const output = structuredClone(model);
  for (const [i, c] of [...output.components.values()].entries()) {
    if (model.fixed.has(c.ref)) continue;
    const old = model.components.get(c.ref), to = { x: (i + 1) * 1317.117, y: -i * 947.313, rotation: angle(old.rotation + (i % 4) * 90) };
    c.bbox = transformBox(old.bbox, old, to); Object.assign(c, to);
    const record = output.assemblyPolicy.records.find(r => r.ref === c.ref);
    record.physicalBox = transformBox(record.physicalBox, old, to);
    // The full permitted angle set is the same but enumeration order changes.
    output.allowedRotations.set(c.ref, [0, 90, 180, 270].map(delta => angle(to.rotation + delta)));
    for (const p of output.pads.filter(p => p.owner === c.ref)) { p.bbox = transformBox(p.bbox, old, to); Object.assign(p, transformPoint(p, old, to)); }
  }
  for (const [i, p] of output.pads.filter(p => !p.owner && !p.locked).entries()) {
    const old = { x: p.x, y: p.y, rotation: 0 }, to = { x: -10000 - 300 * i, y: 100000 + 701 * i, rotation: 0 };
    p.bbox = transformBox(p.bbox, old, to); Object.assign(p, { x: to.x, y: to.y });
  }
  output.components = new Map([...output.components].reverse()); output.pads.reverse(); output.contract.blocks.reverse();
  return output;
}

test('fresh proposals repeat exactly, depend on topology rather than free source poses, and preserve object identity', () => {
  const model = fixture(), options = { seed: 8123, count: 4, explorationStrength: .7 };
  const a = generateInitialProposals(model, options), b = generateInitialProposals(model, options), scattered = generateInitialProposals(scatterModel(model), options);
  assert.deepEqual(a, b);
  assert.deepEqual(a, scattered);
  for (const p of a) {
    assert.equal(p.components.length, 15); assert.equal(p.testPads.length, 5);
    assert.equal(p.metadata.validated, false); assert.equal(p.metadata.requiresLabelInitialization, true);
    assert.deepEqual(p.testPads.map(p => [p.id, p.number, p.net]), model.pads.filter(p => !p.owner).map(p => [p.id, p.number, p.net]));
    assert.ok(p.testPads.every(p => Math.abs(p.x) < 5000 && Math.abs(p.y) < 5000));
    for (const rule of model.edgeRules) {
      const pose = p.components.find(c => c.ref === rule.ref);
      assert.ok(availableEdges(rule, pose.rotation).includes(p.preferredEdges[rule.ref]));
    }
  }
});

test('multiple starts change block relationships and internal distances, not only rigid board pose', () => {
  const proposals = generateInitialProposals(fixture(), { seed: 200, count: 8, explorationStrength: 1 });
  assert.ok(new Set(proposals.map(p => p.metadata.blockOrder.join(','))).size >= 3);
  const relative = proposals.map(p => {
    const poses = new Map(p.components.map(c => [c.ref, c]));
    return ['U1', 'U2', 'U3', 'C1', 'C2'].map(ref => {
      const a = poses.get(ref), b = poses.get('J5'); return Math.round(Math.hypot(a.x - b.x, a.y - b.y));
    }).join(',');
  });
  assert.equal(new Set(relative).size, proposals.length);
});

test('zero exploration has a stable canonical geometry across the requested starts', () => {
  const proposals = generateInitialProposals(fixture(), { seed: 5, count: 3, explorationStrength: 0 });
  assert.deepEqual(proposals[0].components, proposals[1].components);
  assert.deepEqual(proposals[0].testPads, proposals[1].testPads);
  assert.deepEqual(proposals[0].preferredEdges, proposals[2].preferredEdges);
});

test('fixed components and native locked test pads keep absolute positions exactly', () => {
  const model = fixture(), fixed = model.components.get('U1');
  const old = { ...fixed }, precise = { x: 123.1234567890123, y: -456.4567890123456, rotation: -90.00000000000001 };
  fixed.bbox = transformBox(fixed.bbox, old, precise); Object.assign(fixed, precise);
  const record = model.assemblyPolicy.records.find(r => r.ref === fixed.ref);
  record.physicalBox = transformBox(record.physicalBox, old, precise);
  model.fixed.set('U1', { ...fixed }); model.allowedRotations.set('U1', [fixed.rotation]);
  const pad = model.pads.find(p => p.number === 'TP5'); pad.locked = true;
  const padFrom = { x: pad.x, y: pad.y, rotation: 0 }, padTo = { x: 999.1234567890123, y: -999.4567890123456, rotation: 0 };
  pad.bbox = transformBox(pad.bbox, padFrom, padTo); pad.x = padTo.x; pad.y = padTo.y;
  const result = generateInitialProposals(model, { seed: 49, count: 2 });
  for (const p of result) {
    assert.deepEqual(p.components.find(c => c.ref === 'U1'), { ref: fixed.ref, x: fixed.x, y: fixed.y, rotation: fixed.rotation });
    assert.deepEqual(p.testPads.find(t => t.id === pad.id), { ...pad, ref: pad.number });
    assert.deepEqual(p.metadata.fixedRefs, ['U1']); assert.deepEqual(p.metadata.lockedTestPads, ['TP5']);
  }
});

test('configured electrical weights influence coarse topology and zero removes only that link contribution', () => {
  const model = fixture();
  model.links = [{ a: 'U1', b: 'U2', group: 'power' }];
  model.couplingModel.relations = []; model.spatialRules.localGroups = []; model.connectivity = [];
  model.config.comparisonWeights = { power: 0 };
  const options = { seed: 83, count: 1, explorationStrength: .8 };
  const zero = generateInitialProposals(model, options)[0];
  assert.equal(zero.metadata.topologyProxyMil, 0);
  assert.equal(zero.metadata.relationHeuristics.electricalGroupWeights.power, 0);
  model.config.comparisonWeights.power = 6;
  const active = generateInitialProposals(model, options)[0];
  assert.ok(active.metadata.topologyProxyMil > 0);
  assert.equal(active.metadata.relationHeuristics.electricalGroupWeights.power, 6);
  assert.notDeepEqual(active.components, zero.components);
  model.config.comparisonWeights.power = 0;
  model.couplingModel.relations = [{ from: { ref: 'U1' }, to: { ref: 'U2' } }];
  assert.ok(generateInitialProposals(model, options)[0].metadata.topologyProxyMil > 0,
    'disabling one scoring group must not erase an independent declared relation');
});

test('explicit restricted rotations remain respected and impossible opening directions fail visibly', () => {
  const model = fixture(); model.allowedRotations.set('J1', [90]);
  const p = generateInitialProposals(model, { seed: 1, count: 1 })[0];
  assert.equal(p.components.find(c => c.ref === 'J1').rotation, 90);
  assert.deepEqual(p.metadata.restrictedRotationRefs, ['J1']);
  model.edgeRules.find(r => r.ref === 'J1').sides = ['top'];
  assert.throws(() => generateInitialProposals(model, { count: 1 }), /NO_ALLOWED_EDGE J1/);
});

test('malformed generation parameters fail without returning partial candidates', () => {
  const model = fixture();
  for (const options of [{ count: 0 }, { count: 501 }, { seed: -1 }, { seed: 1.2 }, { explorationStrength: 2 }, { gridMil: 0 }, { packingGapMil: -1 }]) {
    assert.throws(() => generateInitialProposals(model, options), /INVALID_INITIAL/);
  }
});
