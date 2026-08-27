import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';

import {
  loadManifest,
  resolveActionRequest,
  summarizeExecution,
} from '../scripts/action-runner.mjs';
import { loadAction } from './helpers/action-harness.mjs';

const manifest = await loadManifest();
assert.equal(manifest.schemaVersion, 1);

const actionFiles = (await readdir(new URL('../scripts/actions/', import.meta.url)))
  .filter((name) => name.endsWith('.js'))
  .sort();
const registeredFiles = Object.values(manifest.actions).map((action) => action.file).sort();
assert.deepEqual(registeredFiles, actionFiles);

for (const [name, action] of Object.entries(manifest.actions)) {
  assert.equal(typeof action.description, 'string', name);
  assert.ok(action.modes[action.defaultMode], name);
  for (const contract of Object.values(action.modes)) assert.equal(typeof contract.mutates, 'boolean', name);
}

const capabilityProbe = await loadAction('eda-capabilities');
const capabilityResult = await capabilityProbe({}, { mode: 'inspect' });
const declaredCapabilities = new Set(Object.keys(capabilityResult.capabilities));
for (const [name, action] of Object.entries(manifest.actions)) {
  for (const required of Object.values(action.requires ?? {}).flat()) {
    assert.ok(declaredCapabilities.has(required), name + ' requires undeclared capability ' + required);
  }
}

const readOnly = resolveActionRequest(manifest, 'pcb-ground-vias', { mode: 'plan' }, false);
assert.equal(readOnly.mutates, false);

assert.throws(
  () => resolveActionRequest(manifest, 'pcb-ground-vias', { mode: 'apply' }, false),
  (error) => error.code === 'WRITE_AUTHORIZATION_REQUIRED',
);
const writable = resolveActionRequest(manifest, 'pcb-ground-vias', { mode: 'apply' }, true);
assert.equal(writable.mutates, true);

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
assert.equal(summary.skillVersion, '0.1.0-test.5');
assert.equal(summary.documentUuid, 'pcb-test');
assert.equal(summary.counts.selectedCount, 7);
assert.equal(summary.nextRequestAvailable, true);
assert.equal(summary.reportFile, 'report.json');

process.stdout.write('action architecture tests passed\n');
