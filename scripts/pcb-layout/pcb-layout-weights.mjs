import { validateWeights, simpleWeightKeys } from './pcb-layout-solver-core.mjs';

export { simpleWeightKeys };
const retiredWeightKeys = new Set(['displacement', 'rotation', 'silk', 'proximity', 'spacing', 'whitespace', 'compactness']);

export function configureWeights(config, document, overrides = []) {
  const out = structuredClone(config);
  const mode = config.scoringMode === undefined ? 'simple-v1' : config.scoringMode;
  if (mode !== 'simple-v1') throw Error('INVALID_SCORING_MODE: only simple-v1 is supported; migrate explicit historical modes before solving');
  out.scoringMode = mode;
  const known = new Set([...out.groups.map(g => g.id).filter(id => simpleWeightKeys.includes(id)), 'connectivity', 'uniformity']);
  const weights = { ...(document?.weights ?? config.comparisonWeights) };
  for (const argument of overrides) {
    const match = /^([a-zA-Z][a-zA-Z0-9_]*)=(.+)$/.exec(argument ?? '');
    if (!match || !match[2].trim()) throw Error('INVALID_WEIGHT_OVERRIDE: expected key=number');
    weights[match[1]] = Number(match[2]);
  }
  const retired = Object.keys(weights).filter(key => retiredWeightKeys.has(key));
  if (retired.length) throw Error('RETIRED_WEIGHTS_IN_SIMPLE_MODE: remove ' + retired.join(', '));
  if (Object.keys(weights).some(key => !known.has(key))) throw Error('INVALID_WEIGHTS: unsupported simple-v1 objective');
  validateWeights(weights, out.groups);
  out.comparisonWeights = weights;
  out.weightLabels = Object.fromEntries(Object.entries(document?.labels ?? {}).filter(([key]) => known.has(key)));
  out.search.profiles = out.search.profiles.map(profile => {
    const multipliers = profile.weightMultipliers ?? {};
    if (Object.entries(multipliers).some(([k, v]) => !known.has(k) || !Number.isFinite(v) || v < 0)) throw Error('INVALID_PROFILE_MULTIPLIER');
    const effective = Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, value * (multipliers[key] ?? 1)]));
    validateWeights(effective, out.groups);
    return { ...profile, weights: effective };
  });
  return out;
}
