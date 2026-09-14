#!/usr/bin/env node
/** Run registered host or EDA actions with compact output and local evidence. */

import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
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
    else if (argument === '--query') {
      const query = argv[++index];
      if (!query?.trim() || query.startsWith('--')) fail('INVALID_DISCOVERY_QUERY', '--query requires a nonempty purpose keyword');
      values.query = query.trim();
    }
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
  if (values.query && values.command !== 'list') fail('QUERY_LIST_ONLY', '--query is only supported by the read-only list command');
  return values;
}

export function validateDiscoveryMetadata(discovery, skillRoot = dirname(SCRIPT_ROOT), label = 'discovery') {
  if (discovery === undefined) return;
  if (!discovery || typeof discovery !== 'object' || Array.isArray(discovery)
      || Object.keys(discovery).some(key => !['keywords', 'reference', 'entrypoint', 'limitations'].includes(key))) {
    fail('INVALID_DISCOVERY_METADATA', label + ' has invalid discovery fields');
  }
  for (const field of ['keywords', 'limitations']) {
    if (discovery[field] !== undefined && (!Array.isArray(discovery[field])
        || discovery[field].some(value => typeof value !== 'string' || !value.trim()))) {
      fail('INVALID_DISCOVERY_METADATA', label + '.' + field + ' must contain nonempty strings');
    }
  }
  const root = realpathSync.native(skillRoot);
  for (const field of ['reference', 'entrypoint']) {
    const value = discovery[field];
    if (value === undefined) continue;
    const allowed = field === 'reference' ? /^references\/.*\.md$/ : /^scripts\/.*\.(?:mjs|py|ps1)$/;
    if (typeof value !== 'string' || !allowed.test(value) || /[\\:]/.test(value) || value.split('/').includes('..')) {
      fail('INVALID_DISCOVERY_METADATA', label + '.' + field + ' must be a portable runtime path');
    }
    const target = resolve(root, value);
    if (!existsSync(target) || !statSync(target).isFile()) fail('INVALID_DISCOVERY_METADATA', label + '.' + field + ' is unavailable: ' + value);
    const realized = relative(root, realpathSync.native(target));
    if (realized.startsWith('..') || isAbsolute(realized)) fail('INVALID_DISCOVERY_METADATA', label + '.' + field + ' escapes the skill');
  }
}

export async function loadManifest(path = MANIFEST_FILE) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (
    manifest.schemaVersion !== 2
    || !manifest.providers
    || typeof manifest.providers !== 'object'
    || Array.isArray(manifest.providers)
    || !manifest.actions
    || typeof manifest.actions !== 'object'
    || Array.isArray(manifest.actions)
    || Object.keys(manifest.actions).length === 0
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
      || typeof action.file !== 'string'
      || !action.file.trim()
      || !Number.isInteger(action.contractVersion)
      || action.contractVersion < 1
      || typeof action.domain !== 'string'
      || !action.domain.trim()
      || !['host', 'eda'].includes(action.runtime)
      || !Array.isArray(action.providers)
      || !action.modes
      || typeof action.modes !== 'object'
      || Array.isArray(action.modes)
      || !action.modes[action.defaultMode]
    ) {
      fail('INVALID_ACTION_MANIFEST', 'Invalid Action contract in ' + path + ': ' + actionName);
    }
    if (action.internal !== undefined && typeof action.internal !== 'boolean') {
      fail('INVALID_ACTION_MANIFEST', actionName + ' internal must be boolean when present');
    }
    validateDiscoveryMetadata(action.discovery, undefined, actionName);
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
  if (manifest.workflows !== undefined && (!manifest.workflows || typeof manifest.workflows !== 'object' || Array.isArray(manifest.workflows))) {
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
      || Array.isArray(workflow.phases)
      || Object.keys(workflow.phases).length === 0
    ) {
      fail('INVALID_ACTION_MANIFEST', 'Invalid Workflow contract in ' + path + ': ' + workflowName);
    }
    validateDiscoveryMetadata(workflow.discovery, undefined, workflowName);
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
  // Transport success is not Action completion. Partial inspections are useful
  // results, but blocked writes and recovery after a failed apply are not success.
  const completedStatuses = new Set([
    'inspected', 'inspected-with-gaps', 'searched', 'searched-with-gaps',
    'resolved', 'generated', 'planned', 'planned-noop', 'applied', 'verified',
    'passed', 'conditional',
  ]);
  if (descriptor.mode === 'rollback') completedStatuses.add('rolled-back');
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
    ok: response?.success !== false && payload.success !== false && completedStatuses.has(payload.status),
    action: descriptor.actionName,
    actionContractVersion: descriptor.contractVersion,
    domain: descriptor.domain,
    runtime: descriptor.runtime,
    provider: descriptor.provider,
    mode: descriptor.mode,
    mutates: descriptor.mutates,
    status: payload.status ?? response?.status ?? 'unknown',
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
      sessionId: response?.sessionId ?? response?.request?.sessionId ?? null,
      windowId: response?.windowId ?? response?.request?.windowId ?? null,
    },
    ...(response?.request ? { request: response.request } : {}),
    ...(response?.submissionReceipt ? { submissionReceipt: response.submissionReceipt } : {}),
    reportFile,
  };
}

function parseControlResult(completed) {
  const stream = (completed.status === 0 ? completed.stdout : completed.stderr)?.trim()
    || (completed.status === 0 ? completed.stderr : completed.stdout)?.trim() || '';
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

function purposeMatches(name, record, query) {
  const normalize = value => value.normalize('NFKC').toLowerCase();
  // Match purpose terms only. Limitations must not make an unsupported purpose discoverable.
  const text = normalize([name, record.description, record.domain, ...(record.discovery?.keywords ?? [])].join(' '));
  return normalize(query).split(/\s+/).every(term => text.includes(term));
}

function discoveryDetails(name, record, workflow = false) {
  const details = record.discovery ?? {};
  return {
    ...(details.reference ? { reference: details.reference } : {}),
    entrypoint: details.entrypoint
      ? { kind: 'script', file: details.entrypoint }
      : workflow ? { kind: 'workflow-steps' }
        : { kind: 'action-runner', file: 'scripts/action-runner.mjs', args: ['run', '--action', name] },
    limitations: details.limitations ?? [],
  };
}

function publicManifest(manifest, skillVersion, requestedDomain = null, full = false, query = null) {
  const publicActionEntries = Object.entries(manifest.actions).filter(([, action]) => full || query || action.internal !== true);
  const workflowEntries = Object.entries(manifest.workflows ?? {});
  const domains = [...new Set([
    ...publicActionEntries.map(([, action]) => action.domain),
    ...workflowEntries.map(([, workflow]) => workflow.domain),
  ])].sort();
  if (requestedDomain && !domains.includes(requestedDomain)) {
    fail('UNKNOWN_ACTION_DOMAIN', `Unknown action domain: ${requestedDomain}. Available domains: ${domains.join(', ')}`);
  }
  const selectedWorkflows = workflowEntries.filter(([name, workflow]) =>
    (!requestedDomain || workflow.domain === requestedDomain) && (!query || purposeMatches(name, workflow, query)));
  const workflowSteps = new Set(query ? selectedWorkflows.flatMap(([, workflow]) =>
    Object.values(workflow.phases).flat().map(step => step.action)) : []);
  const actions = publicActionEntries
    .filter(([name, action]) => (!requestedDomain || action.domain === requestedDomain)
      && (!query || purposeMatches(name, action, query) || workflowSteps.has(name)))
    .map(([name, action]) => ({
      name,
      description: action.description,
      contractVersion: action.contractVersion,
      domain: action.domain,
      runtime: action.runtime,
      providers: action.providers,
      defaultMode: action.defaultMode,
      ...(full || query ? { internal: action.internal === true, file: action.file, requires: action.requires ?? {}, ...discoveryDetails(name, action) } : {}),
      ...(query ? { match: purposeMatches(name, action, query) ? 'direct' : 'workflow-step' } : {}),
      modes: Object.entries(action.modes).map(([mode, contract]) => ({
        mode,
        mutates: Boolean(contract.mutates),
      })),
    }));
  const workflows = selectedWorkflows
    .map(([name, workflow]) => ({
      name,
      description: workflow.description,
      domain: workflow.domain,
      provider: workflow.provider,
      phases: full || query ? workflow.phases : Object.keys(workflow.phases),
      ...(full || query ? discoveryDetails(name, workflow, true) : {}),
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
    ...(query ? {
      readOnly: true,
      queryFilter: query,
      queryStatus: actions.length || workflows.length ? 'matched' : 'no-match',
      ...(!actions.length && !workflows.length ? {
        guidance: '当前注册表无匹配能力；先核对用途关键词，再沿阶段说明和项目交接检查已有脚本。没有登记不等于没有项目脚本，不自动跨原理图/PCB 选用能力。',
      } : {}),
    } : {}),
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
  const requestId = randomUUID();
  const childArguments = [
    HOST_FILE,
    'execute',
    '--eda',
    descriptor.provider,
    '--code-file',
    descriptor.actionFile,
    '--request-id',
    requestId,
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
  let response;
  try {
    response = parseControlResult(completed);
    if (completed.error) throw completed.error;
    return { response, status: completed.status };
  } catch (error) {
    const failure = completed.error || error;
    failure.request = response?.request || { requestId, status: 'unknown' };
    failure.submissionReceipt = response?.submissionReceipt;
    failure.transport = {
      exitCode: completed.status,
      signal: completed.signal ?? null,
      stdout: completed.stdout ?? '',
      stderr: completed.stderr ?? '',
    };
    throw failure;
  }
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
  try {
    if (descriptor.runtime === 'eda') {
      execution = await executeEdaAction(arguments_, descriptor, inputFile);
    } else {
      execution = {
        response: await executeHostAction(descriptor, input, {
          projectRoot: arguments_.projectRoot ? resolve(arguments_.projectRoot) : null,
          skillVersion,
        }),
        status: 0,
      };
    }
  } catch (error) {
    execution = {
      response: {
        success: false,
        status: descriptor.runtime === 'eda' ? 'unknown' : 'error',
        error: { code: error.code || (descriptor.runtime === 'eda' ? 'EDA_TRANSPORT_ERROR' : 'HOST_ACTION_ERROR'), message: error.message },
        ...(descriptor.runtime === 'eda' ? { executionOutcome: 'unknown' } : {}),
        ...(error.transport ? { transport: error.transport } : {}),
        ...(error.request ? { request: error.request } : {}),
        ...(error.submissionReceipt ? { submissionReceipt: error.submissionReceipt } : {}),
      },
      status: 1,
    };
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
    projectRoot: arguments_.projectRoot ? resolve(arguments_.projectRoot) : null,
    response,
  });
  if (execution.status !== 0) {
    const error = response.error || {};
    const failure = new Error(error.message || 'Action execution failed');
    failure.code = error.code || 'ACTION_EXECUTION_FAILED';
    failure.reportFile = reportFile;
    failure.request = response.request;
    failure.executionOutcome = response.executionOutcome;
    failure.submissionReceipt = response.submissionReceipt;
    throw failure;
  }
  const summary = summarizeExecution(response, descriptor, reportFile, skillVersion);
  process.stdout.write(JSON.stringify(arguments_.full ? response : summary) + '\n');
  if (!summary.ok) process.exitCode = 1;
}

export async function main(argv = process.argv.slice(2)) {
  const arguments_ = parseArguments(argv);
  const manifest = await loadManifest();
  const skillVersion = (await readFile(VERSION_FILE, 'utf8')).trim();
  if (arguments_.command === 'list') {
    process.stdout.write(JSON.stringify(publicManifest(manifest, skillVersion, arguments_.domain, arguments_.full, arguments_.query)) + '\n');
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
      ...(error.request ? { request: error.request } : {}),
      ...(error.executionOutcome ? { executionOutcome: error.executionOutcome } : {}),
      ...(error.submissionReceipt ? { submissionReceipt: error.submissionReceipt } : {}),
    }) + '\n');
    process.exitCode = 1;
  });
}
