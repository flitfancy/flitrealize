import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { prepareFixture, addIntent, filterRelation } from '../helpers/pcb-layout-prepare-fixture.mjs';
import { prepareLayoutInputs } from '../../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { inspectCandidate } from '../../scripts/pcb-layout/pcb-layout-solver-core.mjs';
import { runLayoutSearch } from '../../scripts/pcb-layout/pcb-layout-search.mjs';
import { runCatalog } from '../../scripts/pcb-layout/pcb-layout-catalog-run.mjs';
import { writeRunConfiguration } from '../../scripts/pcb-layout/pcb-layout-run.mjs';

async function temporaryProject(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'layout-run-contract-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(tmpdir()));
    assert.ok(path.basename(root).startsWith('layout-run-contract-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function input(root, dir, configure = () => {}) {
  const fixture = addIntent(prepareFixture(), filterRelation());
  fixture.config.initialization = { mode: 'existing', count: 1, seed: 31, explorationStrength: 0, packingGapMil: 10, attemptsPerStart: 1, maxRepairMil: 100 };
  fixture.config.search.catalogGridMil = 9;
  configure(fixture.config);
  const prepared = prepareLayoutInputs(fixture);
  assert.equal(prepared.state.ready, true);
  return { model: prepared.model, snapshot: fixture.snapshot, contract: prepared.contract,
    config: prepared.config, mechanical: prepared.mechanical, root, projectRoot: root, dir,
    fingerprints: { fixture: 'frozen' }, engine: { fixture: 'frozen' }, inputReceipt: prepared.receipt,
    iterations: 16, count: 1, log: () => {} };
}

async function reportFiles(dir) {
  const files = {};
  for (const name of (await fs.readdir(dir)).sort()) {
    files[name] = (await fs.readFile(path.join(dir, name), 'utf8')).replaceAll(dir, '<REPORT>');
  }
  return files;
}

for (const [name, run] of [['search', runLayoutSearch], ['catalog', runCatalog]]) {
  test(`${name} standalone fallback and supplied baseline keep identical results and report files`, async t => {
    const root = await temporaryProject(t);
    const standalone = path.join(root, 'standalone', 'run'), reused = path.join(root, 'reused', 'run');
    await fs.mkdir(standalone, { recursive: true });
    await fs.mkdir(reused, { recursive: true });
    const originalWrite = fs.writeFile, writes = [];
    const spy = mock.method(fs, 'writeFile', function (file, ...args) {
      if (['effective-config.json', 'effective-weights.json'].includes(path.basename(String(file)))) writes.push(String(file));
      return originalWrite.call(this, file, ...args);
    });
    t.after(() => spy.mock.restore());
    const standaloneOptions = input(root, standalone), standaloneResult = await run(standaloneOptions);
    assert.equal(writes.filter(file => path.dirname(file) === standalone).length, 2);
    const reusedOptions = input(root, reused);
    const baseline = inspectCandidate(reusedOptions.model);
    await writeRunConfiguration(reused, reusedOptions.config);
    const writesBeforeRun = writes.length;
    const reusedResult = await run({ ...reusedOptions, baseline, configurationWritten: true });
    assert.equal(writes.length, writesBeforeRun, 'the caller owns configuration already written');
    assert.deepEqual(reusedResult, standaloneResult);
    assert.deepEqual(await reportFiles(reused), await reportFiles(standalone));
    assert.equal(reusedResult.nativeWrites, 0);
    assert.equal(reusedResult.applied, false);
  });
}

for (const [name, run, configure, overrides, error] of [
  ['search', runLayoutSearch, () => {}, { iterations: 0 }, /INVALID_ITERATION_BUDGET/],
  ['catalog', runCatalog, config => { config.search.catalogGridMil = -1; }, {}, /INVALID_CATALOG_GRID/],
]) {
  test(`${name} failure keeps the standalone evidence contract when a baseline is supplied`, async t => {
    const root = await temporaryProject(t);
    const standalone = path.join(root, 'standalone', 'run'), reused = path.join(root, 'reused', 'run');
    await fs.mkdir(standalone, { recursive: true });
    await fs.mkdir(reused, { recursive: true });
    const first = input(root, standalone, configure), second = input(root, reused, configure);
    await assert.rejects(run({ ...first, ...overrides }), error);
    await assert.rejects(run({ ...second, ...overrides, baseline: inspectCandidate(second.model) }), error);
    const originalFiles = await reportFiles(standalone);
    assert.deepEqual(await reportFiles(reused), originalFiles);
    assert.equal(Object.hasOwn(originalFiles, 'effective-config.json'), false);
    assert.equal(Object.hasOwn(originalFiles, 'effective-weights.json'), false);
    assert.equal(Object.hasOwn(originalFiles, 'summary.json'), false);
  });
}
