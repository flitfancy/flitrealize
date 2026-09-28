import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFeatures, checkBlocks } from '../scripts/pcb-layout/pcb-layout-features.mjs';
import { compileReferenceGeometry } from '../scripts/pcb-layout/pcb-layout-reference-scale.mjs';
import { transformBox } from '../scripts/pcb-layout/pcb-layout-geometry.mjs';

function fixture(seed = 0) {
  const initial = [
    { id: 'pJ', ref: 'J', x: 0, y: 0, rotation: 0, bbox: { minX: -20, maxX: 20, minY: -10, maxY: 10 } },
    { id: 'pU', ref: 'U', x: 100, y: 100, rotation: 0, bbox: { minX: 70, maxX: 130, minY: 90, maxY: 110 } },
    { id: 'pX', ref: 'X', x: 200, y: 100, rotation: 0, bbox: { minX: 190, maxX: 210, minY: 90, maxY: 110 } }
  ];
  const components = initial.map((c, i) => {
    const to = { ...c, x: c.x + seed * (151 + i * 421), y: c.y - seed * (153 + i * 152), rotation: (seed + i) % 4 * 90 };
    return { ...to, bbox: transformBox(c.bbox, c, to) };
  });
  const dimensions = compileReferenceGeometry({ components, pads: [] }, null);
  return { components: new Map(components.map(c => [c.ref, c])), contract: { blocks: [{ id: 'b', components: ['J', 'U'] }, { id: 'other', components: ['X'] }] }, dimensions };
}
const feature = block => [{ ref: 'J', edge: true, block: { anchors: ['U'], ...block } }];
const compile = (f, input) => compileFeatures(input, f.components, f.contract, f.dimensions);

test('geometry-derived block limits are unchanged by independently scattered and rotated starts', () => {
  const input = feature({ maxDistanceByGeometry: { factor: 2.5, minMil: 80 } });
  const first = compile(fixture(), input);
  assert.equal(first.blockRules[0].maxDistanceMil, 150); // max(sqrt(800+1200), 60) * 2.5
  assert.equal(first.blockRules[0].distanceSource, 'geometry-derived');
  for (let seed = 1; seed <= 8; seed++) assert.deepEqual(compile(fixture(seed), input), first);
  const minimum = compile(fixture(), feature({ maxDistanceByGeometry: { factor: 1, minMil: 400 } }));
  assert.equal(minimum.blockRules[0].maxDistanceMil, 400);
});

test('cross-block explicit anchors join geometry sizing once and remain actual distance anchors', () => {
  const input = feature({ anchors: ['U', 'X'], maxDistanceByGeometry: { factor: 2, minMil: 0 } });
  const rule = compile(fixture(), input).blockRules[0];
  assert.deepEqual(rule.geometryDistance.refs, ['J', 'U', 'X']);
  assert.equal(rule.geometryDistance.areaMil2, 2400);
  assert.deepEqual(rule.anchors, ['U', 'X']);
  const result = checkBlocks([rule], [{ ref: 'J', x: 151, y: 100 }, { ref: 'U', x: 100, y: 100 }, { ref: 'X', x: 200, y: 100 }]);
  assert.equal(result.details[0].distanceMil, 1); assert.equal(result.issues.length, 0);
});

test('explicit absolute hard maxima take precedence and remain enforced', () => {
  const f = fixture(), compiled = compile(f, feature({ maxDistanceMil: 12, maxDistanceByGeometry: { factor: 2.5, minMil: 400 } }));
  assert.equal(compiled.blockRules[0].maxDistanceMil, 12);
  assert.equal(compiled.blockRules[0].distanceSource, 'explicit-absolute');
  const positions = [{ ref: 'J', x: 13, y: 0 }, { ref: 'U', x: 0, y: 0 }, { ref: 'X', x: 100, y: 100 }];
  assert.equal(checkBlocks(compiled.blockRules, positions).issues[0].code, 'BLOCK_DISTANCE_EXCEEDED');
  positions[0].x = 12;
  assert.equal(checkBlocks(compiled.blockRules, positions).issues.length, 0);
  assert.equal(compileFeatures(feature({ maxDistanceMil: 12 }), f.components, f.contract).blockRules[0].maxDistanceMil, 12);
});

test('retired extra-distance inputs cannot silently create a bound from the current placement', () => {
  const f = fixture();
  for (const block of [{ maxExtraDistanceMil: 5 }, { maxDistanceMil: 10, maxExtraDistanceMil: 1 }, { maxExtraDistanceMil: 1, maxDistanceByGeometry: { factor: 2, minMil: 1 } }]) assert.throws(() => compile(f, feature(block)), /INVALID_BLOCK_DISTANCE/);
  const explicit = compile(f, feature({ maxDistanceMil: 205 })).blockRules[0];
  assert.equal(explicit.maxDistanceMil, 205);
  assert.equal(Object.hasOwn(explicit, 'baselineMil'), false);
  for (let seed = 1; seed <= 3; seed++) assert.deepEqual(compile(fixture(seed), feature({ maxDistanceMil: 205 })).blockRules[0], explicit);
});

test('geometry limits reject unknown fields, invalid values and missing referenced dimensions', () => {
  const f = fixture();
  for (const geometry of [null, {}, { factor: 0, minMil: 1 }, { factor: -1, minMil: 1 }, { factor: 2, minMil: -1 }, { factor: Infinity, minMil: 0 }, { factor: 2, minMil: 1, extra: 1 }]) assert.throws(() => compile(f, feature({ maxDistanceByGeometry: geometry })), /INVALID_BLOCK_GEOMETRY_DISTANCE/);
  for (const block of [{ maxDistanceMil: -1 }, { maxDistanceMil: 10, unknown: 1 }, {}]) assert.throws(() => compile(f, feature(block)), /INVALID_BLOCK_DISTANCE/);
  f.dimensions.delete('U');
  assert.throws(() => compile(f, feature({ maxDistanceByGeometry: { factor: 2, minMil: 1 } })), /MISSING_BLOCK_REFERENCE_GEOMETRY U/);
});
