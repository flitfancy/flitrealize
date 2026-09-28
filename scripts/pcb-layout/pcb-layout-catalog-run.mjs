import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectCandidate } from './pcb-layout-solver-core.mjs';
import { selectCatalogCandidates } from './pcb-layout-catalog-pool.mjs';
import { catalogReport } from './pcb-layout-catalog-report.mjs';
import { startingJobs } from './pcb-layout-starts.mjs';
import { hash } from './pcb-layout-project.mjs';
import { prepareRunStarts, runLayoutJobs, evaluateCandidate, writeCandidate, writeRunConfiguration } from './pcb-layout-run.mjs';

export async function runCatalog({ model, snapshot, contract, config, mechanical, dir, fingerprints, inputReceipt, count = 100, iterations = 1200, initialPlanFile, startOverrides = {}, projectRoot, engine, log = value => console.log(JSON.stringify(value)) }) {
  if (!projectRoot) throw Error('PROJECT_ROOT_REQUIRED');
  const write = (name, value) => fs.writeFile(path.join(dir, name), JSON.stringify(value, null, 2));
  const baseline = inspectCandidate(model);
  await write('baseline.json', baseline);
  const prepared = await prepareRunStarts({ model, dir, initialPlanFile, startOverrides, log, emptyError: 'CATALOG_INITIALIZATION_FAILED' });
  const seed = prepared.starts[0];
  await write('initial-seed.json', { ...seed, plan: { ...seed.plan, sourceBefore: undefined } });
  const workerConfig = structuredClone(config);
  workerConfig.search.catalogPoolSize = config.search.catalogPoolSize ?? 40;
  workerConfig.search.catalogGridMil ??= 20;
  if (!Number.isFinite(workerConfig.search.catalogGridMil) || workerConfig.search.catalogGridMil <= 0) throw Error('INVALID_CATALOG_GRID');
  const accumulated = [], runs = [], previous = new Map();
  let selection = { selected: [], available: 0, duplicatesRemoved: 0 };
  for (let batch = 0; batch < 8 && selection.selected.length < count; batch++) {
    log({ progress: 'catalog-search', batch: batch + 1, iterations, profiles: config.search.profiles.length, available: selection.available });
    const jobs = startingJobs(config, prepared, batch);
    const continuedJobs = jobs.map(job => ({ ...job, initialPlan: previous.get(job.profile.name)?.plan ?? job.initialPlan }));
    const results = await runLayoutJobs(continuedJobs, { snapshot, contract, config: workerConfig, mechanical, iterations });
    results.forEach((result, i) => {
      if (result.status === 'rejected') { runs.push({ batch: batch + 1, profile: jobs[i].profile.name, startId: jobs[i].startId, error: String(result.reason) }); return; }
      const r = result.value;
      accumulated.push(...(r.catalog ?? []), r);
      previous.set(r.name, r);
      runs.push({ batch: batch + 1, profile: r.name, startId: jobs[i].startId, seed: r.seed, retained: r.catalog?.length ?? 0, stats: r.stats });
    });
    selection = selectCatalogCandidates(accumulated, { count });
    await write('run-progress.json', { runs, available: selection.available, selected: selection.selected.length });
    log({ progress: 'catalog-batch-complete', batch: batch + 1, available: selection.available, selected: selection.selected.length });
  }
  if (selection.selected.length !== count) throw Error('CATALOG_INSUFFICIENT_DISTINCT_FEASIBLE_PLANS ' + selection.selected.length + '/' + count);
  // Preserve the entire deduplicated sampled pool, even when the requested page
  // contains only its leading subset. A later review need not rerun the search.
  const allSamples = selectCatalogCandidates(accumulated, { count: accumulated.length }).selected;
  await write('sample-pool.json', allSamples.map(c => ({ plan: c.plan, validation: c.validation, metrics: c.metrics, comparisonScore: c.comparisonScore, originProfile: c.originProfile, initializationMetadata: c.initializationMetadata, seed: c.seed })));
  const candidates = [], records = [];
  for (const [index, source] of selection.selected.entries()) {
    const candidate = { ...source, name: 'candidate_' + String(index + 1).padStart(3, '0'), label: '候选 ' + String(index + 1).padStart(3, '0') };
    delete candidate.catalog; delete candidate.alternatives; delete candidate.plan.sourceBefore;
    evaluateCandidate(model, candidate, { errorCode: 'CATALOG_FINAL_VALIDATION_FAILED' });
    records.push(await writeCandidate(dir, candidate, 0));
    candidates.push(candidate);
  }
  const runId = path.basename(dir);
  await fs.writeFile(path.join(dir, 'catalog.html'), catalogReport(candidates, baseline, config, contract, snapshot, { runId, sourceLabel: '读取的 PCB 快照；仅内存求解，未写入 PCB' }));
  await writeRunConfiguration(dir, config);
  await write('run-parameters.json', { count, iterations, initialization: prepared.options, requestedStarts: prepared.requested, acceptedStarts: prepared.accepted, poolSize: workerConfig.search.catalogPoolSize, poolGridMil: workerConfig.search.catalogGridMil, runs });
  await write('manifest.json', { schemaVersion: 3, kind: 'catalog', engine, projectRoot, fingerprints, snapshotHash: hash(snapshot), candidates: records });
  const summary = { status: 'catalog-ready-not-applied', count, availableDistinctSamples: selection.available, duplicatesRemoved: selection.duplicatesRemoved, applied: false, nativeWrites: 0, scoringMode: config.scoringMode, allConfiguredHardConstraintsPass: true, inputCounts: { components: inputReceipt.components.length, independentPads: inputReceipt.standalonePads.length }, candidates: candidates.map(c => ({ name: c.name, label: c.label, score: c.comparisonScore, scores: c.scores, minimumGapMil: c.validation.minimumGapMil, counts: c.plan.counts, originProfile: c.originProfile ?? c.name, seed: c.seed })), runs };
  await write('summary.json', summary);
  log({ status: summary.status, count, allConfiguredHardConstraintsPass: true, report: dir, page: path.join(dir, 'catalog.html') });
  return summary;
}
