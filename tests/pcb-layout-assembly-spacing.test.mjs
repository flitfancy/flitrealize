import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSpacingPolicy, scorePairSpacing } from '../scripts/pcb-layout/pcb-layout-spacing-policy.mjs';
import { evaluateSpacingPolicy, resolveAssemblyPairSpacing } from '../scripts/pcb-layout/pcb-layout-spacing-evaluation.mjs';
import { spacingTranslation } from '../scripts/pcb-layout/pcb-layout-uniformity.mjs';

const input = { schemaVersion: 2, mode: 'active', source: 'assembly-courtyard', geometry: 'physical', bandRatios: { rejectBelow: .75, neutralMin: .9, neutralMax: 1.2 }, requirements: [] };
const policy = (requirements = []) => compileSpacingPolicy({ ...input, requirements }, ['A', 'B'], { absoluteFloorMil: 1, assemblyPolicy: {} });
const box = (x, y, w = 10, h = 10) => ({ minX: x, minY: y, maxX: x + w, maxY: y + h });
const expand = (b, v) => ({ minX: b.minX - v, minY: b.minY - v, maxX: b.maxX + v, maxY: b.maxY + v });
const maps = (gap, m = 5) => {
  const a = box(0, 0), b = box(10 + gap, 0);
  return [new Map([['A', a], ['B', b]]), new Map([['A', expand(a, m)], ['B', expand(b, m)]])];
};

test('single-side margins add once; 75 percent is the full assembly hard minimum', () => {
  const [p, c] = maps(10), rule = resolveAssemblyPairSpacing(policy(), 'A', 'B', p, c);
  assert.equal(rule.hardMinMil, 10);
  assert.equal(rule.baselineMil, 10 / .75);
  assert.equal(rule.neutralMinMil, 12); assert.equal(rule.neutralMaxMil, 16);
  assert.equal(scorePairSpacing(10, rule).accepted, true);
  assert.equal(scorePairSpacing(9.999, rule).accepted, false);
  for (const gap of [12, 14, 16]) assert.equal(scorePairSpacing(gap, rule).penalty, 0);
  assert.ok(scorePairSpacing(17, rule).penalty > 0);
});

test('directional courtyard chooses feasible Y, not the largest raw X gap', () => {
  const pa = box(0, 0), pb = box(30, 25);
  const p = new Map([['A', pa], ['B', pb]]);
  const c = new Map([['A', { ...expand(pa, 5), maxX: 50 }], ['B', expand(pb, 5)]]);
  const rule = resolveAssemblyPairSpacing(policy(), 'A', 'B', p, c);
  assert.equal(rule.axis, 'y+'); assert.equal(rule.distanceMil, 15); assert.equal(rule.hardMinMil, 10);
  assert.equal(scorePairSpacing(rule.distanceMil, rule).accepted, true);
  assert.deepEqual(spacingTranslation(rule, 'A', 12, 3, 1), { dx: 0, dy: 3 });
});

test('physical absolute requirements cannot pass on a different axis from the courtyard', () => {
  const pa = box(0, 0), pb = box(30, 25);
  const p = new Map([['A', pa], ['B', pb]]);
  const c = new Map([['A', { ...expand(pa, 5), maxX: 50 }], ['B', expand(pb, 5)]]);
  const rule = resolveAssemblyPairSpacing(policy([{ id: 'service', refs: ['A', 'B'], purpose: 'test', hardMinimumMil: 18 }]), 'A', 'B', p, c);
  assert.equal(scorePairSpacing(rule.distanceMil, rule).accepted, false);
});

test('physical scoring is invariant to moving a label', () => {
  const [p, c] = maps(14), shapes = m => [...m].map(([ref, bbox]) => ({ ref, bbox }));
  const geometry = { physical: shapes(p), assemblyPolicy: { courtyards: shapes(c) }, placement: [{ ref: 'A', bbox: box(-1000, -1000, 3000, 3000) }] };
  const first = evaluateSpacingPolicy(policy(), geometry, ['A', 'B']);
  geometry.placement = [{ ref: 'A', bbox: box(0, 0) }];
  assert.deepEqual(evaluateSpacingPolicy(policy(), geometry, ['A', 'B']), first);
  assert.equal(first.penalty, 0); assert.equal(first.stats.checkedPairs, 1);
});

test('new mode rejects missing assembly rules, old fixed bases and unknown pair references', () => {
  assert.throws(() => compileSpacingPolicy(input, ['A', 'B'], { absoluteFloorMil: 1 }), /ASSEMBLY_RULES_REQUIRED/);
  assert.throws(() => compileSpacingPolicy({ ...input, classes: [] }, ['A', 'B'], { absoluteFloorMil: 1, assemblyPolicy: {} }), /INVALID_SPACING_POLICY/);
  assert.throws(() => policy([{ id: 'bad', purpose: 'test', refs: ['A', 'C'], hardMinimumMil: 2 }]), /INVALID_SPACING_REQUIREMENT/);
  assert.throws(() => policy([{ id: 'pending', purpose: 'test', refs: ['A', 'B'], hardMinimumMil: null }]), /INVALID_SPACING_REQUIREMENT/);
});
