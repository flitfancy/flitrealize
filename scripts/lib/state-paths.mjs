/** Shared host configuration and Bridge runtime paths. Resolve before changing cwd. */
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function flitHome({ env = process.env, platform = process.platform, cwd = process.cwd(), userHome = homedir() } = {}) {
  if (env.FLITREALIZE_HOME) return resolve(cwd, env.FLITREALIZE_HOME);
  if (platform === 'win32' && env.LOCALAPPDATA) return resolve(cwd, env.LOCALAPPDATA, 'FlitRealize');
  return resolve(cwd, env.XDG_CONFIG_HOME || resolve(cwd, userHome, '.config'), 'flitrealize');
}

export function bridgeStateDir({ home, stateDir, env = process.env, platform = process.platform, cwd = process.cwd(), userHome = homedir() } = {}) {
  // Explicit caller options take precedence over inherited environment settings.
  if (stateDir != null) return resolve(cwd, stateDir);
  if (home != null) return resolve(cwd, home, 'bridge', 'easyeda-pro');
  if (env.FLITREALIZE_BRIDGE_STATE_DIR) return resolve(cwd, env.FLITREALIZE_BRIDGE_STATE_DIR);
  if (env.FLITREALIZE_HOME) return resolve(cwd, env.FLITREALIZE_HOME, 'bridge', 'easyeda-pro');
  if (platform === 'win32' && env.LOCALAPPDATA) return resolve(cwd, env.LOCALAPPDATA, 'FlitRealize', 'bridge', 'easyeda-pro');
  if (env.XDG_RUNTIME_DIR) return resolve(cwd, env.XDG_RUNTIME_DIR, 'flitrealize', 'bridge', 'easyeda-pro');
  return resolve(cwd, env.XDG_STATE_HOME || resolve(cwd, userHome, '.local', 'state'), 'flitrealize', 'bridge', 'easyeda-pro');
}

/** Freeze both resolved locations for child processes that run from another directory. */
export function statePathEnvironment({ env = process.env, ...context } = {}) {
  return {
    ...env,
    FLITREALIZE_HOME: flitHome({ ...context, env }),
    FLITREALIZE_BRIDGE_STATE_DIR: bridgeStateDir({ ...context, env }),
  };
}
