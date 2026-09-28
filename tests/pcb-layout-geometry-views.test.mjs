import test from 'node:test';
import assert from 'node:assert/strict';
import { compileGeometryViews, buildGeometryViews } from '../scripts/pcb-layout/pcb-layout-geometry-views.mjs';

const box = (minX, minY, maxX, maxY) => ({ minX, minY, maxX, maxY });
function fixture() {
  return {
    components: [{ id: 'c1:', ref: 'U1', x: 10, y: 20, rotation: 0, bbox: box(8, 17, 30, 26), layer: 1 }],
    pads: [
      { id: 'c1:pad1', owner: 'U1', number: '1', net: 'VCC', x: 25, y: 22, bbox: box(24, 21, 28, 24), layer: 1 },
      { id: 'tp-id', owner: null, number: 'TP1', net: 'VCC', x: 70, y: 80, bbox: box(68, 78, 72, 82) }
    ],
    items: [{ id: 'c1:label', owner: 'U1', type: 'attribute', text: 'U1', layer: 3, original: { x: 32, y: 15, rotation: 0, bbox: box(32, 15, 42, 20) } }]
  };
}
const target = [{ ref: 'U1', x: 100, y: 200, rotation: 90 }];
const envelope = { id: 'U1-access', ref: 'U1', kind: 'operation', box: box(2, -6, 12, -2), coordinateSystem: 'component-local-zero', basis: 'Explicit mechanical input' };

test('views keep asymmetric footprint, individual pads and native labels separate through rotation', () => {
  const compiled = compileGeometryViews(fixture());
  const result = buildGeometryViews(compiled, target);
  assert.deepEqual(result.footprint[0].bbox, box(94, 198, 103, 220));
  assert.deepEqual(result.pads[0].bbox, box(96, 214, 99, 218));
  assert.equal(result.pads[0].x, 98); assert.equal(result.pads[0].y, 215);
  assert.equal(result.pads[0].owner, 'U1'); assert.equal(result.pads[0].number, '1'); assert.equal(result.pads[0].net, 'VCC');
  assert.deepEqual(result.silkscreen[0].bbox, box(100, 222, 105, 232));
  assert.deepEqual(result.placement[0].bbox, box(94, 198, 105, 232));
  assert.equal(result.footprint[0].source, 'native-footprint-bbox-proxy');
  assert.equal(result.footprint[0].layer, 1); assert.equal(result.silkscreen[0].layer, 3);
  assert.equal(result.pads[1].layer, null);
  assert.equal(result.units, 'mil'); assert.equal(result.coordinateSystem, 'cartesian-y-up');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('final native label and test-pad positions override transformed originals without changing footprint', () => {
  const compiled = compileGeometryViews(fixture());
  const labels = [{ id: 'c1:label', owner: 'U1', x: 80, y: 198, rotation: 0, bbox: box(80, 198, 90, 203) }];
  const testPads = [{ id: 'tp-id', owner: null, number: 'TP1', net: 'VCC', x: 10, y: 100, bbox: box(8, 98, 12, 102) }];
  const result = buildGeometryViews(compiled, target, labels, testPads);
  assert.deepEqual(result.placement[0].bbox, box(80, 198, 103, 220));
  assert.deepEqual(result.footprint[0].bbox, box(94, 198, 103, 220));
  assert.deepEqual(result.silkscreen[0].bbox, labels[0].bbox); assert.equal(result.silkscreen[0].layer, 3);
  assert.deepEqual(result.placement[1].bbox, testPads[0].bbox);
  assert.equal(result.pads[1].owner, null); assert.equal(result.pads[1].ref, 'TP1');
  assert.equal(result.pads[1].x, 10); assert.equal(result.pads[1].y, 100);
});

test('standalone test pads remain included at their original positions when no final positions are supplied', () => {
  const result = buildGeometryViews(compileGeometryViews(fixture()), target);
  assert.equal(result.pads.length, 2); assert.equal(result.placement.length, 2);
  assert.deepEqual(result.pads[1].bbox, box(68, 78, 72, 82));
  assert.equal(result.placement[1].ref, 'TP1');
  assert.equal(result.footprint.length, 1); assert.equal(result.silkscreen.length, 1);
});

test('explicit assembly and operation envelopes follow zero-angle coordinates and stay separate from placement', () => {
  const assembly = { ...envelope, id: 'U1-assembly', kind: 'assembly', box: box(-10, -10, 10, 10), layer: 9 };
  const compiled = compileGeometryViews(fixture(), { schemaVersion: 1, envelopes: [envelope, assembly] });
  const result = buildGeometryViews(compiled, target);
  assert.deepEqual(result.operation[0].bbox, box(102, 202, 106, 212));
  assert.equal(result.operation[0].basis, envelope.basis); assert.equal(result.operation[0].layer, null);
  assert.deepEqual(result.assembly[0].bbox, box(90, 190, 110, 210));
  assert.equal(result.assembly[0].layer, 9);
  assert.deepEqual(result.placement[0].bbox, box(94, 198, 105, 232));
  const snapshot = fixture(); snapshot.components[0].rotation = 45;
  const at45 = buildGeometryViews(compileGeometryViews(snapshot, { envelopes: [envelope] }), [{ ref: 'U1', x: 0, y: 0, rotation: 45 }]);
  assert.ok(Math.abs(at45.operation[0].bbox.minX - 4 / Math.sqrt(2)) < 1e-10);
  assert.ok(Math.abs(at45.operation[0].bbox.maxX - 18 / Math.sqrt(2)) < 1e-10);
});

test('missing envelopes and layers stay unknown and no physical body, access, or assembly clearance is fabricated', () => {
  const snapshot = fixture(); delete snapshot.components[0].layer; delete snapshot.pads[0].layer; delete snapshot.items[0].layer;
  const result = buildGeometryViews(compileGeometryViews(snapshot), snapshot.components);
  assert.deepEqual(result.assembly, []); assert.deepEqual(result.operation, []);
  for (const kind of ['footprint', 'pads', 'silkscreen', 'placement']) assert.ok(result[kind].every(s => s.layer === null));
  assert.ok(result.limitations.some(l => l.code === 'NATIVE_BBOX_PROXY'));
  assert.ok(result.limitations.some(l => l.code === 'EXPLICIT_ENVELOPES_ONLY'));
  assert.throws(() => compileGeometryViews({ components: [] }), /INVALID_GEOMETRY_SNAPSHOT/);
});

test('geometry compilation and building never mutate source snapshots, configuration, candidates or compiled input', () => {
  const snapshot = fixture(), input = { envelopes: [structuredClone(envelope)] }, candidate = structuredClone(target);
  const originals = structuredClone({ snapshot, input, candidate });
  const compiled = compileGeometryViews(snapshot, input), before = structuredClone(compiled);
  const result = buildGeometryViews(compiled, candidate);
  assert.deepEqual({ snapshot, input, candidate }, originals); assert.deepEqual(compiled, before);
  result.footprint[0].bbox.minX = -999; result.pads[1].bbox.minX = -999;
  assert.deepEqual(compiled, before);
  snapshot.components[0].bbox.minX = -999; input.envelopes[0].box.minX = -999;
  assert.deepEqual(compiled, before);
});

test('schema, unknown fields, envelope references, coordinates, kinds and duplicate IDs are rejected', () => {
  const compile = input => compileGeometryViews(fixture(), input);
  assert.throws(() => compile({ schemaVersion: 2 }), /UNSUPPORTED_GEOMETRY_SCHEMA/);
  assert.throws(() => compile({ clearanceMil: 8 }), /UNKNOWN_GEOMETRY_FIELD/);
  assert.throws(() => compile({ envelopes: {} }), /INVALID_GEOMETRY_ENVELOPES/);
  assert.throws(() => compile({ envelopes: [{ ...envelope, clearance: 8 }] }), /UNKNOWN_GEOMETRY_FIELD/);
  assert.throws(() => compile({ envelopes: [{ ...envelope, ref: 'missing' }] }), /UNKNOWN_GEOMETRY_REF/);
  assert.throws(() => compile({ envelopes: [{ ...envelope, kind: 'courtyard' }] }), /INVALID_GEOMETRY_KIND/);
  assert.throws(() => compile({ envelopes: [{ ...envelope, coordinateSystem: 'world' }] }), /INVALID_GEOMETRY_COORDINATE_SYSTEM/);
  assert.throws(() => compile({ envelopes: [{ ...envelope, box: box(0, 0, -1, 2) }] }), /INVALID_GEOMETRY_BOX/);
  assert.throws(() => compile({ envelopes: [{ ...envelope, box: box(0, 0, 0, 2) }] }), /INVALID_GEOMETRY_BOX/);
  assert.throws(() => compile({ envelopes: [{ ...envelope, box: { ...envelope.box, maxX: NaN } }] }), /INVALID_GEOMETRY_COORDINATE/);
  assert.throws(() => compile({ envelopes: [{ ...envelope, box: { ...envelope.box, z: 1 } }] }), /UNKNOWN_GEOMETRY_FIELD/);
  assert.throws(() => compile({ envelopes: [envelope, envelope] }), /DUPLICATE_GEOMETRY_ID/);
  assert.throws(() => compile({ envelopes: [{ ...envelope, layer: {} }] }), /INVALID_GEOMETRY_LAYER/);
});

test('invalid native or final objects fail rather than silently disappear or move ownership', () => {
  const compiled = compileGeometryViews(fixture());
  assert.throws(() => buildGeometryViews(compiled, []), /GEOMETRY_OBJECT_COUNT/);
  assert.throws(() => buildGeometryViews(compiled, [{ ...target[0], ref: 'missing' }]), /UNKNOWN_GEOMETRY_COMPONENT/);
  assert.throws(() => buildGeometryViews(compiled, [{ ...target[0], x: Infinity }]), /INVALID_GEOMETRY_COORDINATE/);
  assert.throws(() => buildGeometryViews(compiled, target, []), /GEOMETRY_OBJECT_COUNT/);
  assert.throws(() => buildGeometryViews(compiled, target, [{ id: 'bad-id', owner: 'U1', bbox: box(0, 0, 1, 1) }]), /UNKNOWN_GEOMETRY_ID/);
  assert.throws(() => buildGeometryViews(compiled, target, [{ id: 'c1:label', owner: 'U2', bbox: box(0, 0, 1, 1) }]), /GEOMETRY_LABEL_OWNER_CHANGED/);
  assert.throws(() => buildGeometryViews(compiled, target, undefined, []), /GEOMETRY_OBJECT_COUNT/);
  assert.throws(() => buildGeometryViews(compiled, target, undefined, [{ id: 'tp-id', net: 'GND' }]), /GEOMETRY_TEST_PAD_IDENTITY_CHANGED/);
  const bad = fixture(); bad.pads.push(structuredClone(bad.pads[0]));
  assert.throws(() => compileGeometryViews(bad), /DUPLICATE_GEOMETRY_ID/);
  const badLabel = fixture(); badLabel.items[0].owner = 'missing';
  assert.throws(() => compileGeometryViews(badLabel), /UNKNOWN_GEOMETRY_OWNER/);
});

test('explicit parent resolves pad ownership independently of ID shape and native body proxies remain usable', () => {
  const snapshot = fixture(); snapshot.components[0].id = 'c';
  snapshot.components.push({ id: 'c1:', ref: 'U2', x: 0, y: 0, rotation: 0, bbox: box(-1, -1, 1, 1) });
  delete snapshot.pads[0].owner; snapshot.pads[0].parentComponentId = 'c1:';
  const compiled = compileGeometryViews(snapshot);
  assert.equal(compiled.pads[0].owner, 'U2');
  const candidate = [{ ...target[0], body: box(90, 190, 110, 210) }, { ref: 'U2', x: 0, y: 0, rotation: 0, body: box(-1, -1, 1, 1) }];
  assert.deepEqual(buildGeometryViews(compiled, candidate).footprint[0].bbox, candidate[0].body);
});
