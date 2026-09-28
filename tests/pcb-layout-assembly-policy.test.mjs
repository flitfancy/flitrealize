import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { compileAssemblyPolicy, assemblyRuntime, buildAssemblyGeometry, evaluateAssemblyPolicy } from '../scripts/pcb-layout/pcb-layout-assembly-policy.mjs';

const rect = (minX, minY, maxX, maxY) => ({ minX, minY, maxX, maxY });
const part = (ref, x = 0, y = 0, rotation = 0, footprint = 'TEST') => ({ id: 'component_' + ref, ref, x, y, rotation, layer: 1, footprint: { name: footprint }, bbox: rect(x - 5, y - 5, x + 5, y + 5) });
const pad = (c, number = '1') => ({ id: c.id + '.pad' + number, owner: c.ref, number, x: c.x, y: c.y, bbox: rect(c.x - 2, c.y - 2, c.x + 2, c.y + 2), layer: 1 });
const bare = (x = 100, y = 100) => ({ id: 'standalone-pad', owner: null, number: 'TP1', x, y, bbox: rect(x - 2, y - 2, x + 2, y + 2), layer: 1 });
const snapshot = (...components) => ({ components, pads: components.map(c => pad(c)), items: [] });
const input = () => ({ schemaVersion: 1, profile: { id: 'test', label: 'Test profile' }, source: { title: 'Reference', url: 'https://example.test/reference' }, rules: [{ id: 'ordinary', footprintNames: ['TEST'], marginMm: 0.254 }], overrides: [], independentPads: { marginMm: 0, basis: 'Bare pad has no assembly body.' } });
const poses = s => s.components.map(({ id, ref, x, y, rotation }) => ({ id, ref, x, y, rotation }));
const closeBox = (actual, expected) => { for (const k of ['minX', 'minY', 'maxX', 'maxY']) assert.ok(Math.abs(actual[k] - expected[k]) < 1e-9, `${k}: ${actual[k]} vs ${expected[k]}`); };

test('optional policy preserves legacy callers and compiled output is JSON serializable', () => {
  assert.equal(compileAssemblyPolicy({}, undefined), null);
  assert.equal(compileAssemblyPolicy({}, null), null);
  assert.equal(assemblyRuntime(null, []).valid, true);
  const s = snapshot(part('A'));
  const c = compileAssemblyPolicy(s, input());
  assert.deepEqual(JSON.parse(JSON.stringify(c)), c);
  assert.equal(c.coverage.mappedComponents, 1);
  assert.equal(c.coverage.uniqueFootprints, 1);
});

test('exact footprint rule is reused and per-side margins add without double inflation', () => {
  const s = snapshot(part('A'), part('B', 30));
  const c = compileAssemblyPolicy(s, input());
  const touching = assemblyRuntime(c, poses(s));
  assert.equal(touching.valid, true);
  assert.equal(touching.checkedPairs, 1);
  closeBox(touching.courtyards[0].bbox, rect(-15, -15, 15, 15));
  closeBox(touching.courtyards[1].bbox, rect(15, -15, 45, 15));
  const moved = poses(s); moved[1].x -= 0.01;
  const overlap = assemblyRuntime(c, moved);
  assert.equal(overlap.valid, false);
  assert.equal(overlap.issues[0].code, 'ASSEMBLY_COURTYARD_OVERLAP');
});

test('unknown footprint does not silently adopt defaults or a ref override', () => {
  const s = snapshot(part('A', 0, 0, 0, 'UNKNOWN'));
  const cfg = input(); cfg.overrides = [{ ref: 'A', basis: 'test', marginMm: 0.5 }];
  assert.throws(() => compileAssemblyPolicy(s, cfg), /UNKNOWN_ASSEMBLY_FOOTPRINT A:UNKNOWN/);
});

test('strict rule schema rejects duplicate, missing and mistyped inputs', () => {
  const s = snapshot(part('A'));
  const cases = [
    [c => { c.rules.push({ id: 'other', footprintNames: ['TEST'], marginMm: 0.25 }); }, /DUPLICATE_ASSEMBLY_FOOTPRINT/],
    [c => { c.rules.push({ id: 'ordinary', footprintNames: ['OTHER'], marginMm: 0.25 }); }, /DUPLICATE_ASSEMBLY_RULE/],
    [c => { c.rules[0].marginMM = 1; }, /UNKNOWN_ASSEMBLY_FIELD/],
    [c => { c.rules[0].marginMm = { xMinus: 1 }; }, /INVALID_ASSEMBLY_NUMBER/],
    [c => { c.rules[0].marginMm = -1; }, /NEGATIVE_ASSEMBLY_MARGIN/],
    [c => { c.rules[0].marginMm = null; }, /INVALID_ASSEMBLY_OBJECT/],
    [c => { delete c.rules[0].marginMm; }, /ASSEMBLY_RULE_REQUIRES_ONE_GEOMETRY/],
    [c => { c.overrides = [{ ref: 'UNKNOWN', marginMm: 1, basis: 'test' }]; }, /UNKNOWN_ASSEMBLY_OVERRIDE_REF/],
    [c => { c.overrides = [{ ref: 'A', marginMm: 1, basis: 'test' }, { ref: 'A', marginMm: 1, basis: 'test' }]; }, /DUPLICATE_ASSEMBLY_OVERRIDE/],
    [c => { c.independentPads.marginMm = 1; }, /ASSEMBLY_TESTPAD_MARGIN_MUST_BE_ZERO/]
  ];
  for (const [mutate, expected] of cases) { const cfg = input(); mutate(cfg); assert.throws(() => compileAssemblyPolicy(s, cfg), expected); }
  assert.throws(() => compileAssemblyPolicy(snapshot(part('A'), part('A')), input()), /DUPLICATE_ASSEMBLY_COMPONENT/);
});

test('directional exceptions rotate with local-zero axes and normalize quarter-turn noise', () => {
  const s = snapshot(part('A'));
  const cfg = input(); cfg.overrides = [{ ref: 'A', basis: 'Direction test', marginMm: { xMinus: 0.0254, xPlus: 0.508, yMinus: 0.0508, yPlus: 0.0762 } }];
  const c = compileAssemblyPolicy(s, cfg);
  const p = poses(s); p[0].rotation = 90;
  closeBox(assemblyRuntime(c, p).courtyards[0].bbox, rect(-8, -6, 7, 25));
  p[0].rotation = 270;
  const expected = assemblyRuntime(c, p).courtyards[0].bbox;
  p[0].rotation = -90.00000000000001;
  assert.deepEqual(assemblyRuntime(c, p).courtyards[0].bbox, expected);
  p[0].rotation = 45;
  assert.throws(() => assemblyRuntime(c, p), /ASSEMBLY_QUARTER_TURN_REQUIRED/);
});

test('trusted courtyard replaces inflation and must contain actual physical envelope', () => {
  const s = snapshot(part('A'));
  const cfg = input(); cfg.overrides = [{ ref: 'A', basis: 'Verified envelope', courtyard: { coordinateSystem: 'component-local-zero', boxMil: rect(-12, -8, 20, 8), trusted: true, basis: 'Manufacturer drawing' } }];
  const c = compileAssemblyPolicy(s, cfg);
  assert.equal(c.coverage.trustedCourtyards, 1);
  assert.equal(c.records[0].marginMil, null);
  closeBox(assemblyRuntime(c, poses(s)).courtyards[0].bbox, rect(-12, -8, 20, 8));
  const actualPads = structuredClone(s.pads); actualPads[0].bbox.maxX = 30;
  assert.equal(assemblyRuntime(c, s.components, actualPads).issues[0].code, 'ASSEMBLY_COURTYARD_UNDERSIZED');
  cfg.overrides[0].courtyard.boxMil = rect(-1, -1, 1, 1);
  assert.throws(() => compileAssemblyPolicy(s, cfg), /ASSEMBLY_COURTYARD_UNDERSIZED/);
  cfg.overrides[0].courtyard.trusted = false;
  assert.throws(() => compileAssemblyPolicy(s, cfg), /ASSEMBLY_COURTYARD_MUST_BE_TRUSTED/);
});

test('assembly ignores label geometry and includes pads beyond the component proxy', () => {
  const s = snapshot(part('A'));
  s.pads[0].bbox.maxX = 12;
  const first = compileAssemblyPolicy(s, input());
  s.items = [{ id: 'label', owner: 'A', original: { bbox: rect(-1000, -1000, 1000, 1000) } }];
  const second = compileAssemblyPolicy(s, input());
  assert.deepEqual(second, first);
  const geometry = buildAssemblyGeometry(second, poses(s));
  closeBox(geometry.physical[0].bbox, rect(-5, -5, 12, 5));
  closeBox(geometry.courtyards[0].bbox, rect(-15, -15, 22, 15));
});

test('independent pads have zero expansion but remain collidable obstacles', () => {
  const s = snapshot(part('A')); s.pads.push(bare(16, 0));
  const c = compileAssemblyPolicy(s, input());
  assert.equal(c.coverage.independentPads, 1);
  const result = assemblyRuntime(c, poses(s));
  closeBox(result.courtyards.find(p => p.ref === 'TP1').bbox, rect(14, -2, 18, 2));
  assert.equal(result.issues[0].b, 'TP1');
  const actual = structuredClone(s.pads); actual[1].bbox = rect(30, -2, 34, 2);
  assert.equal(assemblyRuntime(c, s.components, actual).valid, true);
});

test('actual readback geometry is used and missing actual data never falls back to predictions', () => {
  const s = snapshot(part('A'), part('B', 40));
  const c = compileAssemblyPolicy(s, input());
  assert.equal(assemblyRuntime(c, poses(s)).valid, true);
  const actual = structuredClone(s.pads); actual[0].bbox = rect(-2, -2, 27, 2);
  const result = assemblyRuntime(c, s.components, actual);
  assert.equal(result.valid, false);
  assert.equal(result.physical[0].bbox.maxX, 27);
  assert.equal(result.physical[0].source, 'provided-footprint-and-pad-bbox-proxy');
  assert.throws(() => assemblyRuntime(c, poses(s), s.pads), /MISSING_ASSEMBLY_ACTUAL_BODY/);
  assert.throws(() => assemblyRuntime(c, s.components, s.pads.slice(1)), /ASSEMBLY_PAD_COUNT/);
  actual[0] = { ...s.pads[0] }; delete actual[0].bbox;
  assert.throws(() => assemblyRuntime(c, s.components, actual), /INVALID_ASSEMBLY_RUNTIME_BOX/);
  actual[0] = { ...s.pads[0], owner: 'B' };
  assert.throws(() => assemblyRuntime(c, s.components, actual), /ASSEMBLY_PAD_OWNER_MISMATCH/);
});

test('explicit pad ownership is authoritative while unknown owners and changed readback ownership are rejected', () => {
  const s = snapshot(part('A'), part('B', 40));
  s.pads[0].owner = 'B';
  const compiled = compileAssemblyPolicy(s, input());
  assert.equal(compiled.pads[0].owner, 'B', 'an old native-id prefix must not override explicit ownership');
  const opaque = structuredClone(s); opaque.pads[0].id = 'opaque-provider-pad';
  assert.equal(compileAssemblyPolicy(opaque, input()).pads[0].owner, 'B');
  opaque.pads[0].owner = 'MISSING';
  assert.throws(() => compileAssemblyPolicy(opaque, input()), /UNKNOWN_ASSEMBLY_PAD_OWNER/);
  const changed = structuredClone(s.pads); changed[0].owner = 'A';
  assert.throws(() => assemblyRuntime(compiled, s.components, changed), /ASSEMBLY_PAD_OWNER_MISMATCH/);
});

test('assembly requires observed ownership and never recovers it from matching object-id prefixes', () => {
  const a = part('A'), b = part('B', 40); a.id = 'c'; b.id = 'c1';
  const s = snapshot(a, b); delete s.pads[0].owner;
  assert.throws(() => compileAssemblyPolicy(s, input()), /PAD_OWNERSHIP_REQUIRED/);
  s.pads[0].parentComponentId = a.id;
  const compiled = compileAssemblyPolicy(s, input());
  assert.deepEqual(compiled.pads.map(p => p.owner), ['A', 'B']);
});

test('runtime can be injected into an isolated native context without module closures', () => {
  const s = snapshot(part('A'), part('B', 40)); s.pads.push(bare());
  const c = compileAssemblyPolicy(s, input());
  const nativeRuntime = vm.runInNewContext('(' + assemblyRuntime.toString() + ')');
  const nativeResult = nativeRuntime(JSON.parse(JSON.stringify(c)), s.components, s.pads);
  assert.deepEqual(JSON.parse(JSON.stringify(nativeResult)), evaluateAssemblyPolicy(c, s.components, s.pads));
});

test('absolute and pair physical floors are independent of courtyard and never discounted', () => {
  const s = snapshot(part('A'), part('B', 35));
  const c = compileAssemblyPolicy(s, input());
  assert.equal(assemblyRuntime(c, poses(s)).valid, true);
  c.absoluteFloorMil = 26;
  let result = assemblyRuntime(c, poses(s));
  assert.deepEqual(result.issues.map(i => i.code), ['ASSEMBLY_PHYSICAL_CLEARANCE']);
  assert.equal(result.issues[0].gapMil, 25);
  c.absoluteFloorMil = 8; c.pairClearancesMil = [{ a: 'A', b: 'B', hardMinMil: 30 }];
  result = assemblyRuntime(c, poses(s));
  assert.equal(result.issues[0].hardMinMil, 30);
  c.pairClearancesMil.push({ a: 'B', b: 'A', hardMinMil: 20 });
  assert.throws(() => assemblyRuntime(c, poses(s)), /DUPLICATE_ASSEMBLY_PAIR_CLEARANCE/);
});

test('anisotropic courtyard accepts any separating axis, not merely largest raw gap', () => {
  const s = snapshot(part('A'), part('B', 60, 30));
  const cfg = input(); cfg.rules[0].marginMm = { xMinus: 2.54, xPlus: 2.54, yMinus: 0.254, yPlus: 0.254 };
  const c = compileAssemblyPolicy(s, cfg);
  const result = assemblyRuntime(c, poses(s));
  assert.equal(result.valid, true, 'Y courts touch even though X gap is bigger but insufficient');
});

test('courtyard and explicit physical floor must pass on the same separating axis', () => {
  const s = snapshot(part('A'), part('B', 20, 30));
  const cfg = input(); cfg.rules[0].marginMm = { xMinus: 0, xPlus: 0, yMinus: 2.54, yPlus: 2.54 };
  const c = compileAssemblyPolicy(s, cfg);
  assert.equal(assemblyRuntime(c, poses(s)).valid, true);
  c.absoluteFloorMil = 15;
  const result = assemblyRuntime(c, poses(s));
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map(i => i.code), ['ASSEMBLY_DIRECTIONAL_CLEARANCE']);
  const moved = poses(s); moved[1].x += 5;
  assert.equal(assemblyRuntime(c, moved).valid, true);
});
