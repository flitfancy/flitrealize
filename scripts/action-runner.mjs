#!/usr/bin/env node
/** Run registered host or EDA actions with compact output and local evidence. */

import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
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
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function edaActionTimeoutMs() {
  const raw = process.env.FLITREALIZE_EDA_ACTION_TIMEOUT_MS;
  if (!raw) return 45_000;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1000 || value > 600_000) {
    fail('INVALID_EDA_ACTION_TIMEOUT', 'FLITREALIZE_EDA_ACTION_TIMEOUT_MS must be an integer between 1000 and 600000.');
  }
  return value;
}

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
    requireEda: true,
    allowWrite: false,
    full: false,
  };
  if (!values.command) fail('COMMAND_REQUIRED', 'A command is required: list or run');
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--action') values.action = argv[++index];
    else if (argument === '--domain') values.domain = argv[++index];
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
  if (
    manifest.schemaVersion !== 2
    || !manifest.providers
    || typeof manifest.providers !== 'object'
    || !manifest.actions
    || typeof manifest.actions !== 'object'
  ) {
    fail('INVALID_ACTION_MANIFEST', 'Unsupported or incomplete action manifest: ' + path);
  }
  for (const [providerId, provider] of Object.entries(manifest.providers)) {
    if (
      !/^[a-z0-9-]+$/.test(providerId)
      || provider?.kind !== 'eda'
      || typeof provider.displayName !== 'string'
      || !provider.displayName.trim()
    ) {
      fail('INVALID_ACTION_MANIFEST', 'Invalid Provider contract in ' + path + ': ' + providerId);
    }
  }
  for (const [actionName, action] of Object.entries(manifest.actions)) {
    if (
      !/^[a-z0-9-]+$/.test(actionName)
      || !action
      || typeof action !== 'object'
      || typeof action.description !== 'string'
      || !action.description.trim()
      || !Number.isInteger(action.contractVersion)
      || action.contractVersion < 1
      || typeof action.domain !== 'string'
      || !action.domain.trim()
      || !['host', 'eda'].includes(action.runtime)
      || !Array.isArray(action.providers)
      || !action.modes
      || typeof action.modes !== 'object'
      || !action.modes[action.defaultMode]
    ) {
      fail('INVALID_ACTION_MANIFEST', 'Invalid Action contract in ' + path + ': ' + actionName);
    }
    if (action.internal !== undefined && typeof action.internal !== 'boolean') {
      fail('INVALID_ACTION_MANIFEST', actionName + ' internal must be boolean when present');
    }
    if (new Set(action.providers).size !== action.providers.length) {
      fail('INVALID_ACTION_MANIFEST', actionName + ' declares duplicate Providers');
    }
    if (action.runtime === 'host' && action.providers.length !== 0) {
      fail('INVALID_ACTION_MANIFEST', actionName + ' host runtime must not declare an EDA Provider');
    }
    if (
      action.runtime === 'eda'
      && (action.providers.length === 0 || action.providers.some((provider) => !manifest.providers[provider]))
    ) {
      fail('INVALID_ACTION_MANIFEST', actionName + ' declares an unknown or missing EDA Provider');
    }
    for (const [mode, contract] of Object.entries(action.modes)) {
      if (!mode || typeof contract?.mutates !== 'boolean') {
        fail('INVALID_ACTION_MANIFEST', actionName + '/' + mode + ' has an invalid mutation contract');
      }
    }
  }
  if (manifest.workflows !== undefined && (!manifest.workflows || typeof manifest.workflows !== 'object')) {
    fail('INVALID_ACTION_MANIFEST', 'workflows must be an object when present in ' + path);
  }
  for (const [workflowName, workflow] of Object.entries(manifest.workflows ?? {})) {
    if (
      !/^[a-z0-9-]+$/.test(workflowName)
      || !workflow
      || typeof workflow !== 'object'
      || typeof workflow.description !== 'string'
      || !workflow.description.trim()
      || typeof workflow.domain !== 'string'
      || !workflow.domain.trim()
      || typeof workflow.provider !== 'string'
      || !manifest.providers[workflow.provider]
      || !workflow.phases
      || typeof workflow.phases !== 'object'
      || Object.keys(workflow.phases).length === 0
    ) {
      fail('INVALID_ACTION_MANIFEST', 'Invalid Workflow contract in ' + path + ': ' + workflowName);
    }
    for (const [phaseName, steps] of Object.entries(workflow.phases)) {
      if (!phaseName || !Array.isArray(steps) || steps.length === 0) {
        fail('INVALID_ACTION_MANIFEST', workflowName + '/' + phaseName + ' has an invalid step list');
      }
      for (const [index, step] of steps.entries()) {
        const action = manifest.actions[step?.action];
        if (
          !action
          || typeof step.mode !== 'string'
          || !action.modes[step.mode]
          || (step.optional !== undefined && typeof step.optional !== 'boolean')
          || action.domain !== workflow.domain
          || (action.runtime === 'eda' && !action.providers.includes(workflow.provider))
        ) {
          fail(
            'INVALID_ACTION_MANIFEST',
            workflowName + '/' + phaseName + '[' + index + '] has an invalid Action reference',
          );
        }
      }
    }
  }
  return manifest;
}

function resolveActionFile(action, provider = null) {
  const path = resolve(ACTION_ROOT, action.file);
  const pathFromRoot = relative(ACTION_ROOT, path);
  if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    fail('INVALID_ACTION_FILE', 'Registered action file path escapes scripts/actions: ' + action.file);
  }
  if (existsSync(path)) return path;
  if (provider) {
    const providerPath = resolve(ACTION_ROOT, provider, action.file);
    const providerRelative = relative(ACTION_ROOT, providerPath);
    if (!providerRelative.startsWith('..') && !isAbsolute(providerRelative) && existsSync(providerPath)) {
      return providerPath;
    }
  }
  fail('INVALID_ACTION_FILE', 'Registered action file is unavailable: ' + action.file);
}

function resolveProvider(manifest, actionName, action, requestedProvider) {
  const providers = action.providers;
  if (!Array.isArray(providers)) {
    fail('INVALID_ACTION_MANIFEST', actionName + ' does not declare providers');
  }
  if (action.runtime === 'host') {
    if (providers.length !== 0) fail('INVALID_ACTION_MANIFEST', actionName + ' host runtime must not declare an EDA provider');
    if (requestedProvider) fail('ACTION_PROVIDER_NOT_APPLICABLE', actionName + ' runs locally and does not use an EDA provider');
    return null;
  }
  if (action.runtime !== 'eda' || providers.length === 0) {
    fail('INVALID_ACTION_MANIFEST', actionName + ' has an invalid runtime/provider contract');
  }
  const provider = requestedProvider || (providers.length === 1 ? providers[0] : null);
  if (!provider) fail('ACTION_PROVIDER_REQUIRED', actionName + ' supports multiple EDA providers; select one with --eda');
  if (!manifest.providers[provider] || !providers.includes(provider)) {
    fail('ACTION_PROVIDER_UNSUPPORTED', actionName + ' does not support EDA provider ' + provider);
  }
  return provider;
}

export function resolveActionRequest(manifest, actionName, input, allowWrite = false, requestedProvider = null) {
  const action = manifest.actions[actionName];
  if (!action) fail('UNKNOWN_ACTION', 'Unknown registered action: ' + actionName);
  if (!Number.isInteger(action.contractVersion) || action.contractVersion < 1 || typeof action.domain !== 'string') {
    fail('INVALID_ACTION_MANIFEST', actionName + ' has an invalid action contract');
  }
  const mode = input?.mode ?? action.defaultMode;
  const modeContract = action.modes?.[mode];
  if (!modeContract) fail('UNSUPPORTED_ACTION_MODE', actionName + ' does not register mode ' + mode);
  if (modeContract.mutates && !allowWrite) {
    const target = action.runtime === 'eda' ? 'the live EDA document' : 'local project state';
    fail(
      'WRITE_AUTHORIZATION_REQUIRED',
      actionName + ' mode ' + mode + ' mutates ' + target + '; rerun with --allow-write only after the relevant write scope is satisfied.',
    );
  }
  const provider = resolveProvider(manifest, actionName, action, requestedProvider);
  return {
    actionName,
    action,
    contractVersion: action.contractVersion,
    domain: action.domain,
    runtime: action.runtime,
    provider,
    mode,
    mutates: Boolean(modeContract.mutates),
    actionFile: resolveActionFile(action, provider),
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
    'unsupported',
    'unknown',
    'blockers',
    'warnings',
    'openItems',
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
    'sourceGeometryFingerprint',
    'contractFingerprint',
    'bindingFingerprint',
    'layoutFingerprint',
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
  addCounts(counts, payload.counts);
  addCounts(counts, state);
  addCounts(counts, payload.grounding);
  const document = payload.document || state.document || null;
  return {
    schemaVersion: 2,
    skillVersion,
    ok: response?.success !== false && payload.status !== 'error',
    action: descriptor.actionName,
    actionContractVersion: descriptor.contractVersion,
    domain: descriptor.domain,
    runtime: descriptor.runtime,
    provider: descriptor.provider,
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

function publicManifest(manifest, skillVersion, requestedDomain = null) {
  const publicActionEntries = Object.entries(manifest.actions).filter(([, action]) => action.internal !== true);
  const workflowEntries = Object.entries(manifest.workflows ?? {});
  const domains = [...new Set([
    ...publicActionEntries.map(([, action]) => action.domain),
    ...workflowEntries.map(([, workflow]) => workflow.domain),
  ])].sort();
  if (requestedDomain && !domains.includes(requestedDomain)) {
    fail('UNKNOWN_ACTION_DOMAIN', `Unknown action domain: ${requestedDomain}. Available domains: ${domains.join(', ')}`);
  }
  const actions = publicActionEntries
    .filter(([, action]) => !requestedDomain || action.domain === requestedDomain)
    .map(([name, action]) => ({
      name,
      description: action.description,
      contractVersion: action.contractVersion,
      domain: action.domain,
      runtime: action.runtime,
      providers: action.providers,
      defaultMode: action.defaultMode,
      modes: Object.entries(action.modes).map(([mode, contract]) => ({
        mode,
        mutates: Boolean(contract.mutates),
      })),
    }));
  const workflows = workflowEntries
    .filter(([, workflow]) => !requestedDomain || workflow.domain === requestedDomain)
    .map(([name, workflow]) => ({
      name,
      description: workflow.description,
      domain: workflow.domain,
      provider: workflow.provider,
      phases: Object.keys(workflow.phases),
    }));
  const actionGroups = Object.fromEntries(domains
    .filter((domain) => !requestedDomain || domain === requestedDomain)
    .map((domain) => [domain, actions.filter((action) => action.domain === domain).map((action) => action.name)]));
  const workflowGroups = Object.fromEntries(domains
    .filter((domain) => !requestedDomain || domain === requestedDomain)
    .map((domain) => [domain, workflows.filter((workflow) => workflow.domain === domain).map((workflow) => workflow.name)]));
  return {
    schemaVersion: manifest.schemaVersion,
    skillVersion,
    domainFilter: requestedDomain,
    domains,
    providers: Object.entries(manifest.providers).map(([id, provider]) => ({ id, ...provider })),
    actionGroups,
    workflowGroups,
    actions,
    workflows,
  };
}

export async function executeHostAction(descriptor, input, context = {}) {
  if (descriptor.runtime !== 'host' || descriptor.provider !== null) {
    fail('HOST_RUNTIME_REQUIRED', descriptor.actionName + ' is not a provider-free host Action');
  }
  const code = await readFile(descriptor.actionFile, 'utf8');
  const execute = new AsyncFunction('flitrealizeInput', 'flitrealizeContext', code);
  const result = await execute(input, {
    action: descriptor.actionName,
    contractVersion: descriptor.contractVersion,
    domain: descriptor.domain,
    mode: descriptor.mode,
    ...context,
  });
  return { success: true, result };
}

async function executeEdaAction(arguments_, descriptor, inputFile) {
  if (!arguments_.action) fail('ACTION_REQUIRED', '--action is required');
  const childArguments = [
    HOST_FILE,
    'execute',
    '--eda',
    descriptor.provider,
    '--code-file',
    descriptor.actionFile,
  ];
  if (inputFile) childArguments.push('--input-file', inputFile);
  if (arguments_.requireEda) childArguments.push('--require-eda');
  if (arguments_.projectRoot) childArguments.push('--project-root', resolve(arguments_.projectRoot));
  if (arguments_.windowId) childArguments.push('--window-id', arguments_.windowId);

  const actionTimeout = edaActionTimeoutMs();
  const completed = spawnSync(process.execPath, childArguments, {
    cwd: SCRIPT_ROOT,
    windowsHide: true,
    encoding: 'utf8',
    timeout: actionTimeout + 20_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (completed.error) throw completed.error;
  return { response: parseControlResult(completed), status: completed.status };
}

async function runAction(arguments_, manifest, skillVersion) {
  if (!arguments_.action) fail('ACTION_REQUIRED', '--action is required');
  const inputFile = arguments_.inputFile ? resolve(arguments_.inputFile) : null;
  const input = inputFile ? JSON.parse(await readFile(inputFile, 'utf8')) : {};
  const descriptor = resolveActionRequest(
    manifest,
    arguments_.action,
    input,
    arguments_.allowWrite,
    arguments_.eda,
  );
  let execution;
  if (descriptor.runtime === 'eda') {
    execution = await executeEdaAction(arguments_, descriptor, inputFile);
  } else {
    try {
      execution = {
        response: await executeHostAction(descriptor, input, {
          projectRoot: arguments_.projectRoot ? resolve(arguments_.projectRoot) : null,
          skillVersion,
        }),
        status: 0,
      };
    } catch (error) {
      execution = {
        response: {
          success: false,
          status: 'error',
          error: { code: error.code || 'HOST_ACTION_ERROR', message: error.message },
        },
        status: 1,
      };
    }
  }
  const { response } = execution;
  const reportFile = resolve(arguments_.reportFile || defaultReportFile(descriptor.actionName, descriptor.mode));
  await saveReport(reportFile, {
    schemaVersion: 2,
    skillVersion,
    capturedAt: new Date().toISOString(),
    action: descriptor.actionName,
    actionContractVersion: descriptor.contractVersion,
    domain: descriptor.domain,
    runtime: descriptor.runtime,
    provider: descriptor.provider,
    mode: descriptor.mode,
    mutates: descriptor.mutates,
    response,
  });
  if (execution.status !== 0) {
    const error = response.error || {};
    const failure = new Error(error.message || 'Action execution failed');
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
    process.stdout.write(JSON.stringify(publicManifest(manifest, skillVersion, arguments_.domain)) + '\n');
    return;
  }
  if (arguments_.command === 'run') {
    await runAction(arguments_, manifest, skillVersion);
    return;
  }
  fail('UNKNOWN_COMMAND', 'Unknown command: ' + arguments_.command);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  const normalize = (value) => {
    const absolute = resolve(value);
    let realized = absolute;
    try {
      realized = realpathSync.native(absolute);
    } catch { /* keep the resolved path for a missing or transient target */ }
    return process.platform === 'win32' ? realized.toLowerCase() : realized;
  };
  return normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({
      status: 'error',
      error: { code: error.code || 'ACTION_RUNNER_ERROR', message: error.message },
      ...(error.reportFile ? { reportFile: error.reportFile } : {}),
    }) + '\n');
    process.exitCode = 1;
  });
}
