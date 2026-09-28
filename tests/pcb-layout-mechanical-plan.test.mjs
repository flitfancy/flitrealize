import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlan } from '../scripts/pcb-layout/pcb-layout-mechanical-plan.mjs';

const rules = { clearanceMil: 8, lockedDesignators: [], localSearchMaxComponents: 6, localSearchMaxNodes: 4096 };
const rect = (x, y, w, h) => ({ minX: x - w / 2, maxX: x + w / 2, minY: y - h / 2, maxY: y + h / 2 });
function fixture(specs, testPads = []) {
  const snapshot = { source: 'fixture', sourceHash: 0, components: [], items: [], pads: [] };
  for (const { ref, x = 0, y = 0, w = 20, h = 20, side = 'bottom', locked = false } of specs) {
    const id = 'component:' + ref + ':', body = rect(x, y, w, h), rotation = ['left', 'right'].includes(side) ? 90 : 0;
    const tx = side === 'left' ? x - w / 2 - 15 : side === 'right' ? x + w / 2 + 15 : x;
    const ty = side === 'top' ? y - h / 2 - 15 : side === 'bottom' ? y + h / 2 + 15 : y;
    const bbox = rect(tx, ty, rotation ? 10 : 20, rotation ? 20 : 10);
    snapshot.components.push({ id, ref, x, y, rotation: 0, locked, bbox: body, footprint: { name: 'generic' } });
    snapshot.pads.push({ id: id + 'pad1', owner: ref, x, y, number: '1', net: 'N_' + ref, bbox: body });
    snapshot.items.push({ id: id + 'ref', parentId: id, owner: ref, type: 'attribute', text: ref, width: 20, height: 10, fontSize: 10, lineWidth: 1, original: { x: rotation ? bbox.maxX : bbox.minX, y: bbox.minY, rotation, alignMode: 3, bbox } });
  }
  snapshot.pads.push(...testPads.map((p, i) => ({ id: 'tp:' + i, owner: null, number: 'TP' + i, net: 'GND', x: p.x, y: p.y, locked: !!p.locked, bbox: rect(p.x, p.y, 10, 10) })));
  return snapshot;
}
function checkGeometry(plan) {
  assert.equal(plan.status, 'planned');
  for (let i = 0; i < plan.bundles.length; i++) for (let j = i + 1; j < plan.bundles.length; j++) {
    const a = plan.bundles[i].bbox, b = plan.bundles[j].bbox;
    const distance = Math.max(a.minX - b.maxX, b.minX - a.maxX, a.minY - b.maxY, b.minY - a.maxY);
    assert.ok(distance >= 8, plan.bundles[i].ref + '/' + plan.bundles[j].ref + ': ' + distance);
  }
}

test('preserves exact current offsets, alignment and unrelated labels without a search', () => {
  const s = fixture([{ ref: 'U1', side: 'top' }, { ref: 'U2', x: 200, side: 'right' }]);
  s.items[0].original.alignMode = 1;
  s.items[0].original.x += 2.75;
  const original = structuredClone(s), plan = makePlan(s, rules);
  checkGeometry(plan);
  assert.equal(plan.counts.labelsChanged, 0);
  assert.equal(plan.counts.moved, 0);
  assert.equal(plan.search.labelRepairAttempts, 0);
  for (const l of plan.labels) {
    const before = s.items.find(t => t.id === l.id);
    assert.equal(l.x, before.original.x);
    assert.equal(l.alignMode, before.original.alignMode);
    assert.equal(l.parentId, before.parentId);
  }
  assert.deepEqual(s, original);
  assert.deepEqual(makePlan(s, rules), plan);
});

test('changes the earlier large component label before displacing the later body', () => {
  const s = fixture([{ ref: 'U1', w: 60, side: 'right' }, { ref: 'U2', x: 60 }, { ref: 'U3', x: 400, side: 'top' }]);
  const p = makePlan(s, rules);
  checkGeometry(p);
  assert.equal(p.counts.moved, 0);
  assert.equal(p.components.find(c => c.ref === 'U1').side, 'bottom');
  assert.equal(p.labels.find(l => l.owner === 'U3').changed, false);
});

test('jointly changes both facing labels when changing either one alone cannot work', () => {
  const s = fixture([{ ref: 'U1', side: 'right' }, { ref: 'U2', x: 40, side: 'left' }]);
  const p = makePlan(s, rules);
  checkGeometry(p);
  assert.equal(p.counts.moved, 0);
  assert.equal(p.counts.labelSidesChanged, 2);
  assert.ok(p.search.labelRepairSuccesses > 0);
});

test('only falls back to moving bodies when body clearance cannot be fixed by labels', () => {
  const p = makePlan(fixture([{ ref: 'U1', w: 40, locked: true }, { ref: 'U2', x: 10 }]), rules);
  checkGeometry(p);
  assert.equal(p.components.find(c => c.ref === 'U1').dx, 0);
  assert.equal(p.counts.moved, 1);
  assert.equal(p.search.componentFallbacks, 1);
});

test('reports the actual locked conflict and retains all components in the plan', () => {
  const p = makePlan(fixture([{ ref: 'J5' }, { ref: 'U2', x: 5, locked: true }, { ref: 'U3', x: 200 }]), { ...rules, lockedDesignators: ['J5'] });
  assert.equal(p.status, 'planned-with-issues');
  assert.equal(p.counts.components, 3);
  assert.equal(p.counts.moved, 0);
  assert.deepEqual(p.issues, [{ code: 'MIN_CLEARANCE_UNSATISFIED', refs: ['J5', 'U2'] }]);
  assert.equal(p.labels.find(l => l.owner === 'U3').changed, false);
});

test('an omitted lock list does not implicitly fix J5 while native locks remain fixed', () => {
  const config = { ...rules }; delete config.lockedDesignators;
  const p = makePlan(fixture([{ ref: 'J5' }, { ref: 'U2', x: 5, locked: true }]), config);
  checkGeometry(p);
  assert.notEqual(p.components.find(c => c.ref === 'J5').dx, 0);
  assert.equal(p.components.find(c => c.ref === 'U2').dx, 0);
  assert.equal(p.components.find(c => c.ref === 'U2').dy, 0);
});

test('tries moving the label before moving an independent test pad', () => {
  const p = makePlan(fixture([{ ref: 'U1', side: 'right' }], [{ x: 35, y: 0 }]), rules);
  checkGeometry(p);
  assert.equal(p.counts.moved, 0);
  assert.equal(p.counts.testPadsMoved, 0);
  assert.equal(p.counts.labelSidesChanged, 1);
});

test('explicit import initialization chooses the vertical template first', () => {
  const s = fixture([{ ref: 'F1', h: 60, side: 'bottom' }]);
  const p = makePlan(s, { ...rules, initializeLabels: true });
  checkGeometry(p);
  assert.equal(p.components[0].side, 'left');
  assert.equal(p.labels[0].rotation, 90);
  assert.equal(p.counts.moved, 0);
  assert.equal(p.counts.labelsChanged, 1);
});

test('a bounded search can fall back without exposing tentative label assignments', () => {
  const s = fixture([{ ref: 'U1', side: 'right' }, { ref: 'U2', x: 40, side: 'left' }]);
  const original = structuredClone(s), p = makePlan(s, { ...rules, localSearchMaxNodes: 1 });
  checkGeometry(p);
  assert.ok(p.search.searchLimitHits > 0);
  assert.ok(p.counts.moved > 0);
  assert.deepEqual(s, original);
});

test('a preferred side is a soft proposal: conflict repair tries other sides before moving bodies', () => {
  const s = fixture([{ ref: 'U1', side: 'left' }, { ref: 'U2', x: 40, side: 'right' }]);
  const p = makePlan(s, { ...rules, preferredLabelSides: { U1: 'right' } });
  checkGeometry(p);
  assert.equal(p.counts.moved, 0);
  assert.notEqual(p.components.find(c => c.ref === 'U1').side, 'right');
  assert.throws(() => makePlan(s, { ...rules, preferredLabelSides: { U1: 'middle' } }), /INVALID_LABEL_SIDE/);
});

const bundleGap = (plan, a, b) => {
  const aa = plan.bundles.find(entry => entry.ref === a).bbox, bb = plan.bundles.find(entry => entry.ref === b).bbox;
  return Math.max(aa.minX - bb.maxX, bb.minX - aa.maxX, aa.minY - bb.maxY, bb.minY - aa.maxY);
};

test('pair clearance applies only to its selected pair and remains visible when relocation is unavailable', () => {
  const s = fixture([{ ref: 'U1', locked: true }, { ref: 'U2', x: 40, locked: true }, { ref: 'U3', x: -30, locked: true }]);
  const p = makePlan(s, { ...rules, pairClearancesMil: [{ a: 'U1', b: 'U2', hardMinMil: 30 }] });
  assert.equal(p.status, 'planned-with-issues');
  assert.deepEqual(p.issues, [{ code: 'MIN_CLEARANCE_UNSATISFIED', refs: ['U1', 'U2'] }]);
  assert.equal(bundleGap(p, 'U1', 'U3'), 10);
  assert.equal(bundleGap(p, 'U1', 'U2'), 20);
  assert.equal(p.counts.moved, 0);
  assert.deepEqual(p.pairClearancesMil, [{ a: 'U1', b: 'U2', hardMinMil: 30 }]);
  const repaired = makePlan(s, { ...rules, lockedDesignators: ['U1', 'U3'], pairClearancesMil: p.pairClearancesMil, maxRelocationMil: 60 });
  assert.equal(repaired.status, 'planned-with-issues');
  // Native locks still prevail over pair-specific spacing requirements.
  assert.equal(repaired.counts.moved, 0);
  s.components.find(c => c.ref === 'U2').locked = false;
  const moved = makePlan(s, { ...rules, pairClearancesMil: p.pairClearancesMil, maxRelocationMil: 60, relocatableRefs: ['U2'] });
  checkGeometry(moved);
  assert.ok(bundleGap(moved, 'U1', 'U2') >= 30);
  assert.equal(bundleGap(moved, 'U1', 'U3'), 10);
  assert.equal(moved.counts.moved, 1);
  for (const entry of moved.bundles) assert.deepEqual(Object.keys(entry.bbox).sort(), ['maxX', 'maxY', 'minX', 'minY']);
});

test('pair-specific clearance repairs labels first without increasing the label-to-body template gap', () => {
  const s = fixture([{ ref: 'U1', w: 60, side: 'right' }, { ref: 'U2', x: 80 }]);
  const p = makePlan(s, { ...rules, pairClearancesMil: [{ a: 'U2', b: 'U1', hardMinMil: 30 }] });
  checkGeometry(p);
  assert.equal(p.counts.moved, 0);
  assert.ok(p.search.labelRepairSuccesses > 0);
  assert.ok(bundleGap(p, 'U1', 'U2') >= 30);
  const component = p.components.find(c => c.ref === 'U1'), label = p.labels.find(l => l.owner === 'U1');
  assert.equal(component.side, 'bottom');
  assert.equal(label.bbox.minY - component.body.maxY, 10);

  const isolated = fixture([{ ref: 'U1' }, { ref: 'U2', x: 300 }]);
  const base = makePlan(isolated, { ...rules, initializeLabels: true });
  const extended = makePlan(isolated, { ...rules, initializeLabels: true, pairClearancesMil: [{ a: 'U1', b: 'U2', hardMinMil: 90 }] });
  assert.deepEqual(extended.labels, base.labels);
});

test('independent test pads participate in both label-first and relocation pair clearance checks', () => {
  const labelFirst = makePlan(fixture([{ ref: 'U1', side: 'right' }], [{ x: 55, y: 0 }]), {
    ...rules, pairClearancesMil: [{ a: 'U1', b: 'TP0', hardMinMil: 30 }]
  });
  checkGeometry(labelFirst);
  assert.equal(labelFirst.counts.moved, 0);
  assert.equal(labelFirst.counts.testPadsMoved, 0);
  assert.equal(labelFirst.counts.labelSidesChanged, 1);
  assert.ok(bundleGap(labelFirst, 'U1', 'TP0') >= 30);

  const relocated = makePlan(fixture([{ ref: 'U1', locked: true }], [{ x: 20, y: 0 }]), {
    ...rules, pairClearancesMil: [{ a: 'TP0', b: 'U1', hardMinMil: 40 }], maxRelocationMil: 80
  });
  checkGeometry(relocated);
  assert.equal(relocated.counts.moved, 0);
  assert.equal(relocated.counts.testPadsMoved, 1);
  assert.ok(bundleGap(relocated, 'U1', 'TP0') >= 40);

  const padPair = makePlan(fixture([], [{ x: 0, y: 0, locked: true }, { x: 30, y: 0, locked: true }]), {
    ...rules, pairClearancesMil: [{ a: 'TP1', b: 'TP0', hardMinMil: 30 }]
  });
  assert.deepEqual(padPair.issues, [{ code: 'MIN_CLEARANCE_UNSATISFIED', refs: ['TP0', 'TP1'] }]);
});

test('an omitted or empty pair list is unchanged and a smaller pair clearance cannot relax the global floor', () => {
  const s = fixture([{ ref: 'U1', side: 'right' }, { ref: 'U2', x: 40, side: 'left' }]);
  const base = makePlan(s, rules), empty = makePlan(s, { ...rules, pairClearancesMil: [] });
  assert.deepEqual(empty, base);
  const lower = makePlan(s, { ...rules, pairClearancesMil: [{ a: 'U1', b: 'U2', hardMinMil: 0 }] });
  const { pairClearancesMil, ...withoutPairReceipt } = lower;
  assert.deepEqual(withoutPairReceipt, base);
});

test('rejects malformed, ambiguous or unknown pair clearance inputs before planning', () => {
  const s = fixture([{ ref: 'U1' }, { ref: 'U2', x: 100 }]);
  const valid = { a: 'U1', b: 'U2', hardMinMil: 30 };
  const invalid = [
    null, {}, [null], [[]], [{ ...valid, extra: 1 }], [{ a: 'U1', b: 'U2' }],
    [{ ...valid, a: '' }], [{ ...valid, a: 1 }], [{ ...valid, b: 'U1' }], [{ ...valid, b: 'U3' }],
    [{ ...valid, hardMinMil: -1 }], [{ ...valid, hardMinMil: NaN }], [{ ...valid, hardMinMil: Infinity }],
    [{ ...valid, hardMinMil: '30' }], [valid, { a: 'U2', b: 'U1', hardMinMil: 40 }]
  ];
  const before = structuredClone(s);
  for (const pairClearancesMil of invalid) assert.throws(() => makePlan(s, { ...rules, pairClearancesMil }), /PAIR_CLEARANCE/);
  assert.deepEqual(s, before);
});
