import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSpacingPolicy, scorePairSpacing } from '../scripts/pcb-layout/pcb-layout-spacing-policy.mjs';

const config = () => ({ schemaVersion: 2, mode: 'active', source: 'assembly-courtyard', geometry: 'physical',
  bandRatios: { rejectBelow: .75, neutralMin: .9, neutralMax: 1.2 }, requirements: [] });
const compile = (input = config(), options = {}) => compileSpacingPolicy(input, ['A', 'B'], { absoluteFloorMil: 8, assemblyPolicy: {}, ...options });
const pair = () => ({ state: 'ready', baselineMil: 100, hardMinMil: 75, neutralMinMil: 90, neutralMaxMil: 120 });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test('ratio boundaries reject below the hard floor and keep both neutral endpoints inclusive', () => {
  const resolved = pair();
  assert.equal(scorePairSpacing(74.999, resolved).accepted, false);
  assert.equal(scorePairSpacing(75, resolved).accepted, true);
  assert.equal(scorePairSpacing(75, resolved).status, 'tight');
  near(scorePairSpacing(75, resolved).penalty, .15 ** 2);
  for (const d of [90, 91, 100, 119, 120]) assert.deepEqual(scorePairSpacing(d, resolved), { ratio: d / 100, status: 'neutral', accepted: true, penalty: 0 });
  assert.equal(scorePairSpacing(120.001, resolved).status, 'loose');
  near(scorePairSpacing(130, resolved).penalty, .1 ** 2);
  assert.equal(scorePairSpacing(-1, resolved).accepted, false);
});

test('a neutral preference cannot waive an independently enforced hard floor', () => {
  const resolved = { ...pair(), hardMinMil: 110 };
  assert.equal(scorePairSpacing(109, resolved).accepted, false);
  assert.equal(scorePairSpacing(109, resolved).penalty, 0);
  assert.equal(scorePairSpacing(110, resolved).accepted, true);
});

test('historical class policies are rejected instead of changing their spacing meaning', () => {
  for (const mode of ['draft', 'active']) {
    const input = { schemaVersion: 1, mode, geometry: 'placement', bandRatios: config().bandRatios,
      classes: [{ id: 'old', label: 'Old', baselineMil: 100 }], assignments: [{ classId: 'old', refs: ['A', 'B'] }], requirements: [] };
    assert.throws(() => compile(input), /UNSUPPORTED_SPACING_POLICY_VERSION/);
  }
  assert.throws(() => compile({ ...config(), mode: 'draft' }), /INVALID_ASSEMBLY_SPACING_POLICY/);
  assert.equal(compileSpacingPolicy(undefined), null);
  assert.equal(compileSpacingPolicy(null), null);
});

test('physical rules reject unknown fields, invalid references and unresolved pair requirements', () => {
  const edits = [
    c => { c.extra = true; }, c => { c.geometry = 'placement'; }, c => { c.source = 'class'; },
    c => { c.classes = []; }, c => { c.bandRatios.extra = 1; },
    c => { c.requirements = [{ id: 'x', refs: ['A', 'B'], purpose: 'access', baselineMil: 100 }]; },
    c => { c.requirements = [{ id: 'x', refs: ['A', 'A'], purpose: 'access', hardMinimumMil: 10 }]; },
    c => { c.requirements = [{ id: 'x', refs: ['A', 'X'], purpose: 'access', hardMinimumMil: 10 }]; },
    c => { c.requirements = [1, 2].map(() => ({ id: 'x', refs: ['A', 'B'], purpose: 'access', hardMinimumMil: 10 })); },
  ];
  for (const edit of edits) { const input = config(); edit(input); assert.throws(() => compile(input), /SPACING/); }
  for (const value of [-1, NaN, Infinity, '10', null, undefined]) {
    assert.throws(() => compile({ ...config(), requirements: [{ id: 'x', refs: ['A', 'B'], purpose: 'access', hardMinimumMil: value }] }), /SPACING_REQUIREMENT/);
  }
  assert.throws(() => compileSpacingPolicy(config(), ['A', 'A'], { absoluteFloorMil: 8, assemblyPolicy: {} }), /SPACING_REFS/);
  assert.throws(() => compile(config(), { assemblyPolicy: null }), /ASSEMBLY_RULES_REQUIRED/);
});

test('invalid bands and unresolved numeric scales cannot produce a valid score', () => {
  for (const ratios of [
    { rejectBelow: 0, neutralMin: .9, neutralMax: 1.2 },
    { rejectBelow: .95, neutralMin: .9, neutralMax: 1.2 },
    { rejectBelow: .75, neutralMin: 1.3, neutralMax: 1.2 },
    { rejectBelow: .75, neutralMin: NaN, neutralMax: 1.2 },
    { rejectBelow: .75, neutralMax: 1.2 },
  ]) assert.throws(() => compile({ ...config(), bandRatios: ratios }), /SPACING/);
  for (const floor of [-1, 0, NaN, Infinity]) assert.throws(() => compile(config(), { absoluteFloorMil: floor }), /ABSOLUTE_FLOOR/);
  assert.throws(() => scorePairSpacing(Infinity, pair()), /SPACING_DISTANCE/);
  for (const resolved of [{ ...pair(), state: 'pending' }, { ...pair(), state: 'conflict' }, { ...pair(), baselineMil: 0 }, { ...pair(), baselineMil: NaN }]) assert.throws(() => scorePairSpacing(100, resolved), /INVALID_RESOLVED_SPACING/);
});

test('compiled physical policies preserve input values and survive JSON roundtrips', () => {
  const input = config(); input.requirements = [{ id: 'access', refs: ['A', 'B'], purpose: 'access', hardMinimumMil: 30 }];
  const before = structuredClone(input), compiled = compile(input);
  assert.deepEqual(JSON.parse(JSON.stringify(compiled)), compiled);
  assert.equal(compiled.geometry, 'physical');
  assert.equal(compiled.baselineDefinition, 'directional-hard-minimum-divided-by-reject-ratio');
  assert.ok(!Object.hasOwn(compiled, 'classes') && !Object.hasOwn(compiled, 'assignments'));
  compiled.requirements[0].refs[0] = 'changed'; compiled.bandRatios.neutralMax = 9;
  assert.deepEqual(input, before);
});
