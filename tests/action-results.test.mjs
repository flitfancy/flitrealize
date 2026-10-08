import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { summarizeExecution, loadManifest } from '../scripts/action-runner.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runner = join(root, 'scripts', 'action-runner.mjs');
const apply = { actionName: 'fixture', mode: 'apply', mutates: true };
const run = (args, options = {}) => spawnSync(process.execPath, [runner, ...args], {
  cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000, ...options,
});

test('blocked, failed, partial and unknown results cannot report successful completion', () => {
  for (const status of [
    'blocked', 'planned-with-blockers', 'generated-with-blockers', 'resolved-with-blockers',
    'mismatch', 'apply-failed', 'verify-failed', 'rolled-back', 'rolled-back-targeted',
    'rollback-incomplete', 'unknown', 'unknown-status',
  ]) {
    const summary = summarizeExecution({ success: true, result: { status } }, apply);
    assert.equal(summary.ok, false, status);
    assert.equal(summary.status, status);
  }
});

test('completed inspections, queries, plans, writes and verification retain their actual status', () => {
  for (const [mode, mutates, status] of [
    ['inspect', false, 'inspected'],
    ['inspect', false, 'inspected-with-gaps'],
    ['search', false, 'searched-with-gaps'],
    ['plan', false, 'planned-noop'],
    ['apply', true, 'applied'],
    ['verify', false, 'verified'],
    ['inspect', false, 'conditional'],
  ]) {
    const summary = summarizeExecution({ success: true, result: { status } },
      { actionName: 'fixture', mode, mutates });
    assert.equal(summary.ok, true, mode + '/' + status);
    assert.equal(summary.status, status);
    assert.equal(summary.mode, mode);
    assert.equal(summary.readOnly, !mutates);
  }
});

test('explicit transport or Action failure overrides a completion status without erasing saved facts', () => {
  for (const response of [
    { success: false, result: { success: true, status: 'applied' } },
    { success: true, result: { success: false, status: 'applied' } },
    { success: true, result: {} },
    { success: true, result: null },
  ]) {
    assert.equal(summarizeExecution(response, apply).ok, false, JSON.stringify(response));
  }
  const savedFailure = summarizeExecution({
    success: true, result: { status: 'verify-failed', saved: true },
  }, apply);
  assert.equal(savedFailure.ok, false);
  assert.equal(savedFailure.saved, true, 'failed verification must not erase an already completed save');
});

test('completed rollback does not turn a failed apply into success', () => {
  const response = { success: true, result: { status: 'rolled-back' } };
  assert.equal(summarizeExecution(response, apply).ok, false);
  const rollback = { ...apply, mode: 'rollback' };
  assert.equal(summarizeExecution(response, rollback).ok, true);
  for (const status of ['rollback-incomplete', 'rolled-back-targeted', 'unknown']) {
    assert.equal(summarizeExecution({ success: true, result: { status } }, rollback).ok, false, status);
  }
});

test('request receipts preserve Bridge identity but cannot substitute for an Action result', () => {
  const request = {
    requestId: 'request-fixture', sessionId: 'session-fixture',
    windowId: 'window-fixture', status: 'succeeded',
  };
  for (const withResult of [true, false]) {
    const response = { success: true, request, ...(withResult ? { result: { status: 'applied' } } : {}) };
    const before = structuredClone(response);
    const summary = summarizeExecution(response, apply);
    assert.equal(summary.ok, withResult);
    assert.deepEqual(summary.request, request);
    assert.equal(summary.bridge.sessionId, request.sessionId);
    assert.equal(summary.bridge.windowId, request.windowId);
    assert.deepEqual(response, before, 'summarizing a result must not rewrite its evidence');
  }
});

test('compact summaries retain target identity and expose pending routing plans', () => {
  const summary = summarizeExecution({
    success: true, result: { status: 'applied', target: { expectedDocumentUuid: 'pcb-fixture' } },
  }, apply);
  assert.equal(summary.documentUuid, 'pcb-fixture');
  for (const key of ['colorPlanRequest', 'widthPlanRequest']) {
    const planned = summarizeExecution({
      success: true, result: { status: 'generated', [key]: { mode: 'plan', rules: [] } },
    }, { actionName: 'pcb-routing-plan', mode: 'generate', mutates: false });
    assert.equal(planned.nextRequestAvailable, true, key);
    assert.equal(planned.readOnly, true, 'a pending plan does not mean the PCB was edited');
  }
  assert.equal(summary.nextRequestAvailable, false);
});

test('full CLI catalogs expose internal Actions and complete registered Workflow steps', async () => {
  const manifest = await loadManifest();
  const domains = new Set([
    ...Object.values(manifest.actions).map(action => action.domain),
    ...Object.values(manifest.workflows ?? {}).map(workflow => workflow.domain),
  ]);
  for (const domain of domains) {
    const result = run(['list', '--domain', domain, '--full']);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const catalog = JSON.parse(result.stdout);
    const expected = Object.entries(manifest.actions).filter(([, action]) => action.domain === domain);
    assert.deepEqual(catalog.actions.map(action => action.name).sort(), expected.map(([name]) => name).sort());
    for (const action of catalog.actions) {
      assert.equal(action.internal, manifest.actions[action.name].internal === true, action.name);
      assert.equal(action.file, manifest.actions[action.name].file, action.name);
    }
    const workflows = Object.entries(manifest.workflows ?? {}).filter(([, workflow]) => workflow.domain === domain);
    assert.deepEqual(catalog.workflows.map(workflow => workflow.name).sort(), workflows.map(([name]) => name).sort());
    for (const workflow of catalog.workflows) {
      assert.deepEqual(workflow.phases, manifest.workflows[workflow.name].phases, workflow.name);
      for (const steps of Object.values(workflow.phases)) {
        for (const step of steps) {
          const action = catalog.actions.find(item => item.name === step.action);
          assert.ok(action, workflow.name + ' needs ' + step.action);
          assert.ok(action.modes.some(mode => mode.mode === step.mode), step.action + '/' + step.mode);
        }
      }
    }
  }
});

test('blocked CLI results exit unsuccessfully and persist the same evidence in compact and full output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'flitrealize-results-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('flitrealize-results-'));
    await rm(directory, { recursive: true, force: true });
  });
  const contract = JSON.parse(await readFile(new URL('./fixtures/schematic-contract/invalid-duplicate-designator.json', import.meta.url), 'utf8'));
  const inputFile = join(directory, 'input.json');
  await writeFile(inputFile, JSON.stringify({ mode: 'inspect', contract }));
  const options = {
    cwd: directory,
    env: { ...process.env, FLITREALIZE_HOME: join(directory, 'state'),
      FLITREALIZE_BRIDGE_STATE_DIR: join(directory, 'bridge') },
  };
  for (const full of [false, true]) {
    const reportFile = join(directory, 'report-' + full + '.json');
    const result = run(['run', '--action', 'schematic-contract-audit',
      '--input-file', inputFile, '--project-root', directory, '--report-file', reportFile,
      ...(full ? ['--full'] : [])], options);
    assert.equal(result.status, 1, result.stdout + result.stderr || result.error?.message);
    const output = JSON.parse(result.stdout);
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    const payload = report.response.result;
    assert.equal(payload.status, 'blocked');
    assert.equal(payload.readOnly, true);
    assert.ok(payload.issues.some(issue => issue.code === 'DUPLICATE_IDENTITY' && issue.severity === 'blocker'));
    assert.equal(report.action, 'schematic-contract-audit');
    assert.equal(report.mode, 'inspect');
    assert.equal(report.mutates, false);
    assert.equal(report.projectRoot, directory);
    if (full) {
      assert.deepEqual(output, report.response, 'full output must retain the exact recorded response');
    } else {
      assert.equal(output.status, 'blocked');
      assert.equal(output.ok, false);
      assert.equal(output.readOnly, true);
      assert.equal(output.saved, null);
      assert.equal(output.reportFile, reportFile);
      assert.equal(output.counts.blockerCount, payload.counts.blockerCount);
      assert.equal(output.fingerprints.fingerprint, payload.fingerprint);
    }
  }
});
