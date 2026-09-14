import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('EDA host forwards read-only queries and preserves execute request handles on both output streams', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'flitrealize-host-request-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const adapter = join(directory, 'adapter'), profile = join(directory, 'profile');
  await mkdir(join(adapter, 'scripts'), { recursive: true });
  await writeFile(join(adapter, 'package.json'), JSON.stringify({ name: 'request-fixture' }));
  await writeFile(join(adapter, 'scripts', 'bridge-control.mjs'), `
const args = process.argv.slice(2);
const argument = flag => args[args.indexOf(flag) + 1];
const request = { requestId: argument('--request-id'), sessionId: args.includes('--session-id') ? argument('--session-id') : 'current-session', windowId: 'fixture-window', codeSha256: 'a'.repeat(64), status: process.env.FIXTURE_MODE === 'success' ? 'succeeded' : 'unknown' };
const result = args[0] === 'request' ? { success: true, request: { ...request, result: { retained: true } }, args } : process.env.FIXTURE_MODE === 'success' ? { success: true, result: { status: 'applied' }, request, args } : { status: 'error', success: false, error: { code: 'EXECUTION_UNKNOWN', message: 'Timed out after dispatch' }, executionOutcome: 'unknown', request, submissionReceipt: 'fixture-receipt.json' };
(process.env.FIXTURE_MODE === 'failure-stderr' ? process.stderr : process.stdout).write(JSON.stringify(result) + '\\n');
if (args[0] === 'execute' && process.env.FIXTURE_MODE !== 'success') process.exitCode = 1;
`);
  const host = fileURLToPath(new URL('../scripts/eda-host.mjs', import.meta.url));
  const invoke = (args, mode = 'success') => spawnSync(process.execPath, [host, ...args], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, FLITREALIZE_HOME: profile, FIXTURE_MODE: mode },
  });
  const registered = invoke(['register', '--eda', 'easyeda-pro', '--adapter-root', adapter]);
  assert.equal(registered.status, 0, registered.stderr);
  const originalProfile = await readFile(join(profile, 'host.json'), 'utf8');
  const requestId = randomUUID(), originalSession = randomUUID();
  const query = invoke(['request', '--eda', 'easyeda-pro', '--request-id', requestId, '--session-id', originalSession]);
  assert.equal(query.status, 0, query.stderr);
  const queried = JSON.parse(query.stdout);
  assert.equal(queried.request.requestId, requestId);
  assert.equal(queried.request.sessionId, originalSession);
  assert.deepEqual(queried.request.result, { retained: true });
  assert.equal(queried.args[0], 'request');
  assert.equal(queried.args.includes('ensure'), false);
  assert.equal(await readFile(join(profile, 'host.json'), 'utf8'), originalProfile);
  const blocked = invoke(['request', '--eda', 'easyeda-pro', '--request-id', requestId, '--session-id', originalSession, '--require-eda']);
  assert.equal(blocked.status, 1);
  assert.match(JSON.parse(blocked.stderr).error.message, /read-only/);

  const codeFile = join(directory, 'code.js');
  await writeFile(codeFile, 'return 1;');
  for (const args of [['--session-id', originalSession], ['--request-id'], ['--window-id'], ['--request-id', '--window-id', 'fixture']]) {
    const rejected = invoke(['execute', '--eda', 'easyeda-pro', '--code-file', codeFile, ...args]);
    assert.equal(rejected.status, 1);
    assert.match(JSON.parse(rejected.stderr).error.message, /requires a value|only supported by request/);
  }
  for (const mode of ['success', 'failure-stderr', 'failure-stdout']) {
    const completed = invoke(['execute', '--eda', 'easyeda-pro', '--code-file', codeFile, '--request-id', requestId], mode);
    const response = JSON.parse(completed.status === 0 ? completed.stdout : completed.stderr);
    assert.equal(completed.status, mode === 'success' ? 0 : 1, completed.stderr);
    assert.equal(response.request.requestId, requestId);
    assert.equal(response.request.sessionId, 'current-session');
    if (mode !== 'success') {
      assert.equal(response.error.code, 'EXECUTION_UNKNOWN');
      assert.equal(response.error.message, 'Timed out after dispatch');
      assert.equal(response.executionOutcome, 'unknown');
      assert.equal(response.submissionReceipt, 'fixture-receipt.json');
    }
  }
});
