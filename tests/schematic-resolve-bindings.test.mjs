import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const resolveAction = await loadAction('schematic-resolve-bindings', 'easyeda-pro');

const contract = {
  kind: 'flitrealize.schematic-contract',
  schemaVersion: 1,
  components: [
    {
      designator: 'U1',
      identity: { selection: 'exact', manufacturer: 'Texas Instruments', mpn: 'TEST123' },
      footprint: { selection: 'exact', name: 'QFN-8' },
      pinMapCoverage: 'complete',
      pins: [{ number: 'VIN' }, { number: 'GND' }],
    },
    {
      designator: 'R1',
      identity: { selection: 'generic', value: '10k' },
      footprint: { selection: 'policy', policy: '0402' },
      pinMapCoverage: 'complete',
      pins: [{ number: '1' }, { number: '2' }],
    },
  ],
};

const eda = {
  lib_Device: {
    async search(query) {
      if (query.includes('TEST123')) {
        return [{
          libraryUuid: 'lib-u1', uuid: 'dev-u1', name: 'TEST123',
          manufacturer: 'Texas Instruments', mpn: 'TEST123', footprint: 'QFN-8',
        }];
      }
      if (query.includes('10k')) {
        return [{ libraryUuid: 'lib-r1-candidate', uuid: 'dev-r1-candidate', name: '10k resistor', footprint: '0402' }];
      }
      return [];
    },
  },
};

const searched = await resolveAction(eda, { mode: 'search', contract, searchMapping: { R1: '10k 0402' } });
assert.equal(searched.status, 'searched');
assert.equal(searched.results.find((result) => result.designator === 'U1').candidates[0].autoSelectable, true);
assert.equal(searched.results.find((result) => result.designator === 'R1').candidates[0].autoSelectable, false);

const partiallyResolved = await resolveAction(eda, {
  mode: 'resolve', contract, searchMapping: { R1: '10k 0402' }, pinMaps: { U1: { VIN: '1', GND: ['2', 'EP'] } },
});
assert.equal(partiallyResolved.status, 'resolved-with-blockers');
assert.deepEqual(partiallyResolved.providerBindings.U1.pinMap, { VIN: ['1'], GND: ['2', 'EP'] });
assert.equal(partiallyResolved.unresolved[0].designator, 'R1');
assert.ok(partiallyResolved.bindingFingerprint.startsWith('fnv1a32-'));
assert.equal('plan' in partiallyResolved, false);

const resolved = await resolveAction(eda, {
  mode: 'resolve',
  contract,
  selections: {
    R1: { libraryUuid: 'lib-r1', deviceUuid: 'dev-r1', pinMap: { 1: '1', 2: ['2'] } },
  },
  pinMaps: { U1: { VIN: '1', GND: '2' } },
});
assert.equal(resolved.status, 'resolved');
assert.deepEqual(resolved.providerBindings.R1.pinMap, { 1: ['1'], 2: ['2'] });
assert.equal(resolved.diagnostics.length, 0);

const substringEda = {
  lib_Device: {
    async search() {
      return [{
        libraryUuid: 'lib-wrong', uuid: 'dev-wrong', manufacturer: 'Texas Instruments China',
        mpn: 'TEST123A', footprint: 'QFN-8-EP',
      }];
    },
  },
};
const substringResult = await resolveAction(substringEda, { mode: 'resolve', contract: { ...contract, components: [contract.components[0]] } });
assert.equal(substringResult.status, 'resolved-with-blockers');
assert.equal(substringResult.resolvedCount, 0);

await assert.rejects(
  () => resolveAction(eda, {
    mode: 'resolve', contract,
    selections: { R1: { libraryUuid: 'lib-r1', deviceUuid: 'dev-r1', pinMap: { MISSING: '1' } } },
  }),
  (error) => error.code === 'INVALID_PIN_MAP',
);

await assert.rejects(
  () => resolveAction({ lib_Device: { async search() { throw new Error('offline'); } } }, { mode: 'search', contract }),
  (error) => error.code === 'LIBRARY_SEARCH_FAILED',
);

process.stdout.write('schematic-resolve-bindings tests passed\n');

function libraryFixture() {
  const component = structuredClone(contract.components[0]);
  component.bindings = { easyedaPro: { libraryUuid: 'device-library', deviceUuid: 'device-id', deviceName: 'TEST123', pinMap: { VIN: ['1'], GND: ['2'] } } };
  component.extensions = { easyedaPro: { expectedPinCount: 8 } };
  const input = { ...structuredClone(contract), components: [component] }, calls = [];
  const records = {
    Device: { uuid: 'device-id', libraryUuid: 'device-library', name: 'TEST123', association: { symbol: { uuid: 'symbol-id', libraryUuid: 'symbol-library' }, footprint: { uuid: 'footprint-id', libraryUuid: 'footprint-library' } }, property: { manufacturerId: 'TEST123' } },
    Symbol: { uuid: 'symbol-id', libraryUuid: 'symbol-library', name: 'TEST123', subPartNames: ['TEST123.1'], otherProperty: { PinCount: '8' } },
    Footprint: { uuid: 'footprint-id', libraryUuid: 'footprint-library', name: 'QFN-8', otherProperty: { PinCount: '9' } },
  };
  const api = Object.fromEntries(Object.keys(records).map(kind => ['lib_' + kind, { async get(uuid, libraryUuid) { calls.push([kind, uuid, libraryUuid]); return structuredClone(records[kind]); } }]));
  return { component, contract: input, records, calls, eda: api, resolve: () => resolveAction(api, { mode: 'resolve', contract: input }) };
}

{
  const f = libraryFixture(), before = structuredClone(f.contract);
  const second = structuredClone(f.component); second.designator = 'U2'; f.contract.components.push(second);
  const result = await f.resolve();
  assert.equal(result.status, 'resolved');
  assert.equal(result.providerBindings.U1.libraryEvidence.status, 'matched');
  assert.equal(result.providerBindings.U1.libraryEvidence.scope, 'library-identity-only');
  assert.equal(result.providerBindings.U1.resolution.libraryIdentityVerified, true);
  assert.deepEqual(f.calls, [['Device', 'device-id', 'device-library'], ['Symbol', 'symbol-id', 'symbol-library'], ['Footprint', 'footprint-id', 'footprint-library']]);
  assert.equal(result.providerBindings.U1.libraryEvidence.symbol.observed.pinCount, 8);
  assert.equal(result.providerBindings.U1.libraryEvidence.footprint.observed.pinCount, 9, 'symbol and footprint counts need not be equal');
  assert.deepEqual(f.contract.components[0], before.components[0], 'library reads must not alter the Contract');
  assert.deepEqual(result.providerBindings.U1.pinMap, f.component.bindings.easyedaPro.pinMap);
}

for (const missing of ['Device', 'Symbol', 'Footprint']) {
  const f = libraryFixture(); delete f.eda['lib_' + missing];
  const result = await f.resolve(), proof = result.providerBindings.U1.libraryEvidence;
  assert.equal(result.status, 'resolved'); assert.equal(result.diagnostics.length, 0);
  assert.notEqual(proof.status, 'matched'); assert.equal(proof[missing.toLowerCase()].readStatus, 'unavailable');
  assert.equal(result.providerBindings.U1.resolution.libraryIdentityVerified, false);
}

for (const failure of ['not-found', 'error', 'malformed']) {
  const f = libraryFixture(); f.eda.lib_Footprint.get = async (uuid, lib) => { f.calls.push(['Footprint', uuid, lib]); if (failure === 'error') throw Error('network offline'); return failure === 'not-found' ? undefined : 'not-an-item'; };
  const second = structuredClone(f.component); second.designator = 'U2'; f.contract.components.push(second);
  const result = await f.resolve();
  assert.equal(result.status, 'resolved'); assert.equal(result.providerBindings.U1.libraryEvidence.footprint.readStatus, failure === 'malformed' ? 'error' : failure);
  assert.equal(result.providerBindings.U1.libraryEvidence.footprint.status, 'unverified');
  assert.equal(f.calls.filter(c => c[0] === 'Footprint').length, 1, 'failed library queries must also be cached');
}

{
  const f = libraryFixture(); f.records.Device.association = { symbol: { uuid: 'symbol-id' }, footprintUuid: 'footprint-id' };
  const result = await f.resolve(), proof = result.providerBindings.U1.libraryEvidence;
  assert.equal(result.status, 'resolved'); assert.equal(proof.status, 'partial');
  assert.equal(proof.symbol.reason, 'exact-library-and-item-uuid-required'); assert.equal(proof.footprint.reason, 'exact-library-and-item-uuid-required');
  assert.deepEqual(f.calls, [['Device', 'device-id', 'device-library']], 'do not use device library or API defaults for an unknown child library');
}

for (const [kind, field, value] of [['Device', 'uuid', 'different'], ['Symbol', 'libraryUuid', 'different'], ['Footprint', 'name', 'QFN-16']]) {
  const f = libraryFixture(); f.records[kind][field] = value;
  const result = await f.resolve();
  assert.equal(result.status, 'resolved-with-blockers'); assert.equal(result.resolvedCount, 0);
  assert.equal(result.unresolved[0].code, 'LIBRARY_IDENTITY_MISMATCH');
  assert.ok(result.unresolved[0].conflicts.some(c => c.field === field));
  assert.equal(result.evidence[0].libraryEvidence.status, 'mismatch');
}

for (const field of ['uuid', 'libraryUuid', 'name']) {
  const f = libraryFixture(); delete f.records.Footprint[field];
  const result = await f.resolve(), proof = result.providerBindings.U1.libraryEvidence.footprint;
  assert.equal(result.status, 'resolved'); assert.equal(proof.status, 'partial');
  assert.ok(proof.checks.some(c => c.field === field && c.status === 'uncovered'));
}

for (const value of [undefined, true, 'not-a-count']) {
  const f = libraryFixture(); f.records.Symbol.otherProperty = value === undefined ? {} : { PinCount: value };
  const result = await f.resolve(), proof = result.providerBindings.U1.libraryEvidence.symbol;
  assert.equal(result.status, 'resolved'); assert.equal(proof.observed.pinCount, null); assert.equal(proof.status, 'partial');
  assert.ok(proof.checks.some(c => c.field === 'pinCount' && c.status === 'uncovered'));
}

{
  const f = libraryFixture(); f.records.Symbol.otherProperty.PinCount = 16;
  const result = await f.resolve(); assert.equal(result.status, 'resolved-with-blockers');
  assert.ok(result.unresolved[0].conflicts.some(c => c.field === 'pinCount' && c.actual === 16 && c.expected === 8));
}

{
  const f = libraryFixture(); delete f.component.extensions;
  f.component.identity.mpn = 'CUSTOM-PART'; f.component.footprint.name = 'CUSTOM-FOOTPRINT';
  f.component.bindings.easyedaPro.extensions = { supplierOverride: 'C-CUSTOM', footprintOverride: { libraryUuid: 'private-library', footprintUuid: 'private-footprint', projectFootprintUuid: 'instance-footprint', name: 'CUSTOM-FOOTPRINT' }, reason: 'Explicit project override' };
  f.eda.lib_Footprint.get = async (uuid, lib) => { f.calls.push(['Footprint', uuid, lib]); return { uuid, libraryUuid: lib, name: 'CUSTOM-FOOTPRINT', otherProperty: {} }; };
  const before = structuredClone(f.contract), result = await f.resolve(), binding = result.providerBindings.U1;
  assert.equal(result.status, 'resolved'); assert.equal(binding.libraryEvidence.status, 'matched');
  assert.equal(binding.libraryEvidence.footprint.selection.explicitOverride, true);
  assert.equal(binding.libraryEvidence.footprint.selection.defaultAssociation.uuid, 'footprint-id');
  assert.ok(f.calls.some(c => c[0] === 'Footprint' && c[1] === 'private-footprint' && c[2] === 'private-library'));
  assert.ok(!f.calls.some(c => c[1] === 'footprint-id' || c[1] === 'instance-footprint'));
  assert.deepEqual(binding.extensions, f.component.bindings.easyedaPro.extensions);
  assert.deepEqual(f.contract, before);
}

{
  const f = libraryFixture(); f.component.bindings.easyedaPro.symbolUuid = 'explicit-symbol'; f.component.bindings.easyedaPro.symbolLibraryUuid = 'explicit-symbol-library'; f.component.bindings.easyedaPro.symbolName = 'EXPLICIT';
  f.eda.lib_Symbol.get = async (uuid, lib) => { f.calls.push(['Symbol', uuid, lib]); return { uuid, libraryUuid: lib, name: 'EXPLICIT', otherProperty: { PinCount: 8 } }; };
  const result = await f.resolve();
  assert.equal(result.status, 'resolved'); assert.equal(result.providerBindings.U1.libraryEvidence.symbol.selection.explicitOverride, true);
  assert.ok(f.calls.some(c => c[0] === 'Symbol' && c[1] === 'explicit-symbol' && c[2] === 'explicit-symbol-library'));
  assert.equal(result.providerBindings.U1.symbolUuid, 'explicit-symbol');
}

{
  const f = libraryFixture(); f.component.bindings.easyedaPro.extensions = { footprintOverride: { footprintUuid: 'private-footprint' } };
  const result = await f.resolve(), proof = result.providerBindings.U1.libraryEvidence.footprint;
  assert.equal(result.status, 'resolved'); assert.equal(proof.readStatus, 'unavailable');
  assert.equal(proof.requested.libraryUuid, null); assert.equal(proof.requested.uuid, 'private-footprint');
  assert.ok(!f.calls.some(c => c[0] === 'Footprint'), 'incomplete explicit override must not fall back to library defaults');
}

{
  const f = libraryFixture(); f.component.bindings.easyedaPro.footprintUuid = 'direct-footprint'; f.component.bindings.easyedaPro.footprintLibraryUuid = 'private-library';
  f.component.bindings.easyedaPro.extensions = { footprintOverride: { footprintUuid: 'other-footprint', libraryUuid: 'private-library' } };
  f.eda.lib_Footprint.get = async (uuid, lib) => ({ uuid, libraryUuid: lib, name: 'QFN-8' });
  const result = await f.resolve(); assert.equal(result.status, 'resolved-with-blockers');
  assert.ok(result.unresolved[0].conflicts.some(c => c.code === 'LIBRARY_OVERRIDE_INPUT_CONFLICT'));
}

{
  const f = libraryFixture(), other = structuredClone(f.component); other.designator = 'U2'; other.bindings.easyedaPro.libraryUuid = 'second-device-library'; f.contract.components.push(other);
  for (const kind of ['Device', 'Symbol', 'Footprint']) f.eda['lib_' + kind].get = async (uuid, lib) => {
    f.calls.push([kind, uuid, lib]);
    if (kind === 'Device') return { uuid, libraryUuid: lib, name: 'TEST123', association: { symbol: { uuid: 'shared-id', libraryUuid: lib }, footprint: { uuid: 'shared-id', libraryUuid: lib } } };
    return { uuid, libraryUuid: lib, name: kind === 'Footprint' ? 'QFN-8' : 'TEST123', otherProperty: { PinCount: 8 } };
  };
  assert.equal((await f.resolve()).status, 'resolved');
  assert.equal(f.calls.length, 6); assert.equal(new Set(f.calls.map(c => JSON.stringify(c))).size, 6, 'cache must include library UUID and item type');
}

process.stdout.write('schematic library identity evidence tests passed\n');
