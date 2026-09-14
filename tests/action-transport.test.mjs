import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/action-runner.mjs';

test('runner persists unknown transport outcomes, partial output and the report path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flitrealize-transport-'));
  try {
    const inputFile = join(directory, 'input.json');
    await writeFile(inputFile, JSON.stringify({ mode: 'apply' }));
    for (const [index, completed] of [
      { error: Object.assign(new Error('output overflow'), { code: 'ENOBUFS' }), status: null, signal: 'SIGTERM', stdout: 'partial response', stderr: '' },
      { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), status: null, signal: 'SIGTERM', stdout: '', stderr: 'partial error' },
      { status: 0, stdout: 'truncated-json{', stderr: '' },
    ].entries()) {
      const reportFile = join(directory, `report-${index}.json`);
      const stub = mock.method(cp, 'spawnSync', () => completed);
      syncBuiltinESMExports();
      try {
        await assert.rejects(main(['run', '--action', 'pcb-net-color', '--input-file', inputFile,
          '--allow-write', '--project-root', directory, '--report-file', reportFile]), error => error.reportFile === reportFile);
        const report = JSON.parse(await readFile(reportFile, 'utf8'));
        assert.equal(report.mode, 'apply'); assert.equal(report.mutates, true);
        assert.equal(report.response.status, 'unknown'); assert.equal(report.response.executionOutcome, 'unknown');
        assert.equal(report.response.transport.stdout, completed.stdout);
        assert.equal(report.response.transport.stderr, completed.stderr);
        assert.equal(report.projectRoot, directory);
      } finally { stub.mock.restore(); syncBuiltinESMExports(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('runner keeps structured request handles and original errors in unknown reports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flitrealize-request-report-'));
  const request = { requestId: '204a01f3-f87c-4448-8c3f-edf52bb52a13', sessionId: 'bd99f1d9-05bb-4b8d-ab6e-b5d859dbf94e', windowId: 'fixture-window', codeSha256: 'a'.repeat(64), status: 'unknown' };
  try {
    const inputFile = join(directory, 'input.json');
    await writeFile(inputFile, JSON.stringify({ mode: 'apply' }));
    for (const overflow of [false, true]) {
      const reportFile = join(directory, `report-${overflow}.json`);
      const response = { status: 'error', success: false, error: { code: 'EXECUTION_UNKNOWN', message: 'Timed out after dispatch' }, executionOutcome: 'unknown', request, submissionReceipt: 'fixture-receipt.json' };
      const completed = { status: overflow ? null : 1, stdout: '', stderr: JSON.stringify(response), ...(overflow ? { error: Object.assign(new Error('output overflow'), { code: 'ENOBUFS' }) } : {}) };
      const stub = mock.method(cp, 'spawnSync', (_node, args) => {
        assert.ok(args.includes('--request-id'));
        assert.match(args[args.indexOf('--request-id') + 1], /^[0-9a-f-]{36}$/);
        return completed;
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(main(['run', '--action', 'pcb-net-color', '--input-file', inputFile,
          '--allow-write', '--report-file', reportFile]), error => {
          assert.equal(error.reportFile, reportFile);
          assert.equal(error.code, overflow ? 'ENOBUFS' : 'EXECUTION_UNKNOWN');
          assert.deepEqual(error.request, request);
          return true;
        });
        const report = JSON.parse(await readFile(reportFile, 'utf8'));
        assert.deepEqual(report.response.request, request);
        assert.equal(report.response.submissionReceipt, 'fixture-receipt.json');
        assert.equal(report.response.executionOutcome, 'unknown');
        assert.equal(report.response.error.code, overflow ? 'ENOBUFS' : 'EXECUTION_UNKNOWN');
        assert.equal(report.mutates, true);
      } finally { stub.mock.restore(); syncBuiltinESMExports(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
