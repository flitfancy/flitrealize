import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectCandidate, objectiveVector } from './pcb-layout-solver-core.mjs';
import { comparisonReport } from './pcb-layout-solver-report.mjs';
import { catalogReport } from './pcb-layout-catalog-report.mjs';
import { addToArchive, planKey, dominates } from './pcb-layout-archive.mjs';
import { startingJobs } from './pcb-layout-starts.mjs';
import { hash as sha } from './pcb-layout-project.mjs';
import { prepareRunStarts, runLayoutJobs, evaluateCandidate, writeCandidate, writeRunConfiguration } from './pcb-layout-run.mjs';
export async function runLayoutSearch({model,snapshot,contract,config,mechanical,root,dir,fingerprints,engine,inputReceipt,initialPlanFile,iterations=config.search.iterations,startOverrides={},sourceKind='offline-snapshot',log=()=>{}}) {
  const write=(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2));
  const baseline = inspectCandidate(model);
  const prepared = await prepareRunStarts({ model, dir, initialPlanFile, startOverrides, log, emptyError: 'NO_FEASIBLE_INITIAL_START' });
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100000) throw Error('INVALID_ITERATION_BUDGET');
  const jobs = startingJobs(config, prepared);
  const results = await runLayoutJobs(jobs, { snapshot, contract, config, mechanical, iterations });
  const failures = results.flatMap((r, i) => r.status === 'rejected' ? [{ name: jobs[i].profile.name, error: String(r.reason) }] : []);
  if (failures.length) { await write('failures.json', failures); throw Error('CANDIDATE_WORKER_FAILED ' + JSON.stringify(failures)); }
  const winners = results.map(r => r.value);
  let archive = [];
  for (const c of [baseline, ...winners.flatMap(c => [c, ...(c.alternatives ?? [])])]) {
    archive = addToArchive(archive, c, objectiveVector(model, c.metrics), config.search.archiveSize ?? 8);
  }
  const winnerKeys = new Set([baseline, ...winners].map(planKey));
  let extraArchive = [];
  for (const e of archive.filter(e => !winnerKeys.has(e.key))) extraArchive = addToArchive(extraArchive, e.candidate, e.vector, config.search.reportAlternatives ?? 4);
  const extras = extraArchive.map((e, i) => ({ ...e.candidate, name: 'tradeoff_' + (i + 1), label: '权衡备选 ' + (i + 1), stats: null }));
  const candidates = [baseline, ...winners, ...extras];
  for (const c of candidates) {
    evaluateCandidate(model, c, { allowInvalid: c.name === 'baseline', errorCode: 'INVALID_WORKER_PLAN' });
    c.objectives = objectiveVector(model, c.metrics);
    c.nondominated = c.validation.valid && !candidates.some(other => other !== c && other.validation.valid && dominates(objectiveVector(model, other.metrics), c.objectives));
    delete c.alternatives;
    delete c.plan.sourceBefore;
  }
  const records = [];
  for (const c of candidates) records.push(await writeCandidate(dir, c));
  await writeRunConfiguration(dir, config);
  await write('run-parameters.json', { initialization: prepared.options, requestedStarts: prepared.requested, acceptedStarts: prepared.accepted, iterationsPerCandidate: iterations, workers: jobs.map(j => ({ name: j.profile.name, seed: j.profile.seed, startId: j.startId, baseProfile: j.baseProfile })) });
  await write('manifest.json', { schemaVersion: 3, engine, projectRoot: root, fingerprints, effectiveWeights: config.comparisonWeights, profiles: config.search.profiles, snapshotHash: sha(snapshot), candidates: records });
  const recommended = candidates.filter(c => c.validation.valid).sort((a, b) => a.comparisonScore - b.comparisonScore)[0].name;
  const summary = { status: 'candidates-ready-not-applied', applied: false, nativeWrites: 0, initialization: { requested: prepared.requested, accepted: prepared.accepted, options: prepared.options }, source: sourceKind, recommendedByConfiguredWeights: recommended, iterationsPerCandidate: iterations, candidates: candidates.map(c => ({ name: c.name, label: c.label, initializationMetadata: c.initializationMetadata, score: c.comparisonScore, scores: c.scores, objectives: c.objectives, nondominated: c.nondominated, spatial: c.metrics.spatial, valid: c.validation.valid, issues: c.validation.issues, edge: c.validation.edge, block: c.validation.block, counts: c.plan.counts, minimumGapMil: c.validation.minimumGapMil, groups: Object.fromEntries(Object.entries(c.metrics.groups).map(([id, g]) => [id, { ...g, changePercent: 100 * (g.mil / Math.max(1, baseline.metrics.groups[id].mil) - 1) }])), stats: c.stats })) };
  await write('summary.json', summary);
  await fs.writeFile(path.join(dir, 'comparison.html'), comparisonReport(candidates, baseline, config, contract, snapshot, inputReceipt));
  await fs.writeFile(path.join(dir, 'catalog.html'), catalogReport(winners, baseline, config, contract, snapshot, { runId: path.basename(dir), sourceLabel: '每个有效起点与搜索偏好各保留一个结果；仅预览，尚未按结构聚类筛选' }));
  log({ status: summary.status, recommended, candidates: summary.candidates.map(c => ({ name: c.name, score: c.score, moved: c.counts.moved, rotated: c.counts.rotated, silkRelocated: c.counts.silkRelocated, minimumGapMil: c.minimumGapMil })), report: dir });
  return summary;
}
