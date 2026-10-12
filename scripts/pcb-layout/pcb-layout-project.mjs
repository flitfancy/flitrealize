import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { configureWeights } from './pcb-layout-weights.mjs';
import { layoutImplementationRecords } from './pcb-layout-engine.mjs';

export const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const skillDirectory = path.resolve(moduleDirectory, '../..');
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));

export async function loadLayoutProject(projectRoot, options = {}) {
  const root = await fs.realpath(projectRoot);
  const read = relative => readJson(path.resolve(root, relative));
  const raw = await read(options.configFile ?? 'design/PCB_LAYOUT_CONSTRAINTS.v1.json');
  const weights = options.weightsFile ?? raw.weightsFile;
  const config = configureWeights(raw, weights ? await read(weights) : undefined, options.weightOverrides ?? [], { validateSearchProfiles: false });
  if (config.featuresFile) {
    const features = await read(config.featuresFile);
    if (features.schemaVersion !== 1 || !Array.isArray(features.components)) throw Error('INVALID_FEATURES_FILE');
    config.componentFeatures = features.components;
  }
  for (const key of ['spatial', 'geometryViews', 'blockCoupling', 'spacingPolicy', 'assemblyRules', 'initialization']) {
    if (config[key + 'File']) config[key] = await read(config[key + 'File']);
  }
  const contract = await read(config.contractFile), mechanical = await read(config.mechanicalRulesFile);
  return { root, contract, config, mechanical, fingerprints: { config: hash(config), contract: hash(contract), mechanical: hash(mechanical) } };
}

// Candidates bind to the implementation as well as their design inputs.
export async function layoutEngineIdentity({ skillRoot = skillDirectory, entrypoints = [] } = {}) {
  const records = await layoutImplementationRecords(skillRoot, { entrypoints });
  return { inputVersion: 1, engine: 'flitrealize-pcb-layout-v1', implementationHash: hash(records) };
}
