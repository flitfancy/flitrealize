import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { independentLabelGeometry, resolveLabelClearances } from '../../pcb-layout/fine/label-geometry.mjs';
import { classifyFineIssues } from '../../pcb-layout/fine/issue-policy.mjs';
import { sourceRecords } from './source-invariant.mjs';
import { sameAngle } from '../../pcb-layout/pcb-layout-geometry.mjs';
export { layoutRealization, labelAlignment, normalizeCoordinateSystem } from './pcb-layout-input.mjs';

export function validateContext(options) {
  if (typeof options?.windowId !== 'string' || !options.windowId.trim()) throw Object.assign(Error('A confirmed EasyEDA windowId is required.'), { code: 'LAYOUT_CONTEXT_REQUIRED' });
}

export function target(config) {
  if (!config || !['expectedProjectUuid', 'expectedDocumentUuid'].every(k => typeof config[k] === 'string' && config[k].trim())) {
    throw Object.assign(Error('TARGET_REQUIRED'), { code: 'TARGET_REQUIRED' });
  }
  return { expectedProjectUuid: config.expectedProjectUuid, expectedDocumentUuid: config.expectedDocumentUuid };
}

export async function buildOperation(phase, input) {
  if (!['inspect', 'preflight', 'apply', 'verify', 'save', 'source'].includes(phase)) throw Error('UNSUPPORTED_LAYOUT_OPERATION');
  const { assemblyRuntime } = await import('../../pcb-layout/pcb-layout-assembly-policy.mjs');
  const { boardRuntime } = await import('../../pcb-layout/pcb-layout-board.mjs');
  const { decodeBoard } = await import('./pcb-layout-board.mjs');
  const runtime = await readFile(new URL('./pcb-layout-native/runtime.js', import.meta.url), 'utf8');
  const body = await readFile(new URL('./pcb-layout-native/' + phase + '.js', import.meta.url), 'utf8');
  return {
    extension: '.js',
    code: 'const layoutExecutionInput=' + JSON.stringify(input) + ';\nconst sameAngle=(' + sameAngle.toString() + ');\nconst sourceRecords=(' + sourceRecords.toString() + ');\nconst assemblyRuntime=(' + assemblyRuntime.toString() + ');\nconst resolveLabelClearances=(' + resolveLabelClearances.toString() + ');\nconst independentLabelGeometry=(' + independentLabelGeometry.toString() + ');\nconst classifyFineIssues=(' + classifyFineIssues.toString() + ');\nconst {resolveBoardBounds,checkBoardBounds}=(' + boardRuntime.toString() + ')();\nconst decodeBoard=(' + decodeBoard.toString() + ');\n' + runtime + '\n' + body,
  };
}

const runFile = promisify(execFile);
const sha256 = code => createHash('sha256').update(code).digest('hex');
function envelopes(stdout, stderr) {
  const values=[];
  for(const stream of [stdout,stderr])for(const line of String(stream??'').trim().split(/\r?\n/)) {
    try { const value=JSON.parse(line);if(typeof value?.success==='boolean')values.push(value); } catch {}
  }
  if(!values.length||values.some(v=>JSON.stringify(v)!==JSON.stringify(values[0])))return null;
  return values[0];
}

export async function resolveWindow({projectRoot}, {runner=runFile}={}) {
  const host=fileURLToPath(new URL('../../eda-host.mjs',import.meta.url));
  const {stdout}=await runner(process.execPath,[host,'windows','--eda','easyeda-pro'],{windowsHide:true,maxBuffer:32*1024*1024,timeout:60000});
  const windows = JSON.parse(stdout.trim()).eda?.windows ?? [];
  const root = await realpath(projectRoot), matches = [];
  for (const window of windows) {
    if (!window.path) continue;
    let file;
    try { file = await realpath(window.path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const relative = path.relative(root, file);
    if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) matches.push(window);
  }
  if(matches.length!==1)throw Object.assign(Error('Specify --window-id: expected one live session inside '+root+', found '+matches.length),{code:'LAYOUT_TARGET_SESSION_REQUIRED'});
  return String(matches[0].windowId);
}

export async function execute({ codeFile, windowId, input, code: expectedCode }, {runner=runFile,requestId=randomUUID()}={}) {
  const host = fileURLToPath(new URL('../../eda-host.mjs', import.meta.url));
  // Exact submitted code binds both the operation and its configured target.
  const code=await readFile(codeFile,'utf8'),binding={requestId,windowId,codeSha256:sha256(code),target:target(input.config)};
  if(expectedCode!==undefined&&code!==expectedCode)throw Object.assign(Error('Operation code changed before submission.'),{code:'LAYOUT_OPERATION_CHANGED'});
  let completed,processError;
  try { completed=await runner(process.execPath,
    [host,'execute','--eda','easyeda-pro','--window-id',windowId,'--code-file',codeFile,'--request-id',requestId],
    {windowsHide:true,maxBuffer:32*1024*1024,timeout:60000}); }
  catch(error){completed=error;processError=error;}
  const response=envelopes(completed.stdout,completed.stderr),request=response?.request;
  const matches=request?.requestId===requestId&&request.codeSha256===binding.codeSha256
    &&(request.windowId??request.sessionId)===windowId&&(response?.channel==='bridge'?typeof request.sessionId==='string'&&Boolean(request.sessionId):request.sessionId===windowId)
    &&(!response?.windowId||response.windowId===windowId)&&(!response?.sessionId||response.sessionId===request.sessionId);
  const document=response?.result?.document??request?.result?.document;
  const targetMatches=!document||(document.uuid===binding.target.expectedDocumentUuid&&document.parentProjectUuid===binding.target.expectedProjectUuid&&document.documentType===3);
  const interrupted=processError&&(processError.killed||processError.signal||typeof processError.code!=='number');
  const knownFailure=!interrupted&&matches&&response.success===false&&response.executionOutcome==='known'
    &&request.status==='failed'&&typeof request.error?.message==='string'&&request.error.message===response.error?.message
    &&request.error.code===response.error?.code&&request.result==null&&response.result==null;
  // A terminal script error proves completion, not absence of side effects.
  // Only an explicit pre-dispatch state proves the native body never ran.
  if (knownFailure) return { ...response, executionBinding: binding,
    mutationOutcome: request.actionStarted === false ? 'not-started' : 'unknown' };
  if(!processError&&response?.success===true&&response.result&&targetMatches&&matches&&request.status==='succeeded'
    &&(request.result===undefined||JSON.stringify(request.result)===JSON.stringify(response.result)))return {...response,executionBinding:binding};
  return {success:false,executionOutcome:'unknown',executionBinding:binding,
    ...(response?{request:response.request,submissionReceipt:response.submissionReceipt,untrustedResponse:response}:{}),
    error:{code:request&&!matches?'LAYOUT_RESPONSE_IDENTITY_MISMATCH':processError?.code??'LAYOUT_RESPONSE_UNRESOLVED',message:processError?.message??'Missing, contradictory or unresolved native receipt.'}};
}
