import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture as liveFixture } from './helpers/pcb-layout-execution-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = [...new Set([process.env.PYTHON, 'python3', 'python'].filter(Boolean))]
  .find(command => spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0);

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(file));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}

test('runtime packaging includes the complete layout engine and runs from an isolated copy', { skip: !python && 'Python is required to query the release inventory; set PYTHON to its executable.' }, async t => {
  const inventory = spawnSync(python, ['-c', [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("package_release", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'print(json.dumps([p.relative_to(module.ROOT).as_posix() for p in module.runtime_files()]))',
  ].join('\n'), join(root, 'scripts/package_release.py')], { encoding: 'utf8', windowsHide: true });
  assert.equal(inventory.status, 0, inventory.stderr || inventory.error?.message);
  const entries = JSON.parse(inventory.stdout);
  const packaged = new Set(entries);
  assert.equal(packaged.size, entries.length, 'runtime inventory contains no duplicate entries');
  for (const file of [...await filesUnder(join(root, 'scripts/pcb-layout')), ...await filesUnder(join(root, 'scripts/providers'))]) {
    if (/\.(mjs|js)$/.test(file)) assert.ok(packaged.has(relative(root, file).replaceAll('\\', '/')), file);
  }
  for (const file of ['scripts/pcb-layout.mjs', 'scripts/actions/pcb-layout-prepare.js', 'schemas/pcb-layout-intent.v1.schema.json', 'references/pcb-layout-inputs.md', 'scripts/api-reference.mjs', 'scripts/actions/api-reference.js', 'adapters/easyeda-pro/api-reference/corpus.json', 'adapters/easyeda-pro/api-reference/provenance.json']) {
    assert.ok(packaged.has(file), file);
  }
  assert.ok(!entries.some(file => /(^|\/)(tests|evidence|node_modules)(\/|$)/.test(file) || file.startsWith('design/')), 'project data, test fixtures and dependencies are not runtime assets');
  for (const file of entries.filter(file => file.startsWith('assets/pcb-layout/'))) assert.ok(file.startsWith('assets/pcb-layout/minimal-project/'), 'only the explicit synthetic example is packaged');
  assert.ok(packaged.has('assets/pcb-layout/minimal-project/snapshot.json'));

  const temporary = await mkdtemp(join(tmpdir(), 'flitrealize-layout-package-'));
  try {
    const installed = join(temporary, 'installed-skill');
    for (const entry of entries) {
      const target = join(installed, entry);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(root, entry), target);
    }
    const execute = (script, args) => spawnSync(process.execPath, [join(installed, script), ...args], {
      cwd: temporary, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, FLITREALIZE_HOME: join(temporary, 'unregistered-state') },
    });
    const help = execute('scripts/pcb-layout.mjs', ['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /prepare\|solve\|apply/);
    assert.match(help.stdout, /--project-root/);
    const lookup = execute('scripts/api-reference.mjs', ['show', '--id', 'SCH_Netlist#getNetlist']);
    assert.equal(lookup.status, 0, lookup.stderr);
    const lookedUp = JSON.parse(lookup.stdout);
    assert.equal(lookedUp.readOnly, true);
    assert.equal(lookedUp.status, 'found');
    assert.ok(lookedUp.statusFlags.includes('deprecated'));

    const discovery = execute('scripts/action-runner.mjs', ['list', '--domain', 'pcb', '--query', '布局输入']);
    assert.equal(discovery.status, 0, discovery.stderr);
    const result = JSON.parse(discovery.stdout);
    assert.equal(result.readOnly, true);
    const action = result.actions.find(item => item.name === 'pcb-layout-prepare');
    assert.equal(action.entrypoint.file, 'scripts/pcb-layout.mjs');
    assert.deepEqual(action.modes, [{ mode: 'prepare', mutates: false }]);

    const runner = await import(pathToFileURL(join(installed, 'scripts/action-runner.mjs')));
    const manifest = await runner.loadManifest();
    assert.throws(() => runner.resolveActionRequest(manifest, 'pcb-layout-prepare', { mode: 'solve' }, false), { code: 'UNSUPPORTED_ACTION_MODE' });
    const descriptor = runner.resolveActionRequest(manifest, 'pcb-layout-prepare', {}, false);
    const prepared = await runner.executeHostAction(descriptor, {}, {});
    assert.equal(prepared.result.status, 'blocked');
    assert.equal(prepared.result.state.ready, false);
    assert.ok(prepared.result.diagnostics.length > 0);
    assert.deepEqual(await readdir(temporary), ['installed-skill'], 'help, discovery and invalid host preparation do not create EDA state or project reports');
    const execution = await import(pathToFileURL(join(installed, 'scripts/pcb-layout/pcb-layout-execution.mjs')));
    const live = await liveFixture(t);
    const snapshot = await execution.inspectLayout(live.options());
    const applied = await execution.applyLayout({ ...live.options(), snapshot, plan: live.plan(snapshot) });
    assert.equal(applied.status, 'verified');
    assert.equal(applied.provider, 'easyeda-pro');
    assert.equal(live.control.saves, 1);
    assert.equal(live.components[0].X, 100);
  } finally {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    assert.ok(basename(temporary).startsWith('flitrealize-layout-package-'));
    await rm(temporary, { recursive: true, force: true });
  }
});
