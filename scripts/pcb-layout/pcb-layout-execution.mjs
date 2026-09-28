/** Native layout operations with immutable evidence and no automatic replay. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { getLayoutProvider } from './pcb-layout-provider.mjs';

export const LAYOUT_EXECUTION_VERSION = 2;
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const sourceFingerprint = value => Number.isSafeInteger(value) || typeof value === 'string' && value.trim().length > 0;
const fail = (code, message = code) => { throw Object.assign(Error(message), { code }); };
const within = (root, file) => { const r = relative(root, file); return r !== '..' && !r.startsWith('..\\') && !r.startsWith('../') && !isAbsolute(r); };
const unsettled = s => ['unknown', 'in-flight', 'outcome-unknown'].includes(s) || s?.endsWith('-running');
async function atomic(file, value) { await writeFile(file + '.tmp', JSON.stringify(value, null, 2) + '\n'); await rename(file + '.tmp', file); }
async function canonicalDestination(directory) {
  try { return await realpath(directory); }
  catch (error) {
    const parent = dirname(directory);
    if (error.code !== 'ENOENT' || parent === directory) throw error;
    return join(await canonicalDestination(parent), basename(directory));
  }
}
async function context(options) {
  if (!options.projectRoot) fail('LAYOUT_CONTEXT_REQUIRED', 'projectRoot is required.');
  const provider = getLayoutProvider(options.providerId ?? options.snapshot?.layout?.provider ?? options.snapshot?.provider);
  provider.validateContext(options);
  const projectRoot = await realpath(resolve(options.projectRoot));
  const requested = await canonicalDestination(options.reportDir ? resolve(projectRoot, options.reportDir) : join(projectRoot, 'evidence', 'pcb-layout-execution', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID()));
  if (!within(projectRoot, requested)) fail('REPORT_OUTSIDE_PROJECT');
  await mkdir(requested, { recursive: true });
  const reportDir = await realpath(requested);
  if (!within(projectRoot, reportDir)) fail('REPORT_OUTSIDE_PROJECT');
  if (options.providerId && (options.snapshot?.layout?.provider ?? options.snapshot?.provider) && options.providerId !== (options.snapshot.layout?.provider ?? options.snapshot.provider)) fail('LAYOUT_PROVIDER_MISMATCH');
  return { projectRoot, reportDir, windowId: options.windowId, provider, transport: options.transport ?? provider.execute };
}
async function invoke(ctx, phase, input, name = phase) {
  const { code, extension } = await ctx.provider.buildOperation(phase, input);
  if (!/^\.[a-z0-9]+$/.test(extension) || typeof code !== 'string') fail('INVALID_PROVIDER_OPERATION');
  const codeFile = join(ctx.reportDir, 'layout-' + name + extension), inputFile = join(ctx.reportDir, 'layout-' + name + '-input.json'), reportFile = join(ctx.reportDir, 'layout-' + name + '-result.json');
  await writeFile(inputFile, JSON.stringify(input, null, 2) + '\n', { flag: 'wx' });
  await writeFile(codeFile, code, { flag: 'wx' });
  const mutates = phase === 'apply' || phase === 'save';
  let response;
  try { response = await ctx.transport({ ...ctx, phase, name, code, input, codeFile, inputFile, reportFile, mutates }); }
  catch (error) { response = { success: false, executionOutcome: 'unknown', error: { code: error.code ?? 'TRANSPORT_ERROR', message: error.message } }; }
  const unknown = !response || response.executionOutcome === 'unknown' || unsettled(response.status) || unsettled(response.result?.status) || /TIMEOUT|TIMEDOUT|ECONN|EPIPE|ENOBUFS|TRANSPORT/.test(response.error?.code ?? '') || (mutates && response.success !== true);
  const record = { schemaVersion: 1, kind: 'flitrealize.pcb-layout.native', executionVersion: LAYOUT_EXECUTION_VERSION, projectRoot: ctx.projectRoot, provider: ctx.provider.id, phase, mutates, target: ctx.provider.target(input.config), response: response ?? null, outcome: unknown ? 'unknown' : 'settled' };
  await writeFile(reportFile, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  if (unknown || response.success !== true || !response.result) fail(unknown ? 'LAYOUT_OUTCOME_UNKNOWN' : 'LAYOUT_NATIVE_FAILED', response?.error?.message ?? 'Native layout request did not return a settled result.');
  return { result: { ...response.result, provider: ctx.provider.id }, reportFile };
}
export async function inspectLayout(options) {
  const ctx = await context(options); ctx.provider.target(options.config);
  const { result } = await invoke(ctx, 'inspect', { config: options.config });
  if (result.status !== 'inspected') fail('LAYOUT_INSPECTION_FAILED');
  return result;
}
export async function verifyLayout(options) {
  const ctx = await context(options); ctx.provider.target(options.config);
  const { result } = await invoke(ctx, 'verify', { config: options.config, plan: options.plan, snapshot: options.snapshot, expectedSourceHash: options.expectedSourceHash }, options.phaseName ?? 'verify');
  if (result.status === 'verified' && options.validateReadback) await options.validateReadback(result);
  return result;
}
async function markerPaths(ctx, receipt) {
  const dir = join(ctx.projectRoot, 'evidence', 'pcb-layout-execution', 'save-attempts'); await mkdir(dir, { recursive: true });
  if (!within(ctx.projectRoot, await realpath(dir))) fail('REPORT_OUTSIDE_PROJECT');
  const key = digest(receipt);
  return { pending: join(dir, key + '.pending.json'), completed: join(dir, key + '.saved.json') };
}
async function exists(file) { try { await readFile(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function readReceipt(ctx, options) {
  if (!options.resumeSave) fail('RESUME_REPORT_REQUIRED');
  const file = await realpath(resolve(ctx.projectRoot, options.resumeSave));
  if (!within(ctx.projectRoot, file)) fail('REPORT_OUTSIDE_PROJECT');
  let record = await json(file);
  if (record.kind === 'flitrealize.pcb-layout.execution') {
    if (unsettled(record.status) || record.steps?.some(s => s.mutates && unsettled(s.status))) fail('SAVE_RECOVERY_UNRESOLVED');
    if (record.saved === true) fail('LAYOUT_ALREADY_SAVED');
    if (!record.resumeSaveReport) fail('SUCCESSFUL_APPLY_REQUIRED');
    const receiptFile = await realpath(resolve(record.resumeSaveReport));
    if (!within(ctx.projectRoot, receiptFile)) fail('REPORT_OUTSIDE_PROJECT');
    record = await json(receiptFile);
  }
  if (record.kind !== 'flitrealize.pcb-layout.apply-receipt' || record.schemaVersion !== 1 || record.executionVersion !== LAYOUT_EXECUTION_VERSION || record.status !== 'applied' || record.saved !== false || !record.applicationId || !record.workflowFile || !sourceFingerprint(record.expectedSourceHash)) fail('SUCCESSFUL_APPLY_REQUIRED');
  if (record.provider !== ctx.provider.id) fail('LAYOUT_PROVIDER_MISMATCH');
  if (await realpath(record.projectRoot) !== ctx.projectRoot) fail('REPORT_OUTSIDE_PROJECT');
  const originalPath = await realpath(record.workflowFile);
  if (!within(ctx.projectRoot, originalPath)) fail('REPORT_OUTSIDE_PROJECT');
  const original = await json(originalPath);
  if (original.applicationId !== record.applicationId || original.receiptHash !== digest(record)) fail('APPLY_RECEIPT_MISMATCH');
  if (unsettled(original.status) || original.steps?.some(s => s.mutates && unsettled(s.status))) fail('SAVE_RECOVERY_UNRESOLVED');
  if (original.saved === true) fail('LAYOUT_ALREADY_SAVED');
  if (options.config && digest(ctx.provider.target(options.config)) !== digest(ctx.provider.target(record.config))) fail('TARGET_MISMATCH');
  return record;
}
async function workflow(options, resume) {
  const ctx = await context(options), resumed = resume ? await readReceipt(ctx, options) : null;
  const config = resumed?.config ?? options.config, plan = resumed?.plan ?? options.plan, snapshot = resumed?.snapshot ?? options.snapshot;
  const reportFile = join(ctx.reportDir, 'layout-execution-result.json');
  const summary = { schemaVersion: 1, kind: 'flitrealize.pcb-layout.execution', executionVersion: LAYOUT_EXECUTION_VERSION, projectRoot: ctx.projectRoot, provider: ctx.provider.id, target: ctx.provider.target(config), applicationId: resumed?.applicationId ?? randomUUID(), status: 'started', saved: resumed ? false : null, applyState: resumed ? 'applied' : 'not-started', saveState: 'not-started', steps: [], reportFile, reportDir: ctx.reportDir };
  await writeFile(reportFile, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  let receipt = resumed, markers, ownsMarker = false, saveUnknown = false;
  const persist = () => atomic(reportFile, summary);
  async function step(phase, name = phase) {
    const mutates = phase === 'apply' || phase === 'save', item = { phase, name, mutates, status: 'in-flight' };
    summary.steps.push(item); summary.status = name + '-running';
    if (phase === 'apply') summary.applyState = 'in-flight';
    if (phase === 'save') { summary.saveState = 'in-flight'; summary.saved = null; saveUnknown = true; }
    await persist();
    let result;
    try { const reply = await invoke(ctx, phase, { config, plan, snapshot, ...(receipt ? { expectedSourceHash: receipt.expectedSourceHash } : {}) }, name); result = reply.result; item.reportFile = reply.reportFile; item.status = result.status; }
    catch (error) {
      item.status = error.code === 'LAYOUT_OUTCOME_UNKNOWN' ? 'unknown' : 'failed';
      if (phase === 'apply') { summary.applyState = item.status; summary.saved = item.status === 'unknown' ? null : false; }
      if (phase === 'save') summary.saveState = item.status;
      error.workflowStatus = item.status === 'unknown' ? 'outcome-unknown' : name + '-failed'; await persist(); throw error;
    }
    if (phase === 'apply') { summary.applyState = result.status; summary.saved = result.saved ?? null; }
    if (phase === 'save') { saveUnknown = false; summary.saveState = result.status; summary.saved = result.saved === true; }
    await persist();
    const expected = phase === 'apply' ? 'applied' : phase === 'save' ? 'saved' : 'verified';
    if (result.status !== expected || phase === 'save' && result.saved !== true) throw Object.assign(Error(result.error?.message ?? name + ' failed.'), { code: result.error?.code ?? 'LAYOUT_' + name.toUpperCase() + '_FAILED', workflowStatus: name + '-failed' });
    if (phase === 'verify' && options.validateReadback) {
      try { await options.validateReadback(result); }
      catch (error) { item.status = 'constraint-verification-failed'; error.workflowStatus = name + '-failed'; throw error; }
    }
    return result;
  }
  try {
    if (!receipt) {
      const applied = await step('apply');
      receipt = { schemaVersion: 1, kind: 'flitrealize.pcb-layout.apply-receipt', executionVersion: LAYOUT_EXECUTION_VERSION, applicationId: summary.applicationId, projectRoot: ctx.projectRoot, provider: ctx.provider.id, workflowFile: reportFile, status: 'applied', saved: false, config, plan, snapshot, expectedSourceHash: applied.sourceHash ?? applied.after?.sourceHash };
      if (!sourceFingerprint(receipt.expectedSourceHash)) fail('APPLIED_FINGERPRINT_MISSING');
      summary.resumeSaveReport = join(ctx.reportDir, 'layout-apply-receipt.json'); summary.receiptHash = digest(receipt);
      await writeFile(summary.resumeSaveReport, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    } else {
      // Keep the immutable successful apply receipt directly addressable even
      // when another known save failure is resumed through this wrapper.
      summary.resumeSaveReport = join(ctx.reportDir, 'layout-apply-receipt.json'); summary.receiptHash = digest(receipt);
      await writeFile(summary.resumeSaveReport, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    }
    await persist(); markers = await markerPaths(ctx, receipt);
    if (await exists(markers.completed)) fail('LAYOUT_ALREADY_SAVED');
    try { await writeFile(markers.pending, JSON.stringify({ projectRoot: ctx.projectRoot, applicationId: receipt.applicationId, workflowFile: reportFile, receiptHash: digest(receipt) }, null, 2) + '\n', { flag: 'wx' }); ownsMarker = true; }
    catch (error) { if (error.code === 'EEXIST') fail('SAVE_RECOVERY_UNRESOLVED', 'A save attempt is in flight or unknown. Reconcile its report before continuing.'); throw error; }
    summary.saveAttemptFile = markers.pending; await persist();
    await step('verify');
    await step('save');
    await writeFile(markers.completed, JSON.stringify({ applicationId: receipt.applicationId, workflowFile: reportFile, saved: true }, null, 2) + '\n', { flag: 'wx' });
    summary.verification = await step('verify', 'verify-after-save');
    summary.status = 'verified';
  } catch (error) { summary.status = error.workflowStatus ?? 'blocked'; summary.error = { code: error.code ?? 'LAYOUT_EXECUTION_FAILED', message: error.message }; }
  await persist();
  if (ownsMarker && !saveUnknown) await unlink(markers.pending);
  return summary;
}
export const applyLayout = options => workflow(options, false);
export const resumeLayoutSave = options => workflow(options, true);
