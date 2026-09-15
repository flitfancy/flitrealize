/**
 * EasyEDA Pro local bridge.
 *
 * The EasyEDA gateway extension connects to /eda without needing a filesystem
 * secret. Agent-facing HTTP and WebSocket operations require a per-process
 * bearer token written to the current user's local FlitRealize state folder.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, get as httpGet } from 'node:http';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { isUuid, RequestStore } from './request-store.mjs';

const DEFAULT_PORT_START = 49620;
const DEFAULT_PORT_END = 49629;
const SERVICE_ID = 'easyeda-bridge';
const ADAPTER_ID = 'easyeda-pro';
const EDA_ID = 'easyeda-pro';
const PROTOCOL_VERSION = 2;
const LISTEN_HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = readTimeoutMs('EASYEDA_BRIDGE_REQUEST_TIMEOUT_MS', 30_000);
const MAX_BODY_BYTES = 1024 * 1024;

const PORT_START = readPort('EASYEDA_BRIDGE_PORT_START', DEFAULT_PORT_START);
const PORT_END = readPort('EASYEDA_BRIDGE_PORT_END', DEFAULT_PORT_END);
if (PORT_END < PORT_START) {
  throw new Error('EASYEDA_BRIDGE_PORT_END must be greater than or equal to EASYEDA_BRIDGE_PORT_START');
}

const SESSION_ID = randomUUID();
const AUTH_TOKEN = randomBytes(32).toString('base64url');
const STARTED_AT = new Date().toISOString();
const STATE_DIR = process.env.FLITREALIZE_BRIDGE_STATE_DIR || defaultStateDir();
const SESSION_FILE = join(STATE_DIR, 'session.json');
const requestStore = new RequestStore(STATE_DIR);

/** @type {Map<string, {ws: import('ws').WebSocket, metadata: object, registeredAt: string}>} */
const edaClients = new Map();

// 超时只结束等候，仍保留原连接的结果归属，直到收到终态。
const pendingRequests = new Map();

let activeEdaWindowId = null;
let listeningPort = null;
let shuttingDown = false;

function readPort(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function readTimeoutMs(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1000 || value > 600_000) {
    throw new Error(`${name} must be an integer between 1000 and 600000`);
  }
  return value;
}

function defaultStateDir() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'FlitRealize', 'bridge', ADAPTER_ID);
  }
  if (process.env.XDG_RUNTIME_DIR) {
    return join(process.env.XDG_RUNTIME_DIR, 'flitrealize', 'bridge', ADAPTER_ID);
  }
  return join(homedir(), '.local', 'state', 'flitrealize', 'bridge', ADAPTER_ID);
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requestToken(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim();
  }
  const headerToken = req.headers['x-flitrealize-token'];
  if (typeof headerToken === 'string') return headerToken;
  try {
    return new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('token');
  } catch {
    return null;
  }
}

function isAuthorized(req) {
  return safeEqual(requestToken(req), AUTH_TOKEN);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

function requireAuthorization(req, res) {
  if (isAuthorized(req)) return true;
  sendJson(res, 401, {
    error: 'UNAUTHORIZED',
    message: 'Use the local bridge control helper; agent endpoints require the current session token.',
  });
  return false;
}

async function readJsonBody(req) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of req) {
    byteLength += chunk.length;
    if (byteLength > MAX_BODY_BYTES) {
      const error = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON request body');
    error.statusCode = 400;
    throw error;
  }
}

function healthPayload() {
  return {
    service: SERVICE_ID,
    protocolVersion: PROTOCOL_VERSION,
    adapterId: ADAPTER_ID,
    edaId: EDA_ID,
    sessionId: SESSION_ID,
    status: 'ok',
    tokenRequired: true,
    edaConnected: edaClients.size > 0,
    edaWindowCount: edaClients.size,
    pendingRequests: pendingRequests.size,
    timestamp: Date.now(),
  };
}

function windowSummary(windowId, client) {
  return {
    windowId,
    connected: client.ws.readyState === 1,
    active: windowId === activeEdaWindowId,
    registeredAt: client.registeredAt,
    edaId: client.metadata.edaId || EDA_ID,
    appVersion: client.metadata.appVersion || null,
    apiVersion: client.metadata.apiVersion || null,
    project: client.metadata.project || null,
    document: client.metadata.document || null,
    capabilities: Array.isArray(client.metadata.capabilities) ? client.metadata.capabilities : [],
  };
}

function sessionPayload() {
  return {
    ...healthPayload(),
    activeWindowId: activeEdaWindowId,
    windows: [...edaClients.entries()].map(([windowId, client]) => windowSummary(windowId, client)),
    capabilities: ['health', 'list-windows', 'select-window', 'raw-execute', 'request-status'],
    mode: 'development',
  };
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: LISTEN_HOST });
    socket.setTimeout(300);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function readBridgeHealth(port) {
  return new Promise((resolve) => {
    const req = httpGet(`http://${LISTEN_HOST}:${port}/health`, { timeout: 800 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const payload = JSON.parse(data);
          resolve(payload.service === SERVICE_ID ? payload : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function findExistingInstance() {
  for (let port = PORT_START; port <= PORT_END; port += 1) {
    const health = await readBridgeHealth(port);
    if (health) return { port, health };
  }
  return null;
}

async function findAvailablePort() {
  for (let port = PORT_START; port <= PORT_END; port += 1) {
    if (!(await isPortInUse(port))) return port;
  }
  throw new Error(`All ports in range ${PORT_START}-${PORT_END} are in use`);
}

async function writeSessionFile(port) {
  const payload = {
    schemaVersion: 1,
    service: SERVICE_ID,
    protocolVersion: PROTOCOL_VERSION,
    adapterId: ADAPTER_ID,
    edaId: EDA_ID,
    sessionId: SESSION_ID,
    pid: process.pid,
    host: LISTEN_HOST,
    port,
    token: AUTH_TOKEN,
    startedAt: STARTED_AT,
  };
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${SESSION_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await unlink(SESSION_FILE).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await rename(temporary, SESSION_FILE);
}

async function removeOwnSessionFile() {
  try {
    const payload = JSON.parse(await readFile(SESSION_FILE, 'utf8'));
    if (payload.sessionId === SESSION_ID) await unlink(SESSION_FILE);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[STATE] Failed to remove session file:', error.message);
  }
}

const httpServer = createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');

  if (req.method === 'OPTIONS') {
    sendJson(res, 403, { error: 'CORS_DISABLED', message: 'Browser cross-origin access is not supported.' });
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    sendJson(res, 200, healthPayload());
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/session') {
    if (!requireAuthorization(req, res)) return;
    sendJson(res, 200, sessionPayload());
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname.startsWith('/requests/')) {
    if (!requireAuthorization(req, res)) return;
    const requestId = requestUrl.pathname.slice('/requests/'.length);
    const sessionId = requestUrl.searchParams.get('sessionId');
    if (!isUuid(requestId) || !isUuid(sessionId)) {
      sendJson(res, 400, { success: false, error: 'INVALID_REQUEST', message: 'Valid requestId and original sessionId UUIDs are required.' });
      return;
    }
    try {
      const record = await requestStore.get(sessionId, requestId);
      if (!record) sendJson(res, 404, { success: false, error: 'REQUEST_NOT_FOUND', message: 'No record exists for this request and session.' });
      else sendJson(res, 200, { success: true, request: record });
    } catch (error) {
      sendJson(res, 500, { success: false, error: 'REQUEST_STORE_UNAVAILABLE', message: error.message });
    }
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/eda-windows') {
    if (!requireAuthorization(req, res)) return;
    sendJson(res, 200, {
      windows: [...edaClients.entries()].map(([windowId, client]) => windowSummary(windowId, client)),
      activeWindowId: activeEdaWindowId,
      count: edaClients.size,
      sessionId: SESSION_ID,
    });
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/eda-windows/select') {
    if (!requireAuthorization(req, res)) return;
    try {
      const { windowId } = await readJsonBody(req);
      if (typeof windowId !== 'string' || !edaClients.has(windowId)) {
        sendJson(res, 404, { error: 'WINDOW_NOT_FOUND', message: `EDA window "${windowId}" not found` });
        return;
      }
      activeEdaWindowId = windowId;
      sendJson(res, 200, { success: true, activeWindowId: windowId, sessionId: SESSION_ID });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: 'INVALID_REQUEST', message: error.message });
    }
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/execute') {
    if (!requireAuthorization(req, res)) return;
    try {
      const payload = await readJsonBody(req);
      const response = await executeOnEda(payload);
      sendJson(res, response.statusCode, response.payload);
    } catch (error) {
      sendJson(res, error.statusCode || 500, executionFailure(error));
    }
    return;
  }

  sendJson(res, 404, { error: 'NOT_FOUND', message: 'Endpoint not found.' });
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  const clientType = requestUrl.pathname === '/eda' ? 'eda' : requestUrl.pathname === '/agent' ? 'agent' : null;

  if (!clientType) {
    ws.close(1008, 'Unknown bridge endpoint');
    return;
  }
  if (clientType === 'agent' && !isAuthorized(req)) {
    ws.close(1008, 'Agent authentication required');
    return;
  }

  ws.send(JSON.stringify({
    type: 'handshake',
    service: SERVICE_ID,
    protocolVersion: PROTOCOL_VERSION,
    adapterId: ADAPTER_ID,
    edaId: EDA_ID,
    sessionId: SESSION_ID,
    clientType,
    tokenRequired: clientType === 'agent',
    timestamp: Date.now(),
  }));

  if (clientType === 'eda') attachEdaClient(ws);
  else attachAgentClient(ws);
});

function attachEdaClient(ws) {
  let registeredWindowId = null;

  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'register') {
        if (typeof message.windowId !== 'string' || message.windowId.trim() === '' || message.windowId.length > 256) {
          ws.close(1008, 'A valid windowId is required');
          return;
        }
        if (registeredWindowId && registeredWindowId !== message.windowId) {
          ws.close(1008, 'A connection cannot change its registered windowId');
          return;
        }
        registeredWindowId = message.windowId;
        const previous = edaClients.get(registeredWindowId);
        if (previous && previous.ws !== ws) previous.ws.close(1000, 'Window re-registered');
        edaClients.set(registeredWindowId, {
          ws,
          registeredAt: new Date().toISOString(),
          metadata: {
            edaId: typeof message.edaId === 'string' ? message.edaId : EDA_ID,
            appVersion: message.appVersion,
            apiVersion: message.apiVersion,
            project: message.project,
            document: message.document,
            capabilities: message.capabilities,
          },
        });
        if (!activeEdaWindowId || !edaClients.has(activeEdaWindowId)) activeEdaWindowId = registeredWindowId;
        console.log(`[WS] EDA window registered: ${registeredWindowId}; total=${edaClients.size}`);
        return;
      }
      handleEdaMessage(message, registeredWindowId, ws);
    } catch (error) {
      console.error('[WS] Failed to parse EDA message:', error.message);
    }
  });

  ws.on('close', (code, reason) => {
    if (!registeredWindowId) return;
    const current = edaClients.get(registeredWindowId);
    if (current?.ws === ws) {
      edaClients.delete(registeredWindowId);
      if (activeEdaWindowId === registeredWindowId) activeEdaWindowId = edaClients.keys().next().value || null;
    }
    for (const request of pendingRequests.values()) {
      if (request.ws !== ws) continue;
      markUnknown(request, `EDA window "${registeredWindowId}" disconnected`, 503).then(() => releaseRequest(request));
    }
    console.log(`[WS] EDA window disconnected: ${registeredWindowId} (${code} ${reason})`);
  });

  ws.on('error', (error) => console.error('[WS] EDA client error:', error.message));
}

function attachAgentClient(ws) {
  ws.on('message', async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
      if (message.type === 'execute') {
        const response = await executeOnEda(message);
        if (ws.readyState === 1) ws.send(JSON.stringify({ ...response.payload, type: response.payload.success ? 'result' : 'error', id: message.id, timestamp: Date.now() }));
      } else if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', id: message.id, timestamp: Date.now() }));
      }
    } catch (error) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ ...executionFailure(error), type: 'error', id: message?.id, timestamp: Date.now() }));
    }
  });
  ws.on('error', (error) => console.error('[WS] Agent client error:', error.message));
}

function requestMetadata(record) {
  const { result: _result, error: _error, ...metadata } = record;
  return metadata;
}

function executionFailure(error) {
  return {
    success: false,
    error: error.code || 'EXECUTE_FAILED',
    message: error.message,
    ...(error.request ? { request: error.request, requestPersisted: false } : {}),
  };
}

function requestResponse(record, unknownStatusCode = 202) {
  const common = { request: requestMetadata(record), windowId: record.windowId, sessionId: record.sessionId };
  if (record.status === 'succeeded') return { statusCode: 200, payload: { success: true, result: record.result, ...common } };
  if (record.status === 'failed') return { statusCode: 500, payload: { success: false, error: 'EXECUTE_FAILED', message: record.error, ...common } };
  return { statusCode: unknownStatusCode, payload: {
    success: false, executionOutcome: 'unknown', error: 'EXECUTION_UNKNOWN',
    message: record.error || 'Execution is still running. Query this request before taking further action.',
    ...common,
  } };
}

function invalidRequest(message, code = 'INVALID_REQUEST', statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function settleRequest(request, response) {
  if (request.resolve) {
    request.resolve(response);
    request.resolve = null;
  }
}

function releaseRequest(request) {
  if (pendingRequests.get(request.record.requestId) === request) pendingRequests.delete(request.record.requestId);
}

function saveOutcome(request, status, detail, unknownStatusCode) {
  request.updates = request.updates.then(async () => {
    if (request.record.status === 'succeeded' || request.record.status === 'failed') return;
    // 超时状态写盘失败后，仍接收原连接的真实终态。
    if (request.persistenceFailed && status === 'unknown') return;
    const now = new Date().toISOString();
    const record = { ...request.record, status, updatedAt: now, ...detail };
    if (status === 'succeeded' || status === 'failed') record.completedAt = now;
    if (status === 'succeeded') delete record.error;
    try {
      await requestStore.save(record);
      request.record = record;
      if (status === 'succeeded' || status === 'failed') releaseRequest(request);
      settleRequest(request, requestResponse(record, unknownStatusCode));
    } catch (error) {
      request.persistenceFailed = true;
      clearTimeout(request.timer);
      if (status === 'succeeded' || status === 'failed') releaseRequest(request);
      console.error(`[STATE] Request ${record.requestId} result could not be saved: ${error.message}`);
      settleRequest(request, { statusCode: 500, payload: {
        success: false, executionOutcome: 'unknown', error: 'REQUEST_PERSISTENCE_FAILED',
        message: 'Execution may have occurred, but its latest outcome could not be saved. Inspect the EDA state before any new execution.',
        requestPersisted: false, request: requestMetadata(request.record),
        sessionId: request.record.sessionId, windowId: request.record.windowId,
      } });
    }
  });
  return request.updates;
}

function markUnknown(request, message, statusCode = 503) {
  clearTimeout(request.timer);
  return saveOutcome(request, 'unknown', { error: message }, statusCode);
}

async function executeOnEda(payload) {
  if (!payload || typeof payload.code !== 'string' || payload.code.trim() === '') throw invalidRequest('A non-empty code string is required.', 'MISSING_CODE');
  if (payload.requestId !== undefined && !isUuid(payload.requestId)) throw invalidRequest('requestId must be a UUID.');
  if (payload.sessionId !== undefined && (!isUuid(payload.sessionId) || payload.sessionId.toLowerCase() !== SESSION_ID)) {
    throw invalidRequest('sessionId does not match the current bridge session.', 'SESSION_MISMATCH', 409);
  }
  if (payload.windowId !== undefined && (typeof payload.windowId !== 'string' || !payload.windowId.trim() || payload.windowId.length > 256)) throw invalidRequest('windowId must be a non-empty string up to 256 characters.');
  const requestId = payload.requestId?.toLowerCase() || randomUUID();
  const codeSha256 = createHash('sha256').update(payload.code, 'utf8').digest('hex');
  let existing;
  try {
    existing = await requestStore.get(SESSION_ID, requestId);
  } catch {
    throw invalidRequest('Cannot read the request store; execution was not dispatched.', 'REQUEST_PERSISTENCE_FAILED', 500);
  }
  // 省略 windowId 的重复提交沿用第一次冻结的窗口。
  const windowId = payload.windowId || existing?.windowId || activeEdaWindowId;
  const sameRequest = (record) => record.sessionId === SESSION_ID && record.windowId === windowId && record.codeSha256 === codeSha256;
  if (existing) {
    if (!sameRequest(existing)) throw invalidRequest('requestId already belongs to different code or window.', 'REQUEST_ID_CONFLICT', 409);
    return requestResponse(existing);
  }
  const client = edaClients.get(windowId);
  if (!client || client.ws.readyState !== 1) throw invalidRequest(`EDA window "${windowId || '(none)'}" is not connected.`, 'EDA_NOT_CONNECTED', 503);
  if (shuttingDown) throw invalidRequest('Bridge is shutting down; execution was not dispatched.', 'BRIDGE_STOPPING', 503);
  const now = new Date().toISOString();
  const record = { schemaVersion: 1, requestId, sessionId: SESSION_ID, windowId, codeSha256, status: 'running', submittedAt: now, updatedAt: now };
  let created;
  try {
    created = await requestStore.create(record);
  } catch {
    throw Object.assign(invalidRequest('Cannot persist the request; execution was not dispatched.', 'REQUEST_PERSISTENCE_FAILED', 500), { request: requestMetadata(record) });
  }
  if (!created.created) {
    if (!sameRequest(created.record)) throw invalidRequest('requestId already belongs to different code or window.', 'REQUEST_ID_CONFLICT', 409);
    return requestResponse(created.record);
  }
  const request = { record, ws: client.ws, updates: Promise.resolve(), resolve: null, timer: null };
  const response = new Promise((resolve) => { request.resolve = resolve; });
  pendingRequests.set(requestId, request);
  request.timer = setTimeout(() => markUnknown(request, `Request ${requestId} timed out after ${REQUEST_TIMEOUT_MS}ms. Execution may still be running.`, 504), REQUEST_TIMEOUT_MS);
  if (shuttingDown || client.ws.readyState !== 1 || edaClients.get(windowId)?.ws !== client.ws) {
    markUnknown(request, 'The original EDA connection changed before dispatch; inspect the request and EDA state.');
    return response;
  }
  try {
    client.ws.send(JSON.stringify({ type: 'execute', id: requestId, code: payload.code, windowId, sessionId: SESSION_ID, timestamp: Date.now() }), (error) => {
      if (error) markUnknown(request, `Sending to the original EDA connection failed: ${error.message}`);
    });
  } catch (error) {
    markUnknown(request, `Sending to the original EDA connection failed: ${error.message}`);
  }
  return response;
}

function handleEdaMessage(message, windowId, ws) {
  if (message.type === 'ping') {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'pong', id: message.id, timestamp: Date.now() }));
    }
    return;
  }
  if (message.type === 'pong' || (message.type !== 'result' && message.type !== 'error')) return;

  const pending = pendingRequests.get(message.id);
  if (!pending || pending.record.windowId !== windowId || pending.ws !== ws || pending.resultReceived) return;
  pending.resultReceived = true;
  clearTimeout(pending.timer);
  if (message.type === 'result') saveOutcome(pending, 'succeeded', { result: message.result });
  else saveOutcome(pending, 'failed', { error: typeof message.error === 'string' ? message.error : 'Unknown EDA error' });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SHUTDOWN] ${signal}`);
  await Promise.all([...pendingRequests.values()].map((request) => markUnknown(request, `Bridge stopped before request ${request.record.requestId} completed`)));
  for (const client of edaClients.values()) client.ws.close(1001, 'Bridge shutting down');
  wss.close();
  await new Promise((resolve) => httpServer.close(resolve));
  await removeOwnSessionFile();
}

async function start() {
  const existing = await findExistingInstance();
  if (existing) {
    const compatible = existing.health.protocolVersion === PROTOCOL_VERSION && existing.health.tokenRequired === true;
    console.log(JSON.stringify({
      status: compatible ? 'already-running' : 'incompatible-running',
      port: existing.port,
      protocolVersion: existing.health.protocolVersion || 1,
    }));
    process.exit(compatible ? 0 : 2);
  }

  await requestStore.recover(SESSION_ID);
  const port = await findAvailablePort();
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    httpServer.once('error', onError);
    httpServer.listen(port, LISTEN_HOST, () => {
      httpServer.off('error', onError);
      resolve();
    });
  });
  listeningPort = port;
  await writeSessionFile(port);
  console.log(JSON.stringify({
    status: 'started',
    service: SERVICE_ID,
    protocolVersion: PROTOCOL_VERSION,
    adapterId: ADAPTER_ID,
    edaId: EDA_ID,
    sessionId: SESSION_ID,
    host: LISTEN_HOST,
    port,
    tokenFile: SESSION_FILE,
  }));
}

process.on('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
process.on('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
process.on('uncaughtException', (error) => {
  console.error('[FATAL]', error);
  shutdown('uncaughtException').finally(() => process.exit(1));
});

start().catch(async (error) => {
  console.error(`[FATAL] ${error.message}`);
  if (listeningPort !== null) await shutdown('startup-failure');
  process.exit(1);
});
