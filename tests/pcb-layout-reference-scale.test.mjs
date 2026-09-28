import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAssemblyPolicy } from '../scripts/pcb-layout/pcb-layout-assembly-policy.mjs';
import { transformBox, transformPoint } from '../scripts/pcb-layout/pcb-layout-geometry.mjs';
import { compileReferenceGeometry, compileReferenceScales, scoreReferenceMil } from '../scripts/pcb-layout/pcb-layout-reference-scale.mjs';

const rect = (minX, minY, maxX, maxY) => ({ minX, minY, maxX, maxY });
function fixture() {
  const snapshot = { components: [
    { id: 'part_A', ref: 'A', footprint: { name: 'TEST' }, x: 0, y: 0, rotation: 0, bbox: rect(-10, -20, 10, 20) },
    { id: 'part_B', ref: 'B', footprint: { name: 'TEST' }, x: 100, y: 100, rotation: 0, bbox: rect(90, 70, 110, 130) }
  ], pads: [
    { id: 'part_A.pad1', owner: 'A', number: '1', x: 15, y: 0, bbox: rect(13, -2, 17, 2) },
    { id: 'part_B.pad1', owner: 'B', number: '1', x: 100, y: 100, bbox: rect(98, 98, 102, 102) },
    { id: 'free1', owner: null, number: 'TP1', x: 500, y: 500, bbox: rect(498, 498, 502, 502) }
  ], items: [] };
  const assembly = { schemaVersion: 1, profile: { id: 'test', label: 'test' }, source: { title: 'test', url: 'https://example.test' },
    rules: [{ id: 'test', footprintNames: ['TEST'], marginMm: { xMinus: .254, xPlus: .508, yMinus: .127, yPlus: .762 } }],
    overrides: [], independentPads: { marginMm: 0, basis: 'bare pad' } };
  return { snapshot, assembly };
}
function modelFor(f) {
  const assemblyPolicy = compileAssemblyPolicy(f.snapshot, f.assembly);
  return { snapshot: f.snapshot, assemblyPolicy, referenceGeometry: compileReferenceGeometry(f.snapshot, assemblyPolicy),
    config: { scoringReference: { mode: 'geometry', distanceFloorMil: 1 }, groups: ['power', 'sense', 'bypass'].map(id => ({ id })) },
    links: ['power', 'sense', 'bypass'].map(group => ({ a: 'A', b: 'B', group })),
    connectivity: [{ name: 'AB', pads: [{ ref: 'A' }, { ref: 'A' }, { ref: 'B' }] }, { name: 'ABC', pads: [{ ref: 'A' }, { ref: 'B' }, { ref: 'TP1' }] }, { name: 'SELF', pads: [{ ref: 'A' }, { ref: 'A' }] }],
    baselineMetrics: { groups: { power: { mil: 1000 }, sense: { mil: 2000 }, bypass: { mil: 3000 }, connectivity: { mil: 4000 } } } };
}
function relocate(f, seed) {
  const old = f.snapshot.components.map(c => structuredClone(c));
  f.snapshot.components = old.map((c, i) => {
    const to = { ...c, x: seed * 123 + i * 1677, y: seed * -227 + i * 63, rotation: (seed + i) % 4 * 90 };
    return { ...to, bbox: transformBox(c.bbox, c, to) };
  });
  f.snapshot.pads = f.snapshot.pads.map(p => {
    const from = old.find(c => c.ref === p.owner);
    if (!from) return { ...p, x: p.x + seed * 199, y: p.y - seed * 421, bbox: rect(p.bbox.minX + seed * 199, p.bbox.minY - seed * 421, p.bbox.maxX + seed * 199, p.bbox.maxY - seed * 421) };
    const to = f.snapshot.components.find(c => c.ref === from.ref);
    return { ...p, ...transformPoint(p, from, to), bbox: transformBox(p.bbox, from, to) };
  });
  return f;
}

test('geometry scales ignore independent translations, quarter-turns, refdes and old score baselines', () => {
  const base = modelFor(fixture()), expected = compileReferenceScales(base);
  for (let seed = 1; seed <= 8; seed++) {
    const f = relocate(fixture(), seed);
    f.snapshot.items = [{ owner: 'A', bbox: rect(-1e5, -1e5, 1e5, 1e5) }];
    const changed = modelFor(f);
    changed.baselineMetrics.groups.power.mil = 1e9;
    assert.deepEqual(changed.referenceGeometry, base.referenceGeometry);
    assert.deepEqual(compileReferenceScales(changed), expected);
  }
});

test('physical proxy includes pads, asymmetric margins use local axes, and trusted courtyards are not inflated twice', () => {
  const f = fixture(), m = modelFor(f), a = m.referenceGeometry.get('A');
  assert.equal(a.widthMil, 57); assert.equal(a.heightMil, 75);
  assert.equal(m.referenceGeometry.get('TP1').areaMil2, 16);
  f.assembly.overrides = [{ ref: 'A', basis: 'fixture', courtyard: { coordinateSystem: 'component-local-zero', trusted: true, basis: 'fixture', boxMil: rect(-50, -50, 50, 50) } }];
  const trusted = modelFor(f).referenceGeometry.get('A');
  assert.equal(trusted.widthMil, 100); assert.equal(trusted.heightMil, 100);
  const proxy = compileReferenceGeometry(f.snapshot, null);
  assert.equal(proxy.get('A').widthMil, 27); assert.equal(proxy.get('A').heightMil, 40);
  assert.deepEqual(compileReferenceGeometry(relocate(fixture(), 3).snapshot, null), proxy);
});

test('existing link groups and unique-owner net topology have explicit finite scales', () => {
  const m = modelFor(fixture()), actual = compileReferenceScales(m);
  const area = ref => m.referenceGeometry.get(ref).areaMil2;
  const pair = (Math.sqrt(area('A')) + Math.sqrt(area('B'))) / 2;
  for (const key of ['power', 'sense', 'bypass']) { assert.equal(actual.groups[key].mil, pair); assert.equal(actual.groups[key].count, 1); }
  assert.equal(actual.nets.length, 2);
  assert.ok(Math.abs(actual.nets[0].mil - 2 * Math.sqrt(area('A') + area('B'))) < 1e-9);
  assert.ok(Math.abs(actual.nets[1].mil - 2 * Math.sqrt(area('A') + area('B') + area('TP1'))) < 1e-9);
  m.scoreReferences = actual;
  assert.equal(scoreReferenceMil(m, 'power'), pair);
  m.connectivity = [{ name: 'SELF', pads: [{ ref: 'A' }, { ref: 'A' }] }];
  const empty = compileReferenceScales(m);
  assert.equal(empty.groups.connectivity.count, 0); assert.equal(empty.groups.connectivity.mil, 1);
});

test('omitted scale uses geometry and never falls back to baseline ratios', () => {
  const m = modelFor(fixture()), expected = compileReferenceScales(m);
  delete m.config.scoringReference;
  assert.deepEqual(compileReferenceScales(m), expected);
  assert.throws(() => scoreReferenceMil(m, 'sense'), /MISSING_COMPILED_SCORE_REFERENCE/);
  m.scoreReferences = compileReferenceScales(m);
  assert.equal(scoreReferenceMil(m, 'sense'), expected.groups.sense.mil);
  m.config.scoringReference = {};
  assert.deepEqual(compileReferenceScales(m), expected);
  m.baselineMetrics.groups.power.mil = 0;
  assert.equal(scoreReferenceMil(m, 'power'), expected.groups.power.mil);
  m.config.scoringReference = { mode: 'legacy-baseline' };
  assert.throws(() => compileReferenceScales(m), /INVALID_SCORING_REFERENCE/);
  assert.throws(() => scoreReferenceMil(m, 'power'), /INVALID_SCORING_REFERENCE/);
});

test('strict scales reject unknown fields, invalid floors, missing geometry and uncompiled geometry references', () => {
  for (const input of [null, { mode: 'other' }, { mode: 'geometry', unknown: 1 }, { mode: 'geometry', distanceFloorMil: -1 }, { mode: 'geometry', distanceFloorMil: 0 }, { mode: 'geometry', distanceFloorMil: Infinity }, { mode: 'legacy-baseline', distanceFloorMil: 1 }]) {
    const m = modelFor(fixture()); m.config.scoringReference = input;
    assert.throws(() => compileReferenceScales(m), /SCORING_REFERENCE/);
  }
  const m = modelFor(fixture());
  assert.throws(() => scoreReferenceMil(m, 'power'), /MISSING_COMPILED_SCORE_REFERENCE/);
  m.links.push({ a: 'A', b: 'UNKNOWN', group: 'sense' });
  assert.throws(() => compileReferenceScales(m), /MISSING_REFERENCE_GEOMETRY UNKNOWN/);
});
