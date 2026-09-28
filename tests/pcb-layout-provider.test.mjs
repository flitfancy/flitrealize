import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { prepareFixture, addIntent, filterRelation } from './helpers/pcb-layout-prepare-fixture.mjs';
import { fixture as liveFixture } from './helpers/pcb-layout-execution-fixture.mjs';
import { prepareLayoutInputs } from '../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { runSearch } from '../scripts/pcb-layout/pcb-layout-solver-core.mjs';
import { getLayoutProvider, layoutLabelAlignment, layoutRealization } from '../scripts/pcb-layout/pcb-layout-provider.mjs';
import { makePlan } from '../scripts/pcb-layout/pcb-layout-mechanical-plan.mjs';
import { padOwner, transformLabel } from '../scripts/pcb-layout/pcb-layout-geometry.mjs';
import { inspectLayout, applyLayout, resumeLayoutSave } from '../scripts/pcb-layout/pcb-layout-execution.mjs';

// This is a test-only normalized source, not a registered or supported EDA.
function otherProviderInput() {
  const f = addIntent(prepareFixture(), filterRelation());
  f.config.provider = 'test-other-eda';
  f.snapshot.provider = f.config.provider;
  f.snapshot.coordinateSystem = 'cartesian-y-up';
  f.snapshot.layout = { schemaVersion: 1, provider: f.config.provider, units: 'mil', coordinateSystem: 'cartesian-y-up', layers: {}, pinMaps: {},
    labelAlignment: { bottomLeft: 'other-bottom-left' },
    netlist: { status: 'ok', source: 'test-import', version: 'test-1', components: [] },
    netNames: { status: 'ok', value: ['SUPPLY'] } };
  for (const [i, c] of f.snapshot.components.entries()) {
    c.layer = 700;
    f.snapshot.layout.layers[c.id] = 'top-copper';
    const p = f.snapshot.pads[i];
    p.id = 'independent-native-id-' + i; p.number = 'P' + (i + 10); p.layer = 900;
    p.parentComponentId = c.id;
    f.snapshot.layout.layers[p.id] = 'all-copper';
    const label = f.snapshot.items[i]; label.layer = 1100;
    f.snapshot.layout.layers[label.id] = 'top-silkscreen';
    f.snapshot.layout.pinMaps[c.ref] = { '1': [p.number] };
    f.snapshot.layout.netlist.components.push({ ref: c.ref, uniqueId: 'other-' + i, pins: [{ number: p.number, net: p.net }] });
    // A different provider's obsolete binding must not affect this mapping.
    f.contract.components[i].bindings = { easyedaPro: { pinMap: { '1': ['WRONG'] } } };
  }
  return f;
}

test('normalized layer roles and physical pin mappings drive the same solver without EasyEDA bindings', () => {
  const f = otherProviderInput(), original = structuredClone(f);
  const result = prepareLayoutInputs(f);
  assert.equal(result.state.ready, true, JSON.stringify(result.diagnostics));
  assert.equal(result.receipt.provider, 'test-other-eda');
  assert.deepEqual(result.receipt.components.map(c => c.pose.layer), ['top-copper', 'top-copper']);
  assert.equal(result.receipt.components[0].pinMap['1'][0], 'P10');
  assert.equal(result.receipt.preparation.nativeChecks.network.status, 'matched');
  assert.equal(result.model.realization.labelAlignment.bottomLeft, 'other-bottom-left');
  const labels = makePlan(f.snapshot, { ...f.mechanical, initializeLabels: true }).labels;
  assert.ok(labels.every(l => l.alignMode === 'other-bottom-left'));
  const c = f.snapshot.components[0];
  assert.equal(transformLabel(f.snapshot.items[0].original, c, { ...c, rotation: 90 }, result.model.realization.labelAlignment.bottomLeft).alignMode, 'other-bottom-left');
  const reference = prepareLayoutInputs(addIntent(prepareFixture(), filterRelation()));
  assert.equal(reference.state.ready, true);
  const profile = { name: 'compare', seed: 42, weights: f.config.comparisonWeights };
  const a = runSearch(result.model, profile, 16), b = runSearch(reference.model, profile, 16);
  const poses = c => c.plan.components.map(({ ref, x, y, rotation, body }) => ({ ref, x, y, rotation, body }));
  assert.equal(a.validation.valid, true);
  assert.deepEqual(poses(a), poses(b));
  assert.deepEqual(a.scores, b.scores);
  assert.deepEqual(f, original);
});

test('unknown portable roles, missing ownership and contradictory provider identities stay unsupported', () => {
  const missingRole = otherProviderInput(); delete missingRole.snapshot.layout.layers[missingRole.snapshot.components[0].id];
  assert.ok(prepareLayoutInputs(missingRole).diagnostics.some(d => d.code === 'UNSUPPORTED_COMPONENT_LAYER'));
  const missingOwner = otherProviderInput(); delete missingOwner.snapshot.pads[0].owner; delete missingOwner.snapshot.pads[0].parentComponentId;
  assert.throws(() => layoutRealization(missingOwner.snapshot, missingOwner.contract), /PAD_OWNERSHIP_REQUIRED/);
  const wrongProvider = otherProviderInput(); wrongProvider.config.provider = 'easyeda-pro';
  const mismatch = prepareLayoutInputs(wrongProvider);
  assert.equal(mismatch.state.ready, false);
  assert.match(mismatch.diagnostics.find(d => d.code === 'PROVIDER_INPUT_UNSUPPORTED').message, /LAYOUT_PROVIDER_MISMATCH/);
  const raw = prepareFixture(); raw.snapshot.provider = 'not-implemented';
  assert.equal(prepareLayoutInputs(raw).state.ready, false);
});

test('portable net records retain contradiction and missing-data checks without a native parser', () => {
  const f = otherProviderInput();
  f.snapshot.layout.netlist.components[0].pins[0].net = 'WRONG';
  const mismatch = prepareLayoutInputs(f);
  assert.equal(mismatch.state.ready, false);
  assert.ok(mismatch.diagnostics.some(d => d.code === 'NATIVE_PAD_NET_MISMATCH'));
  f.snapshot.layout.netlist = { status: 'unavailable' };
  const unavailable = prepareLayoutInputs(f);
  assert.equal(unavailable.state.ready, true);
  assert.equal(unavailable.receipt.preparation.nativeChecks.network.status, 'unavailable');
});

test('normalized offline support never silently selects a live EasyEDA transport for another provider', async t => {
  const f = await liveFixture(t);
  let called = false;
  await assert.rejects(inspectLayout({ ...f.options(), providerId: 'test-other-eda', transport: async () => { called = true; } }), /UNSUPPORTED_LAYOUT_PROVIDER/);
  assert.equal(called, false);
  const snapshot = await inspectLayout(f.options());
  snapshot.provider = 'test-other-eda';
  await assert.rejects(applyLayout({ ...f.options(), providerId: 'easyeda-pro', snapshot, plan: f.plan(snapshot) }), /LAYOUT_PROVIDER_MISMATCH/);
  assert.equal(f.control.modifications.length, 0);
});

test('save recovery is bound to the provider recorded by the successful apply', async t => {
  const f = await liveFixture(t);
  const snapshot = await inspectLayout(f.options()); f.control.saveResult = false;
  const result = await applyLayout({ ...f.options(), snapshot, plan: f.plan(snapshot) });
  assert.equal(result.status, 'save-failed');
  const receipt = JSON.parse(await readFile(result.resumeSaveReport));
  assert.equal(receipt.provider, 'easyeda-pro');
  receipt.provider = 'test-other-eda';
  await writeFile(result.resumeSaveReport, JSON.stringify(receipt));
  const before = f.calls.length;
  await assert.rejects(resumeLayoutSave({ ...f.options(), resumeSave: result.resumeSaveReport }), /LAYOUT_PROVIDER_MISMATCH/);
  assert.equal(f.calls.length, before);
});

test('label alignment rejects non-scalar values at both preparation and direct mechanical entry points', () => {
  for (const invalid of [{}, [], null, undefined, false, NaN, Infinity, 1.5, ' ']) {
    const f = otherProviderInput(); f.snapshot.layout.labelAlignment.bottomLeft = invalid;
    const prepared = prepareLayoutInputs(f);
    assert.equal(prepared.state.ready, false);
    assert.ok(prepared.diagnostics.some(d => d.code === 'PROVIDER_INPUT_UNSUPPORTED' && d.message.includes('INVALID_LAYOUT_LABEL_ALIGNMENT')));
    assert.throws(() => layoutLabelAlignment(f.snapshot), /INVALID_LAYOUT_LABEL_ALIGNMENT/);
    assert.throws(() => makePlan(f.snapshot, f.mechanical), /INVALID_LAYOUT_LABEL_ALIGNMENT/);
  }
  const f = prepareFixture(); f.snapshot.layout = layoutRealization(f.snapshot, f.contract);
  f.snapshot.layout.labelAlignment = { bottomLeft: 'foreign-alignment' };
  assert.throws(() => layoutRealization(f.snapshot, f.contract), /LAYOUT_LABEL_ALIGNMENT_MISMATCH/);
});

test('normalized units and axes must describe the actual coordinate arrays consistently', () => {
  for (const [change, code] of [
    [f => { f.snapshot.layout.units = 'mm'; }, 'UNSUPPORTED_LAYOUT_UNITS'],
    [f => { delete f.snapshot.layout.units; }, 'UNSUPPORTED_LAYOUT_UNITS'],
    [f => { f.snapshot.layout.coordinateSystem = 'screen-y-down'; }, 'UNSUPPORTED_LAYOUT_COORDINATES'],
    [f => { f.snapshot.units = 'mm'; }, 'LAYOUT_UNIT_MISMATCH'],
    [f => { f.snapshot.coordinateSystem = 'screen-y-down'; }, 'LAYOUT_COORDINATE_MISMATCH'],
  ]) {
    const f = otherProviderInput(); change(f);
    assert.throws(() => layoutRealization(f.snapshot, f.contract), new RegExp(code));
    assert.equal(prepareLayoutInputs(f).state.ready, false);
  }
});

test('only consumed map and envelope shapes are checked; additional caller metadata remains intact', () => {
  for (const [change, code] of [
    [f => { f.snapshot.layout.layers[f.snapshot.components[0].id] = {}; }, 'INVALID_LAYOUT_LAYER_ROLE'],
    [f => { f.snapshot.layout.pinMaps.U1 = []; }, 'INVALID_LAYOUT_PIN_MAP'],
    [f => { f.snapshot.layout.pinMaps.U1['1'] = []; }, 'INVALID_LAYOUT_PIN_MAP'],
    [f => { f.snapshot.layout.pinMaps.U1['1'] = [{}]; }, 'INVALID_LAYOUT_PIN_MAP'],
    [f => { f.snapshot.pads[0].owner = {}; }, 'INVALID_LAYOUT_PAD_OWNER'],
    [f => { f.snapshot.layout.netlist = { status: 'ok', components: {} }; }, 'INVALID_LAYOUT_NET_ENVELOPE'],
    [f => { f.snapshot.layout.netNames = { status: 'ok' }; }, 'INVALID_LAYOUT_NET_ENVELOPE'],
    [f => { f.snapshot.layout.netlist = { status: 'invented-state' }; }, 'INVALID_LAYOUT_NET_ENVELOPE'],
    [f => { f.snapshot.layout.netlist = { status: 'unsupported', diagnostics: [null] }; }, 'INVALID_LAYOUT_NET_ENVELOPE'],
  ]) {
    const f = otherProviderInput(); change(f);
    assert.throws(() => layoutRealization(f.snapshot, f.contract), new RegExp(code));
    assert.equal(prepareLayoutInputs(f).state.ready, false, 'Malformed boundary input produces a preparation diagnostic, not an uncaught audit exception');
  }
  const extended = otherProviderInput();
  extended.snapshot.layout.extensions = { downstream: { comment: 'Caller-owned metadata' } };
  assert.equal(prepareLayoutInputs(extended).state.ready, true);
  assert.deepEqual(layoutRealization(extended.snapshot, extended.contract).extensions, extended.snapshot.layout.extensions);
});

test('known EasyEDA conventions fill omitted legacy fields but never overwrite explicit unknown values', () => {
  const f = prepareFixture(); delete f.snapshot.units; delete f.snapshot.coordinateSystem;
  const legacy = layoutRealization(f.snapshot, f.contract);
  assert.equal(legacy.units, 'mil'); assert.equal(legacy.coordinateSystem, 'cartesian-y-up');
  assert.equal(legacy.provenance.legacyUnitsAssumed, true);
  f.snapshot.units = null;
  assert.throws(() => layoutRealization(f.snapshot, f.contract), /UNSUPPORTED_LAYOUT_UNITS/);
  delete f.snapshot.units; f.snapshot.coordinateSystem = null;
  assert.throws(() => layoutRealization(f.snapshot, f.contract), /UNSUPPORTED_LAYOUT_COORDINATES/);
  delete f.snapshot.coordinateSystem;
  f.contract.components[0].bindings = { easyedaPro: { pinMap: null } };
  assert.throws(() => layoutRealization(f.snapshot, f.contract), /INVALID_LAYOUT_PIN_MAP/);
  f.contract.components[0].bindings = { easyedaPro: null };
  assert.throws(() => layoutRealization(f.snapshot, f.contract), /INVALID_EASYEDA_BINDING/);
  delete f.contract.components[0].bindings;
  f.snapshot.items[0].layer = null; f.snapshot.items[0].original.layer = 3;
  assert.equal(layoutRealization(f.snapshot, f.contract).layers[f.snapshot.items[0].id], null, 'An explicitly unknown current layer is not replaced by an old layer value');
});

test('malformed native API observations remain uncovered evidence rather than invented empty results', () => {
  const f = prepareFixture();
  f.snapshot.nativeNetNames = { status: 'ok' };
  f.snapshot.nativeNetlist = { status: 'ok', source: 'pcb_Net.getNetlist', raw: 'unknown format' };
  const result = prepareLayoutInputs(f);
  assert.equal(result.state.ready, true, JSON.stringify(result.diagnostics));
  assert.equal(result.receipt.preparation.nativeChecks.network.status, 'unsupported');
  const input = layoutRealization(f.snapshot, f.contract);
  assert.equal(input.netNames.status, 'unsupported'); assert.equal(input.netNames.value, undefined);
  delete f.snapshot.nativeNetNames; delete f.snapshot.nativeNetlist;
  const absent = layoutRealization(f.snapshot, f.contract);
  assert.equal(absent.netNames, undefined); assert.equal(absent.netlist, undefined);
});

test('explicit invalid provider identity and live context cannot fall through to EasyEDA defaults', () => {
  for (const provider of [null, false, {}, '']) {
    const f = prepareFixture(); f.snapshot.provider = provider;
    assert.throws(() => layoutRealization(f.snapshot, f.contract), /INVALID_LAYOUT_PROVIDER/);
  }
  for (const windowId of [undefined, {}, false, 7, '']) assert.throws(() => getLayoutProvider().validateContext({ windowId }), /confirmed EasyEDA windowId/);
});

test('native operation construction contains only the current runtime input binding', async () => {
  const operation = await getLayoutProvider().buildOperation('inspect', { config: {} });
  assert.match(operation.code, /const layoutExecutionInput=/);
  assert.ok(!operation.code.includes('mechanicalLayoutInput'));
  assert.ok(!operation.code.includes('mechanicalVerifyInput'));
});

test('pad ownership accepts explicit declarations only, including explicitly standalone pads', () => {
  const components = [{ id: 'c', ref: 'A' }, { id: 'c1', ref: 'B' }];
  assert.throws(() => padOwner({ id: 'c1:pad' }, components), /PAD_OWNERSHIP_REQUIRED/);
  assert.equal(padOwner({ id: 'c1:pad', owner: null }, components), undefined);
  assert.equal(padOwner({ id: 'unrelated', parentComponentId: 'c1' }, components), components[1]);
  assert.equal(padOwner({ id: 'unrelated', parentComponentId: null }, components), undefined);
  assert.throws(() => padOwner({ id: 'p', owner: 'A', parentComponentId: 'c1' }, components), /PAD_PARENT_MISMATCH/);
  assert.throws(() => padOwner({ id: 'p', parentComponentId: 'unknown' }, components), /UNKNOWN_PAD_PARENT/);
});
