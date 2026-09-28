import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';
import { summarizeExecution } from '../scripts/action-runner.mjs';

const inspectAction = await loadAction('schematic-inspect', 'easyeda-pro');

function createMockEda(componentX) {
  if (arguments.length === 0) componentX = 2000;
  const components = [
    {
      getState_PrimitiveId: () => 'comp-1', getState_Designator: () => 'U1',
      getState_X: () => componentX, getState_Y: () => 3000, getState_Rotation: () => 0, getState_Mirror: () => false,
      getState_AddIntoBom: () => true, getState_AddIntoPcb: () => true, getState_ComponentType: () => 0,
      getState_LibraryUuid: () => 'lib-uuid-1', getState_Uuid: () => 'dev-uuid-1',
      getState_OtherProperty: () => ({ Value: 'BQ25616' }),
    },
    {
      getState_PrimitiveId: () => 'comp-2', getState_Designator: () => 'R1',
      getState_X: () => 4000, getState_Y: () => 3000, getState_Rotation: () => 90, getState_Mirror: () => false,
      getState_AddIntoBom: () => true, getState_AddIntoPcb: () => true, getState_ComponentType: () => 0,
      getState_LibraryUuid: () => 'lib-uuid-2', getState_Uuid: () => 'dev-uuid-2',
    },
  ];
  return {
    dmt_SelectControl: {
      async getCurrentDocumentInfo() {
        return { uuid: 'sch-test-uuid', tabId: 'sch-test@project', documentType: 1, parentProjectUuid: 'project-test' };
      },
    },
    sch_PrimitiveComponent: {
      async getAll() { return components; },
      async getAllPinsByPrimitiveId(id) {
        const x = id === 'comp-1' ? componentX + 100 : 3900;
        return [{
          getState_PrimitiveId: () => `${id}-pin-1`,
          getState_PinNumber: () => '1',
          getState_PinName: () => 'IN',
          getState_X: () => x,
          getState_Y: () => 3000,
          getState_Rotation: () => 0,
          getState_NoConnect: () => false,
        }];
      },
    },
    sch_PrimitiveWire: {
      async getAll() {
        return [{
          getState_PrimitiveId: () => 'wire-1', getState_Net: () => 'VCC',
          getState_LineWidth: () => 6, getState_LineType: () => 0,
          getState_Line: () => [2100, 3000, 3900, 3000],
        }];
      },
    },
    sch_Net: { async getAllNetsName() { return ['VCC', 'GND', 'NET1']; } },
  };
}

const inspectResult = await inspectAction(createMockEda(), { mode: 'inspect' });
assert.equal(inspectResult.status, 'inspected-with-gaps');
assert.equal(inspectResult.readOnly, true);
assert.equal(inspectResult.schemaVersion, 2);
assert.equal(inspectResult.snapshot.kind, 'flitrealize.schematic-snapshot');
assert.equal(inspectResult.snapshot.document.nativeId, 'sch-test-uuid');
assert.equal(inspectResult.snapshot.components.length, 2);
assert.equal(inspectResult.snapshot.nets.length, 3);
assert.equal(inspectResult.snapshot.components[0].designator, 'U1');
assert.equal(inspectResult.snapshot.components[0].value, 'BQ25616');
assert.deepEqual(inspectResult.snapshot.components[0].position, { x: 2000, y: 3000 });
assert.deepEqual(inspectResult.snapshot.components[0].pins[0].position, { x: 2100, y: 3000 });
assert.equal(inspectResult.snapshot.components[0].pins[0].number, '1');
assert.deepEqual(inspectResult.snapshot.extensions.easyedaPro.wires[0].points, [{ x: 2100, y: 3000 }, { x: 3900, y: 3000 }]);
assert.ok(inspectResult.snapshot.coverage.unknown.includes('net-endpoints'));
assert.ok(inspectResult.snapshot.fingerprints.document.startsWith('fnv1a32-'));

const movedResult = await inspectAction(createMockEda(2200), { mode: 'inspect' });
assert.notEqual(movedResult.snapshot.fingerprints.components, inspectResult.snapshot.fingerprints.components);
assert.notEqual(movedResult.snapshot.fingerprints.document, inspectResult.snapshot.fingerprints.document);

const emptyEda = {
  dmt_SelectControl: {
    async getCurrentDocumentInfo() {
      return { uuid: 'empty', tabId: 'empty@project', documentType: 1, parentProjectUuid: 'project' };
    },
  },
};
const emptyResult = await inspectAction(emptyEda, { mode: 'inspect' });
assert.equal(emptyResult.status, 'inspected-with-gaps');
assert.equal(emptyResult.state.componentCount, 0);
assert.equal(emptyResult.state.coverage.components, 'unsupported');

for (const value of [null, undefined, '', '   ']) {
  const result = await inspectAction(createMockEda(value), { mode: 'inspect' });
  assert.equal(result.snapshot.components[0].position, undefined, 'Unknown coordinates must not become zero');
  const eda = createMockEda();
  eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async () => [{
    getState_PinNumber: () => '1', getState_X: () => value, getState_Y: () => 0,
  }];
  const pins = await inspectAction(eda, { mode: 'inspect' });
  assert.equal(pins.snapshot.components[0].pins[0].position, undefined);
}
assert.deepEqual((await inspectAction(createMockEda(0), {})).snapshot.components[0].position, { x: 0, y: 3000 });

function nativeMock(options = {}) {
  const eda = createMockEda();
  const state = { fileCalls: 0, sourceReads: 0, documentUuid: 'sch-test-uuid', source: 'synthetic-schematic-source', args: null };
  eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ uuid: state.documentUuid, documentType: 1, parentProjectUuid: 'project-test' });
  eda.sys_FileManager = { async getDocumentSource() { state.sourceReads++; return state.source; } };
  eda.sch_ManufactureData = {
    async getNetlistFile(...args) {
      state.fileCalls++; state.args = args;
      if (options.onFile) await options.onFile(state);
      if (options.apiError) throw Error(options.apiError);
      if (Object.hasOwn(options, 'file')) return options.file;
      return new File([options.raw ?? '{"unverifiedExampleFormat":true}'], 'synthetic.enet', { type: 'application/json' });
    },
  };
  return { eda, state };
}

const target = { mode: 'inspect', expectedDocumentUuid: 'sch-test-uuid', expectedProjectUuid: 'project-test' };
const native = nativeMock();
const nativeResult = await inspectAction(native.eda, target);
const nativeEvidence = nativeResult.snapshot.extensions.easyedaPro.nativeNetlist;
assert.equal(nativeEvidence.status, 'ok');
assert.equal(nativeEvidence.source, 'sch_ManufactureData.getNetlistFile');
assert.deepEqual(native.state.args, [undefined, 'JLCEDA']);
assert.equal(native.state.fileCalls, 1);
assert.equal(native.state.sourceReads, 2);
assert.equal(nativeEvidence.raw, '{"unverifiedExampleFormat":true}');
assert.equal(nativeEvidence.file.name, 'synthetic.enet');
assert.equal(nativeEvidence.format.interpretation, 'unverified');
assert.equal(nativeEvidence.scope.pageRange, 'unverified');
assert.equal(nativeEvidence.scope.endpointMembership, 'unverified');
assert.equal(nativeEvidence.scope.sourceUnchanged, true);
assert.equal(nativeEvidence.scope.sourceBeforeFingerprint, nativeEvidence.scope.sourceAfterFingerprint);
assert.ok(nativeEvidence.rawFingerprint.startsWith('fnv1a32-'));
assert.equal(nativeResult.state.coverage.nativeNetlist, 'ok');
assert.ok(nativeResult.snapshot.coverage.unknown.includes('native-netlist-endpoint-semantics'));
assert.ok(nativeResult.snapshot.nets.every(net => net.endpoints.length === 0));
assert.ok(nativeResult.snapshot.components.every(component => component.pins.every(pin => pin.net === null)));
assert.equal(JSON.parse(JSON.stringify(nativeResult)).snapshot.extensions.easyedaPro.nativeNetlist.raw, nativeEvidence.raw, 'File data is transported only as text and scalar metadata');

const unavailable = inspectResult.snapshot.extensions.easyedaPro.nativeNetlist;
assert.equal(unavailable.status, 'unavailable');
assert.equal(unavailable.reason, 'API_UNAVAILABLE');
for (const [options, status, reason] of [
  [{ file: undefined }, 'unavailable', 'FILE_UNAVAILABLE'],
  [{ file: {} }, 'unsupported', 'FILE_TEXT_UNSUPPORTED'],
  [{ file: { async text() { return ''; } } }, 'unsupported', 'EMPTY_OR_NON_TEXT_NETLIST'],
  [{ file: { async text() { return 123; } } }, 'unsupported', 'EMPTY_OR_NON_TEXT_NETLIST'],
  [{ file: { async text() { throw Error('text failed'); } } }, 'error', 'FILE_TEXT_FAILED'],
  [{ apiError: 'export failed' }, 'error', 'NETLIST_API_FAILED'],
]) {
  const mock = nativeMock(options), result = await inspectAction(mock.eda, target);
  const evidence = result.snapshot.extensions.easyedaPro.nativeNetlist;
  assert.equal(evidence.status, status); assert.equal(evidence.reason, reason);
  assert.equal(evidence.raw, undefined); assert.equal(evidence.scope.sourceUnchanged, true);
  assert.equal(result.status, 'inspected-with-gaps');
}

const noSource = nativeMock(); delete noSource.eda.sys_FileManager;
const noSourceResult = await inspectAction(noSource.eda, target);
assert.equal(noSource.state.fileCalls, 0, 'Do not request native output without the source consistency guard');
assert.equal(noSourceResult.snapshot.extensions.easyedaPro.nativeNetlist.reason, 'SOURCE_GUARD_UNAVAILABLE');
const lostSource = nativeMock({ onFile(state) { state.source = null; } });
const lostSourceResult = await inspectAction(lostSource.eda, target);
assert.equal(lostSourceResult.snapshot.extensions.easyedaPro.nativeNetlist.reason, 'SOURCE_GUARD_UNVERIFIED');
assert.equal(lostSourceResult.snapshot.extensions.easyedaPro.nativeNetlist.raw, undefined);

const wrongTarget = nativeMock();
await assert.rejects(() => inspectAction(wrongTarget.eda, { ...target, expectedProjectUuid: 'other-project' }), { code: 'DOCUMENT_MISMATCH' });
assert.equal(wrongTarget.state.fileCalls, 0);
const changedDocument = nativeMock({ onFile(state) { state.documentUuid = 'other-page'; } });
await assert.rejects(() => inspectAction(changedDocument.eda, target), { code: 'DOCUMENT_MISMATCH' });
const changedSource = nativeMock({ onFile(state) { state.source = 'changed-schematic-source'; } });
await assert.rejects(() => inspectAction(changedSource.eda, target), { code: 'DOCUMENT_CHANGED_DURING_INSPECTION' });

const changedBeforeCall = nativeMock();
const originalGetAll = changedBeforeCall.eda.sch_PrimitiveComponent.getAll;
changedBeforeCall.eda.sch_PrimitiveComponent.getAll = async () => { changedBeforeCall.state.documentUuid = 'other-page'; return originalGetAll(); };
await assert.rejects(() => inspectAction(changedBeforeCall.eda, target), { code: 'DOCUMENT_MISMATCH' });
assert.equal(changedBeforeCall.state.fileCalls, 0);

const headerOnly = nativeMock({ onFile(state) { state.source = '{"type":"DOCHEAD","time":2}\nunchanged-content'; } });
headerOnly.state.source = '{"type":"DOCHEAD","time":1}\nunchanged-content';
assert.equal((await inspectAction(headerOnly.eda, target)).snapshot.extensions.easyedaPro.nativeNetlist.scope.sourceUnchanged, true);

function knownNetlist() {
  const component = (ref, uniqueId) => ({ props: { Designator: ref, 'Unique ID': uniqueId }, pinInfoMap: { '1': { name: 'IN', number: '1', net: 'VCC', props: { 'Pin Number': '1' } } } });
  return { version: '2.0.0', projectId: 'project-test', components: { first: component('U1', 'logical-1'), second: component('R1', 'logical-2') } };
}
async function readKnown(value = knownNetlist(), alter = () => {}) {
  const mock = nativeMock({ raw: JSON.stringify(value) }); alter(mock);
  return inspectAction(mock.eda, target);
}
const auditOf = result => result.snapshot.extensions.easyedaPro.nativeNetlist.audit;
const hasDiagnostic = (result, code) => result.snapshot.diagnostics.some(item => item.code === code);
const knownResult = await readKnown();
assert.equal(auditOf(knownResult).status, 'matched');
assert.equal(auditOf(knownResult).counts.matchedComponents, 2);
assert.equal(auditOf(knownResult).counts.matchedPins, 2);
assert.deepEqual(knownResult.snapshot.nets.find(net => net.name === 'VCC').endpoints, [
  { component: 'R1', pin: '1', nativePinId: 'comp-2-pin-1' },
  { component: 'U1', pin: '1', nativePinId: 'comp-1-pin-1' },
]);
assert.ok(knownResult.snapshot.components.every(component => component.pins[0].net === 'VCC'));
assert.equal(knownResult.snapshot.components[0].pins[0].extensions.easyedaPro.netSource.scope, 'current-page-pin-number-match');
assert.equal(knownResult.state.coverage.nativeNetlistEndpoints, 'matched');
assert.ok(!knownResult.snapshot.coverage.unknown.includes('net-endpoints'));
assert.notEqual(knownResult.snapshot.fingerprints.connectivity, nativeResult.snapshot.fingerprints.connectivity, 'Verified endpoint membership participates in the existing connectivity fingerprint');

const multiPage = knownNetlist();
multiPage.components.other = { props: { Designator: 'U_OTHER', 'Unique ID': 'other-page-primitive' }, pinInfoMap: { '1': { number: '1', net: 'OUTSIDE_NET', props: { 'Pin Number': '1' } } } };
const multiResult = await readKnown(multiPage);
assert.equal(auditOf(multiResult).status, 'partial');
assert.deepEqual(auditOf(multiResult).outsidePageRefs, ['U_OTHER']);
assert.ok(!multiResult.snapshot.nets.some(net => net.name === 'OUTSIDE_NET'));
assert.equal(auditOf(multiResult).counts.matchedPins, 2);
assert.equal(multiResult.snapshot.extensions.easyedaPro.nativeNetlist.scope.pageRange, 'current-page-projection;export-range-unverified');

const missingComponent = knownNetlist(); delete missingComponent.components.second;
const missingResult = await readKnown(missingComponent);
assert.equal(auditOf(missingResult).status, 'mismatch');
assert.equal(missingResult.status, 'verification-failed');
assert.equal(summarizeExecution({ success: true, result: missingResult }, { actionName: 'schematic-inspect', mode: 'inspect', mutates: false }).ok, false, 'Read transport success must not promote a known connectivity mismatch to a successful inspection');
assert.ok(missingResult.snapshot.components.length && missingResult.issues.length, 'Failure preserves the observed snapshot and concrete issues');
assert.ok(hasDiagnostic(missingResult, 'PAGE_COMPONENT_MISSING_FROM_NETLIST'));
assert.equal(missingResult.snapshot.components.find(c => c.designator === 'R1').pins[0].net, null);
const missingPin = knownNetlist(); missingPin.components.first.pinInfoMap = {};
assert.ok(hasDiagnostic(await readKnown(missingPin), 'PAGE_PIN_MISSING_FROM_NETLIST'));

const duplicateComponent = knownNetlist(); duplicateComponent.components.copy = structuredClone(duplicateComponent.components.first);
const duplicateResult = await readKnown(duplicateComponent);
assert.equal(auditOf(duplicateResult).status, 'mismatch');
assert.ok(hasDiagnostic(duplicateResult, 'DUPLICATE_EXPORTED_DESIGNATOR'));
assert.equal(duplicateResult.snapshot.components[0].pins[0].net, null);
const duplicatePin = knownNetlist(); duplicatePin.components.first.pinInfoMap.copy = structuredClone(duplicatePin.components.first.pinInfoMap['1']);
assert.ok(hasDiagnostic(await readKnown(duplicatePin), 'DUPLICATE_EXPORTED_PIN'));

const numberingConflict = knownNetlist(); numberingConflict.components.first.pinInfoMap['1'].props['Pin Number'] = '2';
const numberingResult = await readKnown(numberingConflict);
assert.ok(hasDiagnostic(numberingResult, 'NATIVE_PIN_NUMBER_CONFLICT'));
assert.equal(numberingResult.snapshot.components[0].pins[0].net, null);
const extraEmptyPin = knownNetlist(); extraEmptyPin.components.first.pinInfoMap['2'] = { number: '2', net: '', props: { 'Pin Number': '2' } };
const extraEmptyResult = await readKnown(extraEmptyPin);
assert.equal(auditOf(extraEmptyResult).status, 'partial');
assert.deepEqual(auditOf(extraEmptyResult).unmatchedExportPins, [{ ref: 'U1', pin: '2', net: '' }]);
assert.equal(extraEmptyResult.snapshot.components[0].pins.length, 1, 'No symbol pin is invented for an unmatched exported pad');
extraEmptyPin.components.first.pinInfoMap['2'].net = 'VCC';
assert.equal(auditOf(await readKnown(extraEmptyPin)).status, 'mismatch');

const markNoConnect = mock => {
  const original = mock.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId;
  mock.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async id => {
    const pins = await original(id);
    if (id === 'comp-1') pins[0].getState_NoConnect = () => true;
    return pins;
  };
};
const emptyPin = knownNetlist(); emptyPin.components.first.pinInfoMap['1'].net = '';
const ncResult = await readKnown(emptyPin, markNoConnect);
assert.equal(auditOf(ncResult).status, 'matched');
assert.equal(ncResult.snapshot.components[0].pins[0].net, '');
assert.equal(ncResult.snapshot.components[0].pins[0].noConnect, true);
assert.equal(auditOf(ncResult).counts.emptyNetPins, 1);
const unconnected = await readKnown(emptyPin);
assert.equal(unconnected.snapshot.components[0].pins[0].noConnect, false, 'An empty net is not a fabricated NC marker');
const ncConflict = await readKnown(knownNetlist(), markNoConnect);
assert.ok(hasDiagnostic(ncConflict, 'NATIVE_NETLIST_NC_CONFLICT'));
assert.equal(ncConflict.snapshot.components[0].pins[0].net, null);

const wrongProject = knownNetlist(); wrongProject.projectId = 'other-project';
const projectResult = await readKnown(wrongProject);
assert.ok(hasDiagnostic(projectResult, 'NATIVE_NETLIST_PROJECT_MISMATCH'));
assert.equal(auditOf(projectResult).counts.matchedPins, 0);
const wrongName = knownNetlist(); wrongName.components.first.pinInfoMap['1'].net = 'UNLISTED';
assert.equal(auditOf(await readKnown(wrongName)).status, 'matched', 'A successfully interpreted native export is the primary network source');
const withoutNames = await readKnown(knownNetlist(), mock => { delete mock.eda.sch_Net; });
assert.equal(auditOf(withoutNames).status, 'matched');
assert.deepEqual(withoutNames.state.nets, ['VCC']);
assert.equal(withoutNames.snapshot.nets[0].endpoints.length, 2);
const unknownVersion = knownNetlist(); unknownVersion.version = 'future';
const versionResult = await readKnown(unknownVersion);
assert.equal(auditOf(versionResult).status, 'unverified');
assert.ok(versionResult.snapshot.nets.every(net => net.endpoints.length === 0));
assert.equal(versionResult.status, 'inspected-with-gaps');
const failedPinRead = await readKnown(knownNetlist(), mock => { mock.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async () => undefined; });
assert.equal(auditOf(failedPinRead).status, 'partial');
assert.ok(hasDiagnostic(failedPinRead, 'CURRENT_PAGE_PINS_UNVERIFIED'));
assert.equal(failedPinRead.status, 'inspected-with-gaps', 'Unknown pin reads are not known connectivity contradictions');

let legacyNameCalls = 0;
const emptyLegacyNames = await readKnown(knownNetlist(), mock => {
  mock.eda.sch_Net.getAllNetsName = async () => { legacyNameCalls++; return []; };
});
assert.equal(legacyNameCalls, 0, 'Do not run the old names reader alongside a usable native netlist');
assert.equal(auditOf(emptyLegacyNames).status, 'matched');
assert.equal(emptyLegacyNames.snapshot.nets[0].endpoints.length, 2);
assert.equal(emptyLegacyNames.snapshot.extensions.easyedaPro.netReadSource, 'sch_ManufactureData.getNetlistFile');

const manyNets = knownNetlist();
manyNets.components.first.pinInfoMap = Object.fromEntries(Array.from({ length: 53 }, (_, index) => {
  const number = String(index + 1);
  return [number, { number, net: 'SYNTHETIC_NET_' + number, props: { 'Pin Number': number } }];
}));
manyNets.components.second.pinInfoMap['1'].net = 'SYNTHETIC_NET_1';
const manyResult = await readKnown(manyNets, mock => {
  mock.eda.sch_Net.getAllNetsName = async () => [];
  mock.eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId = async id => Array.from({ length: id === 'comp-1' ? 53 : 1 }, (_, index) => ({
    getState_PrimitiveId: () => `${id}-pin-${index + 1}`, getState_PinNumber: () => String(index + 1), getState_NoConnect: () => false,
  }));
});
assert.equal(auditOf(manyResult).status, 'matched');
assert.equal(manyResult.snapshot.nets.length, 53);
assert.equal(manyResult.snapshot.nets.reduce((sum, net) => sum + net.endpoints.length, 0), 54);
assert.equal(manyResult.snapshot.diagnostics.filter(d => d.severity === 'error').length, 0);

const withMarkers = await readKnown(knownNetlist(), mock => {
  const getAll = mock.eda.sch_PrimitiveComponent.getAll;
  mock.eda.sch_PrimitiveComponent.getAll = async () => [...await getAll(),
    { getState_PrimitiveId: () => 'flag', getState_ComponentType: () => 'netflag' },
    { getState_PrimitiveId: () => 'port', getState_ComponentType: () => 'netport' }];
});
assert.equal(withMarkers.snapshot.components.length, 2);
assert.equal(withMarkers.state.componentPrimitiveCount, 4);
assert.equal(withMarkers.state.ignoredNetMarkerCount, 2);
assert.ok(!hasDiagnostic(withMarkers, 'COMPONENT_IDENTITY_INCOMPLETE'));
assert.ok(!withMarkers.snapshot.coverage.unknown.includes('components-without-designators'));
const missingPhysicalIdentity = await readKnown(knownNetlist(), mock => {
  const getAll = mock.eda.sch_PrimitiveComponent.getAll;
  mock.eda.sch_PrimitiveComponent.getAll = async () => [...await getAll(), { getState_PrimitiveId: () => 'nameless-part', getState_ComponentType: () => 'part' }];
});
assert.ok(hasDiagnostic(missingPhysicalIdentity, 'COMPONENT_IDENTITY_INCOMPLETE'), 'A physical component without identity still has incomplete coverage');

process.stdout.write('schematic-inspect tests passed\n');
