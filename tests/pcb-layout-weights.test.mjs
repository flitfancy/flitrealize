import test from 'node:test';
import assert from 'node:assert/strict';
import { configureWeights, simpleWeightKeys } from '../scripts/pcb-layout/pcb-layout-weights.mjs';

export const base = (mode = 'simple-v1') => ({
  ...(mode === undefined ? {} : { scoringMode: mode }),
  groups: ['power', 'sense', 'bypass'].map(id => ({ id })),
  search: { profiles: [{ name: 'balanced', weightMultipliers: {} }] },
});
export const defaults = { power: 6, sense: 5, bypass: 3, connectivity: 1, uniformity: .08 };

test('simple-v1 explicit document preserves objectives, labels and input immutability', () => {
  const document = { weights: defaults, labels: Object.fromEntries(simpleWeightKeys.map(key => [key, key])) };
  const config = base(), original = structuredClone(config);
  const out = configureWeights(config, document);
  assert.deepEqual(Object.keys(out.comparisonWeights), simpleWeightKeys);
  assert.deepEqual(Object.keys(out.weightLabels), simpleWeightKeys);
  assert.deepEqual(out.comparisonWeights, defaults);
  assert.deepEqual(out.search.profiles[0].weights, defaults);
  assert.equal(out.scoringMode, 'simple-v1');
  assert.deepEqual(config, original);
});

test('simple-v1 rejects every retired weight, including zero and CLI overrides', () => {
  for (const key of ['displacement', 'rotation', 'silk', 'proximity', 'spacing', 'whitespace', 'compactness']) {
    assert.throws(() => configureWeights(base(), { weights: { power: 1, [key]: 0 } }), /RETIRED_WEIGHTS_IN_SIMPLE_MODE/);
    assert.throws(() => configureWeights(base(), { weights: { power: 1 } }, [key + '=0.5']), /RETIRED_WEIGHTS_IN_SIMPLE_MODE/);
  }
});

test('simple-v1 accepts zero uniformity but still requires an electrical objective', () => {
  const out = configureWeights(base(), { weights: defaults }, ['uniformity=0', 'power=2']);
  assert.equal(out.comparisonWeights.uniformity, 0);
  assert.equal(out.comparisonWeights.power, 2);
  assert.throws(() => configureWeights(base(), { weights: { uniformity: 1 } }), /NO_OBJECTIVE/);
  for (const override of ['unknown=1', 'uniformity=-1', 'power=NaN', 'power=Infinity', 'power= ']) {
    assert.throws(() => configureWeights(base(), { weights: defaults }, [override]), /INVALID_/);
  }
  const config = base();
  config.groups.push({ id: 'unexpected' });
  assert.throws(() => configureWeights(config, { weights: { power: 1, unexpected: 1 } }), /INVALID_WEIGHTS/);
});

test('simple-v1 profiles multiply active objectives and reject retired targets', () => {
  const config = base();
  config.search.profiles = [{ name: 'uniform', weightMultipliers: { uniformity: 2.5, power: 0 } }];
  const out = configureWeights(config, { weights: defaults });
  assert.equal(out.search.profiles[0].weights.uniformity, .2);
  assert.equal(out.search.profiles[0].weights.power, 0);
  assert.equal(out.comparisonWeights.power, 6);
  for (const multipliers of [{ displacement: 0 }, { spacing: 1 }, { unknown: 1 }, { sense: Infinity }, { sense: -1 }]) {
    config.search.profiles[0].weightMultipliers = multipliers;
    assert.throws(() => configureWeights(config, { weights: defaults }), /INVALID_PROFILE_MULTIPLIER/);
  }
  config.search.profiles[0].weightMultipliers = { power: 0, sense: 0, bypass: 0, connectivity: 0 };
  assert.throws(() => configureWeights(config, { weights: defaults }), /NO_OBJECTIVE/);
});

test('omitted mode uses current scoring while explicit historical modes are rejected', () => {
  const config = base(); delete config.scoringMode;
  const before = structuredClone(config), out = configureWeights(config, { weights: defaults });
  assert.equal(out.scoringMode, 'simple-v1');
  assert.deepEqual(out.comparisonWeights, defaults);
  assert.deepEqual(config, before);
  assert.throws(() => configureWeights(config, { weights: { sense: 1, displacement: .1 } }), /RETIRED_WEIGHTS_IN_SIMPLE_MODE/);
  for (const mode of ['legacy-v1', 'unknown', null]) assert.throws(() => configureWeights(base(mode), { weights: defaults }), /INVALID_SCORING_MODE/);
});

test('simple-v1 does not resurrect retired label controls from an old labels document', () => {
  const out = configureWeights(base(), { weights: { power: 1 }, labels: { power: '功率', displacement: '旧移动', unknown: '未知' } });
  assert.deepEqual(out.weightLabels, { power: '功率' });
});
