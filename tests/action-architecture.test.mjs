import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  defaultReportFile,
  executeHostAction,
  loadManifest,
  resolveActionRequest,
  summarizeExecution,
} from '../scripts/action-runner.mjs';
import { loadAction } from './helpers/action-harness.mjs';

const manifest = await loadManifest();
assert.equal(manifest.schemaVersion, 2);
assert.deepEqual(Object.keys(manifest.providers), ['easyeda-pro']);
assert.equal(manifest.providers['easyeda-pro'].kind, 'eda');

const ACTIONS_ROOT = new URL('../scripts/actions/', import.meta.url);
const actionFiles = [];
for (const entry of await readdir(ACTIONS_ROOT)) {
  if (entry.endsWith('.js')) {
    actionFiles.push(entry);
  } else {
    try {
      const subEntries = await readdir(new URL(entry + '/', ACTIONS_ROOT));
      for (const sub of subEntries) {
        if (sub.endsWith('.js')) actionFiles.push(entry + '/' + sub);
      }
    } catch { /* not a directory */ }
  }
}
actionFiles.sort();
const registeredFiles = Object.values(manifest.actions).map((action) => action.file).sort();
assert.deepEqual(registeredFiles, actionFiles);

for (const [name, action] of Object.entries(manifest.actions)) {
  assert.equal(typeof action.description, 'string', name);
  assert.equal(action.contractVersion, 1, name);
  assert.ok(['system', 'pcb', 'schematic'].includes(action.domain), name);
  assert.ok(['host', 'eda'].includes(action.runtime), name);
  if (action.runtime === 'host') assert.deepEqual(action.providers, [], name);
  else assert.deepEqual(action.providers, ['easyeda-pro'], name);
  assert.ok(action.modes[action.defaultMode], name);
  for (const [mode, contract] of Object.entries(action.modes)) {
    assert.equal(typeof contract.mutates, 'boolean', name + '/' + mode);
    if (contract.mutates) {
      assert.throws(
        () => resolveActionRequest(manifest, name, { mode }, false),
        (error) => error.code === 'WRITE_AUTHORIZATION_REQUIRED',
        name + '/' + mode,
      );
      assert.equal(resolveActionRequest(manifest, name, { mode }, true).mutates, true);
    } else {
      assert.equal(resolveActionRequest(manifest, name, { mode }, false).mutates, false);
    }
  }
}

const capabilityProbe = await loadAction('eda-capabilities', 'easyeda-pro');
const capabilityResult = await capabilityProbe({}, { mode: 'inspect' });
const declaredCapabilities = new Set(Object.keys(capabilityResult.capabilities));
for (const [name, action] of Object.entries(manifest.actions)) {
  for (const required of Object.values(action.requires ?? {}).flat()) {
    assert.ok(declaredCapabilities.has(required), name + ' requires undeclared capability ' + required);
  }
}

const readOnly = resolveActionRequest(manifest, 'pcb-ground-vias', { mode: 'plan' }, false);
assert.equal(readOnly.mutates, false);
assert.equal(readOnly.domain, 'pcb');
assert.equal(readOnly.runtime, 'eda');
assert.equal(readOnly.provider, 'easyeda-pro');

assert.throws(
  () => resolveActionRequest(manifest, 'pcb-ground-vias', { mode: 'plan' }, false, 'kicad'),
  (error) => error.code === 'ACTION_PROVIDER_UNSUPPORTED',
);

assert.throws(
  () => resolveActionRequest(manifest, 'pcb-ground-vias', { mode: 'apply' }, false),
  (error) => error.code === 'WRITE_AUTHORIZATION_REQUIRED',
);
const writable = resolveActionRequest(manifest, 'pcb-ground-vias', { mode: 'apply' }, true);
assert.equal(writable.mutates, true);

const reportName = basename(defaultReportFile('pcb-ground-vias', 'inspect'));
assert.match(
  reportName,
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-pcb-ground-vias-inspect-[0-9a-f-]{36}\.json$/,
);
assert.equal(reportName.includes(':'), false);

const summary = summarizeExecution({
  success: true,
  hostId: 'host-test',
  sessionId: 'session-test',
  windowId: 'window-test',
  result: {
    status: 'generated',
    readOnly: true,
    document: { uuid: 'pcb-test' },
    inspectionFingerprint: 'fnv1a32-11111111',
    selectedCount: 7,
    globalIssues: [],
    nextRequest: { mode: 'plan' },
  },
}, readOnly, 'report.json', '0.1.0-test.5');
assert.equal(summary.ok, true);
assert.equal(summary.schemaVersion, 2);
assert.equal(summary.skillVersion, '0.1.0-test.5');
assert.equal(summary.actionContractVersion, 1);
assert.equal(summary.domain, 'pcb');
assert.equal(summary.runtime, 'eda');
assert.equal(summary.provider, 'easyeda-pro');
assert.equal(summary.documentUuid, 'pcb-test');
assert.equal(summary.counts.selectedCount, 7);
assert.equal(summary.nextRequestAvailable, true);
assert.equal(summary.reportFile, 'report.json');

const hostDescriptor = {
  actionName: 'host-fixture',
  actionFile: fileURLToPath(new URL('./fixtures/host-action.js', import.meta.url)),
  contractVersion: 1,
  domain: 'system',
  runtime: 'host',
  provider: null,
  mode: 'inspect',
  mutates: false,
};
const hostResponse = await executeHostAction(
  hostDescriptor,
  { selected: ['U1', 'U2'], unsupported: ['hierarchical-bus'] },
  { projectRoot: 'fixture-project', skillVersion: 'test-version' },
);
const hostSummary = summarizeExecution(hostResponse, hostDescriptor, 'host-report.json', 'test-version');
assert.equal(hostSummary.ok, true);
assert.equal(hostSummary.runtime, 'host');
assert.equal(hostSummary.provider, null);
assert.equal(hostSummary.counts.selectedCount, 2);
assert.equal(hostSummary.counts.unsupportedCount, 1);
assert.equal(hostSummary.fingerprints.fingerprint, 'fixture-fingerprint');

const hostManifest = {
  schemaVersion: 2,
  providers: manifest.providers,
  actions: {
    'host-fixture': {
      file: 'schematic-contract-audit.js',
      description: 'Fixture local action.',
      contractVersion: 1,
      domain: 'system',
      runtime: 'host',
      providers: [],
      defaultMode: 'inspect',
      modes: { inspect: { mutates: false } },
    },
  },
};
assert.equal(resolveActionRequest(hostManifest, 'host-fixture', {}, false).provider, null);
assert.throws(
  () => resolveActionRequest(hostManifest, 'host-fixture', {}, false, 'easyeda-pro'),
  (error) => error.code === 'ACTION_PROVIDER_NOT_APPLICABLE',
);

const rejectedHostProvider = spawnSync(process.execPath, [
  fileURLToPath(new URL('../scripts/eda-host.mjs', import.meta.url)),
  'status',
  '--eda',
  'kicad',
], { encoding: 'utf8', windowsHide: true });
assert.equal(rejectedHostProvider.status, 1);
assert.match(rejectedHostProvider.stderr, /Unsupported EDA adapter: kicad/);

process.stdout.write('action architecture tests passed\n');
