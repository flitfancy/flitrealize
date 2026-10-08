import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareLayoutInputs } from '../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { compileSemanticCpSatProblem, decodeCpSatCandidate, executeCpSat } from '../scripts/pcb-layout/pcb-layout-cpsat.mjs';

const inputPath = process.env.FLITREALIZE_CPSAT_REPLAY_INPUT;
const problemPath = process.env.FLITREALIZE_CPSAT_REPLAY_PROBLEM;
const resultPath = process.env.FLITREALIZE_CPSAT_REPLAY_RESULT;
const pythonPath = process.env.FLITREALIZE_CPSAT_PYTHON;
const json = async path => JSON.parse(await readFile(path, 'utf8'));

test('replay archived full-board CP-SAT result through the current exact validator', { skip: ![inputPath, problemPath, resultPath].every(Boolean) && 'Provide REPLAY_INPUT, REPLAY_PROBLEM and REPLAY_RESULT environment paths.' }, async () => {
  const [bundle, problem, result] = await Promise.all([json(inputPath), json(problemPath), json(resultPath)]);
  const prepared = prepareLayoutInputs(bundle); assert.equal(prepared.state.ready, true, JSON.stringify(prepared.diagnostics));
  const candidate = decodeCpSatCandidate(prepared.model, problem, result);
  assert.equal(candidate.validation.valid, true, JSON.stringify(candidate.validation.issues));
  assert.equal(candidate.plan.components.length, bundle.snapshot.components.length);
  const compiled = compileSemanticCpSatProblem(prepared.model, { resolutionMil: problem.settings.resolutionMil });
  assert.equal(compiled.problem.entities.length, problem.entities.length);
  assert.equal(compiled.semantic.groups.flatMap(g => g.members).length, bundle.snapshot.components.length);
  assert.ok(compiled.problem.entities.every(e => e.fixed || e.base.x === 0 && e.base.y === 0));
});

test('bounded archived CP-SAT backend replay fixes a proven assignment', { skip: ![inputPath, problemPath, resultPath, pythonPath].every(Boolean) && 'Provide replay paths and a Python runtime.' }, async () => {
  const [bundle, original, result] = await Promise.all([json(inputPath), json(problemPath), json(resultPath)]);
  const prepared = prepareLayoutInputs(bundle); assert.equal(prepared.state.ready, true, JSON.stringify(prepared.diagnostics));
  const problem = structuredClone(original), solved = new Map(result.placements.map(p => [p.ref, p]));
  // Bounded model replay, not a new cold-search quality result. Collapse each
  // entity to the archived solution; preserve all original hard constraints.
  for (const entity of problem.entities) {
    const pose = solved.get(entity.ref), variant = entity.variants[pose.variant];
    entity.base.x += pose.dx * problem.settings.resolutionMil; entity.base.y += pose.dy * problem.settings.resolutionMil;
    entity.variants = [variant]; entity.fixed = true; delete entity.preferredVariant; delete entity.radiusMil;
  }
  problem.noInitialHints = true; problem.feasibilityOnly = true; problem.searchFirstVariantOnly = false;
  delete problem.generatedCheckpointPlacements; problem.settings = { ...problem.settings, timeLimitSeconds: 8, workers: 1 };
  const replay = await executeCpSat(problem, { pythonPath });
  assert.ok(['FEASIBLE', 'OPTIMAL'].includes(replay.status), JSON.stringify(replay));
  assert.equal(decodeCpSatCandidate(prepared.model, problem, replay).validation.valid, true);
});
