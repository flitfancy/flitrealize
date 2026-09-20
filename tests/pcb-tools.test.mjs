import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAction } from './helpers/action-harness.mjs';
import { pcbFixture } from './helpers/pcb-tools-fixture.mjs';
import { loadManifest, resolveActionRequest, summarizeExecution } from '../scripts/action-runner.mjs';

const placement = await loadAction('pcb-placement', 'easyeda-pro');
const width = await loadAction('pcb-trace-width', 'easyeda-pro');
const routing = await loadAction('pcb-routing-plan');
const widthRules = [{ net: 'PWR', primitiveIds: ['l1'], targetWidthMil: 25 }];
const layoutConfig = { boardBounds: { minX: 0, minY: 0, maxX: 1000, maxY: 500 }, lockedDesignators: ['U1'], reservedRegions: [], clearanceMil: 5, cellMil: 25 };

test('width changes only explicitly selected copper segments, preserves narrow escape and other nets', async () => {
  const { eda, scene, target } = pcbFixture();
  const plan = await width(eda, { mode: 'plan', ...target, rules: widthRules });
  assert.equal(scene.writes.length, 0);
  const result = await width(eda, plan.applyRequest);
  assert.equal(result.status, 'applied');
  assert.deepEqual(scene.lines.map(l => l.lineWidth), [25, 6, 8]);
  assert.equal(scene.saves, 0);
  assert.equal((await width(eda, result.verifyRequest)).status, 'verified');
  assert.equal((await width(eda, result.saveRequest)).saved, true);
  assert.equal(scene.saves, 1);
});

test('width refuses unspecific, duplicate, wrong-net, non-copper and locked selections', async () => {
  for (const [change, rules, code] of [
    [() => {}, [{ net: 'PWR', targetWidthMil: 25 }], 'INVALID_RULES'],
    [() => {}, [...widthRules, ...widthRules], 'DUPLICATE_SELECTION'],
    [() => {}, [{ ...widthRules[0], net: 'SIG' }], 'LINE_NOT_FOUND'],
    [s => { s.lines[0].layer = 3; }, widthRules, 'NON_COPPER_LINE'],
    [s => { s.lines[0].primitiveLock = true; }, widthRules, 'LOCKED_LINE'],
  ]) {
    const { eda, scene, target } = pcbFixture(); change(scene);
    await assert.rejects(width(eda, { mode: 'plan', ...target, rules }), { code });
    assert.equal(scene.writes.length, 0);
  }
});

test('width DRC failures are not success and preserve post-write evidence without blind rollback', async () => {
  const { eda, scene, target } = pcbFixture();
  const plan = await width(eda, { mode: 'plan', ...target, rules: widthRules });
  scene.afterWrite = () => { scene.drc = [{ type: 'clearance' }]; };
  const result = await width(eda, plan.applyRequest);
  assert.equal(result.status, 'apply-failed');
  assert.equal(result.error.code, 'DRC_VIOLATIONS');
  assert.equal(result.after.lines[0].lineWidth, 25);
  assert.equal(scene.writes.length, 1);
  assert.equal(scene.saves, 0);
});

test('width can repair an existing violation while retaining unrelated baseline issues honestly', async () => {
  const { eda, scene, target } = pcbFixture();
  const unrelated = { type: 'clearance', primitiveId: 'other', distance: 3 };
  eda.pcb_Drc.check = async () => [unrelated, ...(scene.lines[0].lineWidth < 25 ? [{ type: 'width', primitiveId: 'l1', minimum: 25 }] : [])];
  const plan = await width(eda, { mode: 'plan', ...target, rules: widthRules });
  assert.equal(plan.drc.passed, false);
  assert.equal(plan.drc.violationCount, 2);
  assert.equal(scene.writes.length, 0);
  const applied = await width(eda, plan.applyRequest);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.drc.resolvedViolationCount, 1);
  assert.equal(applied.drc.newViolationCount, 0);
  assert.equal(applied.drc.passed, false);
  assert.deepEqual(applied.drc.violations, [unrelated]);
  assert.equal((await width(eda, applied.saveRequest)).saved, true);
});

test('width compares DRC identities and multiplicity, not just violation count', async () => {
  for (const next of [[{ type: 'clearance', primitiveId: 'l1' }], [{ type: 'width', primitiveId: 'old' }, { type: 'width', primitiveId: 'old' }]]) {
    const { eda, scene, target } = pcbFixture();
    scene.drc = [{ type: 'width', primitiveId: 'old' }];
    const plan = await width(eda, { mode: 'plan', ...target, rules: widthRules });
    scene.afterWrite = () => { scene.drc = next; };
    const applied = await width(eda, plan.applyRequest);
    assert.equal(applied.status, 'apply-failed');
    assert.equal(applied.error.code, 'DRC_VIOLATIONS');
    assert.equal(applied.drc.newViolationCount, 1);
    assert.equal(scene.saves, 0);
  }
});

test('width DRC baseline is order independent but must remain current before writing and saving', async () => {
  const { eda, scene, target } = pcbFixture();
  scene.drc = [{ type: 'a', id: 1 }, { type: 'b', id: 2 }];
  const plan = await width(eda, { mode: 'plan', ...target, rules: widthRules });
  scene.drc = [{ id: 2, type: 'b' }, { id: 1, type: 'a' }];
  const applied = await width(eda, plan.applyRequest);
  assert.equal(applied.status, 'applied');
  scene.drc.push({ type: 'new' });
  await assert.rejects(width(eda, applied.saveRequest), { code: 'DRC_VIOLATIONS' });
  assert.equal(scene.saves, 0);
  const fresh = pcbFixture();
  const pending = await width(fresh.eda, { mode: 'plan', ...fresh.target, rules: widthRules });
  fresh.scene.drc = [{ type: 'new' }];
  await assert.rejects(width(fresh.eda, pending.applyRequest), { code: 'DRC_BASELINE_CHANGED' });
  assert.equal(fresh.scene.writes.length, 0);
});

test('layout shifts a group while preserving fixed critical components and omitted rotation', async () => {
  const { eda, scene, target } = pcbFixture(); scene.lines = [];
  const plan = await placement(eda, { mode: 'plan', ...target, ...layoutConfig, groups: [{ designators: ['R1'], dxMil: -100, dyMil: 100 }] });
  assert.equal(plan.status, 'planned');
  assert.equal(scene.writes.length, 0);
  const fixed = structuredClone(scene.components[0]);
  const result = await placement(eda, plan.applyRequest);
  assert.equal(result.status, 'applied');
  assert.deepEqual(scene.components[0], fixed);
  assert.equal(scene.components[1].x, 200);
  assert.equal(scene.components[1].rotation, 90);
  assert.equal((await placement(eda, result.verifyRequest)).status, 'verified');
  assert.equal((await placement(eda, result.saveRequest)).saved, true);
});

test('layout compares candidates, reports free space and blocks overlaps, keepouts, bounds and routed moves', async () => {
  const { eda, scene, target } = pcbFixture(); scene.lines = [];
  const scenarios = [
    { name: 'overlap', placements: [{ designator: 'R1', x: 100, y: 100 }] },
    { name: 'outside', placements: [{ designator: 'R1', x: 1200, y: 100 }] },
    { name: 'reserve', placements: [{ designator: 'R1', x: 500, y: 100 }] },
    { name: 'valid', placements: [{ designator: 'R1', x: 200, y: 200 }] },
  ];
  const result = await placement(eda, { mode: 'plan', ...target, ...layoutConfig, reservedRegions: [{ name: 'OLED', bbox: { minX: 450, minY: 50, maxX: 550, maxY: 150 } }], scenarios });
  assert.deepEqual(result.candidates.slice(0, 3).map(c => c.issues[0].code), ['BBOX_OVERLAP', 'OUT_OF_BOUNDS', 'RESERVED_REGION']);
  assert.ok(result.candidates[3].applyRequest);
  assert.ok(result.candidates[3].space.largestComponentFreeRectangle.areaMil2 > 0);
  assert.equal(result.candidates[0].applyRequest, undefined);
  scene.lines = pcbFixture().scene.lines;
  const routed = await placement(eda, { mode: 'plan', ...target, ...layoutConfig, ...scenarios[3] });
  assert.equal(routed.status, 'blocked');
  assert.ok(routed.issues.some(i => i.code === 'ROUTED_BOARD'));
  assert.equal(scene.writes.length, 0);
});

test('layout rejects fixed/EDA-locked components, duplicate groups and missing bounds', async () => {
  for (const [change, extra, code] of [
    [() => {}, { placements: [{ designator: 'U1', x: 200, y: 200 }] }, 'LOCKED_COMPONENT'],
    [s => { s.components[1].primitiveLock = true; }, { placements: [{ designator: 'R1', x: 200, y: 200 }] }, 'LOCKED_COMPONENT'],
    [() => {}, { groups: [{ designators: ['R1', 'R1'], dxMil: 10, dyMil: 0 }] }, 'DUPLICATE_SELECTION'],
    [() => {}, { boardBounds: null }, 'INVALID_BOUNDS'],
  ]) {
    const { eda, scene, target } = pcbFixture(); scene.lines = []; change(scene);
    await assert.rejects(placement(eda, { mode: 'plan', ...target, ...layoutConfig, ...extra }), { code });
    assert.equal(scene.writes.length, 0);
  }
});

test('layout/width stale plans and failed reads cannot overwrite user changes', async () => {
  for (const [action, input, mutate] of [
    [width, { rules: widthRules }, s => { s.lines[0].endX = 200; }],
    [placement, { ...layoutConfig, placements: [{ designator: 'R1', x: 200, y: 200 }] }, s => { s.components[1].x = 500; }],
  ]) {
    const { eda, scene, target } = pcbFixture(); if (action === placement) scene.lines = [];
    const plan = await action(eda, { mode: 'plan', ...target, ...input });
    mutate(scene);
    await assert.rejects(action(eda, plan.applyRequest), { code: 'STALE_PLAN' });
    assert.equal(scene.writes.length, 0);
  }
  const { eda, target } = pcbFixture();
  eda.pcb_PrimitiveComponent.getAll = async () => null;
  await assert.rejects(placement(eda, { mode: 'inspect', ...target }), { code: 'SNAPSHOT_FAILED' });
  eda.pcb_PrimitiveLine.getAll = async () => null;
  await assert.rejects(width(eda, { mode: 'inspect', ...target }), { code: 'SNAPSHOT_FAILED' });
});

test('routing plan sorts priorities, builds role-specific width/color requests without claiming routing', async () => {
  const { target } = pcbFixture();
  const rules = { units: 'mil', classes: [
    { name: 'signals', priority: 2, nets: ['SIG'], widthMil: 8, color: '#123456' },
    { name: 'power', priority: 1, nets: ['PWR'], trunkWidthMil: 25, localWidthMil: 10, kind: 'power' },
  ], qfnEscape: { widthMil: 6, maxLengthMil: 50 }, completedNets: ['PWR'] };
  const result = await routing(null, { mode: 'generate', ...target, rules, segmentAssignments: [
    { net: 'PWR', role: 'trunk', primitiveIds: ['l1'] }, { net: 'PWR', role: 'escape', primitiveIds: ['l2'] },
  ] });
  assert.deepEqual(result.sequence.map(s => s.class.name), ['power', 'signals']);
  assert.deepEqual(result.widthRules.map(r => r.targetWidthMil), [25, 6]);
  assert.equal(result.widthPlanRequest.mode, 'plan');
  assert.deepEqual(result.colorPlanRequest.rules, [
    { name: 'power', nets: ['PWR'], kind: 'power' },
    { name: 'signals', nets: ['SIG'], color: '#123456' },
  ]);
  assert.equal(result.capabilities.autorouterPriorityApplied, false);
  assert.equal(result.capabilities.editorNetClassWritten, false);
  await assert.rejects(routing(null, { rules: { ...rules, routingOrder: ['signals', 'power'] } }), { code: 'ORDER_CONFLICT' });
  await assert.rejects(routing(null, { rules: { ...rules, classes: [...rules.classes, { name: 'again', priority: 3, nets: ['PWR'], widthMil: 8 }] } }), { code: 'DUPLICATE_NET' });
});

test('routing requires coloring information for every selected class without guessing names', async () => {
  const { target } = pcbFixture();
  const rules = { units: 'mil', classes: [
    { name: 'POWER', nets: ['PWR'], priority: 1, widthMil: 20, kind: 'power' },
    { name: 'I2C_SCL', nets: ['SCL'], priority: 2, widthMil: 8 },
    { name: 'GND', nets: ['GND'], priority: 3, widthMil: 20 },
  ] };
  const before = structuredClone(rules);
  for (const targets of [{}, target]) {
    await assert.rejects(routing(null, { ...targets, rules }), error => {
      assert.equal(error.code, 'COLOR_KIND_REQUIRED');
      assert.match(error.message, /I2C_SCL, GND/);
      return true;
    });
  }
  const selected = await routing(null, { ...target, rules, selectNets: ['PWR'] });
  assert.deepEqual(selected.colorPlanRequest.rules, [{ name: 'POWER', nets: ['PWR'], kind: 'power' }]);
  const widthOnly = await routing(null, { ...target, rules, selectNets: ['SCL'], segmentAssignments: [
    { net: 'SCL', role: 'signal', primitiveIds: ['clock-line'] },
  ] });
  assert.equal(widthOnly.colorPlanRequest, undefined);
  assert.equal(widthOnly.widthPlanRequest.rules[0].targetWidthMil, 8);
  assert.deepEqual(rules, before);
});

test('all PCB editing actions reject wrong targets and mixed-time snapshots without writing', async () => {
  for (const [action, input] of [[width, {}], [placement, {}]]) {
    const { eda, scene, target } = pcbFixture();
    await assert.rejects(action(eda, { mode: 'inspect', ...target, expectedProjectUuid: 'wrong', ...input }), { code: 'TARGET_MISMATCH' });
    let reads = 0;
    eda.sys_FileManager.getDocumentSource = async () => `source-${reads++}`;
    await assert.rejects(action(eda, { mode: 'inspect', ...target, ...input }), { code: 'SNAPSHOT_CHANGED' });
    assert.equal(scene.writes.length, 0);
  }
});

test('PCB edits recheck the target after asynchronous object reads and before writing', async () => {
  for (const [action, input, namespace, getter] of [
    [width, { rules: widthRules }, 'pcb_PrimitiveLine', 'get'],
    [placement, { ...layoutConfig, placements: [{ designator: 'R1', x: 200, y: 200 }] }, 'pcb_PrimitiveComponent', 'get'],
  ]) {
    const { eda, scene, target } = pcbFixture(); if (action === placement) scene.lines = [];
    const plan = await action(eda, { mode: 'plan', ...target, ...input });
    const originalRead = eda[namespace][getter];
    eda[namespace][getter] = async (...args) => {
      const value = await originalRead(...args);
      scene.documentUuid = 'foreign-pcb';
      return value;
    };
    const result = await action(eda, plan.applyRequest);
    assert.equal(result.status, 'apply-failed');
    assert.equal(result.error.code, 'TARGET_MISMATCH');
    assert.deepEqual(result.attempted, []);
    assert.deepEqual(scene.writes, []);
    assert.equal(scene.saves, 0);
  }
});

test('apply failures retain attempted IDs even when a write mutates then throws', async () => {
  for (const [action, input] of [
    [width, { rules: widthRules }],
    [placement, { ...layoutConfig, placements: [{ designator: 'R1', x: 200, y: 200 }] }],
  ]) {
    const { eda, scene, target } = pcbFixture(); if (action === placement) scene.lines = [];
    const plan = await action(eda, { mode: 'plan', ...target, ...input });
    scene.afterWrite = () => { throw new Error('response interrupted'); };
    const result = await action(eda, plan.applyRequest);
    assert.equal(result.status, 'apply-failed');
    assert.equal(result.attempted.length, 1);
    assert.equal(scene.writes.length, 1);
    assert.ok(result.before.source && result.after.source);
    assert.equal(scene.saves, 0);
  }
});

test('failed saves can be retried independently; later manual edits invalidate verification/save evidence', async () => {
  for (const [action, input] of [
    [width, { rules: widthRules }],
    [placement, { ...layoutConfig, placements: [{ designator: 'R1', x: 200, y: 200 }] }],
  ]) {
    const { eda, scene, target } = pcbFixture(); if (action === placement) scene.lines = [];
    const plan = await action(eda, { mode: 'plan', ...target, ...input });
    const applied = await action(eda, plan.applyRequest);
    const count = scene.writes.length;
    eda.pcb_Document.save = async () => false;
    await assert.rejects(action(eda, applied.saveRequest), { code: 'SAVE_FAILED' });
    eda.pcb_Document.save = async () => true;
    assert.equal((await action(eda, applied.saveRequest)).saved, true);
    assert.equal(scene.writes.length, count);
    const verifiedAfterSave = await action(eda, applied.verifyRequest);
    assert.equal(verifiedAfterSave.status, 'verified');
    assert.equal(verifiedAfterSave.saved, null);
    assert.equal(verifiedAfterSave.saveChecked, false);
    scene.components[0].x += 1;
    assert.equal((await action(eda, applied.verifyRequest)).status, 'mismatch');
    await assert.rejects(action(eda, applied.saveRequest), { code: 'STALE_SAVE' });
    assert.equal(scene.writes.length, count);
  }
});

test('save target switches are errors, not confirmed completion', async () => {
  for (const [action, input] of [[width, { rules: widthRules }], [placement, { ...layoutConfig, placements: [{ designator: 'R1', x: 200, y: 200 }] }]]) {
    const { eda, scene, target } = pcbFixture(); if (action === placement) scene.lines = [];
    const applied = await action(eda, (await action(eda, { mode: 'plan', ...target, ...input })).applyRequest);
    eda.pcb_Document.save = async () => { scene.documentUuid = 'other'; return true; };
    await assert.rejects(action(eda, applied.saveRequest), { code: 'TARGET_MISMATCH' });
  }
});

test('layout checks every component bbox and live region, with bounded grid work', async () => {
  const { eda, scene, target } = pcbFixture(); scene.lines = [];
  const realBBox = eda.pcb_Primitive.getPrimitivesBBox;
  eda.pcb_Primitive.getPrimitivesBBox = async ([id]) => id === 'c2' ? null : realBBox([id]);
  await assert.rejects(placement(eda, { mode: 'inspect', ...target }), { code: 'INVALID_BOUNDS' });
  scene.regions = [{ primitiveId: 'keepout' }];
  eda.pcb_Primitive.getPrimitivesBBox = async ([id]) => id === 'keepout' ? { minX: 450, minY: 50, maxX: 550, maxY: 150 } : realBBox([id]);
  const plan = await placement(eda, { mode: 'plan', ...target, ...layoutConfig, placements: [{ designator: 'R1', x: 500, y: 100 }] });
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.issues.some(i => i.code === 'RESERVED_REGION' && i.region === 'keepout'));
  await assert.rejects(placement(eda, { mode: 'inspect', ...target, ...layoutConfig, cellMil: 0.001 }), { code: 'GRID_TOO_LARGE' });
});

test('width catches collateral edits and unknown DRC instead of treating them as empty/pass', async () => {
  const { eda, scene, target } = pcbFixture();
  const plan = await width(eda, { mode: 'plan', ...target, rules: widthRules });
  scene.afterWrite = () => { scene.lines[2].endX++; };
  const result = await width(eda, plan.applyRequest);
  assert.equal(result.status, 'apply-failed');
  assert.equal(result.error.code, 'WIDTH_READBACK_MISMATCH');
  eda.pcb_Drc.check = async () => null;
  await assert.rejects(width(eda, { mode: 'plan', ...target, rules: widthRules }), { code: 'DRC_UNKNOWN' });
});

test('new PCB modes retain runner authorization and failed writes are non-success', async () => {
  const manifest = await loadManifest();
  for (const name of ['pcb-placement', 'pcb-trace-width']) {
    for (const mode of ['apply', 'save']) {
      assert.throws(() => resolveActionRequest(manifest, name, { mode }, false), { code: 'WRITE_AUTHORIZATION_REQUIRED' });
      const descriptor = resolveActionRequest(manifest, name, { mode }, true);
      assert.equal(summarizeExecution({ success: true, result: { status: 'apply-failed', saved: false } }, descriptor).ok, false);
    }
    assert.equal(resolveActionRequest(manifest, name, { mode: 'plan' }, false).mutates, false);
  }
  const descriptor = resolveActionRequest(manifest, 'pcb-routing-plan', {}, false);
  assert.equal(descriptor.runtime, 'host');
  assert.equal(descriptor.provider, null);
});


test('explicit coloring checks network inventory and does not silently become a routing-only plan', async () => {
  const { target } = pcbFixture();
  const input = { ...target, requireColor: true, netNames: ['PWR', 'GND'], rules: { units: 'mil', classes: [
    { name: 'POWER', nets: ['PWR'], priority: 1, widthMil: 20, kind: 'power' },
    { name: 'GROUND', nets: ['GND'], priority: 1, widthMil: 20, kind: 'ground' },
  ] } };
  const before = structuredClone(input);
  assert.equal((await routing(null, input)).colorPlanRequest.rules.length, 2);
  for (const netNames of [undefined, null, [], 'PWR', ['PWR', 'PWR'], [' PWR', 'GND'], ['PWR', 7]]) {
    await assert.rejects(routing(null, { ...input, netNames }), { code: 'INVALID_NET_INVENTORY' });
  }
  for (const requireColor of ['true', 1, null]) {
    await assert.rejects(routing(null, { ...input, requireColor }), { code: 'INVALID_COLOR_REQUIREMENT' });
  }
  await assert.rejects(routing(null, { ...input, rules: { ...input.rules, classes: [input.rules.classes[0]] } }), error => {
    assert.equal(error.code, 'NET_COVERAGE_MISMATCH'); assert.match(error.message, /GND/); return true;
  });
  await assert.rejects(routing(null, { ...input, netNames: ['PWR'] }), { code: 'NET_COVERAGE_MISMATCH' });
  const unstyled = input.rules.classes.map(({ kind, ...item }) => item);
  await assert.rejects(routing(null, { ...input, rules: { units: 'mil', classes: unstyled } }), { code: 'COLOR_KIND_REQUIRED' });
  const { expectedProjectUuid, expectedDocumentUuid, ...untargeted } = input;
  await assert.rejects(routing(null, untargeted), { code: 'TARGET_REQUIRED' });
  const local = await routing(null, { ...input, selectNets: ['PWR'], rules: { ...input.rules, classes: [input.rules.classes[0]] } });
  assert.deepEqual(local.colorPlanRequest.rules, [{ name: 'POWER', nets: ['PWR'], kind: 'power' }]);
  await assert.rejects(routing(null, { ...input, selectNets: ['PWR'], rules: { units: 'mil', classes: [
    { name: 'ALL', nets: ['PWR', 'GND'], priority: 1, widthMil: 20, kind: 'power' },
  ] } }), { code: 'PARTIAL_CLASS_COLOR' });
  assert.equal((await routing(null, { rules: { units: 'mil', classes: unstyled } })).colorPlanRequest, undefined);
  assert.equal((await routing(null, { ...input, requireColor: false, rules: { units: 'mil', classes: unstyled } })).colorPlanRequest, undefined);
  assert.deepEqual(input, before);
});
