import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {bridgeStateDir,flitHome as resolveFlitHome} from '../../scripts/lib/state-paths.mjs';
import {callOfficialCli,resolveOfficialCli} from '../../scripts/providers/easyeda-pro/cli-channel.mjs';
export function flitHome(env = process.env) {
  return resolveFlitHome({env});
}
export function bridgeState(session,health) {
  if(!health || health.service !== 'easyeda-bridge') return 'unknown';
  if(health.protocolVersion !== 2 || health.tokenRequired !== true) return 'incompatible';
  if(!session.sessionId || health.sessionId !== session.sessionId) return 'session-mismatch';
  return health.edaConnected === true ? 'ready' : health.edaConnected === false ? 'bridge-ready' : 'unknown';
}
/** Read the configured channel only. CLI doctor and Bridge health never connect or execute Actions. */
export async function readBridge(home,{env=process.env,runner}={}) {
  const hostHome=home===undefined?resolveFlitHome({env}):resolve(home);
  let adapter;
  try {
    const profile=JSON.parse(await readFile(join(hostHome,'host.json'),'utf8'));
    adapter=profile.adapters?.['easyeda-pro'];
  } catch(error) {
    if(error.code!=='ENOENT'&&!env.FLITREALIZE_EDA_CHANNEL)return {channel:'unknown',state:'unknown',checkedAt:new Date().toISOString()};
  }
  const channel=env.FLITREALIZE_EDA_CHANNEL||adapter?.channel||'bridge';
  if(!['cli','bridge'].includes(channel))return {channel:'unknown',state:'unknown',checkedAt:new Date().toISOString()};
  if(channel==='cli') {
    let executable;
    try {executable=resolveOfficialCli(env.FLITREALIZE_EASYEDA_CLI||adapter?.cliExecutable,{env});}
    catch {return {channel,state:'unknown',checkedAt:new Date().toISOString()};}
    try {
      const doctor=callOfficialCli(executable,['doctor'],{timeoutMs:1200,...(runner?{runner}:{})}).value;
      const state=doctor?.versionMatch===false||doctor?.resultChannel===false?'incompatible':doctor?.connected===true?'ready':doctor?.connected===false?'stopped':'unknown';
      return {channel,state,checkedAt:new Date().toISOString()};
    } catch {return {channel,state:'unreachable',checkedAt:new Date().toISOString()};}
  }
  let session;
  try { session = JSON.parse(await readFile(join(bridgeStateDir({home,env}),'session.json'),'utf8')); }
  catch { return {channel,state:'unknown',checkedAt:new Date().toISOString()}; }
  const port = session?.port;
  if(!Number.isInteger(port) || port < 1 || port > 65535) return {channel,state:'unknown',checkedAt:new Date().toISOString()};
  // Read-only, unauthenticated health endpoint. Never return session secrets.
  try {
    const response = await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(1200),redirect:'error'});
    const health = response.ok ? await response.json() : null;
    return {channel,state:bridgeState(session,health),port,checkedAt:new Date().toISOString()};
  } catch { return {channel,state:'unreachable',port,checkedAt:new Date().toISOString()}; }
}
