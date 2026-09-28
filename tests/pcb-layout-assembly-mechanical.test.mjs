import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { makePlan } from '../scripts/pcb-layout/pcb-layout-mechanical-plan.mjs';
import { compileAssemblyPolicy, assemblyRuntime } from '../scripts/pcb-layout/pcb-layout-assembly-policy.mjs';

const box = (x, y, w = 20, h = 20) => ({ minX: x - w / 2, maxX: x + w / 2, minY: y - h / 2, maxY: y + h / 2 });
const input = (marginMil = 10, overrides = []) => ({
  schemaVersion: 1, profile: { id: 'test', label: 'Assembly test' }, source: { title: 'Test', url: 'https://example.test' },
  rules: [{ id: 'generic', footprintNames: ['generic'], marginMm: marginMil * .0254 }], overrides,
  independentPads: { marginMm: 0, basis: 'Bare test pads' }
});
function fixture(specs, testPads = []) {
  const snapshot = { source: 'assembly-native-fixture', sourceHash: 2166136261, components: [], items: [], pads: [] };
  for (const ch of snapshot.source) snapshot.sourceHash = Math.imul(snapshot.sourceHash ^ ch.charCodeAt(0), 16777619) >>> 0;
  for (const { ref, x = 0, y = 0, side = 'bottom', locked = false } of specs) {
    const id = ref + ':', bbox = box(x, y), labelBox = side === 'right' ? box(x + 30, y, 20, 10) : side === 'left' ? box(x - 30, y, 20, 10) : box(x, y + 25, 20, 10);
    snapshot.components.push({ id, ref, x, y, rotation: 0, locked, layer: 1, bbox, footprint: { name: 'generic' } });
    snapshot.pads.push({ id: id + 'p', owner: ref, x, y, number: '1', net: 'N', bbox: { ...bbox }, layer: 1 });
    snapshot.items.push({ id: id + 'label', owner: ref, parentId: id, type: 'attribute', text: ref, width: 20, height: 10, fontSize: 10, lineWidth: 1,
      original: { x: labelBox.minX, y: labelBox.minY, rotation: 0, alignMode: 3, bbox: labelBox } });
  }
  for (const [i, p] of testPads.entries()) snapshot.pads.push({ id: 'test:' + i, owner: null, number: 'TP' + i, net: 'N', x: p.x, y: p.y, bbox: box(p.x, p.y, 10, 10), layer: 1 });
  return snapshot;
}
function rules(snapshot, margin = 10, overrides = []) {
  return { clearanceMil: 8, maxRelocationMil: 0, assemblyPolicy: compileAssemblyPolicy(snapshot, input(margin, overrides)) };
}

test('courtyard conflict cannot be repaired by moving labels and is reported when movement is disabled', () => {
  const snapshot = fixture([{ ref: 'U1' }, { ref: 'U2', x: 35 }]);
  const plan = makePlan(snapshot, rules(snapshot));
  assert.equal(plan.status, 'planned-with-issues');
  assert.deepEqual(plan.issues, [{ code: 'ASSEMBLY_COURTYARD_OVERLAP', refs: ['U1', 'U2'] }]);
  assert.equal(plan.search.labelRepairAttempts, 0);
  assert.equal(plan.counts.moved, 0);
  const repaired = makePlan(snapshot, { ...rules(snapshot), maxRelocationMil: 30 });
  assert.equal(repaired.status, 'planned');
  assert.equal(repaired.counts.moved, 1);
  assert.equal(repaired.counts.labelsChanged, 1); // Only follows the moved body.
});

test('courtyard margins do not expand the silkscreen bundle a second time', () => {
  const snapshot = fixture([{ ref: 'U1', side: 'right' }, { ref: 'U2', x: 60 }]);
  const plan = makePlan(snapshot, rules(snapshot));
  assert.equal(plan.status, 'planned');
  assert.equal(plan.counts.moved, 0);
  assert.equal(plan.counts.labelsChanged, 0);
  for (const b of plan.bundles) assert.deepEqual(Object.keys(b.bbox).sort(), ['maxX', 'maxY', 'minX', 'minY']);
});

test('owned pad extent participates even when it extends beyond the component bbox', () => {
  const snapshot = fixture([{ ref: 'U1' }, { ref: 'U2', x: 55 }]);
  snapshot.pads[0].bbox.maxX = 30;
  const plan = makePlan(snapshot, rules(snapshot));
  assert.equal(plan.issues[0].code, 'ASSEMBLY_COURTYARD_OVERLAP');
  const repaired = makePlan(snapshot, { ...rules(snapshot), maxRelocationMil: 30 });
  assert.equal(repaired.status, 'planned');
  assert.equal(repaired.counts.moved, 1);
});

test('standalone pads are included and may move to satisfy the physical courtyard', () => {
  const snapshot = fixture([{ ref: 'U1', locked: true }], [{ x: 35, y: 0 }]);
  const cfg = rules(snapshot, 30);
  assert.equal(makePlan(snapshot, cfg).issues[0].code, 'ASSEMBLY_COURTYARD_OVERLAP');
  const repaired = makePlan(snapshot, { ...cfg, maxRelocationMil: 30 });
  assert.equal(repaired.status, 'planned');
  assert.equal(repaired.counts.moved, 0);
  assert.equal(repaired.counts.testPadsMoved, 1);
});

test('directional margins use the current rotated pose rather than the compiled orientation', () => {
  const snapshot = fixture([{ ref: 'U1', side: 'left' }, { ref: 'U2', y: 35 }]);
  const cfg = rules(snapshot, 0, [{ ref: 'U1', basis: 'Directional clearance', marginMm: { xMinus: 0, xPlus: .508, yMinus: 0, yPlus: 0 } }]);
  assert.equal(makePlan(snapshot, cfg).status, 'planned');
  const rotated = structuredClone(snapshot); rotated.components[0].rotation = 90;
  const plan = makePlan(rotated, cfg);
  assert.equal(plan.status, 'planned-with-issues');
  assert.ok(plan.issues.some(i => i.code === 'ASSEMBLY_COURTYARD_OVERLAP'));
});

test('explicit physical pair floors stay independent from the label bundle clearance', () => {
  const snapshot = fixture([{ ref: 'U1', side: 'right' }, { ref: 'U2', x: 60 }]);
  const cfg = rules(snapshot, 0);
  cfg.assemblyPolicy.absoluteFloorMil = 8;
  cfg.assemblyPolicy.pairClearancesMil = [{ a: 'U1', b: 'U2', hardMinMil: 40 }];
  assert.equal(makePlan(snapshot, cfg).status, 'planned');
  snapshot.pads[0].bbox.maxX = 30;
  const rejected = makePlan(snapshot, cfg);
  assert.ok(rejected.issues.some(i => i.code === 'ASSEMBLY_PHYSICAL_CLEARANCE'));
});

test('courtyard and absolute physical floor must pass on the same separation axis', () => {
  const snapshot = fixture([{ ref: 'U1', side: 'left' }, { ref: 'U2', x: 50, y: 30 }]);
  const cfg = rules(snapshot, 0, [{ ref: 'U1', basis: 'Directional clearance', marginMm: { xMinus: 0, xPlus: 1.016, yMinus: 0, yPlus: 0 } }]);
  cfg.assemblyPolicy.absoluteFloorMil = 20;
  const plan = makePlan(snapshot, cfg);
  assert.equal(plan.status, 'planned-with-issues');
  assert.deepEqual(plan.issues, [{ code: 'ASSEMBLY_DIRECTIONAL_CLEARANCE', refs: ['U1', 'U2'] }]);
});
