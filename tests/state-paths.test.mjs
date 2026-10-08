import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join, isAbsolute } from 'node:path';
import { bridgeStateDir, flitHome, statePathEnvironment } from '../scripts/lib/state-paths.mjs';

const cwd = resolve('state-path-fixture');
const context = { cwd, userHome: join(cwd, 'user'), platform: 'linux' };
const suffix = ['flitrealize', 'bridge', 'easyeda-pro'];

test('Bridge path precedence covers Linux runtime, persistent state and home fallback', () => {
  const cases = [
    [{}, join(context.userHome, '.local', 'state', ...suffix)],
    [{ XDG_CONFIG_HOME: 'config' }, join(context.userHome, '.local', 'state', ...suffix)],
    [{ XDG_STATE_HOME: 'state' }, resolve(cwd, 'state', ...suffix)],
    [{ XDG_STATE_HOME: 'state', XDG_RUNTIME_DIR: 'runtime' }, resolve(cwd, 'runtime', ...suffix)],
    [{ XDG_RUNTIME_DIR: 'runtime', FLITREALIZE_HOME: 'home' }, resolve(cwd, 'home', 'bridge', 'easyeda-pro')],
    [{ FLITREALIZE_HOME: 'home', FLITREALIZE_BRIDGE_STATE_DIR: 'bridge' }, resolve(cwd, 'bridge')],
    [{ FLITREALIZE_HOME: '', FLITREALIZE_BRIDGE_STATE_DIR: '', XDG_RUNTIME_DIR: '', XDG_STATE_HOME: '' }, join(context.userHome, '.local', 'state', ...suffix)],
  ];
  for (const [env, expected] of cases) {
    const actual = bridgeStateDir({ ...context, env });
    assert.equal(actual, expected);
    assert.ok(isAbsolute(actual));
  }
});

test('explicit directories override environment and home is distinct from the final Bridge directory', () => {
  const options = { ...context, env: { FLITREALIZE_HOME: 'env-home', FLITREALIZE_BRIDGE_STATE_DIR: 'env-bridge' } };
  assert.equal(bridgeStateDir({ ...options, home: './explicit/../home' }), resolve(cwd, 'home', 'bridge', 'easyeda-pro'));
  assert.equal(bridgeStateDir({ ...options, home: 'home', stateDir: './explicit/../bridge' }), resolve(cwd, 'bridge'));
});

test('Windows retains LOCALAPPDATA precedence while Linux ignores it', () => {
  const env = { LOCALAPPDATA: 'local', XDG_RUNTIME_DIR: 'runtime' };
  assert.equal(bridgeStateDir({ ...context, env, platform: 'win32' }), resolve(cwd, 'local', 'FlitRealize', 'bridge', 'easyeda-pro'));
  assert.equal(bridgeStateDir({ ...context, env }), resolve(cwd, 'runtime', ...suffix));
});

test('host configuration stays in config directories independently of Bridge runtime state', () => {
  assert.equal(flitHome({ ...context, env: {} }), join(context.userHome, '.config', 'flitrealize'));
  assert.equal(flitHome({ ...context, env: { XDG_CONFIG_HOME: 'config', XDG_RUNTIME_DIR: 'runtime' } }), resolve(cwd, 'config', 'flitrealize'));
  assert.equal(flitHome({ ...context, env: { LOCALAPPDATA: 'local' }, platform: 'win32' }), resolve(cwd, 'local', 'FlitRealize'));
});

test('child environments preserve both locations across working directory changes without mutating the parent', () => {
  for (const env of [{}, { FLITREALIZE_HOME: 'home' }, { FLITREALIZE_BRIDGE_STATE_DIR: 'bridge' }, { XDG_RUNTIME_DIR: 'runtime', XDG_CONFIG_HOME: 'config' }]) {
    const original = { ...env };
    const childEnv = statePathEnvironment({ ...context, env });
    const child = { ...context, cwd: resolve(cwd, 'other'), env: childEnv };
    assert.equal(bridgeStateDir(child), bridgeStateDir({ ...context, env }));
    assert.equal(flitHome(child), flitHome({ ...context, env }));
    assert.deepEqual(env, original);
  }
});
