#!/usr/bin/env node
/** Register and invoke host-local EDA adapters without hard-coded machine paths. */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCHEMA_VERSION = 1;
const actionManifest = JSON.parse(await readFile(new URL('./actions/manifest.json', import.meta.url), 'utf8'));
const SUPPORTED_EDAS = new Set(
  Object.entries(actionManifest.providers || {})
    .filter(([, provider]) => provider?.kind === 'eda')
    .map(([providerId]) => providerId),
);
const STATE_ROOT = stateRoot();
const PROFILE_FILE = join(STATE_ROOT, 'host.json');

function edaActionTimeoutMs() {
  const raw = process.env.FLITREALIZE_EDA_ACTION_TIMEOUT_MS;
  if (!raw) return 45_000;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1000 || value > 600_000) {
    throw new Error('FLITREALIZE_EDA_ACTION_TIMEOUT_MS must be an integer between 1000 and 600000');
  }
  return value;
}

function stateRoot() {
  if (process.env.FLITREALIZE_HOME) return resolve(process.env.FLITREALIZE_HOME);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'FlitRealize');
  }
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, 'flitrealize');
  return join(homedir(), '.config', 'flitrealize');
}

function utcNow() {
  return new Date().toISOString();
}

function parseArguments(argv) {
  const values = { command: argv[0] };
  if (!values.command) throw new Error('A command is required: register, status, ensure, windows, select, or execute');
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--require-eda') values.requireEda = true;
    else if (argument === '--eda') values.eda = argv[++index];
    else if (argument === '--adapter-root') values.adapterRoot = argv[++index];
    else if (argument === '--project-root') values.projectRoot = argv[++index];
    else if (argument === '--window-id') values.windowId = argv[++index];
    else if (argument === '--code-file') values.codeFile = argv[++index];
    else if (argument === '--input-file') values.inputFile = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!values.eda) throw new Error('--eda is required');
  return values;
}

function validateEda(eda) {
  if (!SUPPORTED_EDAS.has(eda)) throw new Error(`Unsupported EDA adapter: ${eda}`);
}

async function readJson(path, required = true) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && !required) return null;
    throw new Error(`Cannot read ${path}: ${error.message}`);
  }
}

async function loadProfile(create = false) {
  const profile = await readJson(PROFILE_FILE, false);
  if (profile) {
    if (profile.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported host profile schema in ${PROFILE_FILE}`);
    return profile;
  }
  if (!create) throw new Error('No FlitRealize host profile. Register an EDA adapter on this machine first.');
  return {
    schemaVersion: SCHEMA_VERSION,
    hostId: randomUUID(),
    createdAt: utcNow(),
    adapters: {},
  };
}

async function saveProfile(profile) {
  await mkdir(dirname(PROFILE_FILE), { recursive: true, mode: 0o700 });
  const temporary = `${PROFILE_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await unlink(PROFILE_FILE).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await rename(temporary, PROFILE_FILE);
}

async function registerAdapter(eda, adapterRoot) {
  validateEda(eda);
  if (!adapterRoot) throw new Error('--adapter-root is required');
  const root = resolve(adapterRoot);
  const control = join(root, 'scripts', 'bridge-control.mjs');
  const packageFile = join(root, 'package.json');
  if (!existsSync(control) || !existsSync(packageFile)) throw new Error(`Adapter root is incomplete: ${root}`);
  const packageData = await readJson(packageFile);
  const profile = await loadProfile(true);
  profile.adapters[eda] = {
    root,
    control: relative(root, control).split('\\').join('/'),
    package: packageData.name || null,
    version: packageData.version || null,
    registeredAt: utcNow(),
  };
  await saveProfile(profile);
  return {
    status: 'registered',
    hostId: profile.hostId,
    edaId: eda,
    adapterRoot: root,
    profile: PROFILE_FILE,
  };
}

async function adapterRecord(eda) {
  validateEda(eda);
  const profile = await loadProfile();
  const adapter = profile.adapters?.[eda];
  if (!adapter) throw new Error(`The ${eda} adapter is not registered on host ${profile.hostId || 'unknown'}`);
  return { profile, adapter };
}

async function checkProjectBinding(projectRoot, expectedEda) {
  if (!projectRoot) return null;
  const bindingPath = join(resolve(projectRoot), '.flitrealize', 'project.json');
  const binding = await readJson(bindingPath, false);
  if (!binding) return null;
  const actualEda = binding.eda || binding.edaId;
  if (actualEda && actualEda !== expectedEda) {
    throw new Error(`EDA_MISMATCH: project expects ${actualEda}, requested adapter is ${expectedEda}`);
  }
  return { path: bindingPath, edaId: actualEda || null, document: binding.document || null };
}

function parseControlOutput(completed) {
  const stream = completed.status === 0 ? completed.stdout.trim() : completed.stderr.trim();
  const lastLine = stream.split(/\r?\n/).filter(Boolean).at(-1);
  if (!lastLine) throw new Error(`Adapter control exited with ${completed.status}`);
  try {
    return JSON.parse(lastLine);
  } catch {
    throw new Error(lastLine);
  }
}

async function runControl(arguments_) {
  const { profile, adapter } = await adapterRecord(arguments_.eda);
  const root = resolve(adapter.root);
  const control = resolve(root, adapter.control);
  if (!existsSync(control)) throw new Error(`Registered adapter control script is missing: ${control}`);
  const relativeControl = relative(root, control);
  if (relativeControl.startsWith('..') || isAbsolute(relativeControl)) {
    throw new Error('Registered adapter control script resolves outside the adapter root');
  }
  const binding = await checkProjectBinding(arguments_.projectRoot, arguments_.eda);
  let effectiveCodeFile = arguments_.codeFile ? resolve(arguments_.codeFile) : null;
  let temporaryCodeFile = null;
  if (arguments_.inputFile) {
    if (!effectiveCodeFile) throw new Error('--input-file requires --code-file');
    const input = await readJson(resolve(arguments_.inputFile));
    const code = await readFile(effectiveCodeFile, 'utf8');
    await mkdir(STATE_ROOT, { recursive: true, mode: 0o700 });
    temporaryCodeFile = join(STATE_ROOT, `execute-${process.pid}-${randomUUID()}.js`);
    const serialized = JSON.stringify(input);
    const prelude = `const flitrealizeInput = JSON.parse(${JSON.stringify(serialized)});\n`;
    await writeFile(temporaryCodeFile, `${prelude}${code}`, { encoding: 'utf8', mode: 0o600 });
    effectiveCodeFile = temporaryCodeFile;
  }

  try {
    const childArguments = [control, arguments_.command, '--json'];
    if (arguments_.requireEda) childArguments.push('--require-eda');
    if (arguments_.windowId) childArguments.push('--window-id', arguments_.windowId);
    if (effectiveCodeFile) childArguments.push('--code-file', effectiveCodeFile);
    const actionTimeout = edaActionTimeoutMs();
    const childEnvironment = {
      ...process.env,
      EASYEDA_BRIDGE_REQUEST_TIMEOUT_MS: process.env.EASYEDA_BRIDGE_REQUEST_TIMEOUT_MS || String(actionTimeout),
    };
    const completed = spawnSync(process.execPath, childArguments, {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      timeout: actionTimeout + 10_000,
      env: childEnvironment,
    });
    if (completed.error) throw completed.error;
    const result = parseControlOutput(completed);
    if (completed.status !== 0) {
      const detail = result.error || {};
      const error = new Error(detail.message || completed.stderr.trim());
      error.code = detail.code || 'ADAPTER_ERROR';
      error.hint = result.hint;
      error.bridgeStatus = result.bridgeStatus;
      throw error;
    }
    result.hostId = profile.hostId;
    if (binding) result.projectBinding = binding;
    return result;
  } finally {
    if (temporaryCodeFile) await unlink(temporaryCodeFile).catch(() => {});
  }
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  let result;
  if (arguments_.command === 'register') result = await registerAdapter(arguments_.eda, arguments_.adapterRoot);
  else if (['status', 'ensure', 'windows', 'select', 'execute'].includes(arguments_.command)) {
    if (arguments_.command === 'select' && !arguments_.windowId) throw new Error('--window-id is required');
    if (arguments_.command === 'execute' && !arguments_.codeFile) throw new Error('--code-file is required');
    result = await runControl(arguments_);
  } else throw new Error(`Unknown command: ${arguments_.command}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: 'error',
    error: { code: error.code || 'EDA_HOST_ERROR', message: error.message },
    ...(error.hint ? { hint: error.hint } : {}),
    ...(error.bridgeStatus ? { bridgeStatus: error.bridgeStatus } : {}),
  })}\n`);
  process.exitCode = 1;
});
