import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  defaultReportFile,
  executeHostAction,
  loadManifest,
  resolveActionRequest,
  summarizeExecution,
} from '../scripts/action-runner.mjs';
import { loadAction } from './helpers/action-harness.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ACTIONS_ROOT = join(ROOT, 'scripts', 'actions');
const manifest = await loadManifest();
const names = entries => entries.map(entry => entry.name).sort();
const runNode = (script, args, cwd = ROOT) => spawnSync(process.execPath, [script, ...args], {
  cwd, encoding: 'utf8', windowsHide: true, timeout: 10000,
});

async function actionFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await actionFiles(join(directory, entry.name), name + '/'));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(name);
  }
  return files;
}

// Provider-selection fixtures describe routing only; no EDA implementation is executed.
function fixtureManifest() {
  const action = runtime => ({
    file: 'schematic-contract-audit.js', description: 'Fixture Action.',
    contractVersion: 1, domain: 'system', runtime,
    providers: runtime === 'host' ? [] : ['fixture-eda'],
    defaultMode: 'inspect', modes: { inspect: { mutates: false }, apply: { mutates: true } },
  });
  return {
    schemaVersion: 2,
    providers: {
      'fixture-eda': { kind: 'eda', displayName: 'Fixture EDA' },
      'fixture-other': { kind: 'eda', displayName: 'Other fixture EDA' },
    },
    actions: { 'host-fixture': action('host'), 'eda-fixture': action('eda') },
    workflows: {
      'fixture-workflow': {
        description: 'Fixture workflow.', domain: 'system', provider: 'fixture-eda',
        phases: { inspect: [{ action: 'host-fixture', mode: 'inspect' }, { action: 'eda-fixture', mode: 'inspect' }] },
      },
    },
  };
}

test('every executable Action file is registered exactly once', async () => {
  const registered = Object.values(manifest.actions).map(action => action.file);
  assert.equal(new Set(registered).size, registered.length, 'Actions must not share a registered file');
  assert.deepEqual(registered.sort(), (await actionFiles(ACTIONS_ROOT)).sort());
});

test('manifest validation rejects broken Provider, mutation and Workflow contracts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'flitrealize-architecture-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('flitrealize-architecture-'));
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'manifest.json');
  const valid = fixtureManifest();
  await writeFile(file, JSON.stringify(valid));
  assert.deepEqual(await loadManifest(file), valid);
  const cases = [
    ['invalid Provider kind', value => { value.providers['fixture-eda'].kind = 'host'; }],
    ['unknown EDA Provider', value => { value.actions['eda-fixture'].providers = ['missing-provider']; }],
    ['duplicate EDA Provider', value => { value.actions['eda-fixture'].providers.push('fixture-eda'); }],
    ['Provider on host Action', value => { value.actions['host-fixture'].providers = ['fixture-eda']; }],
    ['nonboolean mutation flag', value => { value.actions['host-fixture'].modes.apply.mutates = 'false'; }],
    ['unknown Workflow Action', value => { value.workflows['fixture-workflow'].phases.inspect[0].action = 'missing-action'; }],
    ['unknown Workflow mode', value => { value.workflows['fixture-workflow'].phases.inspect[0].mode = 'missing-mode'; }],
    ['cross-domain Workflow step', value => { value.workflows['fixture-workflow'].domain = 'pcb'; }],
    ['unsupported Workflow Provider', value => { value.workflows['fixture-workflow'].provider = 'fixture-other'; }],
  ];
  for (const [label, mutate] of cases) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    await writeFile(file, JSON.stringify(invalid));
    await assert.rejects(loadManifest(file), { code: 'INVALID_ACTION_MANIFEST' }, label);
  }
});

test('every registered mode enforces its mutation contract and resolves its declared Provider', () => {
  // Synthetic host writes exercise authorization even when the real host Actions are read-only.
  for (const registry of [manifest, fixtureManifest()]) {
    for (const [name, action] of Object.entries(registry.actions)) {
      for (const provider of action.runtime === 'host' ? [null] : action.providers) {
        assert.equal(resolveActionRequest(registry, name, {}, true, provider).mode, action.defaultMode, name);
        for (const [mode, contract] of Object.entries(action.modes)) {
          const label = name + '/' + mode + '/' + (provider ?? 'host');
          if (contract.mutates) {
            assert.throws(() => resolveActionRequest(registry, name, { mode }, false, provider),
              { code: 'WRITE_AUTHORIZATION_REQUIRED' }, label);
          }
          const descriptor = resolveActionRequest(registry, name, { mode }, contract.mutates, provider);
          assert.equal(descriptor.actionName, name, label);
          assert.equal(descriptor.mode, mode, label);
          assert.equal(descriptor.mutates, contract.mutates, label);
          assert.equal(descriptor.runtime, action.runtime, label);
          assert.equal(descriptor.domain, action.domain, label);
          assert.equal(descriptor.contractVersion, action.contractVersion, label);
          assert.equal(descriptor.provider, provider, label);
          assert.equal(descriptor.actionFile, join(ACTIONS_ROOT, action.file), label);
        }
      }
    }
  }
});

test('request resolution rejects unknown Actions and modes and requires unambiguous Provider selection', () => {
  const registry = fixtureManifest();
  assert.throws(() => resolveActionRequest(registry, 'missing-action', {}, false), { code: 'UNKNOWN_ACTION' });
  assert.throws(() => resolveActionRequest(registry, 'host-fixture', { mode: 'missing-mode' }, false),
    { code: 'UNSUPPORTED_ACTION_MODE' });
  assert.equal(resolveActionRequest(registry, 'host-fixture', {}, false).provider, null);
  assert.throws(() => resolveActionRequest(registry, 'host-fixture', {}, false, 'fixture-eda'),
    { code: 'ACTION_PROVIDER_NOT_APPLICABLE' });
  assert.equal(resolveActionRequest(registry, 'eda-fixture', {}, false).provider, 'fixture-eda');
  for (const provider of ['missing-provider', 'fixture-other']) {
    assert.throws(() => resolveActionRequest(registry, 'eda-fixture', {}, false, provider),
      { code: 'ACTION_PROVIDER_UNSUPPORTED' }, provider);
  }
  registry.actions['eda-fixture'].providers.push('fixture-other');
  assert.throws(() => resolveActionRequest(registry, 'eda-fixture', {}, false), { code: 'ACTION_PROVIDER_REQUIRED' });
  for (const provider of registry.actions['eda-fixture'].providers) {
    assert.equal(resolveActionRequest(registry, 'eda-fixture', {}, false, provider).provider, provider);
  }
});

test('EasyEDA Action requirements refer to capabilities declared by the Provider', async () => {
  const probe = await loadAction('eda-capabilities', 'easyeda-pro');
  const declared = new Set(Object.keys((await probe({}, { mode: 'inspect' })).capabilities));
  for (const [name, action] of Object.entries(manifest.actions)) {
    if (action.runtime !== 'eda' || !action.providers.includes('easyeda-pro')) continue;
    for (const [group, required] of Object.entries(action.requires ?? {})) {
      assert.ok(Array.isArray(required), name + '/' + group);
      for (const capability of required) {
        assert.ok(declared.has(capability), name + '/' + group + ' requires undeclared capability ' + capability);
      }
    }
  }
});

test('report filenames are portable and distinct for repeated invocations', () => {
  const filenames = Array.from({ length: 2 }, () => basename(defaultReportFile('pcb-ground-vias', 'inspect')));
  assert.equal(new Set(filenames).size, filenames.length);
  for (const filename of filenames) {
    assert.ok(filename.includes('pcb-ground-vias-inspect'), filename);
    assert.ok(filename.endsWith('.json'), filename);
    assert.doesNotMatch(filename, /[<>:"/\\|?*\u0000-\u001f]/);
  }
});

test('EDA summaries preserve contract metadata, document identity, counts and report provenance', () => {
  const descriptor = resolveActionRequest(manifest, 'pcb-ground-vias', { mode: 'plan' }, false);
  const summary = summarizeExecution({
    success: true,
    result: {
      status: 'planned', readOnly: true, document: { uuid: 'pcb-fixture' },
      inspectionFingerprint: 'fnv1a32-11111111', selectedCount: 7,
      nextRequest: { mode: 'apply' },
    },
  }, descriptor, 'fixture-report.json', 'fixture-version');
  assert.equal(summary.ok, true);
  assert.equal(summary.schemaVersion, 2);
  assert.equal(summary.skillVersion, 'fixture-version');
  assert.equal(summary.actionContractVersion, descriptor.contractVersion);
  assert.equal(summary.action, descriptor.actionName);
  assert.equal(summary.domain, 'pcb');
  assert.equal(summary.runtime, 'eda');
  assert.equal(summary.provider, descriptor.provider);
  assert.equal(summary.mode, 'plan');
  assert.equal(summary.readOnly, true);
  assert.equal(summary.documentUuid, 'pcb-fixture');
  assert.equal(summary.counts.selectedCount, 7);
  assert.equal(summary.fingerprints.inspectionFingerprint, 'fnv1a32-11111111');
  assert.equal(summary.nextRequestAvailable, true);
  assert.equal(summary.reportFile, 'fixture-report.json');
});

test('host execution forwards input and context and summarizes results without an EDA Provider', async () => {
  const descriptor = {
    actionName: 'host-fixture',
    actionFile: fileURLToPath(new URL('./fixtures/host-action.js', import.meta.url)),
    contractVersion: 1, domain: 'system', runtime: 'host', provider: null, mode: 'inspect', mutates: false,
  };
  const input = { selected: ['U1', 'U2'], unsupported: ['hierarchical-bus'] };
  const context = { projectRoot: 'fixture-project', skillVersion: 'fixture-version' };
  const response = await executeHostAction(descriptor, input, context);
  assert.deepEqual(response.result.selected, input.selected);
  assert.deepEqual(response.result.unsupported, input.unsupported);
  assert.deepEqual(response.result.context, { action: 'host-fixture', ...context });
  const summary = summarizeExecution(response, descriptor, 'host-report.json', context.skillVersion);
  assert.equal(summary.ok, true);
  assert.equal(summary.runtime, 'host');
  assert.equal(summary.provider, null);
  assert.equal(summary.counts.selectedCount, 2);
  assert.equal(summary.counts.unsupportedCount, 1);
  assert.equal(summary.fingerprints.fingerprint, 'fixture-fingerprint');
  for (const invalid of [{ ...descriptor, runtime: 'eda' }, { ...descriptor, provider: 'fixture-eda' }]) {
    await assert.rejects(executeHostAction(invalid, input, context), { code: 'HOST_RUNTIME_REQUIRED' });
  }
});

test('EDA host CLI rejects an unregistered Provider before requiring host state', () => {
  const provider = 'unregistered-test-provider';
  assert.ok(!Object.hasOwn(manifest.providers, provider));
  const result = runNode(join(ROOT, 'scripts', 'eda-host.mjs'), ['status', '--eda', provider]);
  assert.equal(result.status, 1, result.stderr || result.error?.message);
  const error = JSON.parse(result.stderr);
  assert.equal(error.status, 'error');
  assert.equal(error.success, false);
  assert.equal(error.error.code, 'EDA_HOST_ERROR');
  assert.equal(error.error.message, 'Unsupported EDA adapter: ' + provider);
});

test('public CLI catalogs expose every public Action and Workflow in the requested domain', () => {
  const domains = new Set([
    ...Object.values(manifest.actions).map(action => action.domain),
    ...Object.values(manifest.workflows ?? {}).map(workflow => workflow.domain),
  ]);
  for (const domain of domains) {
    const result = runNode(join(ROOT, 'scripts', 'action-runner.mjs'), ['list', '--domain', domain]);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const catalog = JSON.parse(result.stdout);
    const publicActions = Object.entries(manifest.actions)
      .filter(([, action]) => action.domain === domain && action.internal !== true).map(([name]) => name).sort();
    const workflows = Object.entries(manifest.workflows ?? {})
      .filter(([, workflow]) => workflow.domain === domain).map(([name]) => name).sort();
    assert.equal(catalog.domainFilter, domain);
    assert.deepEqual(names(catalog.actions), publicActions, domain);
    assert.deepEqual(names(catalog.workflows), workflows, domain);
    assert.ok(catalog.actions.every(action => action.domain === domain), domain);
    assert.ok(catalog.workflows.every(workflow => workflow.domain === domain), domain);
    assert.deepEqual(Object.keys(catalog.actionGroups), [domain]);
    assert.deepEqual(Object.keys(catalog.workflowGroups), [domain]);
    assert.deepEqual([...catalog.actionGroups[domain]].sort(), publicActions);
    assert.deepEqual([...catalog.workflowGroups[domain]].sort(), workflows);
  }
});

test('relative and absolute CLI entrypoints return the same catalog', () => {
  const args = ['list', '--domain', 'schematic'];
  const absolute = runNode(join(ROOT, 'scripts', 'action-runner.mjs'), args);
  const relative = runNode(join('scripts', 'action-runner.mjs'), args);
  assert.equal(absolute.status, 0, absolute.stderr || absolute.error?.message);
  assert.equal(relative.status, 0, relative.stderr || relative.error?.message);
  assert.deepEqual(JSON.parse(relative.stdout), JSON.parse(absolute.stdout));
});
