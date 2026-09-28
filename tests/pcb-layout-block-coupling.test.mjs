import test from 'node:test';
import assert from 'node:assert/strict';
import { compileBlockCoupling, evaluateBlockCoupling } from '../scripts/pcb-layout/pcb-layout-block-coupling.mjs';

function fixture() {
  const snapshot = { components: [], pads: [] };
  const contract = { components: [], blocks: [], nets: [
    { name: 'GND', kind: 'ground', endpoints: [] }, { name: 'BUS', kind: 'signal', endpoints: [] }
  ] };
  for (const [ref, x] of [['U1', 0], ['U2', 100], ['U3', 200]]) {
    snapshot.components.push({ ref, id: `${ref}:`, x, y: 0, rotation: 0 });
    contract.components.push({ designator: ref, pins: [{ number: 'A' }, { number: 'B' }, { number: 'C' }],
      bindings: { easyedaPro: { pinMap: { A: ['8'], B: ['9'], C: ['10'] } } } });
    contract.blocks.push({ id: `block-${ref}`, components: [ref] });
    for (const [pin, number, dx, net] of [['A', '8', 10, 'BUS'], ['B', '9', 0, 'GND'], ['C', '10', 40, 'BUS']]) {
      snapshot.pads.push({ id: `${ref}:${number}`, owner: ref, number, net, x: x + dx, y: 0 });
      contract.nets.find(n => n.name === net).endpoints.push({ component: ref, pin });
    }
  }
  const input = { schemaVersion: 1, relations: [{ id: 'bus-endpoints', kind: 'signal', from: { ref: 'U1', pin: 'A' }, to: { ref: 'U2', pin: 'A' }, net: 'BUS', basis: 'fixture' }] };
  return { contract, snapshot, input };
}

test('shared ground and a multidrop bus each form one hyperedge, with no guessed direction or pairwise objective', () => {
  const f = fixture(), compiled = compileBlockCoupling(f.contract, f.snapshot);
  assert.equal(compiled.crossBlockNets.length, 2);
  assert.equal(compiled.crossBlockNets[0].blocks.length, 3);
  assert.equal(compiled.ports.length, 6);
  assert.ok(compiled.ports.every(p => p.direction === 'unspecified'));
  assert.deepEqual(compiled.relations, []);
  assert.deepEqual(JSON.parse(JSON.stringify(compiled)), compiled);
  const result = evaluateBlockCoupling(compiled, f.snapshot.components);
  assert.equal(result.crossBlockNets[0].hpwlMil, 200);
  assert.deepEqual(result.issues, []);
});

test('logical pins map exactly to physical pads, not the closest pin on the same net', () => {
  const f = fixture(), compiled = compileBlockCoupling(f.contract, f.snapshot, f.input);
  assert.deepEqual(compiled.relations[0].from.padIds, ['U1:8']);
  const r = evaluateBlockCoupling(compiled, f.snapshot.components).relations[0];
  assert.equal(r.distanceMil, 100);
  assert.equal(r.endpoints[0].id, 'U1:8');
  assert.equal(r.satisfied, null);
  assert.equal(r.status, 'observed');
  assert.equal(r.crossBlock, true);
  f.contract.components[0].bindings.easyedaPro.pinMap.A.push('MISSING');
  assert.throws(() => compileBlockCoupling(f.contract, f.snapshot, f.input), /MISSING_PHYSICAL_PIN/);
});

test('duplicate primary membership and bad explicit references, pins, or networks are rejected', () => {
  const f = fixture();
  f.contract.blocks[1].components.push('U1');
  assert.throws(() => compileBlockCoupling(f.contract, f.snapshot), /DUPLICATE_PRIMARY_MEMBERSHIP/);
  f.contract.blocks[1].components.pop();
  for (const [key, value] of [['ref', 'U99'], ['pin', 'WRONG']]) {
    const changed = structuredClone(f.input); changed.relations[0].from[key] = value;
    assert.throws(() => compileBlockCoupling(f.contract, f.snapshot, changed), /UNKNOWN_RELATION_ENDPOINT/);
  }
  f.input.relations[0].net = 'GND';
  assert.throws(() => compileBlockCoupling(f.contract, f.snapshot, f.input), /PIN_NET_MISMATCH/);
  f.input.relations[0].net = 'NO_SUCH_NET';
  assert.throws(() => compileBlockCoupling(f.contract, f.snapshot, f.input), /UNKNOWN_RELATION_NET/);
  f.snapshot.pads[0].net = 'GND';
  assert.throws(() => compileBlockCoupling(f.contract, f.snapshot), /PIN_NET_MISMATCH/);
});

test('explicit hard limits measure transformed pad centres and cannot be traded off by a score', () => {
  const f = fixture(); f.input.relations[0].maxDistanceMil = 90;
  const compiled = compileBlockCoupling(f.contract, f.snapshot, f.input);
  const original = evaluateBlockCoupling(compiled, f.snapshot.components);
  assert.equal(original.relations[0].satisfied, false);
  assert.equal(original.issues[0].code, 'BLOCK_COUPLING_DISTANCE_LIMIT');
  const rotated = f.snapshot.components.map(c => c.ref === 'U2' ? { ...c, rotation: 180 } : c);
  const result = evaluateBlockCoupling(compiled, rotated);
  assert.equal(result.relations[0].distanceMil, 80);
  assert.equal(result.relations[0].satisfied, true);
  assert.deepEqual(result.issues, []);
});

test('standalone native test pads retain their Contract block and can participate in explicit relations', () => {
  const f = fixture();
  f.contract.components.push({ designator: 'TP1', pins: [{ number: '1' }] });
  f.contract.blocks[2].components.push('TP1');
  f.contract.nets[1].endpoints.push({ component: 'TP1', pin: '1' });
  f.snapshot.pads.push({ id: 'standalone-pad', owner: null, number: 'TP1', net: 'BUS', x: 300, y: 20 });
  f.input.relations[0].to = { ref: 'TP1', pin: '1' };
  const compiled = compileBlockCoupling(f.contract, f.snapshot, f.input);
  assert.equal(compiled.pads.find(p => p.id === 'standalone-pad').blockId, 'block-U3');
  assert.equal(compiled.pads.find(p => p.id === 'standalone-pad').owner, null);
  const result = evaluateBlockCoupling(compiled, [...f.snapshot.components, { ref: 'TP1', x: 200, y: 30 }]);
  assert.equal(result.relations[0].distanceMil, 220);
  assert.equal(result.relations[0].toBlock, 'block-U3');
});

test('actual readback coordinates are used by id, with missing, duplicate and mismatched pads rejected instead of predicted', () => {
  const f = fixture(), compiled = compileBlockCoupling(f.contract, f.snapshot, f.input);
  const actual = f.snapshot.pads.map(p => p.id === 'U2:8' ? { ...p, x: 150 } : { ...p }).reverse();
  const result = evaluateBlockCoupling(compiled, [], actual);
  assert.equal(result.relations[0].distanceMil, 140);
  assert.deepEqual(result.issues, []);
  const missing = evaluateBlockCoupling(compiled, f.snapshot.components, actual.filter(p => p.id !== 'U1:8'));
  assert.equal(missing.relations[0].distanceMil, null);
  assert.ok(missing.issues.some(i => i.code === 'BLOCK_COUPLING_MISSING_ACTUAL_PAD'));
  const duplicate = evaluateBlockCoupling(compiled, [], [...actual, actual.find(p => p.id === 'U1:8')]);
  assert.equal(duplicate.relations[0].distanceMil, null);
  assert.ok(duplicate.issues.some(i => i.code === 'BLOCK_COUPLING_DUPLICATE_ACTUAL_PAD'));
  const changedNet = actual.map(p => p.id === 'U1:8' ? { ...p, net: 'GND' } : p);
  assert.ok(evaluateBlockCoupling(compiled, [], changedNet).issues.some(i => i.code === 'BLOCK_COUPLING_INVALID_ACTUAL_PAD'));
});

test('unassigned components and same-block relations remain explicit without fabricating cross-block edges', () => {
  const f = fixture(); f.contract.blocks = [];
  const compiled = compileBlockCoupling(f.contract, f.snapshot, f.input);
  assert.deepEqual(compiled.crossBlockNets, []);
  assert.deepEqual(compiled.ports, []);
  assert.deepEqual(compiled.unassignedRefs, ['U1', 'U2', 'U3']);
  assert.equal(compiled.relations[0].crossBlock, false);
  f.contract.blocks = [{ id: 'all', components: ['U1', 'U2', 'U3'] }];
  const same = compileBlockCoupling(f.contract, f.snapshot, f.input);
  assert.equal(same.relations[0].fromBlock, 'all');
  assert.equal(same.relations[0].toBlock, 'all');
  assert.equal(same.relations[0].crossBlock, false);
});

test('unknown configuration, relation and endpoint fields cannot silently disable a requested restriction', () => {
  const f = fixture();
  const configTypo = { ...f.input, relation: [] };
  assert.throws(() => compileBlockCoupling(f.contract, f.snapshot, configTypo), /UNKNOWN_FIELD config\.relation/);
  const limitTypo = structuredClone(f.input);
  limitTypo.relations[0].maxDistancMil = 20;
  assert.throws(() => compileBlockCoupling(f.contract, f.snapshot, limitTypo), /UNKNOWN_FIELD relation\.maxDistancMil/);
  for (const side of ['from', 'to']) {
    const endpointTypo = structuredClone(f.input);
    endpointTypo.relations[0][side].pins = ['A'];
    assert.throws(() => compileBlockCoupling(f.contract, f.snapshot, endpointTypo), new RegExp(`UNKNOWN_FIELD bus-endpoints\\.${side}\\.pins`));
  }
  for (const input of [null, [], { relations: null }, { relations: [null] }]) {
    assert.throws(() => compileBlockCoupling(f.contract, f.snapshot, input), /BLOCK_COUPLING_INVALID_/);
  }
  const valid = { ...f.input, description: 'Supported metadata is retained as input.' };
  valid.relations[0].maxDistanceMil = 120;
  const compiled = compileBlockCoupling(f.contract, f.snapshot, valid);
  assert.equal(compiled.relations[0].maxDistanceMil, 120);
  assert.equal(compiled.relations[0].basis, 'fixture');
});

test('precise pad bbox centres avoid false distance failures from 0.1 mil native getters but reject real excess', () => {
  const f = fixture();
  f.input.relations[0].maxDistanceMil = 100;
  for (const p of f.snapshot.pads) p.bbox = { minX: p.x - 1, maxX: p.x + 1, minY: -1, maxY: 1 };
  const right = f.snapshot.pads.find(p => p.id === 'U2:8');
  right.x = 110.05; // Simulated native getter error; the precise bbox remains centred on 110.
  const compiled = compileBlockCoupling(f.contract, f.snapshot, f.input);
  assert.equal(compiled.pads.find(p => p.id === right.id).x, 110);
  const predicted = evaluateBlockCoupling(compiled, f.snapshot.components);
  assert.equal(predicted.relations[0].distanceMil, 100);
  assert.equal(predicted.relations[0].satisfied, true);
  const actual = evaluateBlockCoupling(compiled, f.snapshot.components, f.snapshot.pads);
  assert.equal(actual.relations[0].distanceMil, 100);
  assert.equal(actual.relations[0].satisfied, true);
  assert.deepEqual(actual.relations[0].measurement.endpointSources, [
    { padId: 'U1:8', source: 'pad-bbox-center' }, { padId: 'U2:8', source: 'pad-bbox-center' }
  ]);
  assert.deepEqual(actual.measurement.sourcesUsed, ['pad-bbox-center']);
  const changed = structuredClone(f.snapshot.pads), moved = changed.find(p => p.id === right.id);
  moved.bbox.minX += .02; moved.bbox.maxX += .02;
  const excessive = evaluateBlockCoupling(compiled, f.snapshot.components, changed);
  assert.equal(excessive.relations[0].satisfied, false);
  assert.ok(excessive.issues.some(i => i.code === 'BLOCK_COUPLING_DISTANCE_LIMIT'));
  moved.bbox.minX = moved.bbox.maxX + 1;
  assert.ok(evaluateBlockCoupling(compiled, f.snapshot.components, changed).issues.some(i => i.code === 'BLOCK_COUPLING_INVALID_ACTUAL_PAD'));
  assert.throws(() => compileBlockCoupling(f.contract, { ...f.snapshot, pads: changed }, f.input), /INVALID_PAD_POSITION/);
  const legacy = fixture(), legacyModel = compileBlockCoupling(legacy.contract, legacy.snapshot, legacy.input);
  assert.deepEqual(evaluateBlockCoupling(legacyModel, legacy.snapshot.components).measurement.sourcesUsed, ['pad-x-y']);
});
