import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileCpSatProblem, cpSatSettings, decodeCpSatCandidate } from './pcb-layout-cpsat-model.mjs';
import { convertSemanticInputs, semanticGroupMetrics } from './pcb-layout-semantic.mjs';
import { scoreReferenceMil } from './pcb-layout-reference-scale.mjs';
import { compileRoughLayoutPolicy, roughLayoutMetrics } from './pcb-layout-rough.mjs';

export { compileCpSatProblem, cpSatSettings, decodeCpSatCandidate };
export const cpSatBackendPath = fileURLToPath(new URL('./pcb-layout-cpsat.py', import.meta.url));

// JSON lines protocol; runtime selection is explicit and has no project paths.
export async function executeCpSat(problem, { pythonPath = process.env.FLITREALIZE_CPSAT_PYTHON ?? 'python', backendPath = cpSatBackendPath, timeoutMs = (problem.settings.timeLimitSeconds + 20) * 1000, onProgress, signal } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('INVALID_CPSAT_PROCESS_TIMEOUT');
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, ['-B', backendPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', stderr = '', last, checkpoint, failure, timedOut = false;
    const consume = line => {
      if (!line.trim()) return;
      try {
        const value = JSON.parse(line);
        if (value.event === 'incumbent') { checkpoint = value; onProgress?.(value); }
        else if (value.progress) onProgress?.(value);
        else last = value;
      } catch (error) { failure = Error('CPSAT_INVALID_OUTPUT: ' + error.message); child.kill(); }
    };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const abort = () => child.kill(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => { buffer += chunk; let index; while ((index = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, index)); buffer = buffer.slice(index + 1); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); consume(buffer);
      if (signal?.aborted) { reject(Error('CPSAT_ABORTED')); return; }
      if (failure) { reject(failure); return; }
      if (code !== 0 && !timedOut) { reject(Error('CPSAT_PROCESS_FAILED ' + code + ': ' + stderr.trim())); return; }
      const result = last ?? (timedOut ? checkpoint : null);
      if (!result || result.error) { reject(Error('CPSAT_NO_RESULT: ' + (result?.error ?? stderr.trim()))); return; }
      if (timedOut) result.solver = { ...result.solver, terminatedAfterTimeout: true, optimalForCompiledModel: false };
      resolve(result);
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(problem));
  });
}

export function compileSemanticCpSatProblem(model, settings = {}, { semanticPolicy, nativeBoardEdgeMil, poseDedupMil, maxStoredSolutions, includeLabels = true, roughLayoutPolicy = model.config.roughLayoutPolicy } = {}) {
  const semantic = convertSemanticInputs(model, semanticPolicy);
  const initialProposal = { metadata: { mode: 'fresh', source: 'unseeded-coordinate-domain' },
    components: [...model.components.values()].map(c => ({ ref: c.ref, ...(model.fixed.get(c.ref) ?? { x: 0, y: 0, rotation: [...model.allowedRotations.get(c.ref)].sort((a, b) => a - b)[0] }) })),
    testPads: model.pads.filter(p => !p.owner).map(p => ({ ...p, ...(p.locked ? {} : { x: 0, y: 0 }) })) };
  const problem = compileCpSatProblem(model, { ...settings, displacementWeight: 0 }, { initialProposal, includeLabels });
  problem.noInitialHints = true; problem.skipFeasibilityPhase = true; problem.semanticGroups = semantic.groups; problem.spacing = []; problem.variantIntervals = true;
  if (nativeBoardEdgeMil !== undefined) {
    if (!Number.isFinite(nativeBoardEdgeMil) || nativeBoardEdgeMil < 0) throw Error('INVALID_CPSAT_COPPER_EDGE');
    problem.nativeBoardEdgeMil = nativeBoardEdgeMil;
  }
  if (poseDedupMil !== undefined) problem.poseDedupMil = poseDedupMil;
  if (maxStoredSolutions !== undefined) problem.maxStoredSolutions = maxStoredSolutions;
  for (const entity of problem.entities) {
    delete entity.preferredVariant;
    entity.variants.sort((a, b) => (a.bundle.maxX - a.bundle.minX) * (a.bundle.maxY - a.bundle.minY) - (b.bundle.maxX - b.bundle.minX) * (b.bundle.maxY - b.bundle.minY) || a.rotation - b.rotation || String(a.side).localeCompare(String(b.side)));
  }
  const divisor = Object.entries(model.config.comparisonWeights).filter(([key]) => key !== 'uniformity').reduce((sum, [, value]) => sum + value, 0);
  for (const link of semantic.inferredLinks) problem.links.push({ id: link.id, left: link.left, right: link.right, weight: (model.config.comparisonWeights.bypass ?? 0) / divisor / scoreReferenceMil(model, 'bypass') });
  problem.coverage.initialization = { mode: 'fresh', poseSource: 'unseeded-coordinate-domain', sourceLabelPositionsUsed: false, externalInitialHints: 0 };
  problem.coverage.objective.semanticGroups = 'source-derived flexible physical group span; proxy only';
  compileRoughLayoutPolicy(model, problem, roughLayoutPolicy);
  return { problem, semantic };
}

// Returns standard layout candidates accepted by the existing exact validator.
// OPTIMAL describes the quantized proxy model, never GND or native DRC.
export async function runCpsatLayout(model, settings = {}, options = {}) {
  const { candidateCount = 1, maxRuns = candidateCount, runtime = {}, onProgress, problem: suppliedProblem, semantic: suppliedSemantic } = options;
  if (['coldStart', 'coldSeconds'].some(key => Object.hasOwn(options, key))) throw Error('CPSAT_OBSOLETE_COLD_START_OPTIONS: each run now solves the full domain directly');
  if (![candidateCount, maxRuns].every(v => Number.isInteger(v) && v >= 1)) throw Error('INVALID_CPSAT_RUN_BUDGET');
  const compiled = suppliedProblem ? { problem: structuredClone(suppliedProblem), semantic: suppliedSemantic } : compileSemanticCpSatProblem(model, settings, options);
  if (compiled.problem.searchFirstVariantOnly || compiled.problem.randomFeasibleShapes) throw Error('CPSAT_RESTRICTED_START_PROBLEM: supply the full legal variant domain');
  compiled.problem.skipFeasibilityPhase = true;
  const candidates = [], runs = [], seen = new Set(), dedup = compiled.problem.poseDedupMil ?? compiled.problem.settings.resolutionMil;
  for (let index = 0; index < maxRuns && candidates.length < candidateCount; index++) {
    const problem = structuredClone(compiled.problem), name = 'cpsat_' + String(index + 1).padStart(3, '0');
    problem.settings.seed = (problem.settings.seed + index) % 2147483647;
    const run = { name, accepted: 0 }; runs.push(run);
    let result;
    try {
      result = await executeCpSat(problem, { ...runtime, onProgress });
      run.status = result.status; run.solver = result.solver;
      for (const placements of (['FEASIBLE', 'OPTIMAL'].includes(result.status) ? [...(result.solutions ?? []), result.placements].filter(Boolean) : [])) {
        const candidate = decodeCpSatCandidate(model, problem, { ...result, placements }, { name: name + '_' + run.accepted, label: 'CP-SAT' });
        if (!candidate.validation.valid) { (run.rejected ??= []).push(candidate.validation.issues); continue; }
        const key = JSON.stringify(candidate.plan.components.map(p => [p.ref, Math.round(p.x / dedup), Math.round(p.y / dedup), p.rotation]).sort());
        if (seen.has(key)) continue; seen.add(key);
        if (compiled.semantic) {
          candidate.semanticGroups = semanticGroupMetrics(compiled.semantic, candidate.plan);
          const semanticScore = candidate.semanticGroups.reduce((sum, g) => sum + g.weight * g.normalizedCompactness, 0);
          candidate.semanticCompactnessScore = semanticScore * (problem.roughLayout?.groupCompactnessWeight ?? 1);
          if(problem.roughLayout) candidate.semanticCompactnessUnscaledScore = semanticScore;
        }
        if(problem.roughLayout){candidate.roughLayoutMetrics=roughLayoutMetrics(problem,candidate.plan);candidate.roughLayoutScore=candidate.roughLayoutMetrics.weightedScore;}
        candidate.noInitialHints = problem.noInitialHints === true; candidate.run = name; run.accepted++; candidates.push(candidate);
      }
    } catch (error) { if (runtime.signal?.aborted) throw error; run.status = 'error'; run.error = error.message; }
    onProgress?.({ progress: 'run-complete', ...run, candidates: candidates.length });
    // A proof over the unchanged full domain does not benefit from another seed.
    if (run.status === 'INFEASIBLE') break;
  }
  candidates.sort((a, b) => (a.comparisonScore + (a.semanticCompactnessScore ?? 0) + (a.roughLayoutScore ?? 0)) - (b.comparisonScore + (b.semanticCompactnessScore ?? 0) + (b.roughLayoutScore ?? 0)));
  const noCandidateReason = candidates.length ? undefined : runs.some(r => r.status === 'INFEASIBLE') ? 'infeasible' : runs.some(r => r.status === 'UNKNOWN') ? 'budget-exhausted' : runs.some(r => r.rejected?.length) ? 'validation-rejected' : 'error';
  return { status: candidates.length ? 'candidates-ready' : 'no-candidate', ...(noCandidateReason ? { noCandidateReason } : {}), candidates: candidates.slice(0, candidateCount), runs, semantic: compiled.semantic, problem: compiled.problem,
    scope: { nativeWrites: 0, nativeDrcRun: false, groundVerified: false, optimization: 'quantized electrical and compactness proxy; exact layout validation after decoding' } };
}
