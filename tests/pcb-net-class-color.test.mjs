import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAction } from './helpers/action-harness.mjs';
import { pcbFixture } from './helpers/pcb-tools-fixture.mjs';

const color = await loadAction('pcb-net-color', 'easyeda-pro');
const rules = [{ name: 'PWR', kind: 'power' }];
const routing = await loadAction('pcb-routing-plan');

test('signal colors stay fixed across projects, batches and ordering', async () => {
  const kinds = [
    ['i2c_scl', '#28745B'], ['i2c_sda', '#4682B4'], ['spi_sclk', '#A87924'], ['spi_mosi', '#9C7BD8'],
    ['spi_miso', '#8E4585'], ['spi_cs', '#708238'], ['uart_tx', '#D65A91'], ['uart_rx', '#4B5BB5'],
    ['reset', '#7B4545'], ['interrupt', '#C2188B'], ['enable', '#009B77'], ['pwm', '#81728F'], ['feedback', '#8B5A2B'],
  ];
  for (const projectUuid of ['project-one', 'project-two']) {
    const { eda, scene, target } = pcbFixture();
    scene.projectUuid = target.expectedProjectUuid = projectUuid;
    scene.netClasses = kinds.map(([kind]) => ({ name: kind, nets: [kind.toUpperCase()], color: {r: 1, g: 2, b: 3, alpha: 1} }));
    const rules = kinds.map(([kind]) => ({name: kind, kind}));
    for (const batch of [rules, [...rules].reverse(), [rules[1], rules[0]]]) {
      const plan = await color(eda, {mode: 'plan', ...target, rules: batch});
      for (const assignment of plan.assignments) assert.equal(assignment.hex, kinds.find(([kind]) => kind === assignment.name)[1]);
      assert.equal(scene.writes.length, 0);
    }
    const plan = await color(eda, {mode: 'plan', ...target, rules});
    const before = structuredClone(scene.netClasses.map(({name,nets}) => ({name,nets})));
    const applied = await color(eda, {...plan.applyRequest, save:true});
    assert.equal(applied.status, 'applied');
    assert.equal(applied.saved, true);
    assert.deepEqual(applied.assignments, plan.assignments);
    assert.deepEqual(scene.netClasses.map(({name,nets}) => ({name,nets})), before);
    assert.equal((await color(eda, {mode: 'plan', ...target, rules})).changedCount, 0);
  }
});

test('coloring honors upstream kinds without inferring or splitting classes', async () => {
  const {eda, scene, target} = pcbFixture();
  scene.netClasses[0].nets = ['SCL', 'SDA', 'GND'];
  const plan = await color(eda, {mode:'plan', ...target, rules:[{name:'PWR', kind:'logic'}]});
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.assignments[0].hex, '#D69A52');
  await color(eda, plan.applyRequest);
  assert.equal(scene.netClasses.length, 2);
  assert.deepEqual(scene.netClasses.find(c=>c.name==='PWR').nets, ['GND','SCL','SDA']);
});

test('routing and direct color requests agree on malformed styling fields', async () => {
  for (const [style, code] of [
    [{ color: null, kind: 'power' }, 'INVALID_COLOR'],
    [{ color: '#112233', kind: 42 }, 'INVALID_KIND'],
    [{ kind: ' power ' }, 'INVALID_KIND'],
  ]) {
    const { eda, scene, target } = pcbFixture();
    await assert.rejects(routing(null, { ...target, rules: { units: 'mil', classes: [
      { name: 'PWR', nets: ['PWR'], priority: 1, widthMil: 25, ...style },
    ] } }), { code });
    await assert.rejects(color(eda, { mode: 'plan', ...target, rules: [{ name: 'PWR', ...style }] }), { code });
    assert.equal(scene.writes.length, 0);
  }
});

test('fixed palette writes opaque classes, preserves overrides and saves only when requested', async () => {
  const { eda, scene, target } = pcbFixture();
  const palette = {
    power: '#D85C5C',
    ground: '#4E6FAE',
    logic_power: '#747985',
    logic: '#D69A52',
    logic_orange: '#D69A52',
    logic_green: '#648B65',
    logic_cyan: '#4C929B',
    switching: '#A568B5',
    analog: '#A08B4B',
    audio: '#C77996',
    i2c_scl: '#28745B',
    i2c_sda: '#4682B4',
    spi_sclk: '#A87924',
    spi_mosi: '#9C7BD8',
    spi_miso: '#8E4585',
    spi_cs: '#708238',
    uart_tx: '#D65A91',
    uart_rx: '#4B5BB5',
    reset: '#7B4545',
    interrupt: '#C2188B',
    enable: '#009B77',
    pwm: '#81728F',
    feedback: '#8B5A2B',
  };
  const overrides = structuredClone(scene.colors);
  eda.pcb_Net.setNetColor = async () => { throw new Error('Unexpected per-net write'); };
  const inspect = await color(eda, { ...target });
  assert.equal(inspect.classes.length, 2);
  assert.deepEqual(inspect.palette, palette);
  for (const [kind, hex] of Object.entries(palette)) {
    const plan = await color(eda, { mode: 'plan', ...target, rules: [{ name: 'PWR', kind }] });
    assert.equal(plan.assignments[0].hex, hex);
    const result = await color(eda, plan.applyRequest);
    assert.equal(result.status, 'applied');
    assert.equal(result.saved, false);
    assert.deepEqual(scene.netClasses.find(c => c.name === 'PWR').color, {
      r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), alpha: 1,
    });
  }
  assert.ok(scene.writes.filter(w => w.type === 'class-create').every(w => w.color.alpha === 255));
  assert.equal(scene.saves, 0);
  assert.deepEqual(scene.colors, overrides);
  const last = { mode: 'apply', ...target, rules: [{ name: 'PWR', kind: 'feedback' }], save: true };
  const writes = scene.writes.length;
  const saved = await color(eda, last);
  assert.equal(saved.saved, true);
  assert.equal(saved.changedCount, 0);
  assert.equal(saved.visualVerified, false);
  assert.equal(scene.writes.length, writes);
});

test('same kind keeps the same color across batches and explicit hex takes priority', async () => {
  const { eda, target } = pcbFixture();
  const selected = [{ name: 'PWR', kind: 'logic_cyan' }, { name: 'SIG', kind: 'logic_cyan' }];
  for (const batch of [selected, [...selected].reverse(), [selected[1]]]) {
    const plan = await color(eda, { mode: 'plan', ...target, rules: batch });
    assert.ok(plan.assignments.every(c => c.hex === '#4C929B'));
  }
  const plan = await color(eda, { mode: 'plan', ...target, rules: [{ ...selected[0], color: '#abcdef' }, selected[1]] });
  assert.deepEqual(plan.assignments.map(c => c.hex), ['#ABCDEF', '#4C929B']);
});

test('invalid input, partial membership, duplicate and overlapping classes stop before writing', async () => {
  for (const [mutate, input, code] of [
    [() => {}, [{ name: 'PWR' }], 'INVALID_COLOR'],
    [() => {}, [{ name: 'PWR', kind: 'toString' }], 'INVALID_COLOR'],
    [() => {}, [{ name: 'PWR', color: '#FFF' }], 'INVALID_COLOR'],
    [() => {}, [{ name: 'missing', kind: 'power' }], 'NET_CLASS_NOT_FOUND'],
    [() => {}, [...rules, ...rules], 'AMBIGUOUS_CLASS'],
    [s => s.netClasses[0].nets.push('PWR2'), [{ ...rules[0], nets: ['PWR'] }], 'CLASS_MEMBERSHIP_MISMATCH'],
    [s => s.netClasses[1].nets.push('PWR'), rules, 'AMBIGUOUS_CLASS'],
  ]) {
    const { eda, scene, target } = pcbFixture(); mutate(scene);
    await assert.rejects(color(eda, { mode: 'apply', ...target, rules: input, save: true }), { code });
    assert.equal(scene.writes.length, 0);
    assert.equal(scene.saves, 0);
  }
});

test('preview is read-only and pins membership; apply uses current rules without stale whole-board snapshots', async () => {
  const { eda, scene, target } = pcbFixture();
  const plan = await color(eda, { mode: 'plan', ...target, rules });
  assert.equal(scene.writes.length, 0);
  scene.ruleState.netRules = [{ name: 'PWR', Track: 'updated-profile' }];
  assert.equal((await color(eda, plan.applyRequest)).status, 'applied');
  assert.equal(scene.ruleState.netRules[0].Track, 'updated-profile');
  scene.netClasses.find(c => c.name === 'PWR').nets.push('PWR2');
  await assert.rejects(color(eda, plan.applyRequest), { code: 'CLASS_MEMBERSHIP_MISMATCH' });
  await assert.rejects(color(eda, { mode: 'apply', plan: { schemaVersion: 2 } }), { code: 'OLD_REQUEST' });
});

test('class rebuild restores config and net rules; rule ordering does not cause false failures', async () => {
  const { eda, scene, target } = pcbFixture();
  scene.ruleState.netRules = [{ name: 'PWR', Track: 'wide' }, { name: 'SIG', Track: 'thin' }];
  const original = structuredClone(scene.ruleState);
  scene.afterWrite = () => {
    if (scene.writes.at(-1).type === 'class-delete') {
      scene.ruleState.netRules = [];
      scene.ruleState.currentRuleConfiguration.config = { clearance: 1 };
    }
  };
  eda.pcb_Drc.overwriteNetRules = async net => { scene.ruleState.netRules = [...net].reverse(); return true; };
  const result = await color(eda, { mode: 'apply', ...target, rules, save: true });
  assert.equal(result.status, 'applied');
  assert.deepEqual(scene.ruleState.currentRuleConfiguration, original.currentRuleConfiguration);
  assert.deepEqual(scene.ruleState.netRules, [...original.netRules].reverse());
  assert.equal(result.saved, true);
});

test('rule values reset by class rebuild must be restored, not excluded from comparison', async () => {
  for (const restoreWorks of [true, false]) {
    const { eda, scene, target } = pcbFixture();
    scene.ruleState.netRules = [{ type: 'netClass', name: 'PWR', defaultValue: 25, minValue: 20, maxValue: 30 }];
    const original = structuredClone(scene.ruleState.netRules);
    scene.afterWrite = () => {
      if (scene.writes.at(-1).type === 'class-create') scene.ruleState.netRules[0].minValue = 1;
    };
    if (!restoreWorks) eda.pcb_Drc.overwriteNetRules = async () => true;
    const result = await color(eda, { mode: 'apply', ...target, rules, save: true });
    if (restoreWorks) {
      assert.equal(result.status, 'applied');
      assert.deepEqual(scene.ruleState.netRules, original);
    } else {
      assert.equal(result.status, 'apply-failed');
      assert.equal(result.error.code, 'RULES_CHANGED');
      assert.equal(scene.saves, 0);
    }
  }
});

test('same-name net and net-class rules remain equivalent when their order changes', async () => {
  const { eda, scene, target } = pcbFixture();
  scene.ruleState.netRules = [{ type: 'netClass', name: 'PWR', Track: 'wide' }, { type: 'net', name: 'PWR', Track: 'thin' }];
  let reads = 0;
  eda.pcb_Drc.getNetRules = async () => {
    const result = structuredClone(scene.ruleState.netRules);
    return ++reads % 2 ? result : result.reverse();
  };
  const result = await color(eda, { mode: 'apply', ...target, rules, save: true });
  assert.equal(result.status, 'applied', JSON.stringify(result.error));
});

test('wrong alpha, changed membership or rules prevents saving', async () => {
  for (const [mutate, code] of [
    [s => { s.netClasses.find(c => c.name === 'PWR').color.alpha = 1 / 255; }, 'COLOR_READBACK_MISMATCH'],
    [s => { s.netClasses.find(c => c.name === 'SIG').nets.push('OTHER'); }, 'COLOR_READBACK_MISMATCH'],
    [s => { s.ruleState.regionRules.push({ name: 'unexpected' }); }, 'RULES_CHANGED'],
  ]) {
    const { eda, scene, target } = pcbFixture();
    scene.afterWrite = () => { if (scene.writes.at(-1).type === 'class-create') mutate(scene); };
    const result = await color(eda, { mode: 'apply', ...target, rules, save: true });
    assert.equal(result.status, 'apply-failed');
    assert.equal(result.error.code, code);
    assert.equal(scene.saves, 0);
  }
});

test('failed recreate retains original classes and rules; target switches prevent further writes', async () => {
  for (const switchTarget of [false, true]) {
    const { eda, scene, target } = pcbFixture();
    eda.pcb_Drc.createNetClass = async () => false;
    if (switchTarget) scene.afterWrite = () => { scene.documentUuid = 'other-pcb'; };
    const result = await color(eda, { mode: 'apply', ...target, rules, save: true });
    assert.equal(result.status, 'apply-failed');
    assert.equal(result.error.code, switchTarget ? 'TARGET_MISMATCH' : 'CLASS_WRITE_FAILED');
    assert.ok(result.before.classes.some(c => c.name === 'PWR'));
    assert.ok(result.before.rules);
    assert.deepEqual(result.attempted, ['PWR']);
    assert.equal(scene.writes.length, 1);
    assert.equal(scene.saves, 0);
  }
});

test('missing capabilities and wrong targets are rejected before deletion', async () => {
  for (const [mutate, code] of [
    [(s, e) => { delete e.pcb_Drc.createNetClass; }, 'CAPABILITY_MISSING'],
    [(s, e) => { delete e.pcb_Document.save; }, 'CAPABILITY_MISSING'],
    [s => { s.documentUuid = 'other'; }, 'TARGET_MISMATCH'],
  ]) {
    const { eda, scene, target } = pcbFixture(); mutate(scene, eda);
    await assert.rejects(color(eda, { mode: 'apply', ...target, rules, save: true }), { code });
    assert.equal(scene.writes.length, 0);
  }
});

test('membership changes during initial rule reads stop before the first write', async () => {
  const { eda, scene, target } = pcbFixture();
  const read = eda.pcb_Drc.getCurrentRuleConfiguration;
  let reads = 0;
  eda.pcb_Drc.getCurrentRuleConfiguration = async () => {
    const result = await read();
    if (++reads === 1) scene.netClasses[0].nets.push('ADDED');
    return result;
  };
  const result = await color(eda, { mode: 'apply', ...target, rules, save: true });
  assert.equal(result.status, 'apply-failed');
  assert.equal(result.error.code, 'COLOR_READBACK_MISMATCH');
  assert.equal(scene.writes.length, 0);
  assert.equal(scene.saves, 0);
});

test('save failures and changes after save report the actual save outcome', async () => {
  for (const afterSave of [false, true]) {
    const { eda, scene, target } = pcbFixture();
    eda.pcb_Document.save = async () => {
      if (!afterSave) return false;
      scene.netClasses.find(c => c.name === 'PWR').color.alpha = 0;
      return true;
    };
    const result = await color(eda, { mode: 'apply', ...target, rules, save: true });
    assert.equal(result.status, 'apply-failed');
    assert.equal(result.saved, afterSave ? true : null);
    assert.equal(result.error.code, afterSave ? 'COLOR_READBACK_MISMATCH' : 'SAVE_FAILED');
  }
});
