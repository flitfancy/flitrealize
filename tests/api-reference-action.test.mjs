import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeExecution } from '../scripts/action-runner.mjs';

const runner = fileURLToPath(new URL('../scripts/action-runner.mjs', import.meta.url));
const descriptor = { actionName: 'api-reference', mode: 'search', mutates: false };

test('API reference summaries accept only the matching query completion status', () => {
  for (const [mode, status] of [['search', 'matched'], ['show', 'found']]) {
    const response = { success: true, result: { status } };
    const summary = summarizeExecution(response, { ...descriptor, mode });
    assert.equal(summary.ok, true, `${mode}: ${status}`);
    assert.equal(summary.status, status);
    assert.equal(response.result.status, status);
    assert.equal(summarizeExecution({ ...response, success: false }, { ...descriptor, mode }).ok, false);
    assert.equal(summarizeExecution({ success: true, result: { status, success: false } }, { ...descriptor, mode }).ok, false);
  }
});

test('query completion statuses do not mask other actions, modes, or unsuccessful results', () => {
  for (const mode of ['search', 'show', 'apply', undefined]) {
    for (const status of ['matched', 'found']) {
      assert.equal(summarizeExecution({ success: true, result: { status } },
        { actionName: 'fixture', mode, mutates: false }).ok, false, `fixture ${mode}: ${status}`);
      if ((mode === 'search' && status === 'matched') || (mode === 'show' && status === 'found')) continue;
      assert.equal(summarizeExecution({ success: true, result: { status } },
        { ...descriptor, mode }).ok, false, `api-reference ${mode}: ${status}`);
    }
    for (const status of ['blocked', 'unknown', 'ambiguous', 'not-found', 'no-match']) {
      assert.equal(summarizeExecution({ success: true, result: { status } },
        { ...descriptor, mode }).ok, false, `api-reference ${mode}: ${status}`);
    }
  }
});

for (const scenario of [
  { input: { mode: 'search', query: 'getAllPins', kind: 'method', limit: 4 }, status: 'matched' },
  { input: { mode: 'show', id: 'IPCB_PrimitiveComponent#getallpins' }, status: 'found' },
]) {
  test(`action-runner API reference ${scenario.input.mode} exits successfully and saves query data`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flitrealize-api-action-'));
    try {
      const inputFile = join(directory, 'input.json');
      const reportFile = join(directory, 'report.json');
      await writeFile(inputFile, JSON.stringify(scenario.input));
      const completed = spawnSync(process.execPath, [runner, 'run', '--action', 'api-reference',
        '--input-file', inputFile, '--report-file', reportFile], {
        cwd: directory, encoding: 'utf8', windowsHide: true,
      });
      assert.equal(completed.status, 0, completed.stdout + completed.stderr);
      const summary = JSON.parse(completed.stdout);
      assert.equal(summary.ok, true);
      assert.equal(summary.status, scenario.status);
      assert.equal(summary.action, 'api-reference');
      assert.equal(summary.mode, scenario.input.mode);
      const report = JSON.parse(await readFile(reportFile, 'utf8'));
      assert.equal(report.response.success, true);
      const payload = report.response.result;
      assert.equal(payload.status, scenario.status);
      if (scenario.input.mode === 'search') {
        assert.equal(payload.query, scenario.input.query);
        assert.ok(payload.total > 0);
        assert.equal(payload.results[0].id, 'IPCB_PrimitiveComponent#getallpins');
      } else {
        assert.equal(payload.id, scenario.input.id);
        assert.equal(payload.signature, 'public getAllPins(): Promise<Array<IPCB_PrimitiveComponentPad>>;');
      }
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('flitrealize-api-action-'));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
