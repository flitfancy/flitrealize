#!/usr/bin/env node
/** Connect the existing PCB plan/apply/verify/save Actions and retain each result. */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const ACTIONS = new Set(['pcb-placement', 'pcb-trace-width', 'pcb-net-color']);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const within = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel); };
const unsettled = status => ['unknown', 'outcome-unknown', 'in-flight', 'started'].includes(status) || status?.endsWith('-running');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

function unknownOutcome(record, mutates) {
  const response = record?.response;
  return !response || response.executionOutcome === 'unknown' || unsettled(response.status) || unsettled(response.result?.status)
    || /TIMEOUT|TIMEDOUT|ENOBUFS|ECONN|EPIPE|TRANSPORT|EMPTY_ADAPTER_RESULT|INVALID_ADAPTER_RESULT|ACTION_OUTCOME_UNKNOWN/.test(response.error?.code ?? '')
    || (mutates && ['EDA_HOST_ERROR', 'ADAPTER_ERROR'].includes(response.error?.code));
}

function requireSettled(record, writesOnly = false) {
  if ((!writesOnly && unsettled(record.status)) || record.steps?.some(step => (!writesOnly || ['apply', 'save'].includes(step.mode)) && unsettled(step.status))) {
    fail('SAVE_RECOVERY_UNRESOLVED', 'An earlier execution is still in flight or has an unknown outcome. Reconcile it read-only before any new save; this entrypoint cannot clear the uncertainty.');
  }
}

function targetOf(request) {
  const target = request?.plan ?? request;
  if (!['expectedProjectUuid', 'expectedDocumentUuid'].every(key => typeof target?.[key] === 'string' && target[key].trim())) {
    fail('TARGET_REQUIRED', 'Explicit expectedProjectUuid and expectedDocumentUuid are required.');
  }
  return { expectedProjectUuid: target.expectedProjectUuid, expectedDocumentUuid: target.expectedDocumentUuid };
}

function sameTarget(request, expected) {
  const actual = targetOf(request);
  if (Object.keys(expected).some(key => actual[key] !== expected[key])) fail('TARGET_MISMATCH', 'A returned request or report belongs to a different project/PCB.');
}

function checkRequests(applied, target) {
  for (const mode of ['verify', 'save']) {
    const request = applied[mode + 'Request'];
    if (request?.mode !== mode || typeof request.expectedFingerprint !== 'string' || !request.expectedFingerprint) fail('INVALID_APPLY_REPORT', `Successful apply must return a ${mode}Request with its fingerprint.`);
    sameTarget(request, target);
    if (request.expectedFingerprint !== applied.after?.fingerprint) fail('INVALID_APPLY_REPORT', 'Follow-up requests do not match the applied readback.');
  }
  sameTarget(applied.after?.target, target);
}

async function projectReport(root, path) {
  const actual = await realpath(resolve(root, path));
  if (!within(root, actual)) fail('REPORT_OUTSIDE_PROJECT', 'Save recovery requires a stable report inside the current project.');
  return { path: actual, record: await json(actual) };
}

async function resumeApply(root, options) {
  let source = await projectReport(root, options.resumeSave);
  const wrapper = source.record.kind === 'flitrealize.pcb-edit' ? source.record : null;
  if (wrapper) {
    requireSettled(wrapper);
    if (typeof wrapper.resumeSaveReport !== 'string') fail('INVALID_APPLY_REPORT', 'This workflow has no successful apply to resume saving.');
    if (await realpath(wrapper.projectRoot) !== root) fail('REPORT_OUTSIDE_PROJECT', 'Workflow report belongs to a different local project.');
    source = await projectReport(root, wrapper.resumeSaveReport);
  }
  const { record } = source;
  const applied = record.response?.result;
  if (record.schemaVersion !== 2 || !ACTIONS.has(record.action) || record.mode !== 'apply' || record.mutates !== true
      || record.runtime !== 'eda' || record.provider !== 'easyeda-pro' || record.response?.success !== true
      || record.action === 'pcb-net-color' || applied?.status !== 'applied' || applied.saved !== false) {
    fail('INVALID_APPLY_REPORT', 'Resume saving requires a successful PCB apply report, not an arbitrary request or a failed write.');
  }
  if (typeof record.projectRoot !== 'string' || !record.projectRoot) fail('PROJECT_OWNERSHIP_REQUIRED', 'The apply report must record its local projectRoot; legacy reports without ownership require reconciliation.');
  if (await realpath(record.projectRoot) !== root) fail('REPORT_OUTSIDE_PROJECT', 'Apply report belongs to a different local project.');
  if ((options.action && options.action !== record.action) || (wrapper && wrapper.action !== record.action)) fail('ACTION_MISMATCH', 'Save recovery action differs from the successful apply.');
  const target = targetOf(applied.saveRequest);
  checkRequests(applied, target);
  if (wrapper) sameTarget(wrapper.target, target);
  // Older wrapper runs may predate save-attempt markers. Follow their original result when present.
  let original;
  try { original = await json(join(dirname(source.path), 'result.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (original?.kind === 'flitrealize.pcb-edit' && original.steps?.some(step => step.mode === 'apply' && resolve(root, step.reportFile) === source.path)) requireSettled(original, true);
  const attemptPath = await saveAttemptPath(root, record);
  try { await readFile(attemptPath); }
  catch (error) { if (error.code === 'ENOENT') return { action: record.action, target, applied, reportFile: source.path, attemptPath }; throw error; }
  fail('SAVE_RECOVERY_UNRESOLVED', 'A prior save attempt has not been confirmed finished. Reconcile its linked report before any new save: ' + attemptPath);
}

async function evidenceDirectory(root) {
  let base = root;
  for (const name of ['evidence', 'pcb-edit']) {
    const path = join(base, name);
    await mkdir(path, { recursive: true });
    base = await realpath(path);
    if (!within(root, base)) fail('REPORT_OUTSIDE_PROJECT', 'Evidence directory resolves outside the current project.');
  }
  return base;
}

async function saveAttemptPath(root, record) {
  const directory = join(await evidenceDirectory(root), 'save-attempts');
  await mkdir(directory, { recursive: true });
  const actual = await realpath(directory);
  if (!within(root, actual)) fail('REPORT_OUTSIDE_PROJECT', 'Save attempt directory resolves outside the current project.');
  const digest = createHash('sha256').update(JSON.stringify(canonical(record))).digest('hex');
  return join(actual, digest + '.json');
}

async function newReportDirectory(root, requested) {
  if (requested) {
    const path = resolve(root, requested);
    const parent = await realpath(dirname(path));
    if (!within(root, parent)) fail('REPORT_OUTSIDE_PROJECT', 'Report directory must be inside the current project.');
    const actual = join(parent, basename(path));
    await mkdir(actual); // A new directory keeps previous reports immutable.
    return actual;
  }
  const base = await evidenceDirectory(root);
  const path = join(base, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
  await mkdir(path);
  return path;
}

async function invokeRunner(action, input, context) {
  const args = [join(SCRIPT_ROOT, 'action-runner.mjs'), 'run', '--action', action,
    '--input-file', context.inputFile, '--project-root', context.projectRoot, '--report-file', context.reportFile];
  if (context.windowId) args.push('--window-id', context.windowId);
  if (context.mutates) args.push('--allow-write');
  let failure;
  try { await promisify(execFile)(process.execPath, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }); }
  catch (error) { failure = error; }
  try { return await json(context.reportFile); }
  catch { throw Object.assign(new Error(failure?.message || 'Runner did not retain an Action result.'), { code: failure?.code || 'ACTION_OUTCOME_UNKNOWN' }); }
}

export async function runPcbEdit(options) {
  if (!options.projectRoot) fail('PROJECT_REQUIRED', '--project-root is required.');
  const projectRoot = await realpath(resolve(options.projectRoot));
  if (options.resumeSave && (!options.apply || options.inputFile || options.candidate)) fail('INVALID_RESUME', '--resume-save requires --apply and cannot be combined with --input-file or --candidate.');
  const resumed = options.resumeSave ? await resumeApply(projectRoot, options) : null;
  const action = resumed?.action ?? options.action;
  if (!ACTIONS.has(action)) fail('UNSUPPORTED_ACTION', 'Choose pcb-placement, pcb-trace-width or pcb-net-color.');
  if (!resumed && !options.inputFile) fail('INPUT_REQUIRED', '--input-file is required.');
  if (options.candidate && action !== 'pcb-placement') fail('INVALID_CANDIDATE', '--candidate is only used for placement scenarios.');
  const input = resumed ? null : await json(resolve(options.inputFile));
  if (input?.mode && input.mode !== 'plan') fail('PLAN_INPUT_REQUIRED', 'Normal input must describe a plan; use --resume-save for a successful apply report.');
  const target = resumed?.target ?? targetOf(input);
  const reportDir = await newReportDirectory(projectRoot, options.reportDir);
  const reportFile = join(reportDir, 'result.json');
  const summary = { schemaVersion: 1, kind: 'flitrealize.pcb-edit', action, projectRoot, target,
    status: 'started', ok: false, readOnly: true, saved: null, selectedCandidate: options.candidate ?? null, steps: [], reportFile };
  const invoke = options.invoke ?? invokeRunner; // Injection is only for isolated Action tests.
  let attemptPath, ownsAttempt = false, writeOutcomeUnknown = false;
  async function persist() {
    await writeFile(reportFile + '.tmp', JSON.stringify(summary, null, 2) + '\n');
    await rename(reportFile + '.tmp', reportFile);
  }
  async function step(name, request, expectedStatus) {
    sameTarget(request, target);
    const mutates = ['apply', 'save'].includes(request.mode);
    if (mutates && !options.apply) fail('WRITE_AUTHORIZATION_REQUIRED', '--apply is required for PCB writes.');
    const prefix = String(summary.steps.length + 1).padStart(2, '0') + '-' + name;
    const item = { step: name, mode: request.mode, inputFile: join(reportDir, prefix + '-input.json'), reportFile: join(reportDir, prefix + '-report.json'), status: 'in-flight' };
    await writeFile(item.inputFile, JSON.stringify(request, null, 2) + '\n', { flag: 'wx' });
    summary.steps.push(item);
    summary.status = name + '-running';
    if (mutates) summary.readOnly = false;
    if (request.mode === 'save') { summary.saved = null; writeOutcomeUnknown = true; }
    await persist();
    let record;
    try {
      record = await invoke(action, request, { ...item, projectRoot, windowId: options.windowId, mutates });
    } catch (error) {
      record = { schemaVersion: 2, action, mode: request.mode, runtime: 'eda', provider: 'easyeda-pro', mutates, projectRoot,
        response: { success: false, status: 'unknown', executionOutcome: 'unknown', error: { code: error.code || 'ACTION_OUTCOME_UNKNOWN', message: error.message } } };
    }
    // The real runner already wrote its report; injected tests use the same envelope.
    try { await writeFile(item.reportFile, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const response = record?.response;
    const result = response?.result;
    const unknown = unknownOutcome(record, mutates);
    item.status = unknown ? 'unknown' : result?.status ?? response?.status ?? 'unknown';
    await persist();
    if (record?.action !== action || record?.mode !== request.mode) {
      throw Object.assign(new Error('Runner returned a report for another action/mode.'), {
        code: 'INVALID_ACTION_REPORT', ...(mutates ? { workflowStatus: 'outcome-unknown' } : {}),
      });
    }
    try {
      for (const state of [result, result?.before, result?.after, result?.state]) if (state?.target) sameTarget(state.target, target);
    } catch (error) {
      if (mutates) error.workflowStatus = 'outcome-unknown';
      throw error;
    }
    if (request.mode === 'apply') summary.saved = unknown ? null : result?.saved ?? null;
    if (request.mode === 'save' && !unknown && (result?.status || response?.status === 'error')) writeOutcomeUnknown = false;
    if (unknown || response?.success !== true || result?.status !== expectedStatus || (request.mode === 'save' && result.saved !== true)) {
      const error = new Error(result?.error?.message || response?.error?.message || `${name} did not complete: ${item.status}`);
      error.code = result?.error?.code || response?.error?.code || 'ACTION_FAILED';
      error.workflowStatus = item.status === 'unknown' ? 'outcome-unknown' : name + '-failed';
      throw error;
    }
    if (request.mode === 'save') summary.saved = true;
    return result;
  }
  async function colorEdit() {
    const planned = await step('plan', { ...input, mode: 'plan' }, 'planned');
    summary.assignments = planned.assignments;
    summary.changedCount = planned.changedCount;
    if (!options.apply) { summary.status = 'planned'; summary.ok = true; return; }
    if (planned.applyRequest?.mode !== 'apply' || planned.issues?.length) fail('BLOCKED_PLAN', 'Color plan has blockers or no apply request.');
    summary.changedCount = null;
    const applied = await step('apply', { ...planned.applyRequest, save: true }, 'applied');
    if (applied.saved !== true) fail('SAVE_FAILED', 'Color apply did not confirm saving.');
    summary.assignments = applied.assignments;
    summary.changedCount = applied.changedCount;
    summary.status = 'verified'; summary.ok = true;
  }
  await persist();
  try {
    if (action === 'pcb-net-color') {
      await colorEdit();
      await persist();
      return summary;
    }
    let applied = resumed?.applied;
    if (!resumed) {
      const planned = await step('plan', { ...input, mode: 'plan' }, 'planned');
      let selected = planned;
      if (Array.isArray(planned.candidates)) {
        summary.candidates = planned.candidates.map(({ name, issues, changedCount }) => ({ name, issues, changedCount }));
        const names = planned.candidates.map(candidate => candidate.name);
        if (new Set(names).size !== names.length) fail('DUPLICATE_CANDIDATE_NAME', 'Placement candidate names must be unique.');
        if (options.candidate) {
          selected = planned.candidates.find(candidate => candidate.name === options.candidate);
          if (!selected) fail('CANDIDATE_NOT_FOUND', 'Requested placement candidate was not returned.');
        } else if (options.apply) {
          summary.status = 'selection-required';
          summary.error = { code: 'CANDIDATE_REQUIRED', message: 'Choose a candidate explicitly with --candidate before applying.' };
          await persist();
          return summary;
        }
      } else if (options.candidate) {
        fail('INVALID_CANDIDATE', 'This input does not return named placement scenarios.');
      }
      if (!options.apply) {
        summary.status = 'planned'; summary.ok = true;
        await persist();
        return summary;
      }
      if (selected.applyRequest?.mode !== 'apply' || selected.issues?.length) fail('BLOCKED_PLAN', 'Selected plan has blockers or no apply request.');
      applied = await step('apply', selected.applyRequest, 'applied');
      checkRequests(applied, target);
      summary.resumeSaveReport = summary.steps.at(-1).reportFile;
    } else {
      summary.resumeSaveReport = resumed.reportFile;
    }
    summary.saveRequest = applied.saveRequest;
    summary.verifyRequest = applied.verifyRequest;
    attemptPath = resumed?.attemptPath ?? await saveAttemptPath(projectRoot, await json(summary.resumeSaveReport));
    try {
      await writeFile(attemptPath, JSON.stringify({ schemaVersion: 1, projectRoot, action, target, applyReport: summary.resumeSaveReport, reportFile }, null, 2) + '\n', { flag: 'wx' });
      ownsAttempt = true;
    } catch (error) {
      if (error.code === 'EEXIST') fail('SAVE_RECOVERY_UNRESOLVED', 'Another save attempt is still active or unresolved: ' + attemptPath);
      throw error;
    }
    summary.saveAttemptFile = attemptPath;
    await persist();
    await step('verify', applied.verifyRequest, 'verified');
    await step('save', applied.saveRequest, 'applied');
    await step('verify-after-save', applied.verifyRequest, 'verified');
    summary.status = 'verified'; summary.ok = true;
  } catch (error) {
    summary.status = error.workflowStatus ?? 'blocked';
    summary.error = { code: error.code || 'PCB_EDIT_FAILED', message: error.message };
  }
  await persist();
  // A missing/unknown write receipt or process interruption leaves this small marker for reconciliation.
  if (ownsAttempt && !writeOutcomeUnknown) await unlink(attemptPath);
  return summary;
}

const HELP = `Usage:
  node scripts/pcb-edit.mjs --project-root <directory> --action <pcb-placement|pcb-trace-width|pcb-net-color>
    --input-file <plan.json> [--candidate <unique-name>] [--apply] [--window-id <id>]
  node scripts/pcb-edit.mjs --project-root <directory> --resume-save <apply-report-or-result.json> --apply
    [--window-id <id>]
  Optional: --report-dir <new-directory-with-existing-parent-inside-project>
Default: plan only. --apply performs apply, verify, save, and verification after saving.
Net color verifies and saves within apply; it does not use separate verify/save or --resume-save.
Placement scenarios require an explicit unique --candidate before writing.
Save recovery reads a successful apply report inside this project and never replays apply.
Unknown/in-flight saves retain a project-local attempt marker and cannot be retried automatically.
`;

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) { process.stdout.write(HELP); return; }
  const options = {};
  const flags = { '--project-root': 'projectRoot', '--action': 'action', '--input-file': 'inputFile', '--candidate': 'candidate', '--window-id': 'windowId', '--report-dir': 'reportDir', '--resume-save': 'resumeSave' };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--apply') { options.apply = true; continue; }
    if (!flags[flag] || !argv[index + 1] || argv[index + 1].startsWith('--')) fail('INVALID_ARGUMENT', 'Unknown or incomplete argument: ' + flag);
    options[flags[flag]] = argv[++index];
  }
  const result = await runPcbEdit(options);
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && await realpath(resolve(process.argv[1])) === await realpath(fileURLToPath(import.meta.url))) {
  main().catch(error => { process.stderr.write(JSON.stringify({ ok: false, error: { code: error.code || 'PCB_EDIT_FAILED', message: error.message } }) + '\n'); process.exitCode = 1; });
}
