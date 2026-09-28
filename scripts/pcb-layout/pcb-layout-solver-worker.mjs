import { parentPort, workerData } from 'node:worker_threads';
import { compileModel, runSearch } from './pcb-layout-solver-core.mjs';
try {
  const { snapshot, contract, config, mechanical, profile, iterations, initialPlan, initializationMetadata } = workerData;
  const result = runSearch(compileModel(snapshot, contract, config, mechanical), profile, iterations, initialPlan);
  if (initializationMetadata) for (const candidate of [result, ...(result.alternatives ?? []), ...(result.catalog ?? [])]) candidate.initializationMetadata = initializationMetadata;
  delete result.plan.sourceBefore;
  for (const alternative of result.alternatives ?? []) delete alternative.plan.sourceBefore;
  for (const candidate of result.catalog ?? []) delete candidate.plan.sourceBefore;
  parentPort.postMessage({ success: true, result });
} catch (error) {
  parentPort.postMessage({ success: false, error: error.stack });
}
