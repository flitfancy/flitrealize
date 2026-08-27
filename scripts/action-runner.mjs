#!/usr/bin/env node
/** Run registered EDA actions through the host adapter with compact output and local evidence. */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const ACTION_ROOT = join(SCRIPT_ROOT, 'actions');
const MANIFEST_FILE = join(ACTION_ROOT, 'manifest.json');
const HOST_FILE = join(SCRIPT_ROOT, 'eda-host.mjs');
const VERSION_FILE = join(dirname(SCRIPT_ROOT), 'VERSION');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function stateRoot() {
  if (process.env.FLITREALIZE_HOME) return resolve(process.env.FLITREALIZE_HOME);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'FlitRealize');
  }
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, 'flitrealize');
  return join(homedir(), '.config', 'flitrealize');
}

function parseArguments(argv) {
  const values = {
    command: argv[0],
    eda: 'easyeda-pro',
    requireEda: true,
    allowWrite: false,
    full: false,
  };
  if (!values.command) fail('COMMAND_REQUIRED', 'A command is required: list or run');
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--action') values.action = argv[++index];
    else if (argument === '--input-file') values.inputFile = argv[++index];
    else if (argument === '--eda') values.eda = argv[++index];
    else if (argument === '--project-root') values.projectRoot = argv[++index];
    else if (argument === '--window-id') values.windowId = argv[++index];
    else if (argument === '--report-file') values.reportFile = argv[++index];
    else if (argument === '--allow-write') values.allowWrite = true;
    else if (argument === '--full') values.full = true;
    else if (argument === '--no-require-eda') values.requireEda = false;
    else fail('UNKNOWN_ARGUMENT', 'Unknown argument: ' + argument);
  }
  return values;
}

export async function loadManifest(path = MANIFEST_FILE) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.actions || typeof manifest.actions !== 'object') {
    fail('INVALID_ACTION_MANIFEST', 'Unsupported or incomplete action manifest: ' + path);
  }
  return manifest;
}

function resolveActionFile(action) {
  const path = resolve(ACTION_ROOT, action.file);
  const pathFromRoot = relative(ACTION_ROOT, path);
  if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot) || !existsSync(path)) {
    fail('INVALID_ACTION_FILE', 'Registered action file is unavailable or outside scripts/actions: ' + action.file);
  }
  return path;
}

export function resolveActionRequest(manifest, actionName, input, allowWrite = false) {
  const action = manifest.actions[actionName];
  if (!action) fail('UNKNOWN_ACTION', 'Unknown registered action: ' + actionName);
  const mode = input?.mode ?? action.defaultMode;
  const modeContract = action.modes?.[mode];
  if (!modeContract) fail('UNSUPPORTED_ACTION_MODE', actionName + ' does not register mode ' + mode);
  if (modeContract.mutates && !allowWrite) {
    fail(
      'WRITE_AUTHORIZATION_REQUIRED',
      actionName + ' mode ' + mode + ' mutates the live EDA document; rerun with --allow-write only after the live-write lock is satisfied.',
    );
  }
  return {
    actionName,
    action,
    mode,
    mutates: Boolean(modeContract.mutates),
    actionFile: resolveActionFile(action),
  };
}

function resultPayload(response) {
  return response && typeof response.result === 'object' && response.result !== null
    ? response.result
    : response;
}

function addFingerprint(target, source, key) {
  if (typeof source?.[key] === 'string') target[key] = source[key];
}

function addCounts(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' && /Count$/.test(key)) target[key] = value;
  }
  const arrayKeys = [
    'created',
    'createdRegionIds',
    'createdPourIds',
    'issues',
    'globalIssues',
    'errors',
    'missing',
    'selected',
    'rejected',
    'skipped',
  ];
  for (const key of arrayKeys) {
    if (Array.isArray(source[key])) target[key + 'Count'] = source[key].length;
  }
}

export function summarizeExecution(response, descriptor, reportFile = null, skillVersion = null) {
  const payload = resultPayload(response) || {};
  const state = payload.state || {};
  const fingerprints = {};
  const fingerprintKeys = [
    'capabilityFingerprint',
    'inspectionFingerprint',
    'plannerEvidenceFingerprint',
    'plannerFingerprint',
    'planFingerprint',
    'fingerprint',
  ];
  for (const key of fingerprintKeys) {
    addFingerprint(fingerprints, payload, key);
    addFingerprint(fingerprints, state, key);
    addFingerprint(fingerprints, payload.analysis, key);
  }
  const counts = {};
  addCounts(counts, payload);
  addCounts(counts, state);
  addCounts(counts, payload.grounding);
  const document = payload.document || state.document || null;
  return {
    schemaVersion: 1,
    skillVersion,
    ok: response?.success !== false && payload.status !== 'error',
    action: descriptor.actionName,
    mode: descriptor.mode,
    mutates: descriptor.mutates,
    status: payload.status ?? response?.status ?? 'completed',
    readOnly: payload.readOnly ?? !descriptor.mutates,
    saved: payload.saved ?? null,
    documentUuid: document?.uuid ?? payload.plan?.expectedDocumentUuid ?? null,
    fingerprints,
    counts,
    issueCount: [
      payload.issues,
      payload.globalIssues,
      payload.errors,
      payload.blockers,
    ].filter(Array.isArray).reduce((total, items) => total + items.length, 0),
    nextRequestAvailable: Boolean(payload.nextRequest || payload.applyRequest),
    rollbackAvailable: Boolean(payload.rollbackRequest),
    bridge: {
      hostId: response?.hostId ?? null,
      sessionId: response?.sessionId ?? null,
      windowId: response?.windowId ?? null,
    },
    reportFile,
  };
}

function parseControlResult(completed) {
  const stream = completed.status === 0 ? completed.stdout.trim() : completed.stderr.trim();
  const lastLine = stream.split(/\r?\n/).filter(Boolean).at(-1);
  if (!lastLine) fail('EMPTY_ADAPTER_RESULT', 'EDA host returned no structured result.');
  try {
    return JSON.parse(lastLine);
  } catch {
    fail('INVALID_ADAPTER_RESULT', lastLine);
  }
}

export function defaultReportFile(actionName, mode) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(stateRoot(), 'reports', timestamp + '-' + actionName + '-' + mode + '-' + randomUUID() + '.json');
}

async function saveReport(path, record) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

function publicManifest(manifest, skillVersion) {
  return {
    schemaVersion: manifest.schemaVersion,
    skillVersion,
    actions: Object.entries(manifest.actions).map(([name, action]) => ({
      name,
      description: action.description,
      defaultMode: action.defaultMode,
      modes: Object.entries(action.modes).map(([mode, contract]) => ({
        mode,
        mutates: Boolean(contract.mutates),
      })),
    })),
  };
}

async function runAction(arguments_, manifest, skillVersion) {
  if (!arguments_.action) fail('ACTION_REQUIRED', '--action is required');
  const inputFile = arguments_.inputFile ? resolve(arguments_.inputFile) : null;
  const input = inputFile ? JSON.parse(await readFile(inputFile, 'utf8')) : {};
  const descriptor = resolveActionRequest(manifest, arguments_.action, input, arguments_.allowWrite);
  const childArguments = [
    HOST_FILE,
    'execute',
    '--eda',
    arguments_.eda,
    '--code-file',
    descriptor.actionFile,
  ];
  if (inputFile) childArguments.push('--input-file', inputFile);
  if (arguments_.requireEda) childArguments.push('--require-eda');
  if (arguments_.projectRoot) childArguments.push('--project-root', resolve(arguments_.projectRoot));
  if (arguments_.windowId) childArguments.push('--window-id', arguments_.windowId);

  const completed = spawnSync(process.execPath, childArguments, {
    cwd: SCRIPT_ROOT,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (completed.error) throw completed.error;
  const response = parseControlResult(completed);
  const reportFile = resolve(arguments_.reportFile || defaultReportFile(descriptor.actionName, descriptor.mode));
  await saveReport(reportFile, {
    schemaVersion: 1,
    skillVersion,
    capturedAt: new Date().toISOString(),
    action: descriptor.actionName,
    mode: descriptor.mode,
    mutates: descriptor.mutates,
    response,
  });
  if (completed.status !== 0) {
    const error = response.error || {};
    const failure = new Error(error.message || 'EDA action failed');
    failure.code = error.code || 'ACTION_EXECUTION_FAILED';
    failure.reportFile = reportFile;
    throw failure;
  }
  const summary = summarizeExecution(response, descriptor, reportFile, skillVersion);
  process.stdout.write(JSON.stringify(arguments_.full ? response : summary) + '\n');
}

export async function main(argv = process.argv.slice(2)) {
  const arguments_ = parseArguments(argv);
  const manifest = await loadManifest();
  const skillVersion = (await readFile(VERSION_FILE, 'utf8')).trim();
  if (arguments_.command === 'list') {
    process.stdout.write(JSON.stringify(publicManifest(manifest, skillVersion)) + '\n');
    return;
  }
  if (arguments_.command === 'run') {
    await runAction(arguments_, manifest, skillVersion);
    return;
  }
  fail('UNKNOWN_COMMAND', 'Unknown command: ' + arguments_.command);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({
      status: 'error',
      error: { code: error.code || 'ACTION_RUNNER_ERROR', message: error.message },
      ...(error.reportFile ? { reportFile: error.reportFile } : {}),
    }) + '\n');
    process.exitCode = 1;
  });
}
