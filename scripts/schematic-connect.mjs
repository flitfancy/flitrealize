#!/usr/bin/env node
/** Connect a declared endpoint-stub schematic, verify it, optionally reflow, save and run strict DRC. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution } from './lib/cli-entrypoint.mjs';
import { planConnections } from './lib/schematic-connect-plan.mjs';
import { stable, sourceChanges, sourceRecords, assertPreserved, connectionDependencies, connectionSourceIssues } from './lib/schematic-local-state.mjs';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const chunks = (items, size = 30) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel); };
async function projectInputFile(root, value) {
  const file = await realpath(resolve(root, value));
  if (!inside(root, file)) fail('INPUT_OUTSIDE_PROJECT', 'Project path mode requires input and Contract files inside the project: ' + value);
  return file;
}
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
  const pathBase = options.pathBase ?? 'legacy';
  if (!['project', 'legacy'].includes(pathBase)) fail('INVALID_PATH_BASE', '--path-base must be project or legacy.');
  const projectRoot = await realpath(resolve(options.projectRoot));
  const inputFile = pathBase === 'project' ? await projectInputFile(projectRoot, options.inputFile) : resolve(options.inputFile);
  const input = await json(inputFile);
  let contractFile = null;
  if (input.contractFile) {
    if (input.contract) fail('DUPLICATE_CONTRACT_INPUT', 'Choose contractFile or embedded contract.');
    contractFile = pathBase === 'project' ? await projectInputFile(projectRoot, input.contractFile) : resolve(dirname(inputFile), input.contractFile);
    input.contract = await json(contractFile);
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
    inputPaths: { pathBase, inputFile, contractFile },
    status: 'started', ok: false, readOnly: true, saved: null, checks: {}, steps: [], preservedChanges: [] };
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
    if (typeof result?.saved === 'boolean' || result?.uncertainWrite === true && result.saved === null) summary.saved = result.saved;
    if (result?.drc) summary.checks.drc = result.drc;
    await persist();
    if (uncertain || response?.success !== true || !statuses.includes(result?.status)) {
      fail(uncertain ? 'OUTCOME_UNKNOWN' : result?.error?.code || result?.issues?.[0]?.code || 'ACTION_FAILED', `${name}: ${result?.error?.message || response?.error?.message || item.status}. See ${item.reportFile}`);
    }
    return result;
  }
  async function inspect(name, includeSource = false) {
    const result = await step('schematic-inspect', name, { mode: 'inspect', ...target, includeConnectionEvidence: true, includeSource }, ['inspected', 'inspected-with-gaps']);
    const snapshot = result.snapshot;
    if (snapshot?.document?.nativeId !== target.expectedDocumentUuid || snapshot?.project?.nativeId !== target.expectedProjectUuid) fail('DOCUMENT_MISMATCH', 'Readback belongs to another schematic/project.');
    if (includeSource) {
      if (typeof result.backupSource !== 'string' || !result.backupSource.trim()) fail('BACKUP_UNAVAILABLE', 'Source backup is unavailable.');
      await writeFile(join(runDir, name === 'initial-inspect' ? 'before.esch' : name + '.esch'), result.backupSource, { flag: 'wx' });
    }
    let localEvidence;
    if (includeSource) {
      const native = await step('schematic-component-place', name + '-occupancy', { mode: 'inspect', includeLocalEvidence: true }, ['inspected']);
      localEvidence = native.state?.localEvidence;
      if (native.state?.document?.uuid !== target.expectedDocumentUuid || native.state?.document?.parentProjectUuid !== target.expectedProjectUuid) fail('DOCUMENT_MISMATCH', 'Occupancy read belongs to another target.');
      if (stable(sourceRecords(localEvidence?.source)) !== stable(sourceRecords(result.backupSource))) fail('EXECUTION_SOURCE_CHANGED', 'Source changed during native occupancy inspection.');
    }
    return { ...snapshot, executionSource: result.backupSource, localEvidence };
  }
  async function assess(snapshot, phase, name) {
    const plan = await planConnections(input, snapshot, { phase });
    await writeFile(join(runDir, name + '.json'), JSON.stringify(plan, null, 2) + '\n');
    summary.checks.connections = { phase, applyReady: plan.applyReady, diagnostics: plan.diagnostics, coverage: plan.scope, pending: plan.pending };
    if (!plan.applyReady) fail('CONNECTIONS_BLOCKED', `Connection ${phase} has unresolved items; see ${name}.json.`);
    return plan;
  }
  async function assertSame(snapshot, global = false) {
    const current = await inspect('pre-write-inspect-' + summary.steps.length, true);
    const refs = new Set(input.designators || input.contract.components.map(component => component.designator));
    const beforeParts = new Map(snapshot.components.map(component => [component.nativeId, component]));
    const afterParts = new Map(current.components.map(component => [component.nativeId, component]));
    for (const component of snapshot.components.filter(component => refs.has(component.designator))) {
      if (stable(component) !== stable(afterParts.get(component.nativeId))) fail('RELATED_SCHEMATIC_CHANGED', 'A target component, property, pin, or network changed after planning.');
    }
    if (current.components.some(component => refs.has(component.designator) && !beforeParts.has(component.nativeId))) fail('RELATED_SCHEMATIC_CHANGED', 'A target designator is duplicated or replaced.');
    const relevantNets = nets => nets.filter(net => (net.endpoints || []).some(endpoint => refs.has(endpoint.component)));
    if (stable(relevantNets(snapshot.nets)) !== stable(relevantNets(current.nets))) fail('RELATED_SCHEMATIC_CHANGED', 'Target pin/network membership changed after planning.');
    const changes = sourceChanges(snapshot.executionSource, current.executionSource);
    const changedParts = current.components.filter(component => stable(component) !== stable(beforeParts.get(component.nativeId)));
    if (!changes.length && !changedParts.length && current.fingerprints.document === snapshot.fingerprints.document) return current;
    if (global) fail('STALE_SCHEMATIC', 'Whole-source reflow still requires an unchanged document.');
    const withoutGeometry = component => {
      const copy = { ...component }; for (const key of ['includeInBom', 'includeInPcb', 'position', 'rotation', 'mirror']) delete copy[key];
      copy.pins = (copy.pins || []).map(pin => { const value = { ...pin }; delete value.position; return value; });
      return copy;
    };
    const safePart = component => !refs.has(component.designator) && beforeParts.has(component.nativeId)
      && stable(withoutGeometry(component)) === stable(withoutGeometry(beforeParts.get(component.nativeId)));
    if (current.components.length !== snapshot.components.length || changedParts.some(component => !safePart(component)) || (!changes.length && changedParts.length)) {
      fail('LOCAL_CHANGE_UNPROVEN', 'Component changes are not covered by the native source difference.');
    }
    const dependencies = connectionDependencies(input, snapshot);
    const localIssues = connectionSourceIssues(snapshot.executionSource, current.executionSource, dependencies, current.localEvidence?.occupancy);
    if (localIssues.length) fail(localIssues[0].code, 'Source difference affects a dependency or lacks native bounds: ' + JSON.stringify(localIssues));
    summary.preservedChanges.push({ checkedAt: new Date().toISOString(), beforeFingerprint: snapshot.fingerprints.document,
      currentFingerprint: current.fingerprints.document, components: changedParts.map(component => ({ before: beforeParts.get(component.nativeId), current: component })), sourceRecords: changes });
    await persist();
    return current;
  }
  function assertNcDelta(before, after, items) {
    const pinPositions = new Map(before.components.flatMap(component => component.pins.map(pin => [pin.nativeId, { x: pin.position?.x, y: -pin.position?.y }])));
    const pinIds = new Map(items.flatMap(item => before.components.filter(component => component.designator === item.designator)
      .flatMap(component => component.pins.filter(pin => String(pin.number) === String(item.pin)).map(pin => [pin.nativeId, item.noConnected !== false]))));
    for (const change of sourceChanges(before.executionSource, after.executionSource)) {
      const trim = record => { const payload = { ...record.payload }; delete payload.noConnected; return { ...record, payload }; };
      const record = change.current;
      if (record?.head.type === 'ATTR' && record.payload.key === 'NO_CONNECT' && pinIds.has(record.payload.parentId)
        && record.payload.value === (pinIds.get(record.payload.parentId) ? 'yes' : 'no')) {
        const pinRecord = sourceRecords(before.executionSource).find(item => item.head.id === record.payload.parentId);
        const position = pinRecord?.payload || pinPositions.get(record.payload.parentId);
        if (position && record.payload.x === position.x && record.payload.y === position.y
          && (!change.before || stable({ ...change.before, payload: { ...change.before.payload, value: record.payload.value } }) === stable(record))) continue;
      }
      if (!change.before || !change.current || !pinIds.has(change.id) || change.current.head.type !== 'PIN'
        || change.current.payload.noConnected !== pinIds.get(change.id) || stable(trim(change.before)) !== stable(trim(change.current))) {
        fail('NC_SOURCE_DELTA_UNPROVEN', 'NC source changed beyond the declared pin Boolean; reconcile the recorded readback.');
      }
    }
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
    const baselineDrc = await step('schematic-save-verify', 'drc-baseline', { mode: 'inspect', ...target, strict: true, runDrc: true }, ['inspected']);
    // Plan each bounded batch against the immediate live state. Never replay an uncertain write.
    let wireBatchPlan = plan;
    for (let i = 0; wireBatchPlan.wirePlan.wires.length; i += 1) {
      snapshot = await assertSame(snapshot);
      const wires = wireBatchPlan.wirePlan.wires.slice(0, 30);
      const wirePlan = { ...wireBatchPlan.wirePlan, wires, executionSource: snapshot.executionSource };
      const beforeWire = snapshot;
      let created = [];
      const planned = await step('schematic-wire-create', `wire-${i}-plan`, { mode: 'plan', plan: wirePlan }, ['planned', 'planned-noop']);
      if (planned.status === 'planned') {
        const applied = await step('schematic-wire-create', `wire-${i}-apply`, planned.applyRequest, ['applied']);
        created = applied.created;
        await step('schematic-wire-create', `wire-${i}-verify`, { mode: 'verify', request: { ...target, created: applied.created } }, ['verified']);
      }
      snapshot = await inspect(`wire-${i}-readback`, true);
      assertPreserved(beforeWire.executionSource, snapshot.executionSource, created.map(item => item.primitiveId));
      const refreshed = await assess(snapshot, 'plan', `wire-${i}-remaining`);
      if (refreshed.wirePlan.wires.length >= wireBatchPlan.wirePlan.wires.length) fail('WIRE_NO_PROGRESS', 'Wire batch did not reduce missing endpoints.');
      wireBatchPlan = refreshed;
    }
    const afterWires = await assess(snapshot, 'plan', 'after-wires-plan');
    for (const [i, items] of chunks(afterWires.missingFlagItems).entries()) {
      snapshot = await assertSame(snapshot);
      const beforeMarker = snapshot;
      const planned = await step('schematic-net-flag', `marker-${i}-plan`, { mode: 'plan', ...target, items, executionSource: snapshot.executionSource }, ['planned']);
      const applied = await step('schematic-net-flag', `marker-${i}-apply`, planned.applyRequest, ['applied']);
      await step('schematic-net-flag', `marker-${i}-verify`, { mode: 'verify', request: { ...target, created: applied.created } }, ['verified']);
      snapshot = await inspect(`marker-${i}-readback`, true);
      assertPreserved(beforeMarker.executionSource, snapshot.executionSource, applied.created.map(item => item.primitiveId));
    }
    // NC assessment is mandatory, including a recorded empty result. Only Contract/explicit provider pins qualify.
    summary.checks.noConnect = { status: 'pending', declaredCount: afterWires.noConnectItems.length };
    for (const [i, items] of chunks(afterWires.pendingNoConnectItems).entries()) {
      snapshot = await assertSame(snapshot);
      const beforeNc = snapshot;
      const planned = await step('schematic-no-connect', `nc-${i}-plan`, { mode: 'plan', ...target, items, executionSource: snapshot.executionSource }, ['planned']);
      await step('schematic-no-connect', `nc-${i}-apply`, planned.applyRequest, ['applied']);
      await step('schematic-no-connect', `nc-${i}-verify`, { mode: 'verify', ...target, items }, ['verified']);
      snapshot = await inspect(`nc-${i}-readback`, true);
      assertNcDelta(beforeNc, snapshot, items);
    }
    summary.checks.noConnect.status = afterWires.noConnectItems.length ? 'verified' : 'not-applicable';
    await assess(snapshot, 'verify', 'connected-audit');
    if (reflowInput) {
      snapshot = await assertSame(snapshot, true);
      const planned = await step('schematic-reflow', 'reflow-plan', { ...reflowInput, mode: 'plan' }, ['planned']);
      await writeFile(join(runDir, 'before-reflow.esch'), planned.backupSource, { flag: 'wx' });
      await step('schematic-reflow', 'reflow-apply', planned.applyRequest, ['applied']);
      await step('schematic-reflow', 'reflow-verify', { ...reflowInput, mode: 'verify' }, ['verified']);
      summary.checks.reflow = { status: 'verified' };
      snapshot = await inspect('reflow-readback', true);
      await assess(snapshot, 'verify', 'reflow-audit');
    }
    snapshot = await assertSame(snapshot);
    const savePlan = await step('schematic-save-verify', 'save-plan', { mode: 'plan', ...target, strict: true, runDrc: true,
      drcBaseline: baselineDrc.drcBaseline, executionSource: snapshot.executionSource }, ['planned']);
    const saved = await step('schematic-save-verify', 'save-apply', savePlan.applyRequest, ['applied']);
    if (saved.saved !== true || !(saved.drc?.passed === true || saved.drc?.comparison?.passed === true)) fail('FINALIZE_FAILED', 'Saving and DRC acceptance must both pass.');
    const final = await inspect('saved-readback', true);
    assertPreserved(snapshot.executionSource, final.executionSource);
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

if (isDirectExecution(import.meta.url)) {
  const options = {};
  try {
    for (let i = 2; i < process.argv.length; i += 1) {
      const arg = process.argv[i];
      if (arg === '--help') {
        console.log('node scripts/schematic-connect.mjs --project-root PROJECT --input-file INPUT [--path-base project|legacy] [--window-id WINDOW] [--apply | --check]\nPaths: project resolves input and Contract from PROJECT; legacy (default) keeps cwd-relative input and input-directory-relative Contract.\nDefault: plan only. --apply connects, audits, optionally reflows, saves and runs strict DRC. --check verifies without writes. See docs/providers/easyeda-pro/2.1-r-schematic-connect.md.');
        process.exit(0);
      }
      if (arg === '--apply' || arg === '--check') { options[arg.slice(2)] = true; continue; }
      const key = { '--project-root': 'projectRoot', '--input-file': 'inputFile', '--path-base': 'pathBase', '--window-id': 'windowId' }[arg];
      if (!key || !process.argv[i + 1]) fail('INVALID_ARGUMENT', `Unknown or incomplete argument ${arg}`);
      options[key] = process.argv[++i];
    }
    const result = await runSchematicConnect(options);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ ok: false, code: error.code, error: error.message })); process.exitCode = 1; }
}
