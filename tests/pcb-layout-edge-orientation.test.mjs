import test from 'node:test';
import assert from 'node:assert/strict';
import { compileEdgeRules, availableEdges, checkEdges, projectEdges } from '../scripts/pcb-layout/pcb-layout-edge.mjs';
import { transformBox } from '../scripts/pcb-layout/pcb-layout-geometry.mjs';

const allSides = ['left', 'right', 'top', 'bottom'];
function part(ref = 'J5', rotation = 0, width = 80, height = 20) {
  const zero = { ref, x: 0, y: 0, rotation: 0 };
  const bbox = transformBox({ minX: -width / 2, maxX: width / 2, minY: -height / 2, maxY: height / 2 }, zero, { ...zero, rotation });
  return { ...zero, rotation, bbox };
}
function compile(rule, c = part()) { return compileEdgeRules([{ ref: c.ref, ...rule }], new Map([[c.ref, c]]))[0]; }
function withBody(source, pose = source) { return { ...pose, body: transformBox(source.bbox, source, pose) }; }
function model(rule, allowedRotations = [0, 90, 180, 270], fixed = false) {
  const j = part(), u = part('U1', 0, 200, 200), components = new Map([[j.ref, j], [u.ref, u]]);
  return { components, edgeRules: compileEdgeRules([{ ref: j.ref, ...rule }], components), fixed: new Map(fixed ? [[j.ref, j]] : []), allowedRotations: new Map([[j.ref, allowedRotations], [u.ref, [0]]]) };
}

test('long and short side alignment use the corresponding side at every quarter turn', () => {
  for (const alignment of ['long-side', 'short-side']) {
    const rule = compile({ alignment });
    for (const rotation of [0, 90, 180, 270]) {
      const horizontal = (rotation % 180 === 0) === (alignment === 'long-side');
      const expected = horizontal ? ['top', 'bottom'] : ['left', 'right'];
      assert.deepEqual(availableEdges(rule, rotation), expected);
      for (const side of allSides) assert.deepEqual(availableEdges({ ...rule, sides: [side] }, rotation), expected.includes(side) ? [side] : []);
    }
  }
});

test('alignment is invariant to the source snapshot rotation and ignores label geometry', () => {
  for (const [width, height, axis] of [[80, 20, 'x'], [20, 80, 'y']]) {
    const reference = compile({ alignment: 'long-side' }, part('J5', 0, width, height));
    for (const sourceRotation of [0, 90, 180, 270, -90]) {
      const c = { ...part('J5', sourceRotation, width, height), label: { bbox: { minX: -1e6, maxX: 1e6, minY: -1, maxY: 1 } } };
      const rule = compile({ alignment: 'long-side' }, c);
      assert.equal(rule.longAxisAtRotation0, axis);
      for (const targetRotation of [0, 90, 180, 270]) assert.deepEqual(availableEdges(rule, targetRotation), availableEdges(reference, targetRotation));
    }
  }
  const noisy = { ...part('J5', 270), rotation: -90.00000000000001 };
  assert.deepEqual(availableEdges(compile({ alignment: 'long-side' }, noisy), noisy.rotation), ['left', 'right']);
});

test('outward direction and alignment must both be satisfied', () => {
  const rule = compile({ alignment: 'long-side', outwardAtRotation0: 'top' });
  for (const [rotation, side] of [[0, 'top'], [90, 'right'], [180, 'bottom'], [270, 'left']]) assert.deepEqual(availableEdges(rule, rotation), [side]);
  const short = compile({ alignment: 'short-side', outwardAtRotation0: 'left' });
  for (const [rotation, side] of [[0, 'left'], [90, 'top'], [180, 'right'], [270, 'bottom']]) assert.deepEqual(availableEdges(short, rotation), [side]);
  assert.throws(() => compile({ alignment: 'long-side', outwardAtRotation0: 'left' }), /EDGE_ORIENTATION_CONFLICT J5/);
});

test('invalid alignment, missing or degenerate geometry, and ambiguous squares fail explicitly', () => {
  for (const alignment of ['horizontal', 'any', '', null, false]) assert.throws(() => compile({ alignment }), /INVALID_EDGE_RULE/);
  assert.throws(() => compile({ alignment: 'long-side' }, { ref: 'J5', rotation: 0 }), /EDGE_ALIGNMENT_MISSING_GEOMETRY/);
  assert.throws(() => compile({ alignment: 'short-side' }, part('J5', 0, 0, 20)), /EDGE_ALIGNMENT_INVALID_GEOMETRY/);
  for (const alignment of ['long-side', 'short-side']) assert.throws(() => compile({ alignment }, part('J5', 90, 20, 20)), /EDGE_ALIGNMENT_AMBIGUOUS_SHAPE/);
  assert.throws(() => compile({ alignment: 'long-side' }, { ...part(), rotation: 45 }), /EDGE_ALIGNMENT_INVALID_ROTATION/);
  assert.throws(() => compile({ alignment: 'long-side' }, { ...part(), bbox: { minX: NaN, maxX: 20, minY: 0, maxY: 10 } }), /EDGE_ALIGNMENT_MISSING_GEOMETRY/);
  assert.throws(() => availableEdges({ alignment: 'long-side', sides: allSides }, 0), /EDGE_ALIGNMENT_NOT_COMPILED/);
  // Existing edge-only declarations do not require an orientation or bbox.
  assert.deepEqual(availableEdges(compile({}, { ref: 'J5' }), 0), allSides);
  assert.deepEqual(compileEdgeRules([{ ref: 'J5', onEdge: false, alignment: 'long-side' }], new Map()), []);
});

test('a connector touching the envelope with its short side fails a long-side requirement', () => {
  const source = part(), other = part('U1', 0, 200, 200), rule = compile({ alignment: 'long-side' }, source);
  const wrong = withBody(source, { ...source, x: -60 });
  assert.equal(wrong.body.minX, -100);
  const rejected = checkEdges([rule], [wrong, withBody(other)]);
  assert.equal(rejected.issues[0].code, 'EDGE_CONSTRAINT_UNSATISFIED');
  assert.equal(rejected.details[0].alignment, 'long-side');
  const right = withBody(source, { ...source, x: -90, rotation: 90 });
  const accepted = checkEdges([rule], [right, withBody(other)]);
  assert.equal(accepted.issues.length, 0);
  assert.equal(accepted.details[0].side, 'left');
});

test('explicit edge projections choose compliant allowed rotations for all four sides', () => {
  for (const alignment of ['long-side', 'short-side']) {
    const m = model({ alignment });
    const positions = [...m.components.values()], before = structuredClone(positions);
    for (const side of allSides) {
      const projected = projectEdges(m, positions, { J5: side });
      const j = projected.find(p => p.ref === 'J5');
      assert.ok(availableEdges(m.edgeRules[0], j.rotation).includes(side));
      const checked = checkEdges(m.edgeRules, projected.map(p => withBody(m.components.get(p.ref), p)));
      assert.equal(checked.issues.length, 0);
      assert.equal(checked.details[0].side, side);
    }
    assert.deepEqual(positions, before);
  }
  const m = model({ alignment: 'long-side', outwardAtRotation0: 'top' });
  const projected = projectEdges(m, [...m.components.values()], { J5: 'left' });
  assert.equal(projected.find(p => p.ref === 'J5').rotation, 270);
});

test('ordinary projection retains the proposed rotation and does not invent an explicit edge', () => {
  const m = model({ alignment: 'long-side' });
  const positions = [...m.components.values()].map(p => p.ref === 'J5' ? { ...p, rotation: 90 } : p);
  const projected = projectEdges(m, positions);
  assert.equal(projected.find(p => p.ref === 'J5').rotation, 90);
  const checked = checkEdges(m.edgeRules, projected.map(p => withBody(m.components.get(p.ref), p)));
  assert.equal(checked.issues.length, 0);
  assert.ok(['left', 'right'].includes(checked.details[0].side));
});

test('fixed and rotation-limited orientation conflicts stay invalid without silently rotating', () => {
  for (const m of [model({ alignment: 'long-side', sides: ['left'] }, [0, 90, 180, 270], true), model({ alignment: 'long-side', sides: ['left'] }, [0, 180])]) {
    const positions = [...m.components.values()], before = structuredClone(positions);
    const projected = projectEdges(m, positions, { J5: 'left' });
    assert.deepEqual(projected, before);
    assert.deepEqual(positions, before);
    const checked = checkEdges(m.edgeRules, projected.map(p => withBody(m.components.get(p.ref), p)));
    assert.equal(checked.issues[0].code, 'EDGE_CONSTRAINT_UNSATISFIED');
  }
});
