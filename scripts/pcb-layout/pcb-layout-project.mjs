import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { configureWeights } from './pcb-layout-weights.mjs';

export const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const skillDirectory = path.resolve(moduleDirectory, '../..');
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));

export async function loadLayoutProject(projectRoot, options = {}) {
  const root = await fs.realpath(projectRoot);
  const read = relative => readJson(path.resolve(root, relative));
  const raw = await read(options.configFile ?? 'design/PCB_LAYOUT_CONSTRAINTS.v1.json');
  if (!Array.isArray(raw.search?.profiles) || !raw.search.profiles.length) throw Error('SEARCH_PROFILES_REQUIRED');
  const weights = options.weightsFile ?? raw.weightsFile;
  const config = configureWeights(raw, weights ? await read(weights) : undefined, options.weightOverrides ?? []);
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
export async function layoutEngineIdentity() {
  const files = ['scripts/pcb-layout.mjs', 'scripts/eda-host.mjs', 'scripts/lib/pcb-python.mjs', 'schemas/pcb-layout-intent.v1.schema.json'];
  const collect = async dir => {
    for (const entry of await fs.readdir(path.join(skillDirectory, dir), { withFileTypes: true })) {
      const relative = dir + '/' + entry.name;
      if (entry.isDirectory()) await collect(relative);
      else if (/\.(mjs|js|py)$/.test(entry.name)) files.push(relative);
    }
  };
  await collect('scripts/pcb-layout');
  await collect('scripts/providers');
  const records = [];
  for (const file of files.sort()) records.push([file, hash(await fs.readFile(path.join(skillDirectory, file), 'utf8'))]);
  return { inputVersion: 1, engine: 'flitrealize-pcb-layout-v1', implementationHash: hash(records) };
}
