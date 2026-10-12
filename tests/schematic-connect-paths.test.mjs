import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runSchematicConnect } from '../scripts/schematic-connect.mjs';
import { connectFixture } from './helpers/connect-fixture.mjs';

const options = fixture => ({ projectRoot: fixture.root, inputFile: fixture.inputFile, invoke: fixture.invoke });
const cli = fileURLToPath(new URL('../scripts/schematic-connect.mjs', import.meta.url));

async function nestedInput(fixture, contractFile) {
  const directory = join(fixture.root, 'config');
  await mkdir(directory);
  const inputFile = join(directory, 'input.json');
  await writeFile(inputFile, JSON.stringify({ ...fixture.input, contractFile }));
  return inputFile;
}

function assertPlanned(result, fixture) {
  assert.equal(result.status, 'planned', JSON.stringify(result.error));
  assert.equal(result.ok, true);
  assert.equal(result.readOnly, true);
  assert.deepEqual(fixture.eda.calls.filter(call => call.mutates), []);
  assert.equal(fixture.eda.saveCount, 0);
}

test('project mode reads nested input and Contract from the project even outside its working directory', async t => {
  const f = await connectFixture(t);
  const inputFile = await nestedInput(f, 'contract.json');
  // A different input-directory Contract must never win over the declared base.
  await writeFile(join(f.root, 'config', 'contract.json'), '{}');
  const result = await runSchematicConnect({ ...options(f), inputFile: join('config', 'input.json'), pathBase: 'project' });
  assertPlanned(result, f);
  assert.deepEqual(result.inputPaths, { pathBase: 'project', inputFile: await realpath(inputFile), contractFile: await realpath(join(f.root, 'contract.json')) });
});

test('default legacy mode preserves an input-directory Contract when a project-root file also exists', async t => {
  const f = await connectFixture(t);
  const inputFile = await nestedInput(f, 'contract.json');
  await writeFile(join(f.root, 'config', 'contract.json'), JSON.stringify(f.contract));
  await writeFile(join(f.root, 'contract.json'), '{}');
  const result = await runSchematicConnect({ ...options(f), inputFile });
  assertPlanned(result, f);
  assert.equal(result.inputPaths.pathBase, 'legacy');
  assert.equal(result.inputPaths.contractFile, join(f.root, 'config', 'contract.json'));
});

test('legacy mode keeps cwd-relative input and input-relative parent paths', async t => {
  const f = await connectFixture(t);
  await nestedInput(f, '../contract.json');
  const previousCwd = process.cwd();
  let result;
  try {
    process.chdir(f.root);
    result = await runSchematicConnect({ ...options(f), inputFile: join('config', 'input.json'), pathBase: 'legacy' });
  } finally {
    process.chdir(previousCwd);
  }
  assertPlanned(result, f);
  assert.equal(result.inputPaths.contractFile, join(f.root, 'contract.json'));
});

test('project mode accepts absolute project files and an embedded Contract', async t => {
  const f = await connectFixture(t);
  const inputFile = await nestedInput(f, join(f.root, 'contract.json'));
  assertPlanned(await runSchematicConnect({ ...options(f), inputFile, pathBase: 'project' }), f);
  const { contractFile, ...input } = f.input;
  await writeFile(inputFile, JSON.stringify({ ...input, contract: f.contract }));
  const result = await runSchematicConnect({ ...options(f), inputFile, pathBase: 'project' });
  assertPlanned(result, f);
  assert.equal(result.inputPaths.contractFile, null);
});

test('project mode rejects input or Contract outside the project before any provider call or evidence write', async t => {
  const f = await connectFixture(t), other = await connectFixture(t);
  const before = (await readdir(f.root)).sort();
  await assert.rejects(runSchematicConnect({ ...options(f), inputFile: other.inputFile, pathBase: 'project' }), { code: 'INPUT_OUTSIDE_PROJECT' });
  await assert.rejects(runSchematicConnect({ ...options(f), inputFile: relative(f.root, other.inputFile), pathBase: 'project' }), { code: 'INPUT_OUTSIDE_PROJECT' });
  f.input.contractFile = join(other.root, 'contract.json');
  await f.writeInput();
  await assert.rejects(runSchematicConnect({ ...options(f), pathBase: 'project' }), { code: 'INPUT_OUTSIDE_PROJECT' });
  assert.deepEqual(f.eda.calls, []);
  assert.deepEqual((await readdir(f.root)).sort(), before);
});

test('project mode checks real paths so a junction cannot redirect the Contract outside the project', async t => {
  const f = await connectFixture(t), other = await connectFixture(t);
  const link = join(f.root, 'external');
  await symlink(other.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    f.input.contractFile = join('external', 'contract.json');
    await f.writeInput();
    await assert.rejects(runSchematicConnect({ ...options(f), pathBase: 'project' }), { code: 'INPUT_OUTSIDE_PROJECT' });
    assert.deepEqual(f.eda.calls, []);
  } finally {
    await unlink(link);
  }
});

test('invalid path modes fail before provider calls or evidence writes instead of guessing a file', async t => {
  const f = await connectFixture(t);
  const before = (await readdir(f.root)).sort();
  await assert.rejects(runSchematicConnect({ ...options(f), pathBase: 'auto' }), { code: 'INVALID_PATH_BASE' });
  assert.deepEqual(f.eda.calls, []);
  assert.deepEqual((await readdir(f.root)).sort(), before);
});

test('the CLI documents and validates the path-base option without connecting to EDA', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--path-base project\|legacy/);
  const invalid = spawnSync(process.execPath, [cli, '--project-root', '.', '--input-file', 'missing.json', '--path-base', 'auto'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).code, 'INVALID_PATH_BASE');
});
