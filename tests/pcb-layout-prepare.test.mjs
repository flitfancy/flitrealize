import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareLayoutInputs } from '../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { inspectCandidate } from '../scripts/pcb-layout/pcb-layout-solver-core.mjs';
import { prepareFixture, filterRelation, addIntent } from './helpers/pcb-layout-prepare-fixture.mjs';

const codes = result => result.diagnostics.map(d => d.code);
function ready(result) { assert.equal(result.state.ready, true, JSON.stringify(result.diagnostics)); }

test('preparation preserves current poses and all source objects without requiring semantic extensions', () => {
  const fixture = prepareFixture(), before = structuredClone(fixture);
  fixture.snapshot.components[0].locked = true; before.snapshot.components[0].locked = true;
  const result = prepareLayoutInputs(fixture);
  ready(result);
  assert.deepEqual(fixture, before);
  assert.equal(Object.hasOwn(result.state, 'currentLayout'), false);
  assert.equal(result.coverage.requirements[0].status, 'unbound');
  assert.deepEqual(result.model.snapshot.components, fixture.snapshot.components);
  assert.deepEqual(result.model.fixed.get('U1'), { ref: 'U1', x: 0, y: 0, rotation: 0 });
});

test('illegal current spacing remains a valid preparation input', () => {
  const fixture = prepareFixture(10), result = prepareLayoutInputs(fixture);
  ready(result);
  assert.equal(inspectCandidate(result.model).validation.valid, false);
  assert.equal(Object.hasOwn(result.state, 'currentLayout'), false);
  assert.equal(fixture.snapshot.components[1].x, 10);
});

test('explicit logical pin relationships produce one objective and an optional hard maximum', () => {
  const fixture = addIntent(prepareFixture(), filterRelation({ maxDistanceMil: 100 })), original = structuredClone(fixture);
  const result = prepareLayoutInputs(fixture);
  ready(result);
  assert.equal(result.model.links.length, 1);
  assert.equal(result.model.limits.length, 1);
  assert.equal(result.model.limits[0].maxMil, 100);
  assert.equal(result.coverage.requirements[0].status, 'partial');
  assert.equal(result.coverage.relations[0].implements[0].active, true);
  assert.deepEqual(result.coverage.requirements[0].relationIds, ['supply-filter']);
  assert.deepEqual(fixture, original);
  assert.equal(inspectCandidate(result.model).validation.valid, false, 'distance is evaluated later, not silently repaired');
});

test('all supported relation kinds use existing objective groups without guessing a distance', () => {
  for (const [kind, group] of [['bypass', 'bypass'], ['bootstrap', 'bypass'], ['sense', 'sense'], ['power-path', 'power']]) {
    const result = prepareLayoutInputs(addIntent(prepareFixture(), filterRelation({ kind })));
    ready(result);
    assert.equal(result.model.links[0].group, group);
    assert.equal(result.model.limits.length, 0);
  }
});

test('an exact legacy objective is reused while prose basis never claims requirement coverage', () => {
  const fixture = prepareFixture();
  fixture.config.groups[2].links.push({ a: 'U1', aPin: '1', b: 'C1', bPin: '1', nets: ['SUPPLY'], basis: 'supply-filtering' });
  const legacy = prepareLayoutInputs(fixture); ready(legacy);
  assert.equal(legacy.coverage.requirements[0].status, 'unbound');
  const merged = prepareLayoutInputs(addIntent(fixture, filterRelation())); ready(merged);
  assert.equal(merged.model.links.length, 1);
});

test('semantic duplicate, net mismatch, reference typo and ambiguous legacy link stop preparation', () => {
  const scenarios = [
    [f => addIntent(f, filterRelation(), filterRelation({ id: 'duplicate' })), 'DUPLICATE_RELATION_OBJECTIVE'],
    [f => addIntent(f, filterRelation({ net: 'OTHER' })), 'RELATION_NET_MISMATCH'],
    [f => addIntent(f, filterRelation({ requirementId: 'missing' })), 'UNKNOWN_REQUIREMENT'],
    [f => { f.config.groups[2].links.push({ a: 'U1', b: 'C1', nets: ['SUPPLY'] }); return addIntent(f, filterRelation()); }, 'OVERLAPPING_DISTANCE_OBJECTIVES'],
    [f => { f.config.hard.pinDistanceLimits = [{ a: 'U1', aPin: '1', b: 'C1', bPin: '1', net: 'SUPPLY', maxMil: 80 }]; return addIntent(f, filterRelation({ maxDistanceMil: 100 })); }, 'CONFLICTING_DISTANCE_LIMIT']
  ];
  for (const [change, code] of scenarios) {
    const result = prepareLayoutInputs(change(prepareFixture()));
    assert.equal(result.state.ready, false);
    assert.ok(codes(result).includes(code), JSON.stringify(result.diagnostics));
    assert.equal(result.model, undefined);
  }
});

test('excluded schematic-only endpoints are projected out without changing the upstream contract', () => {
  const fixture = prepareFixture();
  fixture.contract.components.push({ designator: 'VIRTUAL', role: 'schematic reference', includeInPcb: false, pins: [{ number: '1' }] });
  fixture.contract.blocks[0].components.push('VIRTUAL');
  fixture.contract.nets[0].endpoints.push({ component: 'VIRTUAL', pin: '1' });
  const result = prepareLayoutInputs(fixture); ready(result);
  assert.deepEqual(result.receipt.preparation.scope.excluded, ['VIRTUAL']);
  assert.equal(result.contract.components.length, 2);
  assert.equal(result.contract.nets[0].endpoints.length, 2);
  assert.equal(fixture.contract.components.length, 3);
});

test('PCB-only, missing and explicitly excluded native components are separate identity errors', () => {
  for (const [change, code] of [
    [f => { f.contract.components[1].includeInPcb = false; }, 'EXCLUDED_OBJECT_ON_PCB'],
    [f => { f.contract.components.push({ designator: 'MISSING', role: 'missing', includeInPcb: true, pins: [] }); }, 'MISSING_PCB_OBJECT'],
    [f => { f.snapshot.components[1].ref = 'PCB_ONLY'; f.snapshot.pads[1].owner = 'PCB_ONLY'; f.snapshot.items[1].owner = 'PCB_ONLY'; f.snapshot.items[1].text = 'PCB_ONLY'; }, 'PCB_ONLY_OBJECT']
  ]) {
    const fixture = prepareFixture(); change(fixture); const result = prepareLayoutInputs(fixture);
    assert.equal(result.state.identity, 'mismatch'); assert.ok(codes(result).includes(code));
  }
});

test('a standalone test pad must correspond to an included single-pin contract component', () => {
  const fixture = prepareFixture();
  fixture.snapshot.pads.push({ id: 'standalone', owner: null, number: 'TP1', net: 'SUPPLY', x: 300, y: 0, bbox: { minX: 295, minY: -5, maxX: 305, maxY: 5 }, layer: 1 });
  const unknown = prepareLayoutInputs(fixture); assert.ok(codes(unknown).includes('PCB_ONLY_OBJECT'));
  fixture.contract.components.push({ designator: 'TP1', role: 'test point', includeInPcb: true, pins: [{ number: '1' }] });
  fixture.contract.nets[0].endpoints.push({ component: 'TP1', pin: '1' });
  const declared = prepareLayoutInputs(fixture); ready(declared);
  assert.deepEqual(declared.receipt.preparation.scope.standalonePads, ['TP1']);
});

test('unsupported layers, hidden labels, source rotations, bounded boards and routed copper remain explicit', () => {
  const cases = [
    [f => { f.snapshot.components[0].layer = 2; }, 'UNSUPPORTED_COMPONENT_LAYER'],
    [f => { f.snapshot.items.pop(); }, 'DESIGNATOR_COVERAGE'],
    [f => { f.snapshot.components[0].rotation = 45; }, 'UNSUPPORTED_COMPONENT_ROTATION'],
    [f => { f.config.hard.boardBounds = { minX: 0, minY: 0, maxX: 500, maxY: 500 }; }, 'UNSUPPORTED_BOARD_BOUNDS'],
    [f => { f.snapshot.routing.Via = 1; }, 'EXISTING_ROUTING_UNSUPPORTED'],
    [f => { f.snapshot.outlines.push({ id: 'outline' }); }, 'NATIVE_BOARD_OUTLINE_UNSUPPORTED'],
    [f => { f.snapshot.regions.push({ id: 'region', layer: 1 }); }, 'NATIVE_REGION_UNSUPPORTED']
  ];
  for (const [change, code] of cases) {
    const fixture = prepareFixture(); change(fixture); const result = prepareLayoutInputs(fixture);
    assert.equal(result.state.input, 'valid'); assert.equal(result.state.support, 'unsupported');
    assert.equal(result.state.ready, false); assert.ok(codes(result).includes(code));
  }
});

test('legacy snapshots retain their known coordinate convention with an explicit provenance note', () => {
  const fixture = prepareFixture(); delete fixture.snapshot.units; delete fixture.snapshot.coordinateSystem; delete fixture.snapshot.capabilities;
  const result = prepareLayoutInputs(fixture); ready(result);
  assert.equal(result.receipt.preparation.source.units, 'provider-convention');
  assert.equal(result.receipt.preparation.source.normalization.legacyUnitsAssumed, true);
  assert.equal(result.receipt.preparation.source.normalization.legacyCoordinatesAssumed, true);
  assert.equal(result.receipt.preparation.source.providerCapabilities, 'not-recorded');
});

test('logical-to-physical pad mapping and exact footprint conflicts are identity mismatches', () => {
  const fixture = prepareFixture();
  fixture.contract.components[0].bindings = { easyedaPro: { pinMap: { '1': ['A'] } } };
  fixture.snapshot.pads[0].number = 'A';
  ready(prepareLayoutInputs(fixture));
  fixture.snapshot.pads[0].net = 'WRONG';
  const mismatched = prepareLayoutInputs(fixture);
  assert.equal(mismatched.state.identity, 'mismatch');
  assert.ok(codes(mismatched).includes('MODEL_IDENTITY_FAILED'));
  fixture.snapshot.pads[0].net = 'SUPPLY';
  fixture.contract.components[0].footprint = { selection: 'exact', name: 'other-package' };
  const footprint = prepareLayoutInputs(fixture);
  assert.equal(footprint.state.identity, 'mismatch');
  assert.ok(codes(footprint).includes('FOOTPRINT_IDENTITY_MISMATCH'));
});

test('every declared net endpoint is verified even when no distance objective selects it', () => {
  const fixture = prepareFixture();
  assert.ok(fixture.config.groups.every(g => g.links.length === 0));
  fixture.snapshot.pads[0].net = 'UNDECLARED_CHANGE';
  const result = prepareLayoutInputs(fixture);
  assert.equal(result.state.ready, false);
  assert.equal(result.state.identity, 'mismatch');
  assert.ok(result.diagnostics.some(d => d.message.includes('PIN_NET_MISMATCH')));
});

test('explicit owner or parent is required regardless of native-id naming patterns', () => {
  const fixture = prepareFixture();
  fixture.config.assemblyRules = { schemaVersion: 1, profile: { id: 'synthetic', label: 'Synthetic' }, source: { title: 'Synthetic fixture', url: 'https://example.test' },
    rules: [{ id: 'fixture', footprintNames: ['synthetic-package'], marginMm: .254 }], overrides: [], independentPads: { marginMm: 0, basis: 'Synthetic standalone pads' } };
  fixture.snapshot.components[0].id = 'c'; fixture.snapshot.items[0].parentId = 'c';
  fixture.snapshot.components[1].id = 'c1'; fixture.snapshot.items[1].parentId = 'c1';
  fixture.snapshot.pads[0].id = 'opaque-u'; fixture.snapshot.pads[1].id = 'opaque-c';
  const explicit = prepareLayoutInputs(fixture); ready(explicit);
  assert.equal(explicit.model.pads[1].owner, 'C1');
  delete fixture.snapshot.pads[0].owner; delete fixture.snapshot.pads[1].owner;
  fixture.snapshot.pads[0].id = 'c.pad'; fixture.snapshot.pads[1].id = 'c1.pad';
  const missing = prepareLayoutInputs(fixture);
  assert.equal(missing.state.ready, false);
  assert.ok(missing.diagnostics.some(d => d.message.includes('PAD_OWNERSHIP_REQUIRED')));
  assert.equal(missing.receipt.preparation.nativeChecks.ownership.status, 'missing');
  fixture.snapshot.pads[0].parentComponentId = 'c'; fixture.snapshot.pads[1].parentComponentId = 'c1';
  const parentDeclared = prepareLayoutInputs(fixture); ready(parentDeclared);
  assert.equal(parentDeclared.model.pads[1].owner, 'C1');
  fixture.snapshot.pads[1].parentComponentId = 'missing-component';
  const unknownParent = prepareLayoutInputs(fixture);
  assert.equal(unknownParent.state.identity, 'mismatch');
  assert.ok(codes(unknownParent).includes('UNKNOWN_PAD_PARENT'));
});

test('search profiles must be nonempty, uniquely named and executable with explicit seeds and effective weights', () => {
  const cases = [
    [f => { delete f.config.search.profiles; }, 'MISSING_SEARCH_PROFILES'],
    [f => { f.config.search.profiles = []; }, 'MISSING_SEARCH_PROFILES'],
    [f => { f.config.search.profiles.push(structuredClone(f.config.search.profiles[0])); }, 'INVALID_SEARCH_PROFILE_NAME'],
    [f => { f.config.search.profiles[0].name = '../outside'; }, 'INVALID_SEARCH_PROFILE_NAME'],
    [f => { f.config.search.profiles[0].seed = 1.1; }, 'INVALID_SEARCH_SEED'],
    [f => { f.config.search.profiles[0].seed = -1; }, 'INVALID_SEARCH_SEED'],
    [f => { f.config.search.profiles[0].seed = 0x100000000; }, 'INVALID_SEARCH_SEED'],
    [f => { delete f.config.search.profiles[0].weights; f.config.search.profiles[0].weightMultipliers = { bypass: 2 }; }, 'INVALID_SEARCH_WEIGHTS'],
    [f => { f.config.search.profiles[0].weights = { connectivity: 0 }; }, 'INVALID_SEARCH_WEIGHTS'],
    [f => { f.config.search.profiles[0].weights = { connectivity: 1, unknown: 1 }; }, 'INVALID_SEARCH_WEIGHTS'],
    [f => { f.config.search.profiles[0].weights = { connectivity: 1, displacement: 1 }; }, 'INVALID_SEARCH_WEIGHTS']
  ];
  for (const [change, code] of cases) {
    const fixture = prepareFixture(); change(fixture); const result = prepareLayoutInputs(fixture);
    assert.equal(result.state.ready, false); assert.ok(codes(result).includes(code), JSON.stringify(result.diagnostics));
  }
  const fixture = prepareFixture(); fixture.config.search.profiles[0].seed = 0; ready(prepareLayoutInputs(fixture));
  delete fixture.config.scoringMode;
  fixture.config.search.profiles[0].weights.displacement = 0;
  assert.ok(codes(prepareLayoutInputs(fixture)).includes('INVALID_SEARCH_WEIGHTS'), 'The single current weighting rule also applies when scoringMode is omitted');
});

test('zero or absent objective weights are recorded without creating a new preference', () => {
  const fixture = addIntent(prepareFixture(), filterRelation()); fixture.config.comparisonWeights.bypass = 0;
  const result = prepareLayoutInputs(fixture); ready(result);
  assert.equal(result.coverage.relations[0].implements[0].active, false);
  assert.equal(result.config.comparisonWeights.bypass, 0);
});

test('malformed inputs and unknown semantic fields return diagnostics instead of mutating or throwing', () => {
  for (const value of [{}, { snapshot: {} }, { ...prepareFixture(), mechanical: {} }, { ...prepareFixture(), contract: { components: [] } }]) {
    const result = prepareLayoutInputs(value); assert.equal(result.state.ready, false); assert.equal(result.state.input, 'invalid');
  }
  const fixture = addIntent(prepareFixture(), filterRelation({ guessedRadius: 123 }));
  assert.ok(codes(prepareLayoutInputs(fixture)).includes('INVALID_INTENT_FIELDS'));
  const invalidLegacy = addIntent(prepareFixture(), filterRelation()); invalidLegacy.config.groups[2].links.push(null);
  assert.ok(codes(prepareLayoutInputs(invalidLegacy)).includes('INVALID_DISTANCE_OBJECTIVE'));
  const duplicateLegacy = prepareFixture(); duplicateLegacy.config.groups[2].links.push({ a: 'U1', b: 'C1', nets: ['SUPPLY'] }, { a: 'C1', b: 'U1', nets: ['SUPPLY'] });
  assert.ok(codes(prepareLayoutInputs(duplicateLegacy)).includes('DUPLICATE_DISTANCE_OBJECTIVE'));
  const missingScope = prepareFixture(); delete missingScope.contract.components[0].includeInPcb;
  const scope = prepareLayoutInputs(missingScope);
  assert.ok(codes(scope).includes('MISSING_PCB_SCOPE'));
  assert.equal(scope.state.identity, 'unknown');
});

test('intent schema exposes the exact supported extension and rejects unspecified properties', () => {
  const schema = JSON.parse(readFileSync(new URL('../schemas/pcb-layout-intent.v1.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.$defs.relation.properties.kind.enum, ['bypass', 'bootstrap', 'sense', 'power-path']);
  assert.equal(schema.$defs.relation.additionalProperties, false);
});
