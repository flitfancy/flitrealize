import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateDiscoveryMetadata } from '../scripts/action-runner.mjs';

const runner = fileURLToPath(new URL('../scripts/action-runner.mjs', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../scripts/actions/manifest.json', import.meta.url), 'utf8'));
function run(args, { entrypoint = runner, ...options } = {}) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000, ...options,
  });
}
function lookup(query, domain = 'schematic', options = {}) {
  const result = run(['list', ...(domain ? ['--domain', domain] : []), '--query', query], options);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const catalog = JSON.parse(result.stdout);
  assert.equal(catalog.readOnly, true, query);
  assert.equal(catalog.queryFilter, query.trim());
  assert.equal(catalog.domainFilter, domain);
  if (domain) {
    assert.ok(catalog.actions.every(action => action.domain === domain), query);
    assert.ok(catalog.workflows.every(workflow => workflow.domain === domain), query);
  }
  return catalog;
}
function getAction(result, name) {
  const action = result.actions.find(item => item.name === name);
  assert.ok(action, result.queryFilter + ' must expose ' + name);
  return action;
}

test('API documentation and library/netlist evidence route to their existing scoped entrypoints', () => {
  const api = lookup('API文档', 'system');
  assert.equal(getAction(api, 'api-reference').entrypoint.file, 'scripts/api-reference.mjs');
  assert.ok(api.actions.every(a => a.modes.every(m => !m.mutates)));
  assert.ok(lookup('库身份核对').actions.some(a => a.name === 'schematic-resolve-bindings'));
  assert.ok(lookup('原生网表').actions.some(a => a.name === 'schematic-inspect'));
});

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

test('batch placement query exposes all registered Workflow dependencies and their runtime files', () => {
  const result = lookup('库存批量放件');
  const workflow = result.workflows.find(w => w.name === 'easyeda-schematic-components');
  assert.ok(workflow);
  assert.equal(workflow.entrypoint.kind, 'script');
  assert.equal(workflow.entrypoint.file, 'scripts/schematic-components.mjs');
  const declared = manifest.workflows[workflow.name];
  assert.deepEqual(workflow.phases, declared.phases);
  const dependencies = new Set(Object.values(declared.phases).flat().map(step => step.action));
  for (const name of dependencies) getAction(result, name);
  for (const action of result.actions) {
    assert.ok(action.match === 'direct' || (action.match === 'workflow-step' && dependencies.has(action.name)), action.name);
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
  for (const [query, expected] of [['配色', 'pcb-net-color'], ['走线优先级', 'pcb-routing-plan']]) {
    const result = lookup(query, 'pcb');
    assert.equal(result.queryStatus, 'matched');
    const action = getAction(result, expected);
    assert.equal(action.entrypoint.kind, expected === 'pcb-routing-plan' ? 'action-runner' : 'script');
    assert.equal(action.entrypoint.file, expected === 'pcb-routing-plan' ? 'scripts/action-runner.mjs' : 'scripts/pcb-edit.mjs');
    assert.ok(action.limitations.length);
  }
  const placement = lookup('布局', 'pcb');
  const global = lookup('pcb layout', null);
  for (const name of ['pcb-fine-layout', 'pcb-fine-review', 'pcb-layout-prepare', 'pcb-placement']) {
    getAction(placement, name);
    getAction(global, name);
  }
  assert.equal(getAction(placement, 'pcb-placement').entrypoint.file, 'scripts/pcb-edit.mjs');
  const missing = lookup('unmatched-test-purpose', 'pcb');
  assert.equal(missing.queryStatus, 'no-match');
  assert.deepEqual(missing.actions, []);
  assert.deepEqual(missing.workflows, []);
  assert.ok(missing.guidance.length > 0);
  assert.equal(lookup('走线优先级', 'schematic').queryStatus, 'no-match');
});

test('layout input discovery separates read-only preparation from the full layout wrapper', () => {
  for (const query of ['布局输入', '粗布局', '布局候选', 'pcb layout solver']) {
    const result = lookup(query, 'pcb');
    const action = result.actions.find(a => a.name === 'pcb-layout-prepare');
    assert.ok(action, query);
    assert.equal(action.runtime, 'host');
    assert.deepEqual(action.providers, []);
    assert.equal(action.entrypoint.kind, 'script');
    assert.equal(action.entrypoint.file, 'scripts/pcb-layout.mjs');
    assert.deepEqual(action.modes, [{ mode: 'prepare', mutates: false }]);
    assert.ok(action.reference.endsWith('3.4-pcb-placement.md'));
    assert.ok(action.limitations.length);
    assert.ok(result.actions.every(item => item.domain === 'pcb'));
  }
});

test('fine placement queries distinguish gravity packing from auxiliary review', () => {
  const result = lookup('细布局', 'pcb');
  const main = getAction(result, 'pcb-fine-layout');
  const review = getAction(result, 'pcb-fine-review');
  assert.equal(main.entrypoint.file, 'scripts/pcb-fine-layout.mjs');
  assert.deepEqual(main.modes, [{ mode: 'pack', mutates: false }]);
  assert.equal(review.entrypoint.file, 'scripts/pcb-fine-review.mjs');
});

test('width discovery distinguishes editing existing traces from planning rules', () => {
  const result = lookup('线宽', 'pcb');
  const edit = getAction(result, 'pcb-trace-width');
  assert.equal(edit.runtime, 'eda');
  assert.equal(edit.entrypoint.file, 'scripts/pcb-edit.mjs');
  assert.ok(edit.modes.some(mode => mode.mode === 'apply' && mode.mutates));
  const plan = getAction(result, 'pcb-routing-plan');
  assert.equal(plan.runtime, 'host');
  assert.deepEqual(plan.modes.map(mode => mode.mode), ['generate']);
  const schematic = lookup('线宽', 'schematic');
  getAction(schematic, 'schematic-wire-create');
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
    assert.equal(dirname(resolve(taskDir)), resolve(tmpdir()));
    assert.ok(basename(taskDir).startsWith('flitrealize-discovery-'));
    await rm(taskDir, { recursive: true, force: true });
  }
});

test('empty query and run-plus-query are rejected rather than ignored', () => {
  for (const [args, code] of [
    [['list', '--query'], 'INVALID_DISCOVERY_QUERY'],
    [['list', '--query', '   '], 'INVALID_DISCOVERY_QUERY'],
    [['list', '--query', '--full'], 'INVALID_DISCOVERY_QUERY'],
    [['run', '--action', 'eda-capabilities', '--query', '配色'], 'QUERY_LIST_ONLY'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, result.stderr || result.error?.message);
    assert.equal(JSON.parse(result.stderr).error.code, code, args.join(' '));
  }
});

test('purpose matching normalizes words and excludes limitation-only text and unrelated Actions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'flitrealize-discovery-purpose-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('flitrealize-discovery-purpose-'));
    await rm(directory, { recursive: true, force: true });
  });
  const installed = join(directory, 'skill');
  const scripts = join(installed, 'scripts');
  await mkdir(join(scripts, 'actions'), { recursive: true });
  await copyFile(runner, join(scripts, 'action-runner.mjs'));
  await cp(join(root, 'scripts', 'lib'), join(scripts, 'lib'), { recursive: true });
  await writeFile(join(installed, 'VERSION'), 'fixture-version');
  // These would throw if discovery executed an Action or its advertised wrapper.
  const mustNotExecute = 'throw new Error("Discovery must not execute this file");';
  for (const file of ['actions/primary.js', 'actions/unrelated.js', 'fixture-entry.mjs']) {
    await writeFile(join(scripts, file), mustNotExecute);
  }
  const fixtureAction = file => ({
    file, description: 'Read-only fixture Action.', contractVersion: 1,
    domain: 'fixture', runtime: 'host', providers: [], defaultMode: 'inspect',
    modes: { inspect: { mutates: false } },
  });
  const fixture = {
    schemaVersion: 2, providers: {},
    actions: {
      primary: {
        ...fixtureAction('primary.js'),
        discovery: { keywords: ['Fixture Normalize'], limitations: ['limitation-only-sentinel'],
          entrypoint: 'scripts/fixture-entry.mjs' },
      },
      unrelated: { ...fixtureAction('unrelated.js'), discovery: { keywords: ['Other purpose'] } },
    },
  };
  await writeFile(join(scripts, 'actions', 'manifest.json'), JSON.stringify(fixture));
  const options = {
    entrypoint: join(scripts, 'action-runner.mjs'), cwd: directory,
    env: { ...process.env, FLITREALIZE_HOME: join(directory, 'state'),
      FLITREALIZE_BRIDGE_STATE_DIR: join(directory, 'bridge') },
  };
  for (const query of ['ＦＩＸＴＵＲＥ　ＮＯＲＭＡＬＩＺＥ', '  normalize   FIXTURE  ']) {
    const result = lookup(query, 'fixture', options);
    assert.equal(result.queryStatus, 'matched');
    assert.deepEqual(result.actions.map(action => action.name), ['primary']);
    assert.equal(result.actions[0].match, 'direct');
    assert.deepEqual(result.workflows, []);
  }
  const missing = lookup('limitation-only-sentinel', 'fixture', options);
  assert.equal(missing.queryStatus, 'no-match');
  assert.deepEqual(missing.actions, []);
  assert.deepEqual(missing.workflows, []);
  const full = run(['list', '--domain', 'fixture', '--full', '--query', 'Fixture Normalize'], options);
  assert.equal(full.status, 0, full.stderr || full.error?.message);
  assert.deepEqual(JSON.parse(full.stdout).actions.map(action => action.name), ['primary']);
  assert.deepEqual(await readdir(directory), ['skill']);
});

test('metadata rejects missing, unsafe, mistyped and non-runtime discovery paths', () => {
  assert.doesNotThrow(() => validateDiscoveryMetadata(manifest.actions['schematic-reflow'].discovery));
  for (const [label, metadata] of [
    ['keywords must be an array', { keywords: '布局' }],
    ['keywords must be nonempty', { keywords: [''] }],
    ['limitations must be strings', { limitations: [3] }],
    ['unknown metadata field', { refrence: 'references/0.3-easyeda-pro.md' }],
    ['reference path traversal', { reference: 'references/../SKILL.md' }],
    ['missing reference', { reference: 'references/nonexistent-discovery-reference.md' }],
    ['historical backup reference', { reference: 'docs/en-backup/SKILL.md.bak' }],
    ['Action file is not a CLI entrypoint', { entrypoint: 'scripts/actions/easyeda-pro/schematic-reflow.js' }],
    ['entrypoint path traversal', { entrypoint: 'scripts/../../outside.mjs' }],
  ]) {
    assert.throws(() => validateDiscoveryMetadata(metadata), { code: 'INVALID_DISCOVERY_METADATA' }, label);
  }
});

test('full-plus-query stays filtered and does not silently accept unknown domains', () => {
  const result = run(['list', '--domain', 'schematic', '--full', '--query', '原理图重排']);
  assert.equal(result.status, 0, result.stderr);
  const normal = lookup('原理图重排');
  const full = JSON.parse(result.stdout);
  assert.deepEqual(full.actions.map(action => action.name).sort(), normal.actions.map(action => action.name).sort());
  assert.deepEqual(full.workflows.map(workflow => workflow.name).sort(), normal.workflows.map(workflow => workflow.name).sort());
  const invalid = run(['list', '--domain', 'unregistered-test-domain', '--query', '配色']);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'UNKNOWN_ACTION_DOMAIN');
});
