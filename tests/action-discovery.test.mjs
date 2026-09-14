import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateDiscoveryMetadata } from '../scripts/action-runner.mjs';

const runner = fileURLToPath(new URL('../scripts/action-runner.mjs', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../scripts/actions/manifest.json', import.meta.url), 'utf8'));
function run(args, options = {}) {
  return spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8', windowsHide: true, ...options });
}
function lookup(query, domain = 'schematic') {
  const result = run(['list', '--domain', domain, '--query', query]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('Chinese and English reflow queries expose the real wrapper and verification modes', () => {
  for (const query of ['原理图重排', '布局美化', 'SCHEMATIC REFLOW']) {
    const result = lookup(query);
    assert.equal(result.queryStatus, 'matched');
    assert.equal(result.readOnly, true);
    const action = result.actions.find(a => a.name === 'schematic-reflow');
    assert.ok(action, query);
    assert.equal(action.entrypoint.file, 'scripts/schematic-reflow.mjs');
    assert.equal(action.entrypoint.kind, 'script');
    assert.ok(action.modes.some(m => m.mode === 'verify' && !m.mutates));
    assert.ok(action.reference.endsWith('2.2-schematic-workflow.md'));
  }
});

test('batch placement query expands exactly the workflow dependencies from the registry', () => {
  const result = lookup('库存批量放件');
  const workflow = result.workflows.find(w => w.name === 'easyeda-schematic-components');
  assert.ok(workflow);
  assert.equal(workflow.entrypoint.kind, 'script');
  assert.equal(workflow.entrypoint.file, 'scripts/schematic-components.mjs');
  assert.deepEqual(workflow.phases, manifest.workflows[workflow.name].phases);
  const expected = [...new Set(Object.values(workflow.phases).flat().map(s => s.action))].sort();
  assert.deepEqual(result.actions.map(a => a.name).sort(), expected);
  for (const action of result.actions) {
    assert.equal(action.match, 'workflow-step');
    assert.equal(action.internal, Boolean(manifest.actions[action.name].internal));
    assert.equal(action.file, manifest.actions[action.name].file);
  }
});

test('connection queries find the executable workflow and its marker, NC and finalization dependencies', () => {
  for (const query of ['原理图连接', '连接收尾', 'schematic connect']) {
    const result = lookup(query);
    assert.equal(result.queryStatus, 'matched', query);
    const workflow = result.workflows.find(item => item.name === 'easyeda-schematic-connect');
    assert.ok(workflow, query);
    assert.equal(workflow.entrypoint.kind, 'script');
    assert.equal(workflow.entrypoint.file, 'scripts/schematic-connect.mjs');
    const steps = Object.values(workflow.phases).flat();
    for (const name of ['schematic-net-flag', 'schematic-no-connect', 'schematic-save-verify']) {
      assert.ok(steps.some(step => step.action === name && step.mode === 'apply' && !step.optional), `${query}: ${name} required apply`);
      assert.ok(result.actions.some(action => action.name === name && action.modes.some(mode => mode.mode === 'apply' && mode.mutates)), `${query}: ${name} discoverable dependency`);
    }
  }
});

test('wire color capability is discoverable with its actual limited scope', () => {
  const result = lookup('配色');
  const action = result.actions.find(a => a.name === 'schematic-wire-create');
  assert.ok(action);
  assert.ok(action.limitations.length);
  assert.equal(action.entrypoint.kind, 'action-runner');
  assert.deepEqual(action.entrypoint.args, ['run', '--action', action.name]);
});

test('PCB tools expose real PCB entrypoints without falling back to schematic capabilities', () => {
  for (const [query, expected] of [['配色', 'pcb-net-color'], ['布局', 'pcb-placement'], ['走线优先级', 'pcb-routing-plan']]) {
    const result = lookup(query, 'pcb');
    assert.equal(result.queryStatus, 'matched');
    assert.deepEqual(result.actions.map(a => a.name), [expected]);
    assert.equal(result.actions[0].entrypoint.kind, expected === 'pcb-routing-plan' ? 'action-runner' : 'script');
    assert.equal(result.actions[0].entrypoint.file, expected === 'pcb-routing-plan' ? 'scripts/action-runner.mjs' : 'scripts/pcb-edit.mjs');
    assert.equal(result.actions[0].domain, 'pcb');
    assert.ok(result.actions[0].limitations.length);
    assert.deepEqual(result.workflows, []);
  }
  const result = JSON.parse(run(['list', '--query', 'pcb layout']).stdout);
  assert.deepEqual(result.actions.map(a => a.name), ['pcb-placement']);
  const missing = lookup('自动阻抗求解', 'pcb');
  assert.equal(missing.queryStatus, 'no-match');
  assert.ok(missing.guidance.length > 0);
  assert.equal(lookup('走线优先级', 'schematic').queryStatus, 'no-match');
});

test('width discovery distinguishes editing existing traces from planning rules', () => {
  const result = lookup('线宽', 'pcb');
  assert.deepEqual(result.actions.map(action => action.name).sort(), ['pcb-routing-plan', 'pcb-trace-width']);
  const edit = result.actions.find(action => action.name === 'pcb-trace-width');
  assert.equal(edit.runtime, 'eda');
  assert.equal(edit.entrypoint.file, 'scripts/pcb-edit.mjs');
  assert.ok(edit.modes.some(mode => mode.mode === 'apply' && mode.mutates));
  const plan = result.actions.find(action => action.name === 'pcb-routing-plan');
  assert.equal(plan.runtime, 'host');
  assert.deepEqual(plan.modes.map(mode => mode.mode), ['generate']);
  const schematic = lookup('线宽', 'schematic');
  assert.deepEqual(schematic.actions.map(action => action.name), ['schematic-wire-create']);
  assert.equal(schematic.actions[0].domain, 'schematic');
});

test('discovery never creates reports or initializes an EDA host, even with write flags', async () => {
  const taskDir = await mkdtemp(join(tmpdir(), 'flitrealize-discovery-'));
  try {
    const result = run(['list', '--query', '配色', '--allow-write', '--report-file', join(taskDir, 'report.json')], {
      env: { ...process.env, FLITREALIZE_HOME: join(taskDir, 'unregistered-state') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).readOnly, true);
    assert.deepEqual(await readdir(taskDir), []);
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});

test('empty query and run-plus-query are rejected rather than ignored', () => {
  for (const args of [
    ['list', '--query'], ['list', '--query', '   '], ['list', '--query', '--full'],
    ['run', '--action', 'eda-capabilities', '--query', '配色'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stderr).error.code, /QUERY/);
  }
});

test('query output is smaller than a full stage catalog and has no unrelated actions', () => {
  const result = lookup('原理图重排');
  assert.deepEqual(result.actions.map(a => a.name), ['schematic-reflow']);
  const full = run(['list', '--domain', 'schematic', '--full']);
  assert.equal(full.status, 0, full.stderr);
  assert.ok(JSON.stringify(result).length < full.stdout.length);
});

test('metadata rejects missing, unsafe, mistyped and non-runtime discovery paths', () => {
  assert.doesNotThrow(() => validateDiscoveryMetadata(manifest.actions['schematic-reflow'].discovery));
  for (const metadata of [
    { keywords: '布局' }, { keywords: [''] }, { limitations: [3] },
    { refrence: 'references/0.3-easyeda-pro.md' },
    { reference: 'references/../SKILL.md' },
    { reference: 'references/nonexistent-discovery-reference.md' },
    { reference: 'docs/en-backup/SKILL.md.bak' },
    { entrypoint: 'scripts/actions/easyeda-pro/schematic-reflow.js' },
    { entrypoint: 'scripts/../../outside.mjs' },
  ]) {
    assert.throws(() => validateDiscoveryMetadata(metadata), error => error.code === 'INVALID_DISCOVERY_METADATA');
  }
});

test('full-plus-query stays filtered and does not silently accept unknown domains', () => {
  const result = run(['list', '--domain', 'schematic', '--full', '--query', '原理图重排']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).actions.map(a => a.name), ['schematic-reflow']);
  const invalid = run(['list', '--domain', 'parts', '--query', '配色']);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'UNKNOWN_ACTION_DOMAIN');
});
