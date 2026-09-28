import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fixture } from './pcb-layout-execution-fixture.mjs';

const installed = process.argv[2], execute = promisify(execFile);
const temporary = await fs.mkdtemp(path.join(tmpdir(), 'layout-release-smoke-'));
const cleanup = [];
try {
  const project = path.join(temporary, 'example');
  await fs.cp(path.join(installed, 'assets/pcb-layout/minimal-project'), project, { recursive: true });
  for (const mode of ['prepare', 'solve']) {
    const args = [path.join(installed, 'scripts/pcb-layout.mjs'), '--project-root', project,
      '--snapshot', path.join(project, 'snapshot.json'), '--mode', mode];
    if (mode === 'solve') args.push('--iterations', '4', '--starts', '1');
    const result = await execute(process.execPath, args, { cwd: temporary });
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(output.status, mode === 'prepare' ? 'inputs-ready' : 'candidates-ready-not-applied');
    const manifest = JSON.parse(await fs.readFile(path.join(output.report, 'manifest.json')));
    assert.equal(manifest.synthetic, true);
    assert.ok(manifest.engine.implementationHash);
  }
  const queried = await execute(process.execPath, [path.join(installed, 'scripts/api-reference.mjs'), 'show', '--id', 'SCH_Netlist#getNetlist'], { cwd: temporary });
  assert.ok(JSON.parse(queried.stdout).statusFlags.includes('deprecated'));
  const execution = await import(pathToFileURL(path.join(installed, 'scripts/pcb-layout/pcb-layout-execution.mjs')));
  const live = await fixture({ after: fn => cleanup.push(fn) });
  const snapshot = await execution.inspectLayout(live.options());
  live.control.saveResult = false;
  const failedSave = await execution.applyLayout({ ...live.options(), snapshot, plan: live.plan(snapshot) });
  assert.equal(failedSave.status, 'save-failed');
  const modifications = live.control.modifications.length;
  live.control.saveResult = true;
  const resumed = await execution.resumeLayoutSave({ ...live.options(), resumeSave: failedSave.reportFile });
  assert.equal(resumed.status, 'verified');
  assert.equal(resumed.provider, 'easyeda-pro');
  assert.equal(live.control.modifications.length, modifications);
  assert.equal(live.calls.filter(phase => phase === 'apply').length, 1);
  console.log('Packaged layout input, solve, API lookup and save recovery passed (isolated simulation).');
} finally {
  for (const fn of cleanup.reverse()) await fn();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith('layout-release-smoke-'));
  await fs.rm(temporary, { recursive: true, force: true });
}
