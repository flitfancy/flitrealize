import test from 'node:test';
import assert from 'node:assert/strict';
import { compileUniformity, spacingNeighbors, evaluateUniformity, uniformityPenalty, spacingTranslation } from '../scripts/pcb-layout/pcb-layout-uniformity.mjs';

const b = (ref, x, y, w = 10, h = 10) => ({ ref, bbox: { minX: x, minY: y, maxX: x + w, maxY: y + h } });
const config = { targetMil: 25, toleranceMil: 10 };
const evaluate = bs => evaluateUniformity(config, bs, new Map(bs.map(b => [b.ref, b.bbox])));
const keys = edges => edges.map(e => [e.a, e.b].sort().join('-')).sort();

test('visible neighbors exclude a fully screened part and deduplicate reciprocal faces', () => {
  const bs = [b('A', 0, 0), b('B', 35, 0), b('C', 70, 0)];
  assert.deepEqual(keys(spacingNeighbors(bs)), ['A-B', 'B-C']);
  assert.equal(evaluate(bs).penalty, 0);
  assert.equal(evaluate(bs).stats.inBandFraction, 1);
  assert.deepEqual(spacingNeighbors(bs), spacingNeighbors([...bs].reverse()));
});

test('a large face can have multiple local neighbors, without long sightline attractions', () => {
  const edges = spacingNeighbors([b('A', 0, 0, 10, 100), b('B', 35, 0), b('C', 35, 90)]);
  assert.deepEqual(keys(edges), ['A-B', 'A-C']);
  const ac = edges.find(e => e.a === 'A' && e.b === 'C');
  assert.ok(ac.from.y >= 90 && ac.from.y <= 100);
  assert.equal(ac.distanceMil, 25);
  const slit = spacingNeighbors([b('A', 0, 0, 10, 50), b('B', 35, 0, 10, 20), b('C', 70, 0, 10, 50)]);
  assert.deepEqual(keys(slit), ['A-B', 'B-C']);
});

test('diagonal islands get sparse bridges instead of zero-neighbor or isolated-pair rewards', () => {
  const bs = [b('A', 0, 0), b('B', 35, 0), b('C', 150, 150), b('D', 185, 150)];
  const result = evaluate(bs);
  assert.equal(result.stats.bridges, 1); assert.equal(result.stats.pairs, 3);
  assert.ok(result.penalty > 0);
  assert.equal(evaluate([]).stats.medianMil, null);
  assert.equal(evaluate([b('A', 0, 0)]).penalty, 0);
});

test('edge distance follows unequal envelopes, label extension and translation', () => {
  const bs = [b('A', 0, 0, 100, 50), b('B', 125, 0)];
  assert.equal(evaluate(bs).stats.meanMil, 25);
  const expanded = structuredClone(bs); expanded[0].bbox.maxX += 10;
  assert.equal(evaluate(expanded).stats.meanMil, 15);
  assert.ok(evaluate(expanded).penalty > evaluate(bs).penalty);
  const shifted = bs.map(n => ({ ...n, bbox: Object.fromEntries(Object.entries(n.bbox).map(([k, v]) => [k, v + 123])) }));
  assert.equal(evaluate(shifted).penalty, evaluate(bs).penalty);
});

test('absolute target penalizes equally spaced but overly sparse layouts; tolerance is not a plateau', () => {
  assert.equal(uniformityPenalty(25, config), 0);
  assert.ok(uniformityPenalty(30, config) > 0);
  assert.ok(uniformityPenalty(8, config) > uniformityPenalty(15, config));
  assert.ok(uniformityPenalty(80, config) > uniformityPenalty(40, config));
  assert.ok(Math.abs(uniformityPenalty(35 - 1e-6, config) - uniformityPenalty(35 + 1e-6, config)) < 1e-5);
  assert.ok(evaluate([b('A', 0, 0), b('B', 150, 0), b('C', 300, 0)]).penalty > 0);
  assert.throws(() => compileUniformity({ targetMil: 25, toleranceMil: 0 }), /INVALID_UNIFORMITY/);
  assert.throws(() => compileUniformity({ targetMil: 10, toleranceMil: 20 }), /INVALID_UNIFORMITY/);
  assert.throws(() => compileUniformity({ ...config, typo: 1 }), /INVALID_UNIFORMITY/);
});

test('directed proposals open tight gaps and close wide gaps from either endpoint', () => {
  const edge = spacingNeighbors([b('A', 0, 0), b('B', 60, 0)])[0];
  assert.deepEqual(spacingTranslation(edge, 'A', 25, 20, 5), { dx: 20, dy: 0 });
  assert.equal(spacingTranslation(edge, 'B', 25, 20, 5).dx, -20);
  assert.equal(spacingTranslation(edge, 'A', 75, 20, 5).dx, -20);
  assert.equal(spacingTranslation(edge, 'A', 50, 20, 5).dx, 0);
});
