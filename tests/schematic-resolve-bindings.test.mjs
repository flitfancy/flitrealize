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
