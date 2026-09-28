import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { validatePlan, measure, score, scoreBreakdown } from './pcb-layout-solver-core.mjs';
import { prepareLayoutStarts, runBoundedJobs } from './pcb-layout-starts.mjs';
import { hash, readJson } from './pcb-layout-project.mjs';

export async function prepareRunStarts({ model, dir, initialPlanFile, startOverrides, log, emptyError }) {
  const supplied = initialPlanFile ? await readJson(path.resolve(initialPlanFile)) : undefined;
  const prepared = prepareLayoutStarts(model, startOverrides, supplied?.plan ?? supplied,
    progress => log({ progress: 'initializing-starts', ...progress }));
  const { options, requested, accepted, exhausted, attempts } = prepared;
  await fs.writeFile(path.join(dir, 'initialization.json'), JSON.stringify({ options, requested, accepted, exhausted, attempts }, null, 2));
  for (const start of prepared.starts) {
    await fs.writeFile(path.join(dir, start.startId + '.json'),
      JSON.stringify({ ...start, plan: { ...start.plan, sourceBefore: undefined } }, null, 2));
  }
  if (!prepared.starts.length) throw Error(emptyError + ': see initialization.json');
  return prepared;
}

export function runLayoutJobs(jobs, { snapshot, contract, config, mechanical, iterations }) {
  return runBoundedJobs(jobs, job => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pcb-layout-solver-worker.mjs', import.meta.url), {
      workerData: {
        snapshot, contract, config, mechanical, profile: job.profile, iterations,
        initialPlan: job.initialPlan,
        initializationMetadata: { startId: job.startId, baseProfile: job.baseProfile, ...job.initializationMetadata },
      },
    });
    worker.once('message', reply => reply.success ? resolve(reply.result) : reject(Error(reply.error)));
    worker.once('error', reject);
    worker.once('exit', code => { if (code) reject(Error('Worker exited ' + code)); });
  }));
}

export function evaluateCandidate(model, candidate, { allowInvalid = false, errorCode }) {
  candidate.validation = validatePlan(model, candidate.plan);
  if (!candidate.validation.valid && !allowInvalid) throw Error(errorCode + ' ' + candidate.name);
  candidate.metrics = measure(model, candidate.plan.components, candidate.plan.labels, candidate.plan.bundles, candidate.plan.testPads);
  candidate.comparisonScore = score(model, candidate.metrics);
  candidate.scores = scoreBreakdown(model, candidate.metrics);
}

export async function writeCandidate(dir, candidate, space = 2) {
  const encoded = JSON.stringify(candidate, null, space);
  await fs.writeFile(path.join(dir, candidate.name + '.json'), encoded);
  return { name: candidate.name, sha256: hash(encoded) };
}

export async function writeRunConfiguration(dir, config) {
  await fs.writeFile(path.join(dir, 'effective-config.json'), JSON.stringify(config, null, 2));
  await fs.writeFile(path.join(dir, 'effective-weights.json'),
    JSON.stringify({ schemaVersion: 1, weights: config.comparisonWeights, labels: config.weightLabels }, null, 2));
}
