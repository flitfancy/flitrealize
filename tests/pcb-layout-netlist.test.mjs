import test from 'node:test';
import assert from 'node:assert/strict';
import { auditNativeNetlist } from '../scripts/pcb-layout/pcb-layout-netlist.mjs';

function fixture() {
  const contract = {
    components: [{ designator: 'U_LOAD', includeInPcb: true, pinMapCoverage: 'complete', pins: [{ number: '1', classification: 'power-in' }, { number: '2', classification: 'no-connect' }] }],
    nets: [{ name: 'SUPPLY', endpoints: [{ component: 'U_LOAD', pin: '1' }] }]
  };
  const snapshot = {
    components: [{ id: 'native-load', ref: 'U_LOAD' }],
    pads: [{ id: 'opaque-pad-a', owner: 'U_LOAD', number: '1', net: 'SUPPLY' }, { id: 'opaque-pad-b', owner: 'U_LOAD', number: '2', net: '' }],
    nativeNetlist: { status: 'ok', source: 'pcb_Net.getNetlist', raw: JSON.stringify({ version: 1, components: { sourceId: { props: { Designator: 'U_LOAD', 'Unique ID': 'logical-load' }, pinInfoMap: { first: { number: '1', net: 'SUPPLY' }, second: { number: '2', net: '' } } } } }) },
    nativeNetNames: { status: 'ok', source: 'pcb_Net.getAllNetName', value: ['SUPPLY'] }
  };
  return { snapshot, contract };
}
function editNative(f, callback) {
  const raw = JSON.parse(f.snapshot.nativeNetlist.raw); callback(raw);
  f.snapshot.nativeNetlist.raw = JSON.stringify(raw); return f;
}
const codes = result => result.diagnostics.map(d => d.code);
function expectMismatch(f, code) {
  const result = auditNativeNetlist(f); assert.equal(result.status, 'mismatch', JSON.stringify(result));
  assert.ok(codes(result).includes(code), JSON.stringify(result));
  assert.ok(result.diagnostics.some(d => d.code === code && d.severity === 'error')); return result;
}

test('three-way equality includes explicit NC and does not mutate inputs or claim copper connectivity', () => {
  const f = fixture(), before = structuredClone(f), result = auditNativeNetlist(f);
  assert.equal(result.status, 'matched'); assert.deepEqual(result.diagnostics, []);
  assert.equal(result.counts.comparedComponents, 1); assert.equal(result.counts.comparedPadAssignments, 2);
  assert.equal(result.scope.pinNumbering[0].mode, 'identity-equivalent');
  assert.equal(result.scope.comparison, 'declared-net-assignments-not-copper-connectivity');
  assert.deepEqual(result.scope.formatVersion, { observed: 1, validation: 'supported-structure-only;version-not-certified' });
  assert.deepEqual(f, before);
});

test('native component scope detects missing, unexpected and duplicate designators', () => {
  const missing = editNative(fixture(), raw => { raw.components = {}; }); expectMismatch(missing, 'MISSING_NATIVE_COMPONENT');
  const extra = editNative(fixture(), raw => { raw.components.extra = { props: { Designator: 'UNDECLARED', 'Unique ID': 'extra' }, pinInfoMap: {} }; }); expectMismatch(extra, 'UNEXPECTED_NATIVE_COMPONENT');
  const duplicate = editNative(fixture(), raw => { raw.components.duplicate = structuredClone(raw.components.sourceId); }); expectMismatch(duplicate, 'DUPLICATE_NATIVE_COMPONENT');
});

test('wrong native net and wrong actual pad net each identify the discrepant side', () => {
  const wrongNative = editNative(fixture(), raw => { raw.components.sourceId.pinInfoMap.first.net = 'RETURN'; });
  const nativeResult = expectMismatch(wrongNative, 'NATIVE_CONTRACT_NET_MISMATCH');
  assert.ok(codes(nativeResult).includes('NATIVE_PAD_NET_MISMATCH'));
  const wrongPad = fixture(); wrongPad.snapshot.pads[0].net = 'RETURN';
  const padResult = expectMismatch(wrongPad, 'PAD_CONTRACT_NET_MISMATCH'); assert.ok(codes(padResult).includes('NATIVE_PAD_NET_MISMATCH'));
});

test('same-number physical pads are all compared and disagreeing duplicates are rejected', () => {
  const f = fixture(); f.snapshot.pads.push({ ...f.snapshot.pads[0], id: 'additional-copper-pad' });
  const matched = auditNativeNetlist(f); assert.equal(matched.status, 'matched'); assert.equal(matched.counts.comparedPadAssignments, 3);
  f.snapshot.pads[2].net = 'OTHER'; expectMismatch(f, 'DUPLICATE_PAD_NET_CONFLICT');
});

test('native repeated physical pin entries may agree but cannot carry conflicting nets', () => {
  const f = editNative(fixture(), raw => { raw.components.sourceId.pinInfoMap.copy = { number: '1', net: 'SUPPLY' }; });
  assert.equal(auditNativeNetlist(f).status, 'matched');
  editNative(f, raw => { raw.components.sourceId.pinInfoMap.copy.net = 'OTHER'; }); expectMismatch(f, 'DUPLICATE_NATIVE_PIN_NET_CONFLICT');
});

test('logical and physical number domains are established from explicit mappings, not matching net names', () => {
  for (const nativeNumbering of ['logical', 'physical']) {
    const f = fixture();
    f.contract.components[0].pins[0].number = 'POWER'; f.contract.components[0].pins[1].number = 'UNUSED';
    f.contract.components[0].bindings = { easyedaPro: { pinMap: { POWER: ['1'], UNUSED: ['2'] } } };
    f.contract.nets[0].endpoints[0].pin = 'POWER';
    if (nativeNumbering === 'logical') editNative(f, raw => { raw.components.sourceId.pinInfoMap.first.number = 'POWER'; raw.components.sourceId.pinInfoMap.second.number = 'UNUSED'; });
    const result = auditNativeNetlist(f); assert.equal(result.status, 'matched', JSON.stringify(result));
    assert.equal(result.scope.pinNumbering[0].mode, nativeNumbering);
  }
});

test('one logical pin may map to multiple physical numbers and every pad is checked', () => {
  const f = fixture(); f.contract.components[0].bindings = { easyedaPro: { pinMap: { '1': ['PWR_A', 'PWR_B'], '2': ['NC'] } } };
  f.snapshot.pads[0].number = 'PWR_A'; f.snapshot.pads[1].number = 'NC';
  f.snapshot.pads.push({ id: 'other-power-pad', owner: 'U_LOAD', number: 'PWR_B', net: 'SUPPLY' });
  const result = auditNativeNetlist(f); assert.equal(result.status, 'matched'); assert.equal(result.scope.pinNumbering[0].mode, 'logical');
  assert.equal(result.counts.comparedPadAssignments, 3);
  f.snapshot.pads[2].net = ''; expectMismatch(f, 'PAD_CONTRACT_NET_MISMATCH');
});

test('ambiguous nonidentity numbering remains unsupported even if one interpretation happens to match', () => {
  const f = fixture(); f.contract.components[0].bindings = { easyedaPro: { pinMap: { '1': ['2'], '2': ['1'] } } };
  f.snapshot.pads[0].net = ''; f.snapshot.pads[1].net = 'SUPPLY';
  const result = auditNativeNetlist(f); assert.equal(result.status, 'unsupported');
  assert.ok(codes(result).includes('NATIVE_PIN_NUMBERING_AMBIGUOUS'));
  assert.equal(result.counts.comparedPadAssignments, 0);
});

test('NC means explicit empty net; absent net fields or undeclared logical pins remain unknown', () => {
  const connectedNc = fixture(); connectedNc.snapshot.pads[1].net = 'SUPPLY'; expectMismatch(connectedNc, 'PAD_CONTRACT_NET_MISMATCH');
  const absentPad = fixture(); delete absentPad.snapshot.pads[1].net;
  const pad = auditNativeNetlist(absentPad); assert.equal(pad.status, 'unsupported'); assert.ok(codes(pad).includes('PAD_NET_UNAVAILABLE'));
  const absentNative = editNative(fixture(), raw => { delete raw.components.sourceId.pinInfoMap.second.net; });
  const native = auditNativeNetlist(absentNative); assert.equal(native.status, 'unsupported'); assert.ok(codes(native).includes('NATIVE_PIN_NET_UNAVAILABLE'));
  const undeclared = fixture(); undeclared.contract.components[0].pins[1].classification = 'signal';
  assert.ok(codes(auditNativeNetlist(undeclared)).includes('CONTRACT_PIN_NET_UNDECLARED'));
});

test('standalone test pad absence from component netlist is allowed but its assigned net is checked', () => {
  const f = fixture(); f.contract.components.push({ designator: 'TP_CHECK', includeInPcb: true, pinMapCoverage: 'complete', pins: [{ number: '1', classification: 'passive' }] });
  f.contract.nets[0].endpoints.push({ component: 'TP_CHECK', pin: '1' });
  f.snapshot.pads.push({ id: 'test-pad', owner: null, number: 'TP_CHECK', net: 'SUPPLY' });
  const result = auditNativeNetlist(f); assert.equal(result.status, 'matched'); assert.equal(result.counts.standalonePads, 1);
  editNative(f, raw => { raw.components.test = { props: { Designator: 'TP_CHECK' }, pinInfoMap: { p: { number: '1', net: 'SUPPLY' } } }; });
  assert.equal(auditNativeNetlist(f).status, 'matched');
  f.snapshot.pads[2].net = ''; expectMismatch(f, 'PAD_CONTRACT_NET_MISMATCH');
});

test('excluded upstream entries are projected out without ignoring an excluded actual PCB object', () => {
  const f = fixture(); f.contract.components.push({ designator: 'VIRTUAL', includeInPcb: false, pins: [{ number: '1', classification: 'passive' }] });
  f.contract.nets[0].endpoints.push({ component: 'VIRTUAL', pin: '1' });
  editNative(f, raw => { raw.components.virtual = { props: { Designator: 'VIRTUAL' }, pinInfoMap: { p: { number: '1', net: 'OTHER' } } }; });
  const projected = auditNativeNetlist(f); assert.equal(projected.status, 'matched'); assert.deepEqual(projected.scope.excludedNativeRefs, ['VIRTUAL']);
  f.snapshot.components.push({ id: 'virtual-object', ref: 'VIRTUAL' }); expectMismatch(f, 'UNEXPECTED_PCB_COMPONENT');
});

test('legacy absence, API failures and unknown formats are distinct from a known empty netlist', () => {
  const legacy = fixture(); delete legacy.snapshot.nativeNetlist; delete legacy.snapshot.nativeNetNames;
  const old = auditNativeNetlist(legacy); assert.equal(old.status, 'unavailable'); assert.equal(old.counts.nativeNetNames, null);
  const failure = fixture(); failure.snapshot.nativeNetlist = { status: 'error', source: 'pcb_Net.getNetlist', error: 'read failed' };
  assert.equal(auditNativeNetlist(failure).status, 'error');
  for (const raw of ['not json', '[]', '{}', JSON.stringify({ components: { unknown: { pins: [] } } })]) {
    const f = fixture(); f.snapshot.nativeNetlist.raw = raw;
    assert.equal(auditNativeNetlist(f).status, 'unsupported', raw);
  }
  expectMismatch(editNative(fixture(), raw => { raw.components = {}; }), 'MISSING_NATIVE_COMPONENT');
});

test('unknown pin records do not turn missing fields into claimed omissions', () => {
  const f = editNative(fixture(), raw => { delete raw.components.sourceId.pinInfoMap.first.number; });
  const result = auditNativeNetlist(f); assert.equal(result.status, 'unsupported');
  assert.ok(codes(result).includes('NATIVE_PIN_FORMAT_UNSUPPORTED')); assert.ok(!codes(result).includes('MISSING_NATIVE_PIN'));
});

test('net-name inventory checks only known assigned names and preserves unavailable versus empty', () => {
  const absent = fixture(); delete absent.snapshot.nativeNetNames;
  const partial = auditNativeNetlist(absent); assert.equal(partial.status, 'matched'); assert.equal(partial.scope.nativeNetNames, 'unavailable');
  const empty = fixture(); empty.snapshot.nativeNetNames.value = []; expectMismatch(empty, 'NATIVE_NET_NAME_MISSING');
  const extra = fixture(); extra.snapshot.nativeNetNames.value.push('UNUSED_DECLARED_NET'); assert.equal(auditNativeNetlist(extra).status, 'matched');
});

test('known contradictions still take precedence when another source is unavailable', () => {
  const f = fixture(); f.snapshot.nativeNetlist = { status: 'unavailable', source: 'pcb_Net.getNetlist' }; f.snapshot.pads[0].net = 'OTHER';
  expectMismatch(f, 'PAD_CONTRACT_NET_MISMATCH');
});

test('complete logical mapping may have additional unassigned physical pads without claiming their purpose', () => {
  const f = fixture();
  f.contract.components[0].pins.push({ number: '3', classification: 'no-connect' });
  f.snapshot.pads.push({ id: 'third-declared-pad', owner: 'U_LOAD', number: '3', net: '' });
  editNative(f, raw => { raw.components.sourceId.pinInfoMap.third = { number: '3', net: '' }; });
  for (const number of ['4', '5', '6', '7']) {
    f.snapshot.pads.push({ id: 'extra-' + number, owner: 'U_LOAD', number, net: '' });
    editNative(f, raw => { raw.components.sourceId.pinInfoMap['extra-' + number] = { number, net: '' }; });
  }
  const result = auditNativeNetlist(f);
  assert.equal(result.status, 'partial');
  assert.equal(result.scope.pinNumbering[0].mode, 'physical');
  assert.equal(result.counts.comparedPadAssignments, 7);
  assert.equal(result.counts.comparedContractPadAssignments, 3);
  assert.equal(result.scope.uncoveredPhysicalPins.length, 4);
  assert.ok(result.scope.uncoveredPhysicalPins.every(p => p.nativeNetCompared && p.nativeNet === '' && p.classification === 'not-declared'));
  assert.ok(result.diagnostics.every(d => d.severity === 'warning' && d.code === 'UNDECLARED_EMPTY_PHYSICAL_PIN'));
});

test('an additional physical pad with an assigned net is an undeclared connection, even if native data agrees', () => {
  const f = fixture();
  f.snapshot.pads.push({ id: 'extra-assigned', owner: 'U_LOAD', number: 'EXTRA', net: 'SUPPLY' });
  editNative(f, raw => { raw.components.sourceId.pinInfoMap.extra = { number: 'EXTRA', net: 'SUPPLY' }; });
  const result = expectMismatch(f, 'UNDECLARED_PAD_CONNECTION');
  assert.ok(codes(result).includes('UNDECLARED_NATIVE_PIN_CONNECTION'));
});

test('unknown version labels do not manufacture version support or change the structural audit', () => {
  const f = editNative(fixture(), raw => { raw.version = 'future-unknown'; });
  const result = auditNativeNetlist(f);
  assert.equal(result.status, 'matched');
  assert.equal(result.scope.formatVersion.observed, 'future-unknown');
  assert.equal(result.scope.formatVersion.validation, 'supported-structure-only;version-not-certified');
});

test('native net audit resolves explicit parent IDs and reports unknown parents without inferring an owner', () => {
  const f = fixture();
  for (const pad of f.snapshot.pads) { delete pad.owner; pad.parentComponentId = 'native-load'; }
  const matched = auditNativeNetlist(f);
  assert.equal(matched.status, 'matched'); assert.equal(matched.scope.ownershipSource, 'explicit-owner-or-parent');
  f.snapshot.pads[0].parentComponentId = 'missing';
  expectMismatch(f, 'UNKNOWN_PAD_PARENT');
  delete f.snapshot.pads[0].parentComponentId;
  const missing = auditNativeNetlist(f);
  assert.equal(missing.status, 'unsupported');
  assert.ok(missing.diagnostics.some(d => d.message.includes('PAD_OWNERSHIP_REQUIRED')));
});
