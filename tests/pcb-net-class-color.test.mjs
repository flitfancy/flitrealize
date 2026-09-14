import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAction } from './helpers/action-harness.mjs';
import { pcbFixture } from './helpers/pcb-tools-fixture.mjs';

const color = await loadAction('pcb-net-color', 'easyeda-pro');
const rules = [{ name: 'PWR', nets: ['PWR'], color: '#FF4040' }];
const routing = await loadAction('pcb-routing-plan');

test('class colors use byte alpha and never write or clear individual net overrides', async () => {
  const { eda, scene, target } = pcbFixture();
  const overrides = structuredClone(scene.colors);
  const other = structuredClone(scene.netClasses[1]);
  eda.pcb_Net.setNetColor = async () => { throw new Error('Per-net color writes are forbidden'); };
  const planned = await color(eda, { mode: 'plan', ...target, rules });
  const applied = await color(eda, planned.applyRequest);
  assert.equal(applied.status, 'applied');
  assert.deepEqual(scene.netClasses.find(item => item.name === 'PWR'), {
    name: 'PWR', nets: ['PWR'], color: { r: 255, g: 64, b: 64, alpha: 1 },
  });
  assert.deepEqual(scene.netClasses.find(item => item.name === 'SIG'), other);
  assert.deepEqual(scene.colors, overrides);
  assert.equal(scene.writes.find(item => item.type === 'class-create').color.alpha, 255);
  assert.equal(scene.saves, 0);
  assert.equal((await color(eda, applied.verifyRequest)).status, 'verified');
  assert.equal((await color(eda, applied.saveRequest)).saved, true);
  assert.equal(applied.visualVerified, false);
});

test('inspect lists existing classes; a matching color produces no writes', async () => {
  const { eda, scene, target } = pcbFixture();
  assert.equal((await color(eda, { mode: 'inspect', ...target })).state.netClasses.length, 2);
  const plan = await color(eda, { mode: 'plan', ...target, rules: [{ name: 'SIG', nets: ['SIG'], color: '#010203' }] });
  const applied = await color(eda, plan.applyRequest);
  assert.equal(applied.changedCount, 0);
  assert.equal(scene.writes.length, 0);
});

test('invalid, missing, partial and overlapping class selections never mutate membership', async () => {
  for (const [mutate, inputRules, code] of [
    [() => {}, [{ ...rules[0], color: null }], 'INVALID_COLOR'],
    [() => {}, [{ ...rules[0], color: '#FFF' }], 'INVALID_COLOR'],
    [() => {}, [{ ...rules[0], name: 'missing' }], 'NET_CLASS_NOT_FOUND'],
    [s => { s.netClasses[0].nets.push('PWR2'); }, rules, 'CLASS_MEMBERSHIP_MISMATCH'],
    [s => { s.netClasses[1].nets.push('PWR'); }, rules, 'AMBIGUOUS_CLASS'],
  ]) {
    const { eda, scene, target } = pcbFixture(); mutate(scene);
    await assert.rejects(color(eda, { mode: 'plan', ...target, rules: inputRules }), { code });
    assert.equal(scene.writes.length, 0);
  }
});

test('old plans, stale membership and missing recreate capabilities stop before deletion', async () => {
  for (const [mutate, code] of [
    [(s, e, p) => { p.plan.schemaVersion = 1; }, 'STALE_PLAN'],
    [(s) => { s.netClasses[0].nets.push('PWR2'); }, 'CLASS_MEMBERSHIP_MISMATCH'],
    [(s, e) => { delete e.pcb_Drc.createNetClass; }, 'CAPABILITY_MISSING'],
    [(s) => { s.ruleState.netRules.push({ net: 'SIG', width: 30 }); }, 'STALE_PLAN'],
  ]) {
    const { eda, scene, target } = pcbFixture();
    const plan = await color(eda, { mode: 'plan', ...target, rules }); mutate(scene, eda, plan);
    await assert.rejects(color(eda, plan.applyRequest), { code });
    assert.equal(scene.writes.length, 0);
  }
});

test('class rebuild restores config and net rules reset by the class API', async () => {
  const { eda, scene, target } = pcbFixture();
  scene.ruleState.netRules = [{ netClass: 'PWR', width: 25 }];
  const original = structuredClone(scene.ruleState);
  scene.afterWrite = () => {
    if (scene.writes.at(-1).type === 'class-delete') {
      scene.ruleState.netRules = [];
      scene.ruleState.currentRuleConfiguration.config = { clearance: 1 };
    }
  };
  const planned = await color(eda, { mode: 'plan', ...target, rules });
  const applied = await color(eda, planned.applyRequest);
  assert.equal(applied.status, 'applied');
  assert.deepEqual(scene.ruleState, original);
  assert.deepEqual(applied.operations.map(item => item.method), ['deleteNetClass', 'createNetClass', 'overwriteCurrentRuleConfiguration', 'overwriteNetRules']);
});

test('bad alpha readback, collateral geometry and unselected class changes cannot be saved', async () => {
  for (const [mutate, code] of [
    [s => { s.netClasses.find(item => item.name === 'PWR').color.alpha = 1 / 255; }, 'COLOR_READBACK_MISMATCH'],
    [s => { s.netClasses.find(item => item.name === 'SIG').color.r = 200; }, 'COLOR_READBACK_MISMATCH'],
    [s => { s.lines[0].lineWidth++; }, 'GEOMETRY_CHANGED'],
    [s => { s.ruleState.regionRules.push({ name: 'unexpected' }); }, 'RULES_CHANGED'],
  ]) {
    const { eda, scene, target } = pcbFixture();
    scene.afterWrite = () => { if (scene.writes.at(-1).type === 'class-create') mutate(scene); };
    const applied = await color(eda, (await color(eda, { mode: 'plan', ...target, rules })).applyRequest);
    assert.equal(applied.status, 'apply-failed');
    assert.equal(applied.error.code, code);
    assert.equal(applied.saveRequest, undefined);
    assert.equal(scene.saves, 0);
  }
});

test('failed recreate retains missing-class evidence and never blindly retries or rolls back', async () => {
  const { eda, scene, target } = pcbFixture();
  eda.pcb_Drc.createNetClass = async () => false;
  const applied = await color(eda, (await color(eda, { mode: 'plan', ...target, rules })).applyRequest);
  assert.equal(applied.status, 'apply-failed');
  assert.deepEqual(applied.attempted, ['PWR']);
  assert.ok(applied.before.source);
  assert.ok(!applied.after.netClasses.some(item => item.name === 'PWR'));
  assert.equal(scene.writes.length, 1);
  assert.equal(scene.saves, 0);
});

test('target switches during class reads or after deletion never write to another PCB', async () => {
  for (const phase of ['before-delete', 'after-delete']) {
    const { eda, scene, target } = pcbFixture();
    const planned = await color(eda, { mode: 'plan', ...target, rules });
    const read = eda.pcb_Drc.getAllNetClasses;
    let reads = 0;
    eda.pcb_Drc.getAllNetClasses = async () => {
      const value = await read();
      if (++reads === (phase === 'before-delete' ? 2 : 3)) scene.documentUuid = 'other-pcb';
      return value;
    };
    const applied = await color(eda, planned.applyRequest);
    assert.equal(applied.status, 'apply-failed');
    assert.equal(applied.error.code, 'TARGET_MISMATCH');
    assert.equal(scene.writes.length, phase === 'before-delete' ? 0 : 1);
    assert.equal(scene.saves, 0);
  }
});

test('routing color requests preserve class names and cannot silently color an unselected net', async () => {
  const { target } = pcbFixture();
  const config = { units: 'mil', classes: [{ name: 'PWR', priority: 1, nets: ['PWR', 'PWR2'], widthMil: 25, color: '#FF4040' }] };
  const full = await routing(null, { ...target, rules: config });
  assert.equal(full.colorPlanRequest.rules[0].name, 'PWR');
  assert.deepEqual(full.colorPlanRequest.rules[0].nets, ['PWR', 'PWR2']);
  await assert.rejects(routing(null, { ...target, rules: config, selectNets: ['PWR'] }), { code: 'PARTIAL_CLASS_COLOR' });
});
