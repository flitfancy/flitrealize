import test from 'node:test';
import assert from 'node:assert/strict';
import { compileEdgeDomains, decodeEdgePose } from '../scripts/pcb-layout/pcb-layout-edge-domain.mjs';
import { compileEdgeRules, checkEdges } from '../scripts/pcb-layout/pcb-layout-edge.mjs';
import { transformBox } from '../scripts/pcb-layout/pcb-layout-geometry.mjs';

const rotations = [0, 90, 180, 270];
const envelope = { minX: -100, maxX: 100, minY: -100, maxY: 100 };
function part(rotation = 0, x = 0, y = 0) {
  const pose = { ref: 'J5', x, y, rotation };
  return { ...pose, bbox: transformBox({ minX: -30, maxX: 50, minY: -4, maxY: 16 }, { x: 0, y: 0, rotation: 0 }, pose) };
}
function domain(rule = {}, component = part(), allowed = rotations, fixed = false) {
  const components = new Map([[component.ref, component]]);
  const rules = compileEdgeRules([{ ref: component.ref, ...rule }], components);
  return compileEdgeDomains(rules, components, new Map([[component.ref, allowed]]), new Map(fixed ? [[component.ref, component]] : [])).get(component.ref);
}
function body(state, pose) {
  const o = state.bodyOffset;
  return { minX: pose.x + o.minX, maxX: pose.x + o.maxX, minY: pose.y + o.minY, maxY: pose.y + o.maxY };
}

test('edge domains contain only legal long/short-side states at all four edges', () => {
  for (const alignment of ['long-side', 'short-side']) {
    const d = domain({ alignment });
    assert.equal(d.status, 'ready');
    assert.equal(d.states.length, 8);
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const states = d.states.filter(s => s.side === side);
      assert.equal(states.length, 2);
      for (const state of states) {
        const horizontal = state.rotation % 180 === 0;
        assert.equal(['top', 'bottom'].includes(side), horizontal === (alignment === 'long-side'));
        const decoded = decodeEdgePose(d, state, envelope, { alongMil: 0 });
        assert.ok(decoded);
        const checked = checkEdges([d.rule], [{ ...decoded.pose, body: body(state, decoded.pose) }, { ref: 'extent', rotation: 0, body: envelope }]);
        assert.deepEqual(checked.issues, []);
        assert.equal(checked.details[0].side, side);
        assert.equal(decoded.parameters.insetMil, 0);
      }
    }
  }
});

test('outward and side/rotation restrictions intersect during compilation', () => {
  const d = domain({ alignment: 'long-side', outwardAtRotation0: 'top' });
  assert.deepEqual(d.states.map(s => [s.side, s.rotation]), [['top', 0], ['right', 90], ['bottom', 180], ['left', 270]]);
  const limited = domain({ alignment: 'long-side', sides: ['left', 'top'], outwardAtRotation0: 'top' }, part(), [0, 90, 180]);
  assert.deepEqual(limited.states.map(s => [s.side, s.rotation]), [['top', 0]]);
  assert.throws(() => decodeEdgePose(limited, { id: 'left:0', side: 'left', rotation: 0 }, envelope), /EDGE_DOMAIN_ILLEGAL_STATE/);
});

test('canonical body offsets and decoded poses do not depend on source pose', () => {
  const rule = { alignment: 'long-side', outwardAtRotation0: 'top' };
  const expected = domain(rule);
  for (const rotation of [0, 90, 180, 270, -90]) {
    const actual = domain(rule, part(rotation, 800, -900), [270, 0, 90, 180]);
    for (const state of actual.states) {
      const original = expected.states.find(s => s.id === state.id);
      assert.deepEqual(state, original);
      assert.deepEqual(decodeEdgePose(actual, state, envelope, { alongMil: 12 }), decodeEdgePose(expected, original, envelope, { alongMil: 12 }));
    }
  }
});

test('free angles normalize while fixed floating metadata is retained exactly', () => {
  const source = { ...part(270, -96, 0), rotation: -90.00000000000001 };
  const free = domain({ alignment: 'long-side', sides: ['left'] }, source, [-90.00000000000001]);
  assert.equal(free.states[0].rotation, 270);
  const fixed = domain({ alignment: 'long-side', sides: ['left'] }, source, [-90.00000000000001], true);
  assert.equal(fixed.states[0].rotation, source.rotation);
  const decoded = decodeEdgePose(fixed, fixed.states[0], envelope, { alongMil: 70 });
  assert.ok(decoded);
  assert.deepEqual(decoded.pose, { ref: 'J5', x: source.x, y: source.y, rotation: source.rotation });
});

test('along-edge coordinates clamp to physical body extent and asymmetric origin', () => {
  const d = domain({ alignment: 'long-side', sides: ['top'] }, part(), [0]);
  const s = d.states[0];
  const low = decodeEdgePose(d, s, envelope, { alongMil: -1000 });
  const high = decodeEdgePose(d, s, envelope, { alongMil: 1000 });
  assert.deepEqual(low.interval, { min: -70, max: 50 });
  assert.equal(low.pose.x, -70);
  assert.equal(high.pose.x, 50);
  assert.equal(low.pose.y, -96);
  assert.equal(decodeEdgePose(d, s, envelope).pose.x, -10);
});

test('Manhattan anchor limit intersects the along-edge interval without hiding infeasibility', () => {
  const d = domain({ alignment: 'long-side', sides: ['top'] }, part(), [0]), state = d.states[0];
  const limited = decodeEdgePose(d, state, envelope, { alongMil: 1000, anchorCenter: { x: 10, y: -80 }, maxDistanceMil: 26 });
  assert.deepEqual(limited.interval, { min: 0, max: 20 });
  assert.equal(limited.pose.x, 20);
  assert.equal(decodeEdgePose(d, state, envelope, { anchorCenter: { x: 0, y: 0 }, maxDistanceMil: 80 }), null);
  assert.equal(decodeEdgePose(d, state, envelope, { anchorCenter: { x: 300, y: -96 }, maxDistanceMil: 10 }), null);
  const point = decodeEdgePose(d, state, envelope, { anchorCenter: { x: 30, y: -80 }, maxDistanceMil: 16 });
  assert.deepEqual(point.interval, { min: 30, max: 30 });
});

test('too short or shallow temporary envelopes return null, including inset consumption', () => {
  const d = domain({ alignment: 'long-side', sides: ['top'], maxInsetMil: 10 }, part(), [0]), s = d.states[0];
  assert.equal(decodeEdgePose(d, s, { minX: 0, maxX: 70, minY: 0, maxY: 100 }), null);
  assert.equal(decodeEdgePose(d, s, { minX: 0, maxX: 100, minY: 0, maxY: 19 }), null);
  assert.equal(decodeEdgePose(d, s, { minX: 0, maxX: 100, minY: 0, maxY: 25 }, { insetMil: 6 }), null);
});

test('inset and changing envelope update the normal coordinate directly on every side', () => {
  const d = domain({ outwardAtRotation0: 'top', maxInsetMil: 8 });
  const larger = { minX: -200, maxX: 220, minY: -300, maxY: 340 };
  for (const state of d.states) {
    for (const e of [envelope, larger]) {
      const decoded = decodeEdgePose(d, state, e, { insetMil: 8, alongMil: 0 });
      const b = body(state, decoded.pose);
      assert.equal(state.normalSign * (e[state.normalKey] - b[state.normalKey]), 8);
      assert.deepEqual(checkEdges([d.rule], [{ ...decoded.pose, body: b }, { ref: 'extent', rotation: 0, body: e }]).issues, []);
    }
  }
});

test('empty static orientation domains remain inspectable and fixed restrictions cannot be overridden', () => {
  const limited = domain({ alignment: 'long-side', sides: ['left'] }, part(), [0, 180]);
  assert.equal(limited.status, 'unsatisfied');
  assert.deepEqual(limited.states, []);
  assert.equal(limited.issue.code, 'EDGE_DOMAIN_EMPTY');
  const locked = domain({ alignment: 'long-side', sides: ['left'] }, part(), rotations, true);
  assert.equal(locked.status, 'unsatisfied');
  assert.deepEqual(locked.states, []);
  assert.equal(domain({}, part(), []).status, 'unsatisfied');
});

test('fixed domains return only legal original pose and never clamp position', () => {
  const source = part(0, 10, -91);
  const d = domain({ alignment: 'long-side', sides: ['top'], maxInsetMil: 5 }, source, rotations, true), s = d.states[0];
  const decoded = decodeEdgePose(d, s, envelope, { alongMil: -1000 });
  assert.deepEqual(decoded.pose, { ref: 'J5', x: 10, y: -91, rotation: 0 });
  assert.equal(decoded.parameters.insetMil, 5);
  assert.equal(decodeEdgePose(d, s, { ...envelope, minY: -110 }), null);
  assert.equal(decodeEdgePose(d, s, { ...envelope, maxX: 40 }), null);
  assert.equal(decodeEdgePose(d, s, envelope, { anchorCenter: { x: 0, y: 0 }, maxDistanceMil: 30 }), null);
  const interior = domain({ alignment: 'long-side', sides: ['top'] }, part(), rotations, true);
  assert.equal(decodeEdgePose(interior, interior.states[0], envelope), null);
});

test('invalid state, numbers, geometry and incomplete anchor pairs are explicit errors', () => {
  const d = domain(), s = d.states[0];
  for (const options of [{ alongMil: NaN }, { alongMil: Infinity }, { insetMil: -1 }, { insetMil: 1 }]) assert.throws(() => decodeEdgePose(d, s, envelope, options), /EDGE_DOMAIN_INVALID_PARAMETERS/);
  for (const options of [{ anchorCenter: { x: 0, y: 0 } }, { maxDistanceMil: 1 }, { anchorCenter: { x: 0, y: 0 }, maxDistanceMil: -1 }, { anchorCenter: { x: 0, y: NaN }, maxDistanceMil: 10 }]) assert.throws(() => decodeEdgePose(d, s, envelope, options), /EDGE_DOMAIN_INVALID_ANCHOR/);
  assert.throws(() => decodeEdgePose(d, undefined, envelope), /EDGE_DOMAIN_ILLEGAL_STATE/);
  assert.throws(() => decodeEdgePose(d, s, { ...envelope, maxX: NaN }), /EDGE_DOMAIN_INVALID_ENVELOPE/);
  assert.throws(() => decodeEdgePose(d, s, { ...envelope, maxX: -100 }), /EDGE_DOMAIN_INVALID_ENVELOPE/);
  assert.throws(() => domain({}, part(), [45]), /EDGE_DOMAIN_INVALID_ROTATION/);
  assert.throws(() => domain({}, { ...part(), bbox: null }), /INVALID_EDGE_DOMAIN_COMPONENT/);
});

test('cached states and body offsets cannot be modified by proposals or decode', () => {
  const d = domain(), state = d.states[0], before = structuredClone(d);
  assert.throws(() => { state.rotation = 90; }, TypeError);
  assert.throws(() => { state.bodyOffset.minX = -1000; }, TypeError);
  const forgedOffset = { ...state, bodyOffset: { minX: -1000, maxX: 1000, minY: -1000, maxY: 1000 } };
  assert.deepEqual(decodeEdgePose(d, forgedOffset, envelope), decodeEdgePose(d, state, envelope));
  assert.deepEqual(d, before);
});
