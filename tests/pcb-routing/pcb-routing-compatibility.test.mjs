import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { probeRoutingCompatibility, assertRoutingCompatibility } from '../../scripts/providers/easyeda-pro/routing-compatibility.mjs';
import { executeNative } from '../../scripts/providers/easyeda-pro/routing-provider.mjs';

const target = { project: 'P', document: 'D' };
const keys = ['__flitrealizeRoutingTransaction', '__natureCraftSesImport', '__natureCraftAutorouteTask', '__flitrealizeBst2AutoRouteTrial'];
const present = report => report.findings.filter(f => f.present);
const record = (status, saved, scope = target) => ({ status, saved, target: scope });
async function directory(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'routing-compatibility-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('absent journals and explicitly saved journals are clear and the probe never mutates input', () => {
  const empty = probeRoutingCompatibility({}, target);
  assert.equal(empty.state, 'clear'); assert.equal(empty.findings.length, 4);
  for (const key of keys) {
    const globals = { [key]: record('saved', true) }, before = structuredClone(globals);
    const report = probeRoutingCompatibility(globals, target);
    assert.equal(report.state, 'clear'); assert.equal(present(report)[0].scope, 'same-target');
    assert.deepEqual(globals, before);
    assert.doesNotThrow(() => assertRoutingCompatibility(report));
  }
});

test('unfinished and unknown journals block every recognized current or legacy source', () => {
  for (const key of keys) for (const value of [record('running', false), record('needs-attention', false), record('done', false), record('unknown', null), record('saved', 1), record('running', true), {}, false, 0, 'pending']) {
    const globals = { [key]: value }, before = structuredClone(globals), report = probeRoutingCompatibility(globals, target);
    assert.equal(report.state, 'blocked', key + ':' + JSON.stringify(value));
    assert.equal(present(report)[0].key, key);
    assert.throws(() => assertRoutingCompatibility(report), error => {
      assert.equal(error.compatibility, report);
      assert.ok(error.message.includes(JSON.stringify(report)));
      return true;
    });
    assert.deepEqual(globals, before);
  }
});

test('missing, partial and conflicting target evidence is never permission to write', () => {
  assert.equal(probeRoutingCompatibility({}, undefined).state, 'blocked');
  for (const scope of [undefined, null, {}, { project: 'P' }, { project: 'P', document: 'D', projectUuid: 'OTHER', pcbUuid: 'D' }]) {
    const state = record('saved', true, scope); if (scope === undefined) delete state.target;
    assert.equal(probeRoutingCompatibility({ [keys[0]]: state }, target).state, 'blocked');
  }
  const state = record('saved', true); state.before = { target: { project: 'OTHER', document: 'D' } };
  assert.equal(present(probeRoutingCompatibility({ [keys[0]]: state }, target))[0].target.status, 'unreliable');
});

test('different target is reported and never bypasses an unfinished journal', () => {
  for (const key of keys) {
    const other = { project: 'P2', document: 'D2' };
    const pending = probeRoutingCompatibility({ [key]: record('running', false, other) }, target);
    assert.equal(pending.state, 'blocked'); assert.equal(present(pending)[0].scope, 'different-target');
    const saved = probeRoutingCompatibility({ [key]: record('saved', true, other) }, target);
    assert.equal(saved.state, 'clear'); assert.deepEqual(present(saved)[0].target.value, other);
  }
});

test('accessors, inherited values and failed property inspection remain unread and blocked', () => {
  let getters = 0;
  const globals = {}; Object.defineProperty(globals, keys[0], { get() { getters++; throw Error('unsafe'); } });
  assert.equal(probeRoutingCompatibility(globals, target).state, 'blocked');
  const state = record('saved', true); Object.defineProperty(state, 'status', { get() { getters++; return 'saved'; } });
  assert.equal(probeRoutingCompatibility({ [keys[1]]: state }, target).state, 'blocked');
  const inherited = Object.create({ [keys[2]]: record('saved', true) });
  assert.equal(probeRoutingCompatibility(inherited, target).state, 'blocked');
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('unavailable'); } });
  assert.equal(probeRoutingCompatibility(proxy, target).state, 'blocked');
  assert.equal(getters, 0);
});

test('only the current controller trusts its proven rollback or preflight rejection', () => {
  const rolledBack = { status: 'rolled-back', saved: false, before: { target } };
  assert.equal(probeRoutingCompatibility({ [keys[0]]: rolledBack }, target).state, 'clear');
  for (const key of keys.slice(1)) assert.equal(probeRoutingCompatibility({ [key]: rolledBack }, target).state, 'blocked');
  const rejected = { ...record('preflight-rejected', false), writeStarted: false };
  assert.equal(probeRoutingCompatibility({ [keys[0]]: rejected }, target).state, 'clear');
  delete rejected.writeStarted;
  assert.equal(probeRoutingCompatibility({ [keys[0]]: rejected }, target).state, 'blocked');
});

test('known compatibility failures survive both native result and failed-process envelopes', async t => {
  const root = await directory(t), report = probeRoutingCompatibility({ [keys[1]]: record('running', false) }, target);
  let error; try { assertRoutingCompatibility(report); } catch (value) { error = value; }
  const envelope = JSON.stringify({ success: false, error: { code: error.code, message: error.message } });
  for (const failedProcess of [false, true]) {
    const runner = async () => { if (failedProcess) throw { stdout: '', stderr: envelope }; return { stdout: envelope }; };
    await assert.rejects(executeNative({ directory: root, windowId: 'MOCK', mode: 'apply', input: { target }, logName: failedProcess ? 'process' : 'result' }, { runner }), value => {
      assert.equal(value.code, 'OTHER_IMPORT_PENDING'); assert.deepEqual(value.compatibility, report);
      return true;
    });
  }
  const runner = async () => { throw { stdout: '', stderr: 'transport lost' }; };
  await assert.rejects(executeNative({ directory: root, windowId: 'MOCK', mode: 'apply', input: { target }, logName: 'unknown' }, { runner }), /NATIVE_REQUEST_UNRESOLVED/);
});
