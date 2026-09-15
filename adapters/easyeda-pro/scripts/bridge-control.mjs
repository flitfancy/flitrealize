#!/usr/bin/env node
/** Control the authenticated EasyEDA bridge without exposing its session token. */

import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVICE_ID = 'easyeda-bridge';
const ADAPTER_ID = 'easyeda-pro';
const PROTOCOL_VERSION = 2;
const DEFAULT_PORT_START = 49620;
const DEFAULT_PORT_END = 49629;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = resolve(SCRIPT_DIR, '..');
const SERVER_SCRIPT = join(SCRIPT_DIR, 'bridge-server.mjs');
const STATE_DIR = process.env.FLITREALIZE_BRIDGE_STATE_DIR || defaultStateDir();
const SESSION_FILE = join(STATE_DIR, 'session.json');
const LOG_FILE = join(STATE_DIR, 'bridge.log');
const PORT_START = readPort('EASYEDA_BRIDGE_PORT_START', DEFAULT_PORT_START);
const PORT_END = readPort('EASYEDA_BRIDGE_PORT_END', DEFAULT_PORT_END);

function defaultStateDir() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'FlitRealize', 'bridge', ADAPTER_ID);
  }
  if (process.env.XDG_RUNTIME_DIR) {
    return join(process.env.XDG_RUNTIME_DIR, 'flitrealize', 'bridge', ADAPTER_ID);
  }
  return join(homedir(), '.local', 'state', 'flitrealize', 'bridge', ADAPTER_ID);
}

function readPort(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} is invalid`);
  return value;
}

function parseArguments(argv) {
  const values = { command: argv[0] || 'status', json: false, requireEda: false };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') values.json = true;
    else if (argument === '--require-eda') values.requireEda = true;
    else if (argument === '--window-id') values.windowId = argumentValue(argv[++index], argument);
    else if (argument === '--code-file') values.codeFile = argumentValue(argv[++index], argument);
    else if (argument === '--request-id') values.requestId = argumentValue(argv[++index], argument);
    else if (argument === '--session-id') values.sessionId = argumentValue(argv[++index], argument);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return values;
}

function argumentValue(value, flag) {
  if (!value?.trim() || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${path}: ${error.message}`);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { message: text };
    }
    return { ok: response.ok, statusCode: response.status, payload, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

async function scanBridge() {
  for (let port = PORT_START; port <= PORT_END; port += 1) {
    try {
      const response = await fetchJson(`http://127.0.0.1:${port}/health`);
      if (response.ok && response.payload.service === SERVICE_ID) return { port, health: response.payload };
    } catch {
      // An unused port is expected while scanning the small reserved range.
    }
  }
  return null;
}

function publicSession(session) {
  if (!session) return null;
  const { token: _token, ...safe } = session;
  return safe;
}

async function authenticatedRequest(found, path, options = {}, timeoutMs = 35_000) {
  const session = await readJson(SESSION_FILE);
  if (!session || session.service !== SERVICE_ID || session.sessionId !== found.health.sessionId || session.port !== found.port) {
    const error = new Error('Bridge session file is missing or does not match the running process');
    error.code = 'SESSION_MISMATCH';
    throw error;
  }
  const headers = {
    Authorization: `Bearer ${session.token}`,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...options.headers,
  };
  const response = await fetchJson(`http://127.0.0.1:${found.port}${path}`, { ...options, headers }, timeoutMs);
  if (!response.ok) {
    const error = new Error(response.payload.message || response.payload.error || `HTTP ${response.statusCode}`);
    error.code = response.payload.error || 'BRIDGE_REQUEST_FAILED';
    error.statusCode = response.statusCode;
    error.request = response.payload.request;
    error.executionOutcome = response.payload.executionOutcome;
    error.requestPersisted = response.payload.requestPersisted;
    throw error;
  }
  return response.payload;
}

async function status() {
  const found = await scanBridge();
  if (!found) {
    return { status: 'stopped', adapterId: ADAPTER_ID, portRange: [PORT_START, PORT_END] };
  }
  if (found.health.protocolVersion !== PROTOCOL_VERSION || found.health.tokenRequired !== true) {
    return {
      status: 'incompatible',
      adapterId: ADAPTER_ID,
      port: found.port,
      expectedProtocolVersion: PROTOCOL_VERSION,
      actualProtocolVersion: found.health.protocolVersion || 1,
    };
  }
  try {
    const details = await authenticatedRequest(found, '/session');
    return {
      status: details.edaConnected ? 'ready' : 'bridge-ready',
      adapterId: ADAPTER_ID,
      bridge: {
        service: details.service,
        protocolVersion: details.protocolVersion,
        sessionId: details.sessionId,
        host: '127.0.0.1',
        port: found.port,
        pid: (await readJson(SESSION_FILE))?.pid || null,
        startedAt: (await readJson(SESSION_FILE))?.startedAt || null,
        tokenRequired: true,
        mode: details.mode,
      },
      eda: {
        id: details.edaId,
        connected: details.edaConnected,
        windowCount: details.edaWindowCount,
        activeWindowId: details.activeWindowId,
        windows: details.windows,
      },
      capabilities: details.capabilities,
    };
  } catch (error) {
    return {
      status: 'session-mismatch',
      adapterId: ADAPTER_ID,
      port: found.port,
      session: publicSession(await readJson(SESSION_FILE)),
      error: { code: error.code || 'UNKNOWN', message: error.message },
    };
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let current;
  do {
    current = await status();
    if (predicate(current)) return current;
    await delay(250);
  } while (Date.now() < deadline);
  return current;
}

async function startDetached() {
  if (!existsSync(SERVER_SCRIPT)) throw new Error(`Bridge server not found: ${SERVER_SCRIPT}`);
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const descriptor = openSync(LOG_FILE, 'a');
  try {
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      cwd: ADAPTER_ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', descriptor, descriptor],
      env: { ...process.env, FLITREALIZE_BRIDGE_STATE_DIR: STATE_DIR },
    });
    child.unref();
  } finally {
    closeSync(descriptor);
  }
}

async function ensure(requireEda) {
  let current = await status();
  if (current.status === 'incompatible') {
    throw Object.assign(new Error('An older or incompatible EasyEDA bridge is already running; inspect unresolved requests before arranging an upgrade.'), {
      code: 'INCOMPATIBLE_BRIDGE',
    });
  }
  if (current.status === 'session-mismatch') {
    throw Object.assign(new Error('The running bridge does not match the local session credential; inspect unresolved requests before arranging service recovery.'), {
      code: 'SESSION_MISMATCH',
    });
  }
  if (current.status === 'stopped') {
    await startDetached();
    current = await waitFor((value) => value.status === 'bridge-ready' || value.status === 'ready', 8_000);
  }
  if (current.status !== 'bridge-ready' && current.status !== 'ready') {
    throw Object.assign(new Error(`Bridge did not become ready; inspect ${LOG_FILE}`), { code: 'START_FAILED' });
  }
  if (requireEda && current.status !== 'ready') {
    current = await waitFor((value) => value.status === 'ready', 12_000);
    if (current.status !== 'ready') {
      throw Object.assign(
        new Error('Bridge is running, but no EasyEDA window connected before the timeout.'),
        {
          code: 'EDA_NOT_CONNECTED',
          hint: 'In EasyEDA, open API Gateway and choose reconnect. Start the Bridge before opening EasyEDA to avoid this step next time.',
          bridgeStatus: current,
        },
      );
    }
  }
  return current;
}

async function windows() {
  const found = await scanBridge();
  if (!found) throw Object.assign(new Error('Bridge is not running'), { code: 'BRIDGE_STOPPED' });
  return authenticatedRequest(found, '/eda-windows');
}

async function selectWindow(windowId) {
  if (!windowId) throw new Error('--window-id is required');
  const found = await scanBridge();
  if (!found) throw Object.assign(new Error('Bridge is not running'), { code: 'BRIDGE_STOPPED' });
  return authenticatedRequest(found, '/eda-windows/select', {
    method: 'POST',
    body: JSON.stringify({ windowId }),
  });
}

function requireUuid(value, flag) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw Object.assign(new Error(`${flag} requires a UUID`), { code: 'INVALID_REQUEST' });
  }
  return value.toLowerCase();
}

async function requestSession(found) {
  if (found.health.protocolVersion !== PROTOCOL_VERSION || found.health.tokenRequired !== true) {
    throw Object.assign(new Error('The running Bridge must be upgraded before request tracking can be used.'), { code: 'INCOMPATIBLE_BRIDGE' });
  }
  const session = await authenticatedRequest(found, '/session');
  if (!session.capabilities?.includes('request-status')) {
    throw Object.assign(new Error('The running Bridge does not support request-status. Upgrade it before execution; this command does not restart it.'), { code: 'REQUEST_STATUS_UNSUPPORTED' });
  }
  return session;
}

function executionTimeoutMs() {
  const raw = process.env.EASYEDA_BRIDGE_REQUEST_TIMEOUT_MS;
  if (!raw) return 35_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1000 || value > 600_000) {
    throw new Error('EASYEDA_BRIDGE_REQUEST_TIMEOUT_MS must be an integer between 1000 and 600000');
  }
  return value + 5_000;
}

async function saveSubmission(request) {
  const directory = join(STATE_DIR, 'submissions', request.sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${request.requestId}.json`);
  let file;
  try {
    file = await open(path, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(request)}\n`, 'utf8');
    await file.sync();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await readJson(path);
    if (previous?.codeSha256 !== request.codeSha256 || previous?.windowId !== request.windowId) {
      throw Object.assign(new Error('The request ID already has a submission receipt for different code or window.'), { code: 'REQUEST_ID_CONFLICT' });
    }
  } finally {
    await file?.close();
  }
  return path;
}

async function requestStatus(requestId, sessionId) {
  requestId = requireUuid(requestId, '--request-id');
  sessionId = requireUuid(sessionId, '--session-id');
  try {
    const found = await scanBridge();
    if (!found) throw Object.assign(new Error('Bridge is not running'), { code: 'BRIDGE_STOPPED' });
    await requestSession(found);
    return await authenticatedRequest(found, `/requests/${requestId}?sessionId=${sessionId}`);
  } catch (error) {
    error.request ??= { requestId, sessionId, status: 'unknown' };
    error.executionOutcome ??= 'unknown';
    if (error.code === 'REQUEST_NOT_FOUND') {
      error.executionOutcome = 'unknown';
      error.hint = 'No retained Bridge record was found. This does not prove that the write did not run; reconcile the EDA state before any next step.';
    }
    throw error;
  }
}

async function executeCode(codeFile, windowId, requestId = randomUUID()) {
  if (!codeFile) throw new Error('--code-file is required; command-line code is intentionally unsupported');
  requestId = requireUuid(requestId, '--request-id');
  const code = await readFile(resolve(codeFile), 'utf8');
  const found = await scanBridge();
  if (!found) throw Object.assign(new Error('Bridge is not running'), { code: 'BRIDGE_STOPPED' });
  const session = await requestSession(found);
  const sessionId = requireUuid(session.sessionId, 'Bridge sessionId');
  const frozenWindowId = windowId || session.activeWindowId;
  if (!frozenWindowId) throw Object.assign(new Error('No EasyEDA window is selected'), { code: 'EDA_NOT_CONNECTED' });
  const timeoutMs = executionTimeoutMs();
  // Persist before HTTP dispatch. This receipt records intent, never execution proof.
  const request = { requestId, sessionId, windowId: frozenWindowId, codeSha256: createHash('sha256').update(code).digest('hex'), status: 'unknown', submittedAt: new Date().toISOString() };
  const submissionReceipt = await saveSubmission(request);
  try {
    const result = await authenticatedRequest(found, '/execute', {
      method: 'POST',
      body: JSON.stringify({ code, requestId, sessionId, windowId: frozenWindowId }),
    }, timeoutMs);
    return { ...result, request: result.request || request, submissionReceipt };
  } catch (error) {
    error.request ??= request;
    error.submissionReceipt = submissionReceipt;
    if (!error.executionOutcome && !['succeeded', 'failed'].includes(error.request.status)) error.executionOutcome = 'unknown';
    throw error;
  }
}

function formatHuman(result) {
  if (result.status === 'ready') {
    return `READY | ${result.eda.id} | session=${result.bridge.sessionId} | windows=${result.eda.windowCount} | port=${result.bridge.port}`;
  }
  if (result.status === 'bridge-ready') {
    return `BRIDGE_READY | ${result.adapterId} | session=${result.bridge.sessionId} | waiting-for-eda | port=${result.bridge.port}`;
  }
  if (result.status) return `${result.status.toUpperCase()} | ${result.adapterId}`;
  return JSON.stringify(result);
}

function print(result, json) {
  process.stdout.write(`${json ? JSON.stringify(result) : formatHuman(result)}\n`);
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  let result;
  if (['--help', 'help'].includes(arguments_.command)) {
    process.stdout.write('bridge-control: status | ensure | windows | select --window-id ID | execute --code-file FILE [--window-id ID] [--request-id UUID] | request --request-id UUID --session-id ORIGINAL_UUID [--json]\nRequest queries are read-only. Reconcile EDA state before continuing a workflow after an unknown result.\n');
    return;
  }
  if (arguments_.command === 'request' && (arguments_.codeFile || arguments_.windowId || arguments_.requireEda)) {
    throw new Error('request is read-only and accepts no execution or connection options');
  }
  if (arguments_.sessionId && arguments_.command !== 'request') throw new Error('--session-id is only supported by request; execute freezes the current Bridge session');
  if (arguments_.command === 'status') result = await status();
  else if (arguments_.command === 'ensure') result = await ensure(arguments_.requireEda);
  else if (arguments_.command === 'windows') result = await windows();
  else if (arguments_.command === 'select') result = await selectWindow(arguments_.windowId);
  else if (arguments_.command === 'execute') result = await executeCode(arguments_.codeFile, arguments_.windowId, arguments_.requestId);
  else if (arguments_.command === 'request') result = await requestStatus(arguments_.requestId, arguments_.sessionId);
  else throw new Error(`Unknown command: ${arguments_.command}`);
  print(result, arguments_.json);
  if (result.success === false) process.exitCode = 1;
}

main().catch((error) => {
  const payload = {
    status: 'error',
    success: false,
    adapterId: ADAPTER_ID,
    error: { code: error.code || 'BRIDGE_CONTROL_ERROR', message: error.message },
    ...(error.hint ? { hint: error.hint } : {}),
    ...(error.bridgeStatus ? { bridgeStatus: error.bridgeStatus } : {}),
    ...(error.request ? { request: error.request } : {}),
    ...(error.submissionReceipt ? { submissionReceipt: error.submissionReceipt } : {}),
    ...(error.executionOutcome ? { success: false, executionOutcome: error.executionOutcome } : {}),
    ...(error.requestPersisted !== undefined ? { requestPersisted: error.requestPersisted } : {}),
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
});
