import test from 'node:test';
import assert from 'node:assert/strict';
import { bandPenalty, compileSpatial, evaluateSpatial, occupiedArea } from '../scripts/pcb-layout/pcb-layout-spatial.mjs';
import { addToArchive, dominates } from '../scripts/pcb-layout/pcb-layout-archive.mjs';

const box = (minX, minY, maxX, maxY) => ({ minX, minY, maxX, maxY });
const components = [{ ref: 'U1', x: 0, y: 0, rotation: 0, body: box(-5, -5, 5, 5) }, { ref: 'C1', x: 30, y: 0, rotation: 0, body: box(25, -5, 35, 5) }];
const compile = config => compileSpatial(config, new Map(components.map(c => [c.ref, c])));

test('distance bands have a neutral ideal interval and penalties on both sides', () => {
  const band = { hardMinMil: 8, idealMinMil: 12, idealMaxMil: 32, hardMaxMil: 80, scaleMil: 10 };
  assert.equal(bandPenalty(12, band), 0); assert.equal(bandPenalty(32, band), 0);
  assert.ok(Math.abs(bandPenalty(8, band) - .16) < 1e-12); assert.equal(bandPenalty(42, band), 1);
  const rule = { id: 'gap', a: 'U1', b: 'C1', metric: 'body-gap', category: 'spacing', band };
  assert.equal(evaluateSpatial(compile({ relations: [rule] }), components).issues.length, 0);
  const moved = structuredClone(components); moved[1].body = box(10, -5, 20, 5);
  assert.equal(evaluateSpatial(compile({ relations: [rule] }), moved).issues[0].code, 'SPATIAL_DISTANCE_LIMIT');
  assert.throws(() => compile({ relations: [{ ...rule, band: { ...band, idealMinMil: 40 } }] }), /REVERSED_DISTANCE_BAND/);
});

test('same-category normalization does not reward adding redundant rules', () => {
  const relation = { id: 'a', a: 'U1', b: 'C1', metric: 'origin-manhattan', category: 'proximity', band: { idealMaxMil: 20, scaleMil: 10 } };
  const one = evaluateSpatial(compile({ relations: [relation] }), components);
  const two = evaluateSpatial(compile({ relations: [relation, { ...relation, id: 'b', weight: 2 }] }), components);
  assert.equal(one.penalties.proximity, 1); assert.equal(two.penalties.proximity, 1);
  assert.deepEqual(evaluateSpatial(compile({}), components).penalties, { proximity: 0, spacing: 0, whitespace: 0, compactness: 0, uniformity: 0 });
});

test('occupied area clips to the target and counts overlapping shapes once', () => {
  const target = box(0, 0, 10, 10);
  assert.equal(occupiedArea([box(-20, 0, 5, 10), box(2, 0, 8, 10), box(2, 0, 8, 10)], target), 80);
  assert.equal(occupiedArea([box(-20, -20, 20, 20)], target), 100);
  const filled = compile({ zones: [{ id: 'fill', mode: 'preferFilled', box: target }] });
  const result = evaluateSpatial(filled, components, [{ ref: 'X', bbox: box(-20, -20, 20, 20) }]);
  assert.equal(result.penalties.whitespace, 0);
  assert.equal(result.zones[0].occupiedFraction, 1);
});

test('attached keepout moves and rotates with its owner and excludes the owner only', () => {
  const rules = compile({ zones: [{ id: 'access', owner: 'U1', mode: 'keepout', box: box(20, -10, 40, 10) }] });
  assert.deepEqual(evaluateSpatial(rules, components).issues[0].refs, ['C1']);
  const rotated = structuredClone(components); rotated[0].rotation = 90;
  const checked = evaluateSpatial(rules, rotated);
  assert.deepEqual(checked.zones[0].box, box(-10, 20, 10, 40));
  assert.equal(checked.issues.length, 0);
  rotated[0].x = 30; rotated[0].y = -30;
  assert.deepEqual(evaluateSpatial(rules, rotated).issues[0].refs, ['C1']);
});

test('bundle clearance and keepout include native labels and independent test pads', () => {
  const rules = compile({ relations: [{ id: 'silk-gap', a: 'U1', b: 'C1', metric: 'bundle-gap', category: 'spacing', band: { hardMinMil: 8, scaleMil: 10 } }], zones: [{ id: 'empty', mode: 'keepout', box: box(90, 90, 110, 110) }] });
  const bundles = [{ ref: 'U1', bbox: box(-5, -5, 20, 5) }, { ref: 'C1', bbox: components[1].body }, { ref: 'TP1', bbox: box(95, 95, 105, 105) }];
  const result = evaluateSpatial(rules, components, bundles);
  assert.equal(result.relations[0].distanceMil, 5);
  assert.deepEqual(result.issues.map(i => i.code), ['SPATIAL_DISTANCE_LIMIT', 'SPATIAL_KEEPOUT']);
  assert.deepEqual(result.zones[0].conflicts, ['TP1']);
  rules.zones[0].geometry = 'body';
  assert.deepEqual(evaluateSpatial(rules, components, bundles).zones[0].conflicts, ['TP1']);
});

test('groups overlap without implicitly adding a compactness or empty-area penalty', () => {
  const rules = compile({ localGroups: [{ id: 'a', refs: ['U1', 'C1'] }, { id: 'b', refs: ['U1', 'C1'] }] });
  assert.equal(evaluateSpatial(rules, components).penalties.compactness, 0);
  assert.throws(() => compile({ localGroups: [{ id: 'bad', refs: ['U1', 'missing'] }] }), /INVALID_LOCAL_GROUP/);
});

test('archive discards invalid/dominated samples and keeps bounded deterministic tradeoffs', () => {
  const candidate = x => ({ validation: { valid: true }, plan: { components: [{ ref: 'U1', x, y: 0, rotation: 0 }], labels: [], testPads: [] } });
  assert.equal(dominates([1, 2], [2, 2]), true);
  let archive = addToArchive([], candidate(0), [1, 4], 4);
  archive = addToArchive(archive, candidate(1), [4, 1], 4);
  assert.equal(addToArchive(archive, candidate(2), [4, 4], 4).length, 2);
  assert.equal(addToArchive(archive, { ...candidate(3), validation: { valid: false } }, [0, 0], 4).length, 2);
  const run = () => {
    let a = [];
    for (let i = 0; i < 20; i++) a = addToArchive(a, candidate(i), [i, 20 - i], 4);
    return a;
  };
  assert.deepEqual(run(), run()); assert.equal(run().length, 4);
  assert.ok(run().some(e => e.vector[0] === 0) && run().some(e => e.vector[0] === 19));
});
