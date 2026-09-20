import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
export function flitHome(env = process.env) {
  return env.FLITREALIZE_HOME || (process.platform === 'win32' && env.LOCALAPPDATA ? join(env.LOCALAPPDATA,'FlitRealize') : join(env.XDG_CONFIG_HOME || join(homedir(),'.config'),'flitrealize'));
}
export function bridgeState(session,health) {
  if(!health || health.service !== 'easyeda-bridge') return 'unknown';
  if(health.protocolVersion !== 2 || health.tokenRequired !== true) return 'incompatible';
  if(!session.sessionId || health.sessionId !== session.sessionId) return 'session-mismatch';
  return health.edaConnected === true ? 'ready' : health.edaConnected === false ? 'bridge-ready' : 'unknown';
}
export async function readBridge(home = flitHome()) {
  let session;
  try { session = JSON.parse(await readFile(join(home,'bridge','easyeda-pro','session.json'),'utf8')); }
  catch { return {state:'unknown'}; }
  const port = session?.port;
  if(!Number.isInteger(port) || port < 1 || port > 65535) return {state:'unknown'};
  // Read-only, unauthenticated health endpoint. Never return session secrets.
  try {
    const response = await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(1200),redirect:'error'});
    const health = response.ok ? await response.json() : null;
    return {state:bridgeState(session,health),port,checkedAt:new Date().toISOString()};
  } catch { return {state:'unreachable',port,checkedAt:new Date().toISOString()}; }
}
