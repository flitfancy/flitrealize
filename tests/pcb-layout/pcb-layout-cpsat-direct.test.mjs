import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareLayoutInputs } from '../../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { scopeLayoutModel } from '../../scripts/pcb-layout/pcb-layout-scope.mjs';
import { inspectCandidate } from '../../scripts/pcb-layout/pcb-layout-solver-core.mjs';
import { compileSemanticCpSatProblem, decodeCpSatCandidate, executeCpSat, runCpsatLayout } from '../../scripts/pcb-layout/pcb-layout-cpsat.mjs';
import { prepareFixture, filterRelation, addIntent } from '../helpers/pcb-layout-prepare-fixture.mjs';

const runtime = { pythonPath: process.env.FLITREALIZE_CPSAT_PYTHON };
const skip = !runtime.pythonPath && 'Set FLITREALIZE_CPSAT_PYTHON to an OR-Tools Python runtime.';
const settings = { timeLimitSeconds: 2, workers: 1, resolutionMil: .1, seed: 0 };
const box = (x, y, radius) => ({ minX: x-radius, maxX: x+radius, minY: y-radius, maxY: y+radius });

function rotationModel({ x = 100, rotation = 0, maxMil = 10.5 } = {}) {
  const fixture = addIntent(prepareFixture(x), filterRelation());
  fixture.config.hard.boardBounds = { minX: -50, minY: -50, maxX: 150, maxY: 100 };
  fixture.config.hard.fixed = [{ ref: 'U1', x: 0, y: 0, rotation: 0 }];
  fixture.config.hard.pinDistanceLimits = [{ id: 'near-pin', a: 'U1', aPin: '1', b: 'C1', bPin: '1', net: 'SUPPLY', maxMil }];
  fixture.config.assemblyRules = { schemaVersion: 1, profile: { id: 'test', label: 'Synthetic one-mil margin' }, source: { title: 'Synthetic rotation fixture', url: 'https://example.test/cpsat-direct' }, rules: [{ id: 'synthetic-margin', footprintNames: ['synthetic-package'], marginMm: .0254, basis: 'Synthetic one-mil assembly margin for the rotation regression.' }], independentPads: { marginMm: 0, basis: 'No independent pads in this fixture.' } };
  fixture.config.spacingPolicy = { schemaVersion: 2, mode: 'active', source: 'assembly-courtyard', geometry: 'physical', bandRatios: { rejectBelow: .75, neutralMin: .9, neutralMax: 1.2 }, requirements: [] };
  for (const component of fixture.snapshot.components) {
    if (component.ref === 'C1') component.rotation = rotation;
    const pad = fixture.snapshot.pads.find(p => p.owner === component.ref);
    pad.x = component.x + (component.rotation === 180 ? -9 : 9);
    pad.bbox = box(pad.x, pad.y, 1);
  }
  fixture.config.roughLayoutPolicy={schemaVersion:1,clearanceMil:8}; // Explicit stage override keeps this pad-limit rotation fixture feasible.
  const prepared = prepareLayoutInputs(fixture);
  assert.equal(prepared.state.ready, true, JSON.stringify(prepared.diagnostics));
  return scopeLayoutModel(prepared.model, { includeLabels: false });
}

test('direct runtime rejects retired cold controls and restricted start problems', async () => {
  const model = rotationModel();
  for (const option of [{ coldStart: true }, { coldStart: false }, { coldSeconds: 1 }]) {
    await assert.rejects(runCpsatLayout(model, settings, option), /OBSOLETE_COLD_START_OPTIONS/);
  }
  const { problem } = compileSemanticCpSatProblem(model, settings, { includeLabels: false });
  assert.equal(problem.skipFeasibilityPhase, true);
  await assert.rejects(runCpsatLayout(model, settings, { problem: { ...problem, searchFirstVariantOnly: true } }), /RESTRICTED_START_PROBLEM/);
});

test('single-variant infeasibility does not prevent a valid full-domain solution', { skip }, async () => {
  const model = rotationModel(), { problem } = compileSemanticCpSatProblem(model, settings, { includeLabels: false });
  const restricted = await executeCpSat({ ...structuredClone(problem), feasibilityOnly: true, searchFirstVariantOnly: true }, runtime);
  assert.equal(restricted.status, 'INFEASIBLE');
  const progress = [], result = await runCpsatLayout(model, settings, { includeLabels: false, runtime, onProgress: event => progress.push(event) });
  assert.equal(result.status, 'candidates-ready', JSON.stringify(result.runs));
  assert.equal(result.candidates[0].validation.valid, true);
  assert.equal(result.runs.length, 1);
  assert.equal(Object.hasOwn(result.runs[0], 'coldStatus'), false);
  assert.equal(progress.filter(p => p.progress === 'run-complete').length, 1);
  assert.ok(progress.some(p => p.event === 'incumbent'));
  assert.equal(result.runs[0].solver.solverTimeBudgetSeconds, settings.timeLimitSeconds);
  assert.equal(result.runs[0].solver.initialHintCount, 0);
  assert.equal(result.runs[0].solver.internallyGeneratedHintCount, 0);
  assert.equal(result.problem.assembly, true);
  assert.equal(result.problem.limits[0].maxMil, 10.5);
  assert.deepEqual(result.problem.pairs, problem.pairs);
});

for (const [name, baseline, expectedValid] of [
  ['feasible baseline', { x: 28, rotation: 180 }, true],
  ['infeasible baseline', { x: 0, rotation: 0 }, false],
  ['no initial layout seed', { x: 100, rotation: 0 }, false]
]) test('direct runtime accepts ' + name, { skip }, async () => {
  const model = rotationModel(baseline), before = structuredClone(model.snapshot);
  assert.equal(inspectCandidate(model).validation.valid, expectedValid);
  const result = await runCpsatLayout(model, settings, { includeLabels: false, runtime });
  assert.equal(result.status, 'candidates-ready', JSON.stringify(result.runs));
  assert.equal(result.candidates[0].validation.valid, true);
  assert.equal(result.runs[0].solver.externalInitialHintCount, 0);
  assert.ok(result.problem.entities.every(e => e.fixed || e.base.x === 0 && e.base.y === 0));
  assert.deepEqual(model.snapshot, before);
});

test('full-domain infeasibility is reported once without retrying another seed', { skip }, async () => {
  const result = await runCpsatLayout(rotationModel({ maxMil: 1 }), settings, { includeLabels: false, candidateCount: 3, maxRuns: 3, runtime });
  assert.equal(result.status, 'no-candidate');
  assert.equal(result.noCandidateReason, 'infeasible');
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].status, 'INFEASIBLE');
});

test('solver budget exhaustion remains distinct from a proof of infeasibility', { skip }, async () => {
  const model = rotationModel(), { problem } = compileSemanticCpSatProblem(model, settings, { includeLabels: false });
  const template = problem.entities.find(e => !e.fixed);
  problem.board = { minX: -500, minY: -500, maxX: 1500, maxY: 1500 };
  problem.entities = Array.from({ length: 32 }, (_, i) => ({ ...structuredClone(template), ref: 'P'+i, id: 'P'+i, fixed: false }));
  problem.pairs = []; problem.limits = []; problem.links = []; problem.nets = []; problem.semanticGroups = []; delete problem.blockLayout;
  for (let i = 0; i < 32; i++) for (let j = i+1; j < 32; j++) {
    const a = problem.entities[i], b = problem.entities[j], id = Object.keys(template.variants[0].pads)[0];
    problem.pairs.push({ a: a.ref, b: b.ref, gapMil: 8, physicalGapMil: 8 });
    problem.links.push({ id: a.ref+'-'+b.ref, left: [{ ref: a.ref, id }], right: [{ ref: b.ref, id }], weight: 1 });
  }
  problem.settings.timeLimitSeconds = .01;
  const result = await runCpsatLayout(model, settings, { problem, runtime });
  assert.equal(result.noCandidateReason, 'budget-exhausted', JSON.stringify(result.runs));
  assert.equal(result.runs[0].status, 'UNKNOWN');
  assert.equal(result.runs[0].solver.solverTimeBudgetSeconds, .01);
});

test('explicit checkpoint hints remain optional and may be infeasible', { skip }, async () => {
  const model = rotationModel(), { problem } = compileSemanticCpSatProblem(model, settings, { includeLabels: false });
  problem.generatedCheckpointPlacements = problem.entities.map(e => ({ ref: e.ref, dx: 0, dy: 0, variant: 0 }));
  const before = structuredClone(problem), result = await runCpsatLayout(model, settings, { problem, runtime });
  assert.equal(result.status, 'candidates-ready', JSON.stringify(result.runs));
  assert.equal(result.candidates[0].validation.valid, true);
  assert.equal(result.runs[0].solver.internallyGeneratedHintCount, problem.entities.length*3);
  assert.deepEqual(problem, before);
  const solved = await executeCpSat({ ...problem, generatedCheckpointPlacements: [] }, runtime);
  const continued = await executeCpSat({ ...problem, generatedCheckpointPlacements: solved.placements }, runtime);
  assert.equal(decodeCpSatCandidate(model, problem, continued).validation.valid, true);
});

test('process timeout recovers the emitted incumbent and still validates it', { skip }, async t => {
  const model = rotationModel(), { problem } = compileSemanticCpSatProblem(model, settings, { includeLabels: false });
  const solved = await executeCpSat(problem, runtime);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cpsat-timeout-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const backendPath = path.join(directory, 'incumbent.py');
  await fs.writeFile(backendPath, 'import json,sys,time\nd=json.load(sys.stdin)\nprint(json.dumps(d["testIncumbent"]),flush=True)\ntime.sleep(30)\n');
  const result = await executeCpSat({ ...problem, testIncumbent: { ...solved, event: 'incumbent', status: 'FEASIBLE' } }, { ...runtime, backendPath, timeoutMs: 1500 });
  assert.equal(result.status, 'FEASIBLE');
  assert.equal(result.solver.terminatedAfterTimeout, true);
  assert.equal(decodeCpSatCandidate(model, problem, result).validation.valid, true);
});
