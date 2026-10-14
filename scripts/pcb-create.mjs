#!/usr/bin/env node
/** One-page schematic to a new PCB. Existing PCB updates are never replayed. */
import { readFile, writeFile, mkdir, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDirectExecution } from './lib/cli-entrypoint.mjs';
import { buildOperation, execute } from './providers/easyeda-pro/pcb-layout.mjs';
import { auditNativeNetlist } from './pcb-layout/pcb-layout-netlist.mjs';
import { auditFootprintNames } from './pcb-layout/pcb-footprint-audit.mjs';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const fail = (code, message = code) => { throw Object.assign(Error(message), { code }); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside = (root, file) => { const path = relative(root, file); return path !== '..' && !path.startsWith('..\\') && !path.startsWith('../') && !isAbsolute(path); };
async function projectFile(root, file) { const path = await realpath(resolve(root, file)); if (!inside(root, path)) fail('INPUT_OUTSIDE_PROJECT'); return path; }
async function atomic(file, value) { await writeFile(file + '.tmp', JSON.stringify(value, null, 2) + '\n'); await rename(file + '.tmp', file); }
const unsettled = response => !response || response.executionOutcome === 'unknown' || response.result?.uncertainWrite === true || ['unknown', 'running', 'in-flight', 'outcome-unknown'].includes(response.status) || ['unknown', 'running', 'outcome-unknown'].includes(response.result?.status);
const help = 'node scripts/pcb-create.mjs --project-root PROJECT --input-file INPUT --window-id WINDOW [--apply]\nnode scripts/pcb-create.mjs --project-root PROJECT --resume RUN_DIR --window-id WINDOW [--apply]\nDefault plans a new PCB with a verified same-Board source. A source Board with an existing PCB is blocked. Resume never recreates, reassociates or reimports; --apply may finish a known failed save. Single-page sources only. See docs/providers/easyeda-pro/pcb-create.md.';

async function invokeAction(action, input, context) {
  const args = [join(scriptRoot, 'action-runner.mjs'), 'run', '--action', action, '--input-file', context.inputFile, '--report-file', context.reportFile, '--project-root', context.projectRoot, '--window-id', context.windowId];
  if (context.mutates) args.push('--allow-write');
  let failure;
  try { await promisify(execFile)(process.execPath, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }); }
  catch (error) { failure = error; }
  try { return (await json(context.reportFile)).response; }
  catch { throw failure ?? Error('Action returned no durable report.'); }
}

export function auditCreatedPcb(snapshot, contract) {
  const network = auditNativeNetlist({ snapshot, contract });
  const footprints = auditFootprintNames({ snapshot, contract });
  const ownership = snapshot.padOwnership?.status === 'verified';
  return { status: network.status === 'mismatch' || footprints.status === 'mismatch' ? 'differences' : network.status === 'matched' && footprints.status === 'matched' && ownership ? 'matched' : 'unverified', network, footprints, ownership, scope: 'PCB-membership;footprint-names;pin-pad-map;assigned-net-names;not-copper-connectivity-DRC-or-electrical-validation' };
}

export async function runPcbCreate(options) {
  if (!options.projectRoot || !options.windowId || Boolean(options.inputFile) === Boolean(options.resume)) fail('INPUT_REQUIRED');
  const projectRoot = await realpath(resolve(options.projectRoot));
  const evidenceRoot = join(projectRoot, 'evidence');
  await mkdir(evidenceRoot, { recursive: true });
  if (!inside(projectRoot, await realpath(evidenceRoot))) fail('REPORT_OUTSIDE_PROJECT');
  const activeFile = join(evidenceRoot, '.pcb-create-active.json'), lockFile = join(evidenceRoot, '.pcb-create.lock');
  let record, input, contract, runDir, ownLock = false;
  if (options.resume) {
    runDir = await projectFile(projectRoot, options.resume);
    record = await json(join(runDir, 'result.json'));
    if (record.kind !== 'flitrealize.pcb-create' || record.projectRoot !== projectRoot) fail('RUN_MISMATCH');
    input = await json(join(runDir, 'input.json')); contract = await json(join(runDir, 'contract.json'));
    if (digest(input) !== record.inputHash || digest(contract) !== record.contractHash) fail('FROZEN_INPUT_CHANGED');
    if (record.windowId !== options.windowId && options.apply) fail('ORIGINAL_SESSION_REQUIRED');
  } else {
    const inputFile = await projectFile(projectRoot, options.inputFile);
    input = await json(inputFile);
    const allowed = ['contractFile', 'expectedProjectUuid', 'expectedSchematicUuid', 'expectedSchematicPageUuid'];
    if (!input || Object.keys(input).some(key => !allowed.includes(key)) || !allowed.every(key => typeof input[key] === 'string' && input[key].trim())) fail('INVALID_INPUT', 'Only a Contract and explicit project/schematic/page identities are accepted; no existing PCB target.');
    contract = await json(await projectFile(projectRoot, input.contractFile));
    const auditCode = await readFile(join(scriptRoot, 'actions', 'schematic-contract-audit.js'), 'utf8');
    const audit = await new (Object.getPrototypeOf(async function () {}).constructor)('flitrealizeInput', 'flitrealizeContext', auditCode)({ contract }, {});
    if (!['passed', 'conditional'].includes(audit.status)) fail('CONTRACT_BLOCKED', 'Contract structural blockers must be resolved first.');
    if (!contract.components.some(component => component.includeInPcb) || contract.components.some(component => component.includeInPcb && (component.identity.selection === 'unresolved' || component.footprint.selection === 'unresolved'))) fail('PCB_SCOPE_UNRESOLVED');
    if (options.apply) {
      try { const active = await json(activeFile); fail('EXISTING_CREATION_RUN', 'Use --resume ' + active.runDir + '; do not create another PCB.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    runDir = join(evidenceRoot, 'pcb-create-' + randomUUID()); await mkdir(runDir);
    record = { kind: 'flitrealize.pcb-create', schemaVersion: 1, projectRoot, windowId: options.windowId, runDir, inputHash: digest(input), contractHash: digest(contract), status: 'started', ok: false, createdPcbUuid: null, saved: null, saveAttempted: false, steps: [], capturedAt: new Date().toISOString() };
    await writeFile(join(runDir, 'input.json'), JSON.stringify(input, null, 2), { flag: 'wx' });
    await writeFile(join(runDir, 'contract.json'), JSON.stringify(contract, null, 2), { flag: 'wx' });
  }
  const resultFile = join(runDir, 'result.json');
  const persist = () => atomic(resultFile, record);
  async function boardContext() {
    if (!record.boardPlanHash || !record.boardAssociationHash) fail('BOARD_ASSOCIATION_REQUIRED', 'The created PCB has no confirmed frozen Board association. Retain it and reconcile the original operation; do not recreate, associate or import automatically.');
    let expectedBoardPlan, expectedBoardAssociation;
    try { expectedBoardPlan = await json(join(runDir, 'board-plan.json')); expectedBoardAssociation = await json(join(runDir, 'board-association.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; fail('BOARD_ASSOCIATION_REQUIRED', 'Frozen Board evidence is missing. Reconcile the original creation without replaying it.'); }
    if (digest(expectedBoardPlan) !== record.boardPlanHash || digest(expectedBoardAssociation) !== record.boardAssociationHash) fail('FROZEN_BOARD_PLAN_CHANGED');
    return { expectedBoardPlan, expectedBoardAssociation };
  }
  async function step(name, payload, mutates = false, action = null) {
    const prefix = String(record.steps.length + 1).padStart(3, '0') + '-' + name;
    const context = { projectRoot, windowId: options.windowId, mutates, inputFile: join(runDir, prefix + '-input.json'), reportFile: join(runDir, prefix + '-report.json'), codeFile: join(runDir, prefix + '.js') };
    if (mutates && !options.apply) fail('APPLY_REQUIRED');
    const entry = { name, action, mutates, state: 'in-flight', reportFile: context.reportFile };
    if (name === 'create-import' && mutates) { record.creationAttempted = null; record.creation = 'unconfirmed'; }
    await writeFile(context.inputFile, JSON.stringify(payload, null, 2), { flag: 'wx' }); record.steps.push(entry); await persist();
    entry.inputBytes = Buffer.byteLength(JSON.stringify(payload));
    const start = performance.now(); let response;
    try {
      if (action) response = await (options.invokeAction ?? invokeAction)(action, payload, context);
      else {
        const operation = await buildOperation(name === 'snapshot' ? 'inspect' : name, payload);
        await writeFile(context.codeFile, operation.code, { flag: 'wx' });
        response = await (options.transport ?? execute)({ ...context, code: operation.code, phase: name, input: payload });
      }
    } catch (error) { response = { success: false, executionOutcome: 'unknown', error: { code: error.code ?? 'TRANSPORT_ERROR', message: error.message }, ...(error.request ? { request: error.request } : {}) }; }
    entry.milliseconds = performance.now() - start; entry.state = unsettled(response) ? 'unknown' : 'settled';
    // The Action runner may already have written this report.
    try { await writeFile(context.reportFile, JSON.stringify({ response }, null, 2), { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const result = response?.result;
    if (result?.createdPcbUuid) { record.createdPcbUuid = result.createdPcbUuid; record.creation = 'confirmed'; }
    if (typeof result?.creationAttempted === 'boolean') record.creationAttempted = record.creationAttempted === true || result.creationAttempted;
    if (result?.creation) record.creation = result.creation;
    if (result?.returnedPcbUuid) record.rejectedPcbUuid = result.returnedPcbUuid;
    if (typeof result?.associationAttempted === 'boolean' && name === 'create-import') record.associationAttempted = result.associationAttempted;
    if (result?.createdBoardName) record.createdBoardName = result.createdBoardName;
    if (result?.pendingWrite) record.pendingWrite = result.pendingWrite;
    if (result?.boardAssociation && name === 'create-import') {
      record.boardAssociation = result.boardAssociation;
      record.boardAssociationHash = digest(result.boardAssociation);
      await writeFile(join(runDir, 'board-association.json'), JSON.stringify(result.boardAssociation, null, 2), { flag: 'wx' });
    }
    if (typeof result?.saved === 'boolean') record.saved = result.saved;
    if (mutates && entry.state === 'unknown') record.status = 'outcome-unknown';
    await persist();
    if (entry.state === 'unknown' || response?.success !== true || !result) fail('NATIVE_OUTCOME_UNCONFIRMED', 'See ' + context.reportFile);
    return result;
  }
  // Every invocation writes its local report, so even read-only resumptions
  // must not race another writer of the same run.
  await writeFile(lockFile, JSON.stringify({ runDir }), { flag: 'wx' }); ownLock = true;
  try {
    for (const entry of record.steps.filter(entry => entry.state !== 'settled')) {
      let response;
      try { response = (await json(entry.reportFile)).response; } catch (error) { if (entry.mutates) record.status = 'outcome-unknown'; throw error; }
      if (unsettled(response) || response?.success !== true || !response.result || (entry.mutates && !['applied', 'saved', 'save-failed', 'save-blocked', 'apply-failed'].includes(response.result.status))) { if (entry.mutates) record.status = 'outcome-unknown'; fail('UNRESOLVED_WRITE', 'Query the original request first; do not replay creation or import.'); }
      entry.state = 'settled';
      if (response.result.createdPcbUuid) record.createdPcbUuid = response.result.createdPcbUuid;
      if (typeof response.result.saved === 'boolean') record.saved = response.result.saved;
      if (entry.name === 'create-import') {
        record.imported = response.result.imported === true;
        if (response.result.boardAssociation && !record.boardAssociation) {
          record.boardAssociation = response.result.boardAssociation; record.boardAssociationHash = digest(record.boardAssociation);
          await writeFile(join(runDir, 'board-association.json'), JSON.stringify(record.boardAssociation, null, 2), { flag: 'wx' });
        }
        if (response.result.createdBoardName) record.createdBoardName = response.result.createdBoardName;
      }
    }
    delete record.error;
    record.status = 'started';
    if (!record.createdPcbUuid) {
      if (options.resume && record.steps.some(entry => entry.name === 'create-import')) fail('CREATION_NOT_REPLAYABLE');
      const target = { expectedProjectUuid: input.expectedProjectUuid, expectedSchematicUuid: input.expectedSchematicUuid, expectedSchematicPageUuid: input.expectedSchematicPageUuid };
      let expectedSource, expectedBoardPlan;
      try { expectedSource = await readFile(join(runDir, 'source.esch'), 'utf8'); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const plan = await step('source-plan', { ...target, mode: 'inspect' }, false, 'pcb-create');
        if (plan.status !== 'inspected') fail(plan.error?.code ?? 'SOURCE_NOT_READY', plan.error?.message);
        expectedSource = plan.expectedSource;
        await writeFile(join(runDir, 'source.esch'), expectedSource, { flag: 'wx' });
        record.sourceHash = digest(expectedSource);
        if (!plan.boardPlan) fail('BOARD_PLAN_REQUIRED');
        await writeFile(join(runDir, 'board-plan.json'), JSON.stringify(plan.boardPlan, null, 2), { flag: 'wx' });
        record.boardPlanHash = digest(plan.boardPlan); record.boardMode = plan.boardPlan.mode;
      }
      if (digest(expectedSource) !== record.sourceHash) fail('FROZEN_SOURCE_CHANGED');
      try { expectedBoardPlan = await json(join(runDir, 'board-plan.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; fail('BOARD_PLAN_REQUIRED', 'This old plan has no Board preflight. Replan only if no creation was attempted; an existing unknown run must remain occupied.'); }
      if (digest(expectedBoardPlan) !== record.boardPlanHash) fail('FROZEN_BOARD_PLAN_CHANGED');
      if (!options.apply) { record.status = 'planned'; record.ok = true; await persist(); return record; }
      try { await writeFile(activeFile, JSON.stringify({ runDir, target }), { flag: 'wx' }); }
      catch (error) { if (error.code === 'EEXIST') fail('EXISTING_CREATION_RUN'); throw error; }
      const created = await step('create-import', { ...target, mode: 'apply', expectedSource, expectedBoardPlan }, true, 'pcb-create');
      record.imported = created.imported === true;
      record.nativeStages = created.stages;
      if (created.status !== 'applied') fail(created.error?.code ?? 'PCB_CREATE_FAILED', created.error?.message);
    } else {
      const { expectedBoardPlan, expectedBoardAssociation } = await boardContext();
      const selected = await step('select-created', { ...input, contractFile: undefined, mode: 'verify', createdPcbUuid: record.createdPcbUuid, expectedBoardPlan, expectedBoardAssociation }, false, 'pcb-create');
      if (selected.status !== 'verified') fail(selected.error?.code ?? 'CREATED_TARGET_UNCONFIRMED', selected.error?.message);
      if (record.imported !== true) fail('IMPORT_NOT_REPLAYABLE', 'Created PCB is retained; inspect the failed import, do not rerun it.');
    }
    const config = { expectedProjectUuid: input.expectedProjectUuid, expectedDocumentUuid: record.createdPcbUuid, includeFunctionalLabels: false };
    const snapshotFile = join(runDir, 'snapshot.json'); let snapshot;
    try { snapshot = await json(snapshotFile); }
    catch (error) { if (error.code !== 'ENOENT') throw error; snapshot = await step('snapshot', { config }); await writeFile(snapshotFile, JSON.stringify(snapshot, null, 2), { flag: 'wx' }); record.snapshotHash = digest(snapshot); }
    if (snapshot.status !== 'inspected' || digest(snapshot) !== record.snapshotHash) fail('FROZEN_SNAPSHOT_CHANGED');
    if (snapshot.document?.uuid !== record.createdPcbUuid || snapshot.document?.parentProjectUuid !== input.expectedProjectUuid) fail('SNAPSHOT_TARGET_MISMATCH');
    record.checks = auditCreatedPcb(snapshot, contract);
    await writeFile(join(runDir, 'audit.json'), JSON.stringify(record.checks, null, 2));
    if (record.saved === true || options.resume) {
      const source = await step('source', { config });
      if (source.status !== 'source-checked' || source.sourceHash !== snapshot.sourceHash) fail('SOURCE_CHANGED_RECONCILE');
    }
    if (record.saved !== true && options.apply) {
      const { expectedBoardPlan, expectedBoardAssociation } = await boardContext();
      const selected = await step('verify-before-save', { ...input, contractFile: undefined, mode: 'verify', createdPcbUuid: record.createdPcbUuid, expectedBoardPlan, expectedBoardAssociation }, false, 'pcb-create');
      if (selected.status !== 'verified') fail(selected.error?.code ?? 'CREATED_TARGET_UNCONFIRMED', selected.error?.message);
      record.saveAttempted = true; await persist();
      const saved = await step('save', { config, expectedSourceHash: snapshot.sourceHash }, true);
      if (saved.status !== 'saved' || saved.saved !== true) fail(saved.error?.code ?? 'SAVE_NOT_CONFIRMED');
      const after = await step('source', { config });
      if (after.status !== 'source-checked' || after.sourceHash !== snapshot.sourceHash) fail('SAVE_CHANGED_SOURCE');
    }
    record.status = record.checks.status === 'differences' ? 'created-differences' : record.saved !== true || record.checks.status !== 'matched' ? 'created-unverified' : 'created-saved';
    record.ok = record.status === 'created-saved';
  } catch (error) {
    if (record.status !== 'outcome-unknown') record.status = 'blocked';
    record.ok = false; record.error = { code: error.code ?? 'PCB_CREATE_ERROR', message: error.message };
  } finally { if (ownLock) await unlink(lockFile); await persist(); }
  return record;
}

export function summarizePcbCreate(record) {
  const unknownCreation = !record.createdPcbUuid && record.steps.some(step => step.name === 'create-import' && step.state !== 'settled');
  return { status: record.status, ok: record.ok, runDir: record.runDir, createdPcbUuid: record.createdPcbUuid, creationAttempted: unknownCreation && record.creationAttempted !== true ? null : record.creationAttempted ?? false, creation: unknownCreation ? 'unconfirmed' : record.creation ?? (record.createdPcbUuid ? 'confirmed' : 'not-attempted'), rejectedPcbUuid: record.rejectedPcbUuid ?? null, boardMode: record.boardMode ?? null, createdBoardName: record.createdBoardName ?? null, boardAssociation: record.boardAssociation ?? null, imported: record.imported ?? null, saved: record.saved, saveAttempted: record.saveAttempted, checks: record.checks ? { status: record.checks.status, network: record.checks.network.status, footprints: record.checks.footprints.status, counts: record.checks.network.counts, scope: record.checks.scope } : null, nativeStages: record.nativeStages ?? [], error: record.error ?? null, calls: record.steps.map(step => ({ name: step.name, state: step.state, milliseconds: step.milliseconds, inputBytes: step.inputBytes })) };
}
if (isDirectExecution(import.meta.url)) {
  try {
    const options = {}, args = process.argv.slice(2);
    if (args.includes('--help')) { console.log(help); process.exit(0); }
    for (let index = 0; index < args.length; index++) {
      const argument = args[index];
      if (argument === '--apply') { options.apply = true; continue; }
      const key = { '--project-root': 'projectRoot', '--input-file': 'inputFile', '--resume': 'resume', '--window-id': 'windowId' }[argument];
      if (!key || !args[index + 1]) fail('INVALID_ARGUMENT', argument);
      options[key] = args[++index];
    }
    const result = await runPcbCreate(options); console.log(JSON.stringify(summarizePcbCreate(result))); if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ ok: false, error: { code: error.code, message: error.message } })); process.exitCode = 1; }
}
