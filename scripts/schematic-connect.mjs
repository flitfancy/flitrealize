#!/usr/bin/env node
/** Connect a declared endpoint-stub schematic, verify it, optionally reflow, save and run strict DRC. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planConnections } from './lib/schematic-connect-plan.mjs';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const chunks = (items, size = 30) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel); };
const unknown = response => !response || response.executionOutcome === 'unknown' || ['unknown', 'in-flight'].includes(response.status)
  || /TIMEOUT|TIMEDOUT|ENOBUFS|TRANSPORT|EDA_HOST_ERROR|ADAPTER_ERROR|ECONN|EPIPE/.test(response.error?.code || '');

async function invokeRunner(action, input, context) {
  const args = [join(scriptRoot, 'action-runner.mjs'), 'run', '--action', action,
    '--input-file', context.inputFile, '--report-file', context.reportFile, '--project-root', context.projectRoot];
  if (context.windowId) args.push('--window-id', context.windowId);
  if (context.mutates) args.push('--allow-write');
  let error;
  try { await promisify(execFile)(process.execPath, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }); }
  catch (caught) { error = caught; }
  try { return await json(context.reportFile); }
  catch { throw error || new Error('Action runner returned no durable report.'); }
}

export async function runSchematicConnect(options) {
  if (!options.projectRoot || !options.inputFile) fail('INPUT_REQUIRED', '--project-root and --input-file are required.');
  if (options.apply && options.check) fail('INVALID_MODE', '--apply and --check are mutually exclusive.');
  const projectRoot = await realpath(resolve(options.projectRoot));
  const input = await json(resolve(options.inputFile));
  if (input.contractFile) {
    if (input.contract) fail('DUPLICATE_CONTRACT_INPUT', 'Choose contractFile or embedded contract.');
    input.contract = await json(resolve(dirname(resolve(options.inputFile)), input.contractFile));
  }
  const target = { expectedDocumentUuid: input.expectedDocumentUuid, expectedProjectUuid: input.expectedProjectUuid };
  if (Object.values(target).some(value => typeof value !== 'string' || !value.trim())) fail('TARGET_REQUIRED', 'Explicit schematic and project UUIDs are required.');
  if (input.reflow && input.reflow.mode !== 'preserve' && !Array.isArray(input.reflow.blocks)) fail('REFLOW_CONFIG_REQUIRED', 'Reflow needs existing blocks/layout, or mode preserve with a reason.');
  if (input.reflow?.mode === 'preserve' && !input.reflow.reason?.trim()) fail('REFLOW_REASON_REQUIRED', 'Record why the existing layout should be preserved.');
  const reflowInput = input.reflow && input.reflow.mode !== 'preserve' ? { ...input.reflow, ...target, phase: 'complete' } : null;
  const base = join(projectRoot, 'evidence', 'schematic-connect');
  await mkdir(base, { recursive: true });
  if (!inside(projectRoot, await realpath(base))) fail('REPORT_OUTSIDE_PROJECT', 'Evidence directory resolves outside the project.');
  const runDir = join(base, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
  await mkdir(runDir);
  const reportFile = join(runDir, 'result.json');
  const summary = { schemaVersion: 1, kind: 'flitrealize.schematic-connect', projectRoot, target, runDir, reportFile,
    status: 'started', ok: false, readOnly: true, saved: null, checks: {}, steps: [] };
  const lockFile = join(base, createHash('sha256').update(JSON.stringify(target)).digest('hex') + '.active.json');
  const invoke = options.invoke || invokeRunner;
  let ownsLock = false, unresolvedWrite = false;
  async function persist() {
    await writeFile(reportFile + '.tmp', JSON.stringify(summary, null, 2) + '\n');
    await rename(reportFile + '.tmp', reportFile);
  }
  async function step(action, name, request, statuses) {
    const mutates = ['apply', 'rollback'].includes(request.mode);
    if (mutates && !options.apply) fail('WRITE_AUTHORIZATION_REQUIRED', '--apply is required.');
    for (const candidate of [request, request.request, request.plan, request.request?.plan]) {
      for (const [key, expected] of Object.entries(target)) {
        if (candidate?.[key] != null && candidate[key] !== expected) fail('RETURNED_TARGET_MISMATCH', 'An Action request targets a different schematic/project.');
      }
    }
    const index = String(summary.steps.length + 1).padStart(3, '0');
    const item = { action, name, mode: request.mode, mutates, status: 'in-flight',
      inputFile: join(runDir, index + '-' + name + '-input.json'), reportFile: join(runDir, index + '-' + name + '-report.json') };
    await writeFile(item.inputFile, JSON.stringify(request, null, 2) + '\n', { flag: 'wx' });
    summary.steps.push(item);
    if (mutates) { summary.readOnly = false; unresolvedWrite = true; }
    await persist();
    let record;
    try { record = await invoke(action, request, { ...item, projectRoot, windowId: options.windowId }); }
    catch (error) { record = { action, mode: request.mode, response: { success: false, status: 'unknown', executionOutcome: 'unknown', error: { message: error.message } } }; }
    try { await writeFile(item.reportFile, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const response = record?.response, result = response?.result;
    const uncertain = unknown(response) || result?.uncertainWrite === true
      || ['rollback-incomplete', 'outcome-unknown'].includes(result?.status)
      || record?.action !== action || record?.mode !== request.mode;
    item.status = uncertain ? 'unknown' : result?.status || response?.status || 'failed';
    if (mutates) unresolvedWrite = uncertain;
    if (typeof result?.saved === 'boolean') summary.saved = result.saved;
    if (result?.drc) summary.checks.drc = result.drc;
    await persist();
    if (uncertain || response?.success !== true || !statuses.includes(result?.status)) {
      fail(uncertain ? 'OUTCOME_UNKNOWN' : result?.error?.code || 'ACTION_FAILED', `${name}: ${result?.error?.message || response?.error?.message || item.status}. See ${item.reportFile}`);
    }
    return result;
  }
  async function inspect(name, includeSource = false) {
    const result = await step('schematic-inspect', name, { mode: 'inspect', ...target, includeConnectionEvidence: true, includeSource }, ['inspected', 'inspected-with-gaps']);
    const snapshot = result.snapshot;
    if (snapshot?.document?.nativeId !== target.expectedDocumentUuid || snapshot?.project?.nativeId !== target.expectedProjectUuid) fail('DOCUMENT_MISMATCH', 'Readback belongs to another schematic/project.');
    if (includeSource) {
      if (typeof result.backupSource !== 'string' || !result.backupSource.trim()) fail('BACKUP_UNAVAILABLE', 'Source backup is unavailable.');
      await writeFile(join(runDir, 'before.esch'), result.backupSource, { flag: 'wx' });
    }
    return snapshot;
  }
  async function assess(snapshot, phase, name) {
    const plan = await planConnections(input, snapshot, { phase });
    await writeFile(join(runDir, name + '.json'), JSON.stringify(plan, null, 2) + '\n');
    summary.checks.connections = { phase, applyReady: plan.applyReady, diagnostics: plan.diagnostics, coverage: plan.scope, pending: plan.pending };
    if (!plan.applyReady) fail('CONNECTIONS_BLOCKED', `Connection ${phase} has unresolved items; see ${name}.json.`);
    return plan;
  }
  async function assertSame(snapshot) {
    const current = await inspect('pre-write-inspect');
    if (current.fingerprints.document !== snapshot.fingerprints.document) fail('STALE_SCHEMATIC', 'Schematic changed after planning; no new write was started.');
  }
  async function verifyDrc() {
    const result = await step('schematic-save-verify', 'strict-drc-verify', { mode: 'verify', ...target, strict: true, runDrc: true }, ['verified']);
    if (result.drc?.passed !== true) fail('DRC_NOT_PASSED', 'Strict DRC was not confirmed.');
  }
  await writeFile(join(runDir, 'input.json'), JSON.stringify(input, null, 2) + '\n', { flag: 'wx' });
  await persist();
  try {
    if (options.apply) {
      try { await writeFile(lockFile, JSON.stringify({ target, reportFile }) + '\n', { flag: 'wx' }); ownsLock = true; }
      catch (error) { if (error.code === 'EEXIST') fail('UNRESOLVED_RUN', `Another running or unresolved write exists: ${lockFile}. Reconcile that report before another apply.`); throw error; }
    }
    let snapshot = await inspect('initial-inspect', Boolean(options.apply));
    const plan = await assess(snapshot, options.check ? 'verify' : 'plan', 'initial-plan');
    summary.checks.reflow = reflowInput ? { status: 'pending' }
      : { status: 'not-requested', reason: input.reflow?.reason || 'No reflow configuration supplied; existing layout is retained.' };
    if (options.check) {
      if (reflowInput) {
        await step('schematic-reflow', 'reflow-verify', { ...reflowInput, mode: 'verify' }, ['verified']);
        summary.checks.reflow = { status: 'verified' };
      }
      await verifyDrc();
      const final = await inspect('final-inspect');
      await assess(final, 'verify', 'final-audit');
      if (final.fingerprints.document !== snapshot.fingerprints.document) fail('CHECK_CHANGED_SOURCE', 'Schematic changed during read-only checks.');
      summary.status = 'checked'; summary.ok = true;
      await persist(); return summary;
    }
    if (!options.apply) {
      summary.status = 'planned'; summary.ok = true;
      summary.pending = { wires: plan.wirePlan.wires.length, markers: plan.missingFlagItems.length, noConnect: plan.pendingNoConnectItems.length };
      await persist(); return summary;
    }
    // Plan each bounded batch against the immediate live state. Never replay an uncertain write.
    let wireBatchPlan = plan;
    for (let i = 0; wireBatchPlan.wirePlan.wires.length; i += 1) {
      await assertSame(snapshot);
      const wires = wireBatchPlan.wirePlan.wires.slice(0, 30);
      const wirePlan = { ...wireBatchPlan.wirePlan, wires };
      const planned = await step('schematic-wire-create', `wire-${i}-plan`, { mode: 'plan', plan: wirePlan }, ['planned', 'planned-noop']);
      if (planned.status === 'planned') {
        const applied = await step('schematic-wire-create', `wire-${i}-apply`, planned.applyRequest, ['applied']);
        await step('schematic-wire-create', `wire-${i}-verify`, { mode: 'verify', request: { ...target, created: applied.created } }, ['verified']);
      }
      snapshot = await inspect(`wire-${i}-readback`);
      const refreshed = await assess(snapshot, 'plan', `wire-${i}-remaining`);
      if (refreshed.wirePlan.wires.length >= wireBatchPlan.wirePlan.wires.length) fail('WIRE_NO_PROGRESS', 'Wire batch did not reduce missing endpoints.');
      wireBatchPlan = refreshed;
    }
    const afterWires = await assess(snapshot, 'plan', 'after-wires-plan');
    for (const [i, items] of chunks(afterWires.missingFlagItems).entries()) {
      await assertSame(snapshot);
      const planned = await step('schematic-net-flag', `marker-${i}-plan`, { mode: 'plan', ...target, items }, ['planned']);
      const applied = await step('schematic-net-flag', `marker-${i}-apply`, planned.applyRequest, ['applied']);
      await step('schematic-net-flag', `marker-${i}-verify`, { mode: 'verify', request: { ...target, created: applied.created } }, ['verified']);
      snapshot = await inspect(`marker-${i}-readback`);
    }
    // NC assessment is mandatory, including a recorded empty result. Only Contract/explicit provider pins qualify.
    summary.checks.noConnect = { status: 'pending', declaredCount: afterWires.noConnectItems.length };
    for (const [i, items] of chunks(afterWires.pendingNoConnectItems).entries()) {
      await assertSame(snapshot);
      const planned = await step('schematic-no-connect', `nc-${i}-plan`, { mode: 'plan', ...target, items }, ['planned']);
      await step('schematic-no-connect', `nc-${i}-apply`, planned.applyRequest, ['applied']);
      await step('schematic-no-connect', `nc-${i}-verify`, { mode: 'verify', ...target, items }, ['verified']);
      snapshot = await inspect(`nc-${i}-readback`);
    }
    summary.checks.noConnect.status = afterWires.noConnectItems.length ? 'verified' : 'not-applicable';
    await assess(snapshot, 'verify', 'connected-audit');
    if (reflowInput) {
      await assertSame(snapshot);
      const planned = await step('schematic-reflow', 'reflow-plan', { ...reflowInput, mode: 'plan' }, ['planned']);
      await writeFile(join(runDir, 'before-reflow.esch'), planned.backupSource, { flag: 'wx' });
      await step('schematic-reflow', 'reflow-apply', planned.applyRequest, ['applied']);
      await step('schematic-reflow', 'reflow-verify', { ...reflowInput, mode: 'verify' }, ['verified']);
      summary.checks.reflow = { status: 'verified' };
      snapshot = await inspect('reflow-readback');
      await assess(snapshot, 'verify', 'reflow-audit');
    }
    await assertSame(snapshot);
    const savePlan = await step('schematic-save-verify', 'save-plan', { mode: 'plan', ...target, strict: true, runDrc: true }, ['planned']);
    const saved = await step('schematic-save-verify', 'save-apply', savePlan.applyRequest, ['applied']);
    if (saved.saved !== true || saved.drc?.passed !== true) fail('FINALIZE_FAILED', 'Saving and strict DRC must both pass.');
    const final = await inspect('saved-readback');
    await assess(final, 'verify', 'saved-audit');
    if (final.fingerprints.document !== snapshot.fingerprints.document) fail('SAVE_CHANGED_SOURCE', 'Saving changed the schematic; inspect the recorded before/after evidence.');
    summary.status = 'connected-saved'; summary.ok = true;
  } catch (error) {
    summary.status = unresolvedWrite ? 'outcome-unknown' : 'blocked';
    summary.error = { code: error.code || 'WORKFLOW_FAILED', message: error.message };
  } finally {
    if (ownsLock && !unresolvedWrite) await unlink(lockFile);
    await persist();
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  try {
    for (let i = 2; i < process.argv.length; i += 1) {
      const arg = process.argv[i];
      if (arg === '--help') {
        console.log('node scripts/schematic-connect.mjs --project-root PROJECT --input-file INPUT [--window-id WINDOW] [--apply | --check]\nDefault: plan only. --apply connects, audits, optionally reflows, saves and runs strict DRC. --check verifies without writes. See references/providers/easyeda-pro/2.4-schematic-connect.md.');
        process.exit(0);
      }
      if (arg === '--apply' || arg === '--check') { options[arg.slice(2)] = true; continue; }
      const key = { '--project-root': 'projectRoot', '--input-file': 'inputFile', '--window-id': 'windowId' }[arg];
      if (!key || !process.argv[i + 1]) fail('INVALID_ARGUMENT', `Unknown or incomplete argument ${arg}`);
      options[key] = process.argv[++i];
    }
    const result = await runSchematicConnect(options);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ ok: false, code: error.code, error: error.message })); process.exitCode = 1; }
}
