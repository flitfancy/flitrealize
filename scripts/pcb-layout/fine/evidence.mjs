import fs from 'node:fs/promises';
import path from 'node:path';
import { studyOutputDirectory } from '../../lib/pcb-study.mjs';
import { readLayoutApplyReceipt } from '../pcb-layout-execution.mjs';
import { digest, fail } from './common.mjs';

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
export async function fineApplicationEvidence({ reference, inputs, request, candidate, result, routingReceipt, required, options, config }) {
  const root = await fs.realpath(options.projectRoot), selected = await projectJson(root, reference);
  let nativeReference = selected.file;
  if (selected.value.kind === 'flitrealize.fine-layout.application') {
    if (selected.value.candidateHash !== candidate.candidateHash || digest(selected.value.source) !== digest(result.source)) fail('FINE_APPLICATION_RECEIPT_MISMATCH');
    nativeReference = selected.value.execution?.reportFile ?? selected.value.execution?.resumeSaveReport ?? fail('FINE_RESUME_RECEIPT_REQUIRED');
  }
  const bound = await readLayoutApplyReceipt({ ...options, config, snapshot: inputs.snapshot, resumeSave: nativeReference }, { readOnly: true });
  if (selected.value.kind === 'flitrealize.fine-layout.application' && selected.value.execution?.applicationId !== bound.receipt.applicationId) fail('FINE_APPLICATION_RECEIPT_MISMATCH');
  const receipt = bound.receipt;
  if (digest(receipt.plan) !== digest(candidate.plan) || digest(receipt.snapshot) !== digest(inputs.snapshot) || digest(receipt.config) !== digest(config)) fail('FINE_RESUME_CANDIDATE_MISMATCH');
  const evidence = receipt.acceptanceEvidence;
  let route = routingReceipt, routingReference = null;
  if (evidence) {
    const expected = binding({ inputs, request, candidate, result }, required);
    for (const key of ['schemaVersion', 'kind', 'inputsHash', 'requestHash', 'candidateHash', 'candidateFileHash', 'engineHash']) if (evidence[key] !== expected[key]) fail('FINE_APPLICATION_EVIDENCE_CHANGED');
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
