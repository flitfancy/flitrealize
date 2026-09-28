import test from 'node:test';
import assert from 'node:assert/strict';
import { addCatalogCandidate, getCatalogPoseKey, selectCatalogCandidates } from '../scripts/pcb-layout/pcb-layout-catalog-pool.mjs';

const candidate = (score = 1, x = 0, rotation = 0) => ({
  comparisonScore: score,
  validation: { valid: true },
  plan: {
    components: [{ ref: 'R1', x, y: 10, rotation }, { ref: 'U1', x: 200, y: 200, rotation: 90 }],
    labels: [{ id: 'R1-label', x: 30, y: 30, rotation: 0 }],
    testPads: [{ id: 'tp1', x: 40, y: 40 }],
  },
});
const poolOf = (candidates, options) => candidates.reduce((pool, item) => addCatalogCandidate(pool, item, options), []);

test('pose key is independent of component input order and normalizes equivalent rotations', () => {
  const a = candidate(1, 0, 270), b = candidate(1, 0, -90), c = candidate(1, 0, 630);
  b.plan.components.reverse();
  assert.equal(getCatalogPoseKey(a), getCatalogPoseKey(b));
  assert.equal(getCatalogPoseKey(a), getCatalogPoseKey(c));
  assert.equal(getCatalogPoseKey(candidate(1, -0, 360)), getCatalogPoseKey(candidate()));
});

test('label and standalone test pad changes do not invent a new component layout', () => {
  const a = candidate(), b = candidate();
  b.plan.labels[0].x += 100; b.plan.labels[0].rotation = 90; b.plan.testPads[0].x += 80;
  const pool = poolOf([a, b]);
  assert.equal(pool.length, 1);
  const selection = selectCatalogCandidates([a, b]);
  assert.deepEqual(selection, { selected: [a], available: 1, duplicatesRemoved: 1 });
  assert.equal(selection.selected[0], a);
});

test('coarse worker pool merges nearby poses while final selection retains exact distinct poses', () => {
  const a = candidate(2, 1), b = candidate(1, 8), c = candidate(3, 21);
  const pool = poolOf([a, b, c]);
  assert.equal(pool.length, 2);
  assert.equal(pool[0].candidate, b);
  assert.equal(pool[1].candidate, c);
  assert.equal(selectCatalogCandidates([a, b, c]).available, 3);
  assert.equal(poolOf([a, b, c], { gridMil: 1 }).length, 3);
});

test('same signature is replaced by lower score without cloning the candidate or mutating the old pool', () => {
  const a = candidate(2), b = candidate(1), worse = candidate(3);
  const before = addCatalogCandidate([], a), after = addCatalogCandidate(before, b);
  assert.equal(before[0].candidate, a);
  assert.equal(after[0].candidate, b);
  assert.equal(addCatalogCandidate(after, worse), after);
  assert.equal(selectCatalogCandidates([a, b, worse]).selected[0], b);
});

test('bounded pool keeps best scores in ascending order, independent of candidate iteration order', () => {
  const inputs = Array.from({ length: 10 }, (_, i) => candidate(10 - i, i * 40));
  const forward = poolOf(inputs, { limit: 3 }), backward = poolOf([...inputs].reverse(), { limit: 3 });
  assert.deepEqual(forward.map(entry => entry.candidate.comparisonScore), [1, 2, 3]);
  assert.deepEqual(forward, backward);
  assert.equal(poolOf(inputs, { limit: 0 }).length, 0);
});

test('score ties use pose keys for deterministic ordering and coarse-pool representative selection', () => {
  const a = candidate(1, 1), b = candidate(1, 8), c = candidate(1, 100);
  assert.deepEqual(poolOf([a, b, c]), poolOf([c, b, a]));
  assert.deepEqual(selectCatalogCandidates([a, c]), selectCatalogCandidates([c, a]));
});

test('invalid verdicts, nonfinite scores and malformed component poses are excluded', () => {
  const good = candidate();
  const bad = [null, ...[false, undefined, 'true'].map(valid => ({ ...candidate(), validation: { valid } })),
    ...[NaN, Infinity, -Infinity, '1'].map(score => candidate(score))];
  const noPose = candidate(); delete noPose.plan.components; bad.push(noPose);
  const empty = candidate(); empty.plan.components = []; bad.push(empty);
  const nonfinite = candidate(); nonfinite.plan.components[0].x = NaN; bad.push(nonfinite);
  const duplicate = candidate(); duplicate.plan.components[1].ref = 'R1'; bad.push(duplicate);
  const invalidRef = candidate(); invalidRef.plan.components[0].ref = ''; bad.push(invalidRef);
  const pool = addCatalogCandidate([], good);
  for (const rejected of bad) assert.equal(addCatalogCandidate(pool, rejected), pool);
  assert.deepEqual(selectCatalogCandidates([...bad, good]), { selected: [good], available: 1, duplicatesRemoved: 0 });
});

test('final selection reports true availability, duplicate count and shortfalls without padding', () => {
  const a = candidate(3), aBetter = candidate(1), b = candidate(2, 20), c = candidate(4, 40);
  const selection = selectCatalogCandidates([a, b, aBetter, c]);
  assert.deepEqual(selection, { selected: [aBetter, b, c], available: 3, duplicatesRemoved: 1 });
  assert.equal(selection.selected[0], aBetter);
  assert.deepEqual(selectCatalogCandidates([a, b, c], { count: 2 }), { selected: [b, a], available: 3, duplicatesRemoved: 0 });
  assert.deepEqual(selectCatalogCandidates([a], { count: 0 }), { selected: [], available: 1, duplicatesRemoved: 0 });
});

test('final selection uses 0.001mil coordinate precision and does not confuse different rotations', () => {
  const a = candidate(2, 1), b = candidate(1, 1.0004), c = candidate(3, 1.002), d = candidate(4, 1, 90);
  const selection = selectCatalogCandidates([a, b, c, d]);
  assert.deepEqual(selection, { selected: [b, c, d], available: 3, duplicatesRemoved: 1 });
});

test('invalid capacities and grids fail explicitly', () => {
  for (const gridMil of [0, -1, NaN, Infinity]) assert.throws(() => getCatalogPoseKey(candidate(), gridMil), /gridMil/);
  for (const value of [-1, 0.5, NaN, Infinity]) {
    assert.throws(() => addCatalogCandidate([], candidate(), { limit: value }), /limit/);
    assert.throws(() => selectCatalogCandidates([], { count: value }), /count/);
  }
});
