import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlan } from '../scripts/pcb-layout/pcb-layout-mechanical-plan.mjs';
import { compileAssemblyPolicy, assemblyRuntime } from '../scripts/pcb-layout/pcb-layout-assembly-policy.mjs';

const box = (x, y, w = 20, h = 20) => ({ minX: x - w / 2, maxX: x + w / 2, minY: y - h / 2, maxY: y + h / 2 });
const shift = (b, x, y) => ({ minX: b.minX + x, maxX: b.maxX + x, minY: b.minY + y, maxY: b.maxY + y });
function fixture(specs, testPads = []) {
  const snapshot = { source: 'axis-fixture', sourceHash: 0, components: [], pads: [], items: [] };
  for (const { ref, x = 0, y = 0, w = 20, h = 20, locked = false, side = 'bottom' } of specs) {
    const id = ref + ':', bbox = box(x, y, w, h);
    const label = side === 'right' ? box(x + w / 2 + 15, y, 10, 20)
      : side === 'left' ? box(x - w / 2 - 15, y, 10, 20) : box(x, y + h / 2 + 15, 20, 10);
    const rotation = ['left', 'right'].includes(side) ? 90 : 0;
    snapshot.components.push({ id, ref, x, y, rotation: 0, locked, bbox, footprint: { name: 'generic' } });
    snapshot.pads.push({ id: id + 'pad', owner: ref, x, y, number: '1', net: 'N', bbox: { ...bbox } });
    snapshot.items.push({ id: id + 'label', parentId: id, owner: ref, type: 'attribute', text: ref, width: 20, height: 10,
      fontSize: 10, lineWidth: 1, original: { x: rotation ? label.maxX : label.minX, y: label.minY, rotation, alignMode: 3, bbox: label } });
  }
  testPads.forEach((p, i) => snapshot.pads.push({ id: 'test:' + i, owner: null, number: 'TP' + i, net: 'N', x: p.x, y: p.y, bbox: box(p.x, p.y, 10, 10) }));
  return snapshot;
}
function rules(snapshot, extra = {}) {
  return { clearanceMil: 8, maxRelocationMil: 50, assemblyPolicy: compileAssemblyPolicy(snapshot, {
    schemaVersion: 1, profile: { id: 'test', label: 'Axis test' }, source: { title: 'Test', url: 'https://example.test' },
    rules: [{ id: 'generic', footprintNames: ['generic'], marginMm: .254 }], overrides: [],
    independentPads: { marginMm: 0, basis: 'Bare test pads' }
  }), ...extra };
}
function verify(snapshot, cfg, plan) {
  assert.equal(plan.status, 'planned');
  const posed = structuredClone(snapshot);
  for (const c of posed.components) {
    const move = plan.components.find(p => p.ref === c.ref);
    c.x = move.x; c.y = move.y; c.bbox = shift(c.bbox, move.dx, move.dy);
    for (const pad of posed.pads.filter(p => p.id.startsWith(c.id))) {
      pad.x += move.dx; pad.y += move.dy; pad.bbox = shift(pad.bbox, move.dx, move.dy);
    }
  }
  for (const p of plan.testPads) {
    const pad = posed.pads.find(q => q.id === p.id);
    pad.x = p.x; pad.y = p.y; pad.bbox = { ...p.bbox };
  }
  assert.deepEqual(assemblyRuntime(cfg.assemblyPolicy, posed.components, posed.pads).issues, []);
  for (let i = 0; i < plan.bundles.length; i++) for (let j = i + 1; j < plan.bundles.length; j++) {
    const a = plan.bundles[i].bbox, b = plan.bundles[j].bbox;
    assert.ok(Math.max(b.minX - a.maxX, a.minX - b.maxX, b.minY - a.maxY, a.minY - b.maxY) >= cfg.clearanceMil);
  }
  assert.equal(Object.hasOwn(plan, 'relocationAxesByRef'), false, 'Repair axes must not become a persistent plan constraint');
}

test('x/y tangent repair preserves the normal coordinate exactly and satisfies assembly and label clearances', () => {
  for (const axis of ['x', 'y']) {
    const snapshot = fixture([{ ref: 'U1', y: 123.456, locked: true }, { ref: 'J5', x: 35, y: 123.456 }]);
    const original = structuredClone(snapshot), cfg = rules(snapshot, { relocationAxesByRef: { J5: axis } });
    const plan = makePlan(snapshot, cfg), before = snapshot.components[1], after = plan.components.find(c => c.ref === 'J5');
    verify(snapshot, cfg, plan);
    const normal = axis === 'x' ? 'y' : 'x';
    assert.equal(after[normal], before[normal]);
    assert.notEqual(after[axis], before[axis]);
    assert.ok(plan.search.axisRestrictedRelocationAttempts > 0);
    assert.ok(plan.search.axisRestrictedOffsetsTried <= 1 + 2 * cfg.maxRelocationMil / 5);
    assert.deepEqual(snapshot, original);
  }
});

test('none still permits label-only repair while preserving both bodies', () => {
  const snapshot = fixture([{ ref: 'J5', side: 'right' }, { ref: 'J6', x: 40, side: 'left' }]);
  const cfg = rules(snapshot, { relocationAxesByRef: { J5: 'none', J6: 'none' } });
  const plan = makePlan(snapshot, cfg);
  verify(snapshot, cfg, plan);
  assert.equal(plan.counts.moved, 0);
  assert.equal(plan.counts.labelSidesChanged, 2);
  assert.ok(plan.search.labelRepairSuccesses > 0);
});

test('tangent restriction reports unresolved conflicts when only normal movement could repair them', () => {
  const snapshot = fixture([{ ref: 'U1', w: 200, locked: true }, { ref: 'J5' }]);
  const cfg = rules(snapshot, { relocationAxesByRef: { J5: 'x' } }), plan = makePlan(snapshot, cfg);
  assert.equal(plan.status, 'planned-with-issues');
  assert.ok(plan.issues.some(i => i.code === 'ASSEMBLY_COURTYARD_OVERLAP'));
  assert.ok(plan.issues.some(i => i.code === 'MIN_CLEARANCE_UNSATISFIED'));
  assert.equal(plan.components.find(c => c.ref === 'J5').x, 0);
  assert.equal(plan.components.find(c => c.ref === 'J5').y, 0);
  assert.equal(plan.search.axisRestrictedOffsetsTried, 1 + 2 * cfg.maxRelocationMil / 5);
  const freeCfg = rules(snapshot), free = makePlan(snapshot, freeCfg);
  verify(snapshot, freeCfg, free);
  assert.notEqual(free.components.find(c => c.ref === 'J5').y, 0);
});

test('none cannot silently relax an assembly or physical pair floor', () => {
  const snapshot = fixture([{ ref: 'U1', locked: true }, { ref: 'J5', x: 45 }]);
  const cfg = rules(snapshot, { relocationAxesByRef: { J5: 'none' } });
  cfg.assemblyPolicy.pairClearancesMil = [{ a: 'U1', b: 'J5', hardMinMil: 40 }];
  const plan = makePlan(snapshot, cfg);
  assert.equal(plan.status, 'planned-with-issues');
  assert.ok(plan.issues.some(i => i.code === 'ASSEMBLY_PHYSICAL_CLEARANCE'));
  assert.equal(plan.counts.moved, 0);
  assert.equal(plan.search.axisRestrictedOffsetsTried, 1);
});

test('native locks, explicit locks and relocatable allowlists take priority over an allowed axis', () => {
  for (const restriction of ['native', 'explicit', 'allowlist']) {
    const snapshot = fixture([{ ref: 'U1', locked: true }, { ref: 'J5', x: 35, locked: restriction === 'native' }]);
    const cfg = rules(snapshot, { relocationAxesByRef: { J5: 'x' },
      ...(restriction === 'explicit' ? { lockedDesignators: ['J5'] } : {}),
      ...(restriction === 'allowlist' ? { relocatableRefs: [] } : {}) });
    const plan = makePlan(snapshot, cfg);
    assert.equal(plan.status, 'planned-with-issues');
    assert.equal(plan.counts.moved, 0);
    assert.equal(plan.search.axisRestrictedRelocationAttempts, 0);
  }
});

test('independent test pad repair also respects a specified tangent axis', () => {
  const snapshot = fixture([{ ref: 'U1', locked: true }], [{ x: 20, y: 0 }]);
  const cfg = rules(snapshot, { relocationAxesByRef: { TP0: 'y' } }), plan = makePlan(snapshot, cfg);
  verify(snapshot, cfg, plan);
  assert.equal(plan.testPads[0].x, 20);
  assert.notEqual(plan.testPads[0].y, 0);
  assert.equal(plan.counts.testPadsMoved, 1);
});

test('omitted and empty axis maps preserve the existing unrestricted result', () => {
  const snapshot = fixture([{ ref: 'U1', locked: true }, { ref: 'J5', x: 5 }]);
  const cfg = rules(snapshot), before = makePlan(snapshot, cfg);
  verify(snapshot, cfg, before);
  assert.deepEqual(makePlan(snapshot, { ...cfg, relocationAxesByRef: {} }), before);
  assert.deepEqual(makePlan(snapshot, { ...cfg, relocationAxesByRef: Object.create(null) }), before);
});

test('axis schema rejects unsupported containers, unknown refs and invalid values', () => {
  const snapshot = fixture([{ ref: 'J5' }]), cfg = rules(snapshot);
  for (const axes of [null, [], 'x', 1, new Map(), new Date(), { J5: 'xy' }, { J5: null }, { J5: true }, { J5: {} }, { UNKNOWN: 'x' }]) {
    assert.throws(() => makePlan(snapshot, { ...cfg, relocationAxesByRef: axes }), /RELOCATION_AX/);
  }
});
