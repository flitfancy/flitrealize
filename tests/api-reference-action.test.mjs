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
  { input: { mode: 'search', query: 'get', domain: 'pcb', class: 'PCB_PrimitiveVia', kind: 'method', limit: 2, offset: 2 }, status: 'matched' },
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
        if (scenario.input.class) {
          assert.equal(payload.class, scenario.input.class);
          assert.equal(payload.domain, scenario.input.domain);
          assert.equal(payload.offset, scenario.input.offset);
          assert.equal(payload.results.length, scenario.input.limit);
          assert.equal(payload.hasMore, true);
          assert.ok(payload.results.every(item => item.entryId === scenario.input.class));
        } else {
          assert.equal(payload.results[0].id, 'IPCB_PrimitiveComponent#getallpins');
          assert.equal(Object.hasOwn(payload, 'offset'), false);
        }
      } else {
        assert.equal(payload.id, scenario.input.id);
        assert.equal(payload.signature, 'function getAllPins(): Promise<Array<IPCB_PrimitiveComponentPad>>;');
      }
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('flitrealize-api-action-'));
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('host query action preserves an exhausted page and reports empty strict-filter results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flitrealize-api-action-'));
  try {
    for (const [index, input, expectedExit, expectedStatus] of [
      [0, { mode: 'search', query: 'get', domain: 'pcb', offset: Number.MAX_SAFE_INTEGER }, 0, 'matched'],
      [1, { mode: 'search', query: 'get', domain: 'library', class: 'PCB_PrimitiveVia', offset: 0 }, 1, 'no-match'],
    ]) {
      const inputFile = join(directory, 'input-' + index + '.json'), reportFile = join(directory, 'report-' + index + '.json');
      await writeFile(inputFile, JSON.stringify(input));
      const completed = spawnSync(process.execPath, [runner, 'run', '--action', 'api-reference', '--input-file', inputFile, '--report-file', reportFile], { cwd: directory, encoding: 'utf8', windowsHide: true });
      assert.equal(completed.status, expectedExit, completed.stdout + completed.stderr);
      const payload = JSON.parse(await readFile(reportFile, 'utf8')).response.result;
      assert.equal(payload.status, expectedStatus);
      assert.deepEqual(payload.results, []);
      assert.equal(payload.hasMore, false);
      assert.equal(payload.offset, input.offset);
    }
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('flitrealize-api-action-'));
    await rm(directory, { recursive: true, force: true });
  }
});
