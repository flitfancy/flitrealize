import fs from 'node:fs/promises';
import path from 'node:path';
import { studyOutputDirectory } from '../../lib/pcb-study.mjs';
import { readLayoutApplyReceipt, layoutOutcomeUnsettled } from '../pcb-layout-execution.mjs';
import { digest, fail } from './common.mjs';
import { readJson } from '../pcb-layout-project.mjs';

async function evidenceFiles(root,name) {
  const found=[];
  async function visit(dir){try{const actual=await fs.realpath(dir),relative=path.relative(root,actual);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))fail('FINE_RECEIPT_OUTSIDE_PROJECT');}catch(e){if(e.code==='ENOENT')return;throw e;}let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
    for(const e of entries){const file=path.join(dir,e.name);if(e.isDirectory())await visit(file);else if(e.isFile()&&e.name===name)found.push(file);}
  }
  await visit(path.join(root,'evidence'));return found;
}

// A damaged summary may belong to another document. Use its existing execution
// input to establish that fact; a directory name or an absent input proves nothing.
async function unrelatedExecution(root, file, target, providerId) {
  let unrelated = false;
  for (const name of ['layout-apply-input.json', 'layout-preflight-input.json', 'layout-verify-input.json']) {
    let value;
    try { value = (await projectJson(root, path.join(path.dirname(file), name))).value; }
    catch (error) { if (error.code === 'ENOENT') continue; if (error instanceof SyntaxError) return false; throw error; }
    const config = value.config, provider = value.snapshot?.layout?.provider ?? value.snapshot?.provider;
    if (!config?.expectedProjectUuid || !config?.expectedDocumentUuid || !provider) return false;
    const different = provider !== providerId || config.expectedProjectUuid !== target.expectedProjectUuid
      || config.expectedDocumentUuid !== target.expectedDocumentUuid;
    if (!different) return false;
    unrelated = true;
  }
  return unrelated;
}

// A settled native preflight rejection is a known zero-write result, not a
// successful apply receipt. Preserve its immutable reports and allow a new
// guarded attempt only when the core summary and native phase report agree.
async function rejectedBeforeMutation(root, workflow) {
  if (workflow.provider !== 'easyeda-pro' || workflow.status !== 'apply-failed'
    || workflow.applyState !== 'blocked' || workflow.saved !== false
    || workflow.saveState !== 'not-started' || workflow.resumeSaveReport) return false;
  const mutations = workflow.steps?.filter(s => s.mutates) ?? [];
  if (mutations.length !== 1 || mutations[0].phase !== 'apply' || mutations[0].status !== 'blocked') return false;
  let record;
  try { record = (await projectJson(root, mutations[0].reportFile)).value; }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  if (record.kind !== 'flitrealize.pcb-layout.native' || record.phase !== 'apply' || record.mutates !== true
    || record.executionVersion !== workflow.executionVersion || record.provider !== workflow.provider
    || digest(record.target) !== digest(workflow.target) || await fs.realpath(record.projectRoot) !== root
    || record.outcome !== 'settled' || record.response?.success !== true) return false;
  const response = record.response, result = response.result;
  if(['cli','bridge'].includes(response.channel)&&(!response.request||!response.executionBinding))return false;
  if (response.request && (response.request.status !== 'succeeded' || digest(response.request.result) !== digest(result))) return false;
  const bound = response.executionBinding;
  if (bound && (bound.requestId !== response.request?.requestId || bound.windowId !== response.request?.windowId
    || bound.codeSha256 !== response.request?.codeSha256 || digest(bound.target) !== digest(workflow.target))) return false;
  return result?.status === 'blocked' && result.saved === false
    && Array.isArray(result.attempted) && result.attempted.length === 0
    && result.error?.code === 'LAYOUT_PREFLIGHT_FAILED';
}

/** Discover existing core evidence only; do not create another state ledger. */
export async function findFineExecution(input,config) {
  const target = config ?? input.inputs.mechanical;
  const root=await fs.realpath(input.options.projectRoot),matches=[];
  for(const file of await evidenceFiles(root,'layout-execution-result.json')) {
    let workflow;
    try { workflow = await readJson(file); }
    catch (error) {
      if (await unrelatedExecution(root, file, target, input.options.providerId)) continue;
      fail('FINE_HISTORY_UNREADABLE', file + ': ' + error.message);
    }
    if(workflow.kind!=='flitrealize.pcb-layout.execution'||workflow.provider!==input.options.providerId
      ||workflow.target?.expectedProjectUuid!==target.expectedProjectUuid||workflow.target?.expectedDocumentUuid!==target.expectedDocumentUuid)continue;
    if(await fs.realpath(workflow.projectRoot)!==root)fail('FINE_APPLICATION_RECEIPT_MISMATCH');
    const unknown=layoutOutcomeUnsettled(workflow.applyState)||layoutOutcomeUnsettled(workflow.saveState)||workflow.steps?.some(s=>s.mutates&&layoutOutcomeUnsettled(s.status));
    if(unknown)fail('FINE_TARGET_OUTCOME_UNKNOWN','Inspect the original request before another write: '+file);
    if(await rejectedBeforeMutation(root,workflow))continue;
    let applied;
    try{applied=await readJson(path.join(path.dirname(file),'layout-apply-input.json'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
    if(digest(applied.plan)===digest(input.candidate.plan)&&digest(applied.snapshot)===digest(input.inputs.snapshot)&&(!config||digest(applied.config)===digest(config)))matches.push({file,workflow});
  }
  const identities=new Set(matches.map(m=>m.workflow.applicationId));
  if(identities.size>1)fail('FINE_APPLICATION_AMBIGUOUS','Select an explicit --receipt or --resume-save; matching workflows: '+matches.map(m=>m.file).join(', '));
  if(!matches.length)return null;
  const {file,workflow}=matches[0];
  if(!workflow.resumeSaveReport)fail('FINE_APPLICATION_REQUIRES_RECONCILIATION','Previous apply did not issue a successful receipt: '+file);
  return file;
}

export async function findFineRouting(input) {
  const matches=[];
  for(const file of await evidenceFiles(await fs.realpath(input.options.projectRoot),'fine-routing-receipt.json')) {
    let value;
    try { value = await readJson(file); }
    catch (error) { fail('FINE_HISTORY_UNREADABLE', file + ': ' + error.message); }
    if(value.candidateHash===input.candidate.candidateHash)matches.push(value);
  }
  if(new Set(matches.map(digest)).size>1)fail('FINE_ROUTING_EVIDENCE_AMBIGUOUS','Select --routing-receipt explicitly.');
  return matches[0];
}

async function projectJson(projectRoot, reference) {
  const root = await fs.realpath(projectRoot), file = await fs.realpath(path.resolve(root, reference));
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('FINE_RECEIPT_OUTSIDE_PROJECT');
  return { file, value: JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')) };
}
function binding({ inputs, request, candidate, result }, required) {
  return { schemaVersion: 1, kind: 'flitrealize.fine-layout.acceptance', inputsHash: digest(inputs), requestHash: digest(request), candidateHash: digest(candidate.plan), candidateFileHash: digest(candidate), engineHash: digest(result.source.engine), routing: { required } };
}

/** Store the already verified route once and bind it to the native apply receipt.
 * This is evidence only; save/unknown/concurrency state belongs to the core. */
export async function recordFineAcceptance(input, required, routingReceipt, options) {
  const evidence = binding(input, required);
  if (!routingReceipt) return evidence;
  if (!options?.projectRoot) fail('FINE_EVIDENCE_PROJECT_REQUIRED');
  const root = await fs.realpath(options.projectRoot);
  const directory = await studyOutputDirectory(root, options.reportDir, { category: 'pcb-fine-layout-application' });
  const file = path.join(directory, 'fine-routing-receipt.json');
  await fs.writeFile(file, JSON.stringify(routingReceipt, null, 2) + '\n', { flag: 'wx' });
  evidence.routing.receipt = { file: path.relative(root, file).replaceAll('\\', '/'), hash: digest(routingReceipt) };
  return evidence;
}

/** Resolve application.json, a native workflow report, or an immutable receipt.
 * The shared core validates receipt/workflow identity and reads save evidence. */
async function readFineCoreEvidence({ reference, inputs, candidate, result, options, config }, { strictConfig = true } = {}) {
  const root = await fs.realpath(options.projectRoot), selected = await projectJson(root, reference);
  let nativeReference = selected.file;
  if (selected.value.kind === 'flitrealize.fine-layout.application') {
    if (selected.value.candidateHash !== candidate.candidateHash || strictConfig && digest(selected.value.source) !== digest(result.source)) fail('FINE_APPLICATION_RECEIPT_MISMATCH');
    nativeReference = selected.value.execution?.reportFile ?? selected.value.execution?.resumeSaveReport ?? fail('FINE_RESUME_RECEIPT_REQUIRED');
  }
  const bound = await readLayoutApplyReceipt({ ...options, config, snapshot: inputs.snapshot, resumeSave: nativeReference }, { readOnly: true });
  if (selected.value.kind === 'flitrealize.fine-layout.application' && selected.value.execution?.applicationId !== bound.receipt.applicationId) fail('FINE_APPLICATION_RECEIPT_MISMATCH');
  const receipt = bound.receipt;
  if (digest(receipt.plan) !== digest(candidate.plan) || digest(receipt.snapshot) !== digest(inputs.snapshot) || strictConfig && digest(receipt.config) !== digest(config)) fail('FINE_RESUME_CANDIDATE_MISMATCH');
  return { ...bound, nativeReference };
}

/** Historical save facts do not grant permission to use an old candidate. */
export async function fineHistoricalState(input) {
  const reference = input.receiptFile ?? input.resumeSave ?? await findFineExecution(input);
  if (!reference) return null;
  const bound = await readFineCoreEvidence({ ...input, reference, config: input.inputs.mechanical }, { strictConfig: false });
  return { native: 'applied', saved: bound.save.saved, verified: false,
    savePending: bound.save.pending, saveUnsettled: bound.save.unsettled,
    nativeWrites: 0, applyReceipt: bound.receiptFile };
}

export async function fineApplicationEvidence({ reference, inputs, request, candidate, result, routingReceipt, required, options, config }) {
  const root = await fs.realpath(options.projectRoot);
  const bound = await readFineCoreEvidence({ reference, inputs, candidate, result, options, config });
  const { receipt, nativeReference } = bound;
  const evidence = receipt.acceptanceEvidence;
  let route = routingReceipt, routingReference = null;
  if (evidence) {
    const expected = binding({ inputs, request, candidate, result }, required);
    for (const key of ['schemaVersion', 'kind', 'inputsHash', 'requestHash', 'candidateHash', 'candidateFileHash', 'engineHash']) if (evidence[key] !== expected[key]) {
      throw Object.assign(Error('FINE_APPLICATION_EVIDENCE_CHANGED: '+key+' in '+bound.receiptFile),{code:'FINE_APPLICATION_EVIDENCE_CHANGED',
        details:{field:key,expected:expected[key],actual:evidence[key],receipt:bound.receiptFile},
        state:{native:'applied',saved:bound.save.saved,verified:false,savePending:bound.save.pending,saveUnsettled:bound.save.unsettled,nativeWrites:0}});
    }
    if (evidence.routing?.required !== required) fail('FINE_APPLICATION_EVIDENCE_CHANGED');
    routingReference = evidence.routing?.receipt ?? null;
    if (routingReference) {
      let stored;
      try { stored = await projectJson(root, routingReference.file); }
      catch(error) { if (['ENOENT','EACCES'].includes(error.code) || error instanceof SyntaxError) fail('FINE_ROUTING_EVIDENCE_UNAVAILABLE', error.message); throw error; }
      if (digest(stored.value) !== routingReference.hash || route && digest(route) !== routingReference.hash) fail('FINE_ROUTING_EVIDENCE_CHANGED');
      route = stored.value;
    } else if (route) fail('FINE_ROUTING_EVIDENCE_CHANGED');
  }
  // Old receipts remain usable with explicit matching evidence. Never rewrite
  // one to add metadata: that would change its shared save-marker identity.
  if (required && !route) fail('FINE_REQUIRED_ROUTING_NOT_VERIFIED');
  return { ...bound, routingReceipt: route, routingReference, nativeReference, compatibility: evidence ? null : 'legacy-explicit-evidence' };
}
