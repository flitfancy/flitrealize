import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarizeExecution, loadManifest } from '../scripts/action-runner.mjs';

const descriptor = { actionName: 'fixture', mode: 'apply', mutates: true };
for (const status of ['blocked', 'planned-with-blockers', 'generated-with-blockers',
  'resolved-with-blockers', 'mismatch', 'apply-failed', 'verify-failed',
  'rolled-back', 'rolled-back-targeted', 'rollback-incomplete', 'unknown-status']) {
  assert.equal(summarizeExecution({ success: true, result: { status } }, descriptor).ok, false, status);
}
for (const status of ['inspected', 'inspected-with-gaps', 'searched-with-gaps', 'planned-noop', 'applied', 'verified', 'conditional']) {
  assert.equal(summarizeExecution({ success: true, result: { status } }, descriptor).ok, true, status);
}
assert.equal(summarizeExecution({ success: true, result: { success: false, status: 'applied' } }, descriptor).ok, false);
assert.equal(summarizeExecution({ success: true, result: {} }, descriptor).ok, false);
assert.equal(summarizeExecution({ success: true, result: { status: 'rolled-back' } }, { ...descriptor, mode: 'rollback' }).ok, true);
const request = { requestId: 'request-fixture', sessionId: 'session-fixture', windowId: 'window-fixture', status: 'succeeded' };
const withRequest = summarizeExecution({ success: true, request, result: { status: 'applied' } }, descriptor);
assert.deepEqual(withRequest.request, request);
assert.equal(withRequest.bridge.sessionId, request.sessionId);
assert.equal(withRequest.bridge.windowId, request.windowId);
assert.equal(summarizeExecution({ success: true, request }, descriptor).ok, false);

const runner = fileURLToPath(new URL('../scripts/action-runner.mjs', import.meta.url));
const catalog = spawnSync(process.execPath, [runner, 'list', '--domain', 'schematic', '--full'], { encoding: 'utf8', windowsHide: true });
assert.equal(catalog.status, 0, catalog.stderr);
const full = JSON.parse(catalog.stdout), manifest = await loadManifest();
assert.ok(full.actions.some(a => a.name === 'schematic-component-place' && a.internal));
for (const workflow of full.workflows) {
  assert.deepEqual(workflow.phases, manifest.workflows[workflow.name].phases);
  for (const steps of Object.values(workflow.phases)) for (const step of steps) {
    const action = full.actions.find(a => a.name === step.action);
    assert.ok(action, step.action);
    assert.ok(action.modes.some(m => m.mode === step.mode));
    assert.equal(action.file, manifest.actions[step.action].file);
  }
}

const taskDir = await mkdtemp(join(tmpdir(), 'flitrealize-results-'));
try {
  const contract = JSON.parse(await readFile(new URL('./fixtures/schematic-contract/invalid-duplicate-designator.json', import.meta.url), 'utf8'));
  const inputFile = join(taskDir, 'input.json');
  await writeFile(inputFile, JSON.stringify({ mode: 'inspect', contract }));
  for (const fullOutput of [false, true]) {
    const reportFile = join(taskDir, `report-${fullOutput}.json`);
    const result = spawnSync(process.execPath, [runner, 'run', '--action', 'schematic-contract-audit',
      '--input-file', inputFile, '--report-file', reportFile, ...(fullOutput ? ['--full'] : [])], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(fullOutput ? output.result.status : output.status, 'blocked');
    if (!fullOutput) assert.equal(output.ok, false);
    assert.equal(JSON.parse(await readFile(reportFile, 'utf8')).response.result.status, 'blocked');
  }
} finally {
  await rm(taskDir, { recursive: true, force: true });
}
console.log('action result and discovery tests passed');
