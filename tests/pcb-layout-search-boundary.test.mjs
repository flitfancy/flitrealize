import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { prepareFixture, addIntent, filterRelation } from './helpers/pcb-layout-prepare-fixture.mjs';
import { prepareLayoutInputs } from '../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { compileModel, runSearch, validateSearchSettings } from '../scripts/pcb-layout/pcb-layout-solver-core.mjs';
import { compileSemanticCpSatProblem } from '../scripts/pcb-layout/pcb-layout-cpsat.mjs';
import { configureWeights } from '../scripts/pcb-layout/pcb-layout-weights.mjs';
import { loadLayoutProject } from '../scripts/pcb-layout/pcb-layout-project.mjs';
import { runLayoutSearch } from '../scripts/pcb-layout/pcb-layout-search.mjs';
import { runCatalog } from '../scripts/pcb-layout/pcb-layout-catalog-run.mjs';
import { main } from '../scripts/pcb-layout.mjs';

function input(change = () => {}) {
  const f = addIntent(prepareFixture(), filterRelation());
  f.config.hard.boardBounds = { minX: -100, minY: -100, maxX: 400, maxY: 300 };
  change(f);
  return f;
}
function model(f) {
  const prepared = prepareLayoutInputs(f);
  assert.equal(prepared.state.ready, true, JSON.stringify(prepared.diagnostics));
  return prepared.model;
}
async function project(t, f) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'layout-search-boundary-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'design'));
  f.snapshot.sourceKind = 'synthetic-example';
  f.config.contractFile = 'design/contract.json';
  f.config.mechanicalRulesFile = 'design/mechanical.json';
  for (const [file, data] of [['snapshot.json', f.snapshot], ['design/contract.json', f.contract], ['design/mechanical.json', f.mechanical], ['design/PCB_LAYOUT_CONSTRAINTS.v1.json', f.config]]) {
    await fs.writeFile(path.join(root, file), JSON.stringify(data));
  }
  return root;
}

test('common preparation and CP-SAT problem do not require a search object, profiles or iterations', () => {
  for (const change of [f => { delete f.config.search; }, f => { delete f.config.search.profiles; delete f.config.search.iterations; }]) {
    const f = input(change), original = structuredClone(f), m = model(f);
    const { problem } = compileSemanticCpSatProblem(m);
    assert.equal(problem.entities.length, 2);
    assert.deepEqual(f, original);
    assert.throws(() => validateSearchSettings(m), /INVALID_ITERATION_BUDGET/);
  }
});

test('search-only invalid values are rejected at search boundaries, not by common compilation', () => {
  const cases = [
    [f => { f.config.search.rotationMoveProbability = -1; }, /INVALID_MOVE_PROBABILITIES/],
    [f => { f.config.search.silkMoveProbability = 1; }, /INVALID_MOVE_PROBABILITIES/],
    [f => { f.config.search.neighborRadiusMil = -1; }, /INVALID_SEARCH_DISTANCE/],
    [f => { f.config.search.archiveSize = 1; }, /INVALID_ARCHIVE_SIZE/],
    [f => { f.config.search.reportAlternatives = 13; }, /INVALID_REPORT_ALTERNATIVES/],
    [f => { f.config.search.profiles = []; }, /MISSING_SEARCH_PROFILES/],
    [f => { f.config.search.profiles[0].seed = -1; }, /INVALID_SEARCH_SEED/],
    [f => { f.config.search.profiles[0].weightMultipliers = { unknown: 1 }; }, /INVALID_PROFILE_MULTIPLIER/],
  ];
  for (const [change, error] of cases) {
    const m = model(input(change));
    assert.equal(compileSemanticCpSatProblem(m).problem.entities.length, 2);
    assert.throws(() => validateSearchSettings(m, { requireProfiles: true }), error);
  }
});

test('malformed search container and legacy rotation constraints remain common errors', () => {
  for (const value of [null, [], 'unknown']) {
    const f = input(f => { f.config.search = value; });
    assert.equal(prepareLayoutInputs(f).state.ready, false);
    assert.throws(() => compileModel(f.snapshot, f.contract, f.config, f.mechanical), /INVALID_SEARCH_CONFIGURATION/);
  }
  const f = input(f => { f.config.search.rotationDeltas = [0, 180]; delete f.config.search.profiles; });
  assert.deepEqual(model(f).allowedRotations.get('U1'), [0, 180]);
  f.config.search.rotationDeltas = [45];
  assert.equal(prepareLayoutInputs(f).state.ready, false);
  assert.throws(() => compileModel(f.snapshot, f.contract, f.config, f.mechanical), /INVALID_ROTATION_OPTIONS/);
  const badNet = input(f => { delete f.config.search; f.snapshot.pads[0].net = 'OTHER'; });
  assert.equal(prepareLayoutInputs(badNet).state.ready, false);
});

test('public project load tolerates unused invalid profiles while legacy weight API stays strict', async t => {
  const f = input();
  f.config.search.profiles = [{ name: 'bad', seed: 0, weightMultipliers: { unknown: 1 } }];
  const root = await project(t, f), loaded = await loadLayoutProject(root);
  assert.deepEqual(loaded.config.search.profiles, f.config.search.profiles);
  const m = model({ ...f, config: loaded.config });
  assert.throws(() => validateSearchSettings(m, { requireProfiles: true }), /INVALID_PROFILE_MULTIPLIER/);
  assert.throws(() => configureWeights(f.config), /INVALID_PROFILE_MULTIPLIER/);
  f.config.search.profiles = [{ name: 'balanced', seed: 0, weightMultipliers: { bypass: 2 } }];
  assert.deepEqual(configureWeights(f.config), configureWeights(f.config, undefined, [], { validateSearchProfiles: false }));
});

test('standalone search APIs validate profiles and budgets before starting workers', async t => {
  const f = input(f => { f.config.search.profiles = []; });
  f.config.initialization = { mode: 'existing', count: 1, seed: 0, explorationStrength: 0, attemptsPerStart: 1 };
  const m = model(f), root = await project(t, f);
  for (const run of [runLayoutSearch, runCatalog]) {
    const dir = path.join(root, run.name); await fs.mkdir(dir);
    await assert.rejects(run({ model: m, ...f, root, projectRoot: root, dir, iterations: 2, log: () => {} }), /MISSING_SEARCH_PROFILES/);
    assert.equal((await fs.readdir(dir)).some(name => name === 'summary.json'), false);
  }
  const valid = model(input()), profile = valid.config.search.profiles[0];
  assert.throws(() => runSearch(valid, profile, 0), /INVALID_ITERATION_BUDGET/);
  assert.throws(() => runSearch(valid, { ...profile, seed: -1 }, 2), /INVALID_SEARCH_SEED/);
  assert.deepEqual(runSearch(valid, { ...profile, seed: 0 }, 2), runSearch(valid, { ...profile, seed: 0 }, 2));
});

test('public CP-SAT solve runs without unused search parameters', { skip: !process.env.FLITREALIZE_CPSAT_PYTHON && 'Numeric runtime required' }, async t => {
  for (const change of [f => { delete f.config.search; }, f => { f.config.search = { profiles: null, iterations: 0, rotationMoveProbability: -2 }; }]) {
    const f = input(change), root = await project(t, f);
    const result = await main(['--project-root', root, '--snapshot', path.join(root, 'snapshot.json'), '--mode', 'solve', '--backend', 'cpsat', '--python', process.env.FLITREALIZE_CPSAT_PYTHON, '--seconds', '1'], { log: () => {} });
    assert.equal(result.status, 'candidates-ready');
    assert.equal(result.candidateCount, 1);
    assert.equal(result.nativeWrites, 0);
  }
});
