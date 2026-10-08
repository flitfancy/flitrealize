import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
async function importableCliScripts(directory) {
  const scripts = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) scripts.push(...await importableCliScripts(file));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      const source = await readFile(file, 'utf8');
      // Discover the CLI/module interface, independently of its guard implementation.
      if (source.startsWith('#!/usr/bin/env node') && /^export\s/m.test(source)) scripts.push(file);
    }
  }
  return scripts.sort();
}
const scripts = (await importableCliScripts(join(root, 'scripts'))).map(file => relative(root, file));
assert.ok(scripts.length > 0, 'discover importable CLI entrypoints');
let directory, linked, importer;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'flitrealize-cli-links-'));
  linked = join(directory, 'linked skill');
  await symlink(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
  importer = join(directory, 'import-cli.mjs');
  await writeFile(importer, "await import(process.argv[2]); console.log('imported');\n");
});
after(async () => {
  // Unlink the alias itself before recursively removing our temporary directory.
  if (linked) await unlink(linked).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (directory) {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('flitrealize-cli-links-'));
    await rm(directory, { recursive: true, force: true });
  }
});
const run = args => spawnSync(process.execPath, args, {
  cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10000,
  env: { ...process.env, FLITREALIZE_HOME: join(directory, 'unused-home') },
});

for (const script of scripts) {
  test(`${script} executes through a linked installation just like its real path`, () => {
    // The Action runner exposes read-only discovery instead of --help.
    const args = basename(script) === 'action-runner.mjs' ? ['list', '--domain', 'system'] : ['--help'];
    const direct = run([join(root, script), ...args]);
    assert.equal(direct.status, 0, direct.stderr);
    assert.ok(direct.stdout.trim(), 'the direct CLI has observable output');
    const aliases = [join(linked, script), relative(directory, join(linked, script))];
    // Node's format loader treats the extension as case-sensitive even on
    // Windows. Exercise path casing while retaining the recognized .mjs suffix.
    if (process.platform === 'win32') aliases.push(join(linked, script).slice(0, -4).toUpperCase() + '.mjs');
    for (const entry of aliases) {
      const alias = run([entry, ...args]);
      assert.equal(alias.status, 0, alias.stderr);
      assert.equal(alias.stdout, direct.stdout, 'the linked CLI must actually execute');
      assert.equal(alias.stderr, direct.stderr);
    }
  });
}

test('linked API lookup performs a real read-only query', async () => {
  const result = run([join(linked, 'scripts/api-reference.mjs'), 'search', '--query', '焊盘', '--limit', '1']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), 'query must return its result');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'matched');
  assert.equal(payload.results.length, 1);
  assert.deepEqual((await readdir(directory)).sort(), ['import-cli.mjs', 'linked skill']);
});

test('importing the CLI modules does not run their commands', async () => {
  for (const script of scripts) {
    const url = pathToFileURL(join(linked, script)).href;
    const imported = run([importer, url]);
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout.trim(), 'imported');
    assert.equal(imported.stderr, '');
  }
  assert.deepEqual((await readdir(directory)).sort(), ['import-cli.mjs', 'linked skill']);
});
