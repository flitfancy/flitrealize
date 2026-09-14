#!/usr/bin/env node
/** Bounded component-placement orchestration; all EDA operations use registered Actions. */
import { readFile, writeFile, mkdir, realpath, stat, rename, open, unlink } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const PLACE = 'schematic-component-place', SAVE = 'schematic-save-verify';
const terminalStatuses = action => action === PLACE ? ['applied', 'apply-failed', 'blocked', 'rolled-back', 'rollback-incomplete'] : ['applied', 'apply-failed'];
const HELP = `原理图批量放件：审计 → 绑定 → 布局计划 → 代表器件 → 分批放件/回读 → 保存/回读。
node scripts/schematic-components.mjs --project-root <绝对路径> --input-file <项目内 JSON> --window-id <窗口> [--apply]
node scripts/schematic-components.mjs --project-root <绝对路径> --resume <该项目内运行目录> --window-id <窗口> [--apply | --close]
默认仅生成计划并读取 EDA，同时在 evidence/ 下保存输入、源码备份和报告。
--apply 允许本次放件和保存。续接也必须显式传 --apply 才能写入。
--resume 默认只读对账；--close 在确认无未知写入后结束旧批次、保留现场，供重新规划。
不连线、不重排已有对象、不运行整图 DRC、不自动删除或回滚。不重放结果未知的写入。
输入格式、恢复边界和完整示例见 references/providers/easyeda-pro/2.3-component-batch.md。`;
const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}' : JSON.stringify(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const canonicalSource = value => value.split(/\r?\n/).filter(line => line && !line.includes('"type":"DOCHEAD"')).join('\n');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function need(value, message) { if (!value) fail('INVALID_BATCH_INPUT', message); }
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function atomic(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await rename(temp, path);
}
function within(root, path) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
async function projectFile(root, path) {
  const real = await realpath(resolve(root, path));
  if (!within(root, real) || !(await stat(real)).isFile()) fail('UNSAFE_PATH', '输入必须是当前项目内的普通文件：' + path);
  return real;
}
function validate(input, contract) {
  need(input && typeof input === 'object' && !Array.isArray(input), '需要输入对象');
  const fields = ['contractFile', 'expectedProjectUuid', 'expectedDocumentUuid', 'designators', 'selections', 'pinMaps', 'searchMapping', 'catalog', 'layout', 'batchSize'];
  need(Object.keys(input).every(key => fields.includes(key)), '输入含未知字段');
  for (const key of ['contractFile', 'expectedProjectUuid', 'expectedDocumentUuid']) need(typeof input[key] === 'string' && input[key].trim(), `${key} 必填`);
  need(contract?.kind === 'flitrealize.schematic-contract' && contract.schemaVersion === 1 && Array.isArray(contract.components), '需要 SchematicContract v1');
  need(Array.isArray(input.designators) && input.designators.length > 0 && new Set(input.designators).size === input.designators.length, 'designators 必须明确列出本批次已确认器件，且不重复');
  const refs = new Set(contract.components.map(c => c.designator));
  need(input.designators.every(ref => typeof ref === 'string' && refs.has(ref)), 'designators 必须属于 Contract');
  need(Number.isInteger(input.batchSize ?? 10) && (input.batchSize ?? 10) >= 1 && (input.batchSize ?? 10) <= 50, 'batchSize 必须为 1–50');
  for (const key of ['selections', 'pinMaps', 'searchMapping', 'catalog', 'layout']) {
    if (input[key] !== undefined) need(input[key] && typeof input[key] === 'object' && !Array.isArray(input[key]), `${key} 必须是对象`);
  }
  for (const key of ['selections', 'pinMaps', 'searchMapping', 'catalog']) need(Object.keys(input[key] || {}).every(ref => input.designators.includes(ref)), `${key} 含本批次之外的位号`);
}
function target(state, input) {
  if (!Array.isArray(state?.components) || state.document?.documentType !== 1 ||
      state.document?.uuid !== input.expectedDocumentUuid || state.document?.parentProjectUuid !== input.expectedProjectUuid) fail('TARGET_MISMATCH', '当前原理图/项目与输入不符，未继续写入');
}
function scopedContract(contract, designators) {
  const refs = new Set(designators);
  return { ...contract, components: contract.components.filter(component => refs.has(component.designator)),
    blocks: (contract.blocks || []).map(block => ({ ...block, components: block.components.filter(ref => refs.has(ref)) })).filter(block => block.components.length),
    nets: (contract.nets || []).map(net => ({ ...net, endpoints: net.endpoints.filter(endpoint => refs.has(endpoint.component)) })).filter(net => net.endpoints.length) };
}
function matches(actual, expected) {
  if (!actual || actual.primitiveId !== expected.primitiveId) return false;
  if (typeof expected.value === 'string' && actual.value !== expected.value) return false;
  for (const key of ['designator', 'mirror', 'addIntoBom', 'addIntoPcb']) if (actual[key] !== expected[key]) return false;
  for (const key of ['x', 'y', 'rotation']) if (!Number.isFinite(actual[key]) || Math.abs(actual[key] - expected[key]) > 1e-6) return false;
  if (actual.providerLibraryUuid && actual.providerLibraryUuid !== expected.libraryUuid) return false;
  if (actual.providerDeviceUuid && actual.providerDeviceUuid !== expected.uuid) return false;
  return true;
}
function receipts(transaction) {
  const owned = new Map();
  for (const attempt of transaction.attempts) {
    if (attempt.action !== PLACE || attempt.mode !== 'apply' || !attempt.result) continue;
    for (const item of attempt.result.created || attempt.result.createdBeforeFailure || []) {
      if (owned.has(item.primitiveId) && stable(owned.get(item.primitiveId)) !== stable(item)) fail('CONFLICTING_RECEIPTS', '创建回执互相冲突');
      owned.set(item.primitiveId, item);
    }
  }
  return [...owned.values()];
}
function reconcile(state, baseline, owned, desired, reportOnly = false) {
  const issues = [];
  const issue = (code, message, details = {}) => issues.push({ code, message, ...details });
  const byId = new Map(state.components.map(item => [item.primitiveId, item]));
  const baselineIds = new Set(baseline.components.map(item => item.primitiveId));
  const ownedIds = new Set(owned.map(item => item.primitiveId));
  const baselineChanges = baseline.components.filter(item => stable(byId.get(item.primitiveId)) !== stable(item))
    .map(item => ({ before: item, current: byId.get(item.primitiveId) ?? null }));
  if (baselineChanges.length) issue('BASELINE_CHANGED', '原有器件已变化，可能影响剩余布局；可结束旧批次后按现场重新规划', { components: baselineChanges });
  const unaccounted = state.components.filter(item => !baselineIds.has(item.primitiveId) && !ownedIds.has(item.primitiveId));
  if (unaccounted.length) issue('UNACCOUNTED_COMPONENTS', '发现没有创建回执的新增对象；不自动认领或重复创建', { components: unaccounted });
  for (const item of owned) {
    const plan = desired.find(component => component.designator === item.designator);
    if (!plan || item.libraryUuid !== plan.bindings.easyedaPro.libraryUuid || item.uuid !== plan.bindings.easyedaPro.deviceUuid ||
        (typeof item.requestedValue === 'string' && item.requestedValue !== plan.value) ||
        item.x !== plan.position.x || item.y !== plan.position.y || item.rotation !== (plan.rotation ?? 0) || item.mirror !== (plan.mirror ?? false) ||
        item.addIntoBom !== (plan.includeInBom !== false) || item.addIntoPcb !== (plan.includeInPcb !== false)) issue('RECEIPT_PLAN_MISMATCH', '创建回执与冻结的放置意图不符', { receipt: item });
    if (!matches(byId.get(item.primitiveId), item)) issue('CREATED_COMPONENT_CHANGED', '已创建对象缺失或未符合计划：' + item.designator, { before: item, current: byId.get(item.primitiveId) ?? null });
  }
  const completedRefs = new Set(owned.map(item => item.designator));
  if (completedRefs.size !== owned.length) issue('DUPLICATE_RECEIPTS', '创建回执存在重复位号');
  if (baseline.components.some(item => desired.some(component => component.designator === item.designator))) issue('DESIGNATOR_ALREADY_EXISTS', '本次请求的位号在批次开始前已存在；不覆盖、不重复放置');
  const pending = desired.filter(item => !completedRefs.has(item.designator));
  if (reportOnly) return { pending, issues };
  if (issues.length) fail(issues[0].code, issues[0].message);
  return pending;
}

/** The injected executor is only used by isolated tests; the CLI always uses action-runner. */
export function actionInvoker(projectRoot, windowId) {
  return async (action, input, context) => {
    const args = [join(SCRIPT_ROOT, 'action-runner.mjs'), 'run', '--action', action,
      '--input-file', context.inputFile, '--project-root', projectRoot, '--report-file', context.reportFile];
    if (windowId) args.push('--window-id', windowId);
    if (context.mutates) args.push('--allow-write');
    let failure;
    try { await promisify(execFile)(process.execPath, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }); }
    catch (error) { failure = error; }
    let report;
    try { report = await json(context.reportFile); } catch { /* No conclusive result was written. */ }
    if (report?.action === action && report.mode === input.mode && report.response?.success !== false && report.response?.result) return report.response.result;
    throw Object.assign(new Error(failure?.message || 'Action did not return a result'), { code: 'ACTION_OUTCOME_UNKNOWN' });
  };
}

export async function runComponentBatch(options) {
  need(!options.close || (options.resume && !options.apply), 'close 仅用于 resume，不能同时 apply');
  need(isAbsolute(options.projectRoot || ''), 'projectRoot 必须是明确的绝对目录');
  const projectRoot = await realpath(options.projectRoot);
  need((await stat(projectRoot)).isDirectory(), 'projectRoot 必须是目录');
  const evidenceRoot = join(projectRoot, 'evidence');
  await mkdir(evidenceRoot, { recursive: true });
  if (!within(projectRoot, await realpath(evidenceRoot))) fail('UNSAFE_PATH', 'evidence 目录越出项目');
  const lockPath = join(evidenceRoot, '.schematic-components.lock');
  const activePath = join(evidenceRoot, '.schematic-components-active.json');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') fail('BATCH_LOCKED', '已有批量入口或遗留锁；先确认旧进程和 EDA 写入已结束，不能自动抢锁'); throw error; }
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), resume: options.resume || null }));
  let runDir, transaction;
  const invoke = options.invoke || actionInvoker(projectRoot, options.windowId);
  async function persist() { await atomic(join(runDir, 'transaction.json'), transaction); }
  async function inputIntegrity() {
    const sources = await Promise.all(transaction.sources.map(async file => {
      try {
        const bytes = await readFile(await projectFile(projectRoot, file.path));
        const byteMatch = sha(bytes) === file.sha256;
        const parsed = JSON.parse(bytes);
        const semanticMatch = byteMatch || (file.semanticSha256 && sha(stable(file.designators ? scopedContract(parsed, file.designators) : parsed)) === file.semanticSha256);
        return { path: file.path, integrity: semanticMatch ? 'current' : 'changed', byteMatch };
      } catch (error) { return { path: file.path, integrity: 'unavailable', code: error.code || 'INVALID_JSON' }; }
    }));
    const toolchain = await Promise.all(transaction.toolchain.map(async file => {
      try { return { path: file.path, integrity: sha(await readFile(await projectFile(SCRIPT_ROOT, file.path))) === file.sha256 ? 'current' : 'changed' }; }
      catch (error) { return { path: file.path, integrity: 'unavailable', code: error.code || 'READ_FAILED' }; }
    }));
    return { sources, toolchain };
  }
  function requireCurrentInputs(integrity) {
    if (integrity.sources.some(file => file.integrity !== 'current')) fail('INPUT_CHANGED', '批次输入语义已变化或原版本不可确认；先结束旧批次，再按当前输入重新规划');
    if (integrity.toolchain.some(file => file.integrity !== 'current')) fail('TOOLCHAIN_CHANGED', '批次执行脚本已变化；先结束旧批次，再使用新脚本重新规划');
  }
  async function frozenSource(file) {
    const root = file.snapshotFile ? runDir : projectRoot;
    try {
      const bytes = await readFile(await projectFile(root, file.snapshotFile || file.path));
      if (sha(bytes) !== file.sha256) {
        if (file.snapshotFile) fail('FROZEN_INPUT_CHANGED', '运行目录中的原始输入备份被修改');
        return null; // Legacy records did not retain a source snapshot.
      }
      return JSON.parse(bytes);
    } catch (error) {
      if (file.snapshotFile) throw error;
      return null;
    }
  }
  async function dispatch(action, input, mutates = false) {
    if (mutates && !options.apply) fail('WRITE_NOT_ALLOWED', '本次调用没有 --apply');
    if (mutates) {
      requireCurrentInputs(await inputIntegrity());
      await atomic(activePath, { runDir });
    }
    const number = transaction.attempts.length + 1;
    const prefix = String(number).padStart(4, '0') + '-' + action + '-' + input.mode;
    const inputFile = join(runDir, prefix + '-input.json'), reportFile = join(runDir, prefix + '-report.json');
    const attempt = { number, action, mode: input.mode, mutates, inputFile: prefix + '-input.json', reportFile: prefix + '-report.json', state: 'in-flight' };
    await writeFile(inputFile, JSON.stringify(input, null, 2), { flag: 'wx' });
    attempt.inputSha256 = sha(await readFile(inputFile));
    transaction.attempts.push(attempt);
    await persist(); // Durable intent before a possibly ambiguous external write.
    try {
      const result = await invoke(action, input, { inputFile, reportFile, mutates });
      need(result && typeof result.status === 'string', 'Action 缺少状态');
      // The production runner already wrote its complete report. Tests use the same envelope.
      try { await stat(reportFile); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await atomic(reportFile, { action, mode: input.mode, response: { success: true, result } }); }
      if (mutates && !terminalStatuses(action).includes(result.status)) fail('ACTION_OUTCOME_UNKNOWN', '写入返回的状态不是确定终态');
      attempt.result = result;
      attempt.state = 'settled';
      await persist();
      return result;
    } catch (error) {
      attempt.state = mutates ? 'unknown' : 'failed';
      attempt.error = { code: error.code || 'ACTION_FAILED', message: error.message };
      await persist();
      throw error;
    }
  }
  function expected(result, status) { if (result.status !== status) fail('ACTION_NOT_COMPLETED', `步骤返回 ${result.status}，需要 ${status}；完整证据在运行目录`); return result; }
  async function inspect(input, includeSource = false) {
    const result = expected(await dispatch(PLACE, { mode: 'inspect', includeSource }), 'inspected');
    target(result.state, input);
    return result;
  }
  async function recoverAttempts() {
    for (const attempt of transaction.attempts.filter(item => ['in-flight', 'unknown'].includes(item.state))) {
      if (!attempt.mutates) { attempt.state = 'failed'; continue; }
      let report;
      try {
        const requestFile = await projectFile(runDir, attempt.inputFile);
        need(sha(await readFile(requestFile)) === attempt.inputSha256, '运行请求已被修改');
        report = await json(await projectFile(runDir, attempt.reportFile));
      } catch { /* A missing/invalid receipt never proves that a write did not happen. */ }
      if (report?.action === attempt.action && report.mode === attempt.mode && report.response?.success !== false && terminalStatuses(attempt.action).includes(report.response?.result?.status)) {
        attempt.result = report.response.result;
        attempt.state = 'settled';
      }
    }
    await persist();
  }
  try {
    let input, contract;
    let active;
    try { active = await json(activePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (active && (!options.resume || ((options.apply || options.close) && await realpath(resolve(projectRoot, options.resume)) !== active.runDir))) fail('UNFINISHED_BATCH', '本项目仍有未解决的写入批次；使用原 runDir 续接或对账后 --close');
    if (options.resume) {
      need(!options.inputFile, '续接使用原输入，不同时传 inputFile');
      runDir = await realpath(resolve(projectRoot, options.resume));
      need(within(await realpath(evidenceRoot), runDir), 'resume 必须在本项目 evidence 内');
      transaction = await json(await projectFile(runDir, 'transaction.json'));
      need(transaction.schemaVersion === 1 && transaction.kind === 'flitrealize.component-batch' && transaction.projectRoot === projectRoot && Array.isArray(transaction.attempts), '运行记录不属于当前项目或版本不支持');
      need(transaction.sources?.length === 2, '运行记录缺少输入来源');
      need(Array.isArray(transaction.toolchain) && transaction.toolchain.length > 0, '运行记录缺少执行脚本版本');
      input = await frozenSource(transaction.sources[0]);
      contract = await frozenSource(transaction.sources[1]);
      await recoverAttempts();
    } else {
      need(options.inputFile, '需要 inputFile 或 resume');
      const inputPath = await projectFile(projectRoot, options.inputFile);
      input = await json(inputPath);
      need(typeof input.contractFile === 'string' && input.contractFile, 'contractFile 必填');
      const contractPath = await projectFile(projectRoot, input.contractFile);
      const sourceBytes = await Promise.all([inputPath, contractPath].map(path => readFile(path)));
      input = JSON.parse(sourceBytes[0]);
      contract = JSON.parse(sourceBytes[1]);
      need(await projectFile(projectRoot, input.contractFile) === contractPath, '读取期间 contractFile 发生变化，请重试');
      validate(input, contract);
      runDir = join(evidenceRoot, 'schematic-components-' + randomUUID());
      await mkdir(runDir);
      transaction = { kind: 'flitrealize.component-batch', schemaVersion: 1, projectRoot, status: 'preparing', startedAt: new Date().toISOString(),
        sources: await Promise.all([inputPath, contractPath].map(async (path, index) => {
          const bytes = sourceBytes[index], snapshotFile = index === 0 ? 'input.snapshot.json' : 'contract.snapshot.json';
          await writeFile(join(runDir, snapshotFile), bytes, { flag: 'wx' });
          return { path: relative(projectRoot, path).split(sep).join('/'), sha256: sha(bytes),
            semanticSha256: sha(stable(index === 0 ? input : scopedContract(contract, input.designators))),
            ...(index === 0 ? {} : { designators: input.designators }), snapshotFile };
        })),
        toolchain: await Promise.all(['schematic-components.mjs', 'action-runner.mjs', 'actions/manifest.json', 'actions/schematic-layout.js', 'actions/schematic-contract-audit.js', 'actions/easyeda-pro/schematic-resolve-bindings.js', 'actions/easyeda-pro/schematic-component-place.js', 'actions/easyeda-pro/schematic-save-verify.js']
          .map(async path => ({ path, sha256: sha(await readFile(join(SCRIPT_ROOT, path))) }))), attempts: [] };
      await persist();
      input = await frozenSource(transaction.sources[0]);
      contract = await frozenSource(transaction.sources[1]);
    }
    let prepared;
    if (transaction.preparedSha256) {
      const bytes = await readFile(await projectFile(runDir, 'prepared.json'));
      if (sha(bytes) !== transaction.preparedSha256) fail('PREPARED_INPUT_CHANGED', '冻结的计划被修改');
      prepared = JSON.parse(bytes);
      input ||= { expectedDocumentUuid: prepared.baseline.document.uuid, expectedProjectUuid: prepared.baseline.document.parentProjectUuid };
    } else {
      need(input && contract, '旧记录缺少冻结输入和计划；无法确认原目标，请从原有报告恢复');
      validate(input, contract);
      const audit = await dispatch('schematic-contract-audit', { mode: 'inspect', contract });
      if (!['passed', 'conditional'].includes(audit.status)) fail('CONTRACT_BLOCKED', 'Contract 结构审计未通过');
      const scoped = scopedContract(contract, input.designators);
      const binding = expected(await dispatch('schematic-resolve-bindings', { mode: 'resolve', contract: scoped, selections: input.selections, pinMaps: input.pinMaps, searchMapping: input.searchMapping }), 'resolved');
      const layout = expected(await dispatch('schematic-layout', { mode: 'generate', contract: scoped, catalog: input.catalog, layout: input.layout, providerBindings: binding.providerBindings, bindingFingerprint: binding.bindingFingerprint }), 'generated');
      const baseline = await inspect(input, true);
      await writeFile(join(runDir, 'before.esch'), baseline.backupSource, { flag: 'wx' });
      prepared = { baseline: baseline.state, placementPlan: layout.placementPlan, bindingEvidence: binding.evidence, limitations: layout.diagnostics };
      await writeFile(join(runDir, 'prepared.json'), JSON.stringify(prepared, null, 2), { flag: 'wx' });
      transaction.preparedSha256 = sha(await readFile(join(runDir, 'prepared.json')));
      transaction.status = 'planned';
      await persist();
    }
    let current = await inspect(input, true);
    const unresolved = transaction.attempts.filter(attempt => attempt.mutates && ['unknown', 'in-flight'].includes(attempt.state));
    const desired = prepared.placementPlan.components;
    let owned = receipts(transaction);
    const live = reconcile(current.state, prepared.baseline, owned, desired, true);
    const integrity = await inputIntegrity();
    const issues = [
      ...live.issues,
      ...integrity.sources.filter(file => file.integrity !== 'current').map(file => ({ code: 'INPUT_CHANGED', ...file })),
      ...integrity.toolchain.filter(file => file.integrity !== 'current').map(file => ({ code: 'TOOLCHAIN_CHANGED', ...file })),
      ...unresolved.map(attempt => ({ code: 'IN_FLIGHT_OUTCOME_UNKNOWN', attempt: attempt.number, action: attempt.action })),
    ];
    const sourceChanged = transaction.completedSourceSha256 && sha(canonicalSource(current.backupSource)) !== transaction.completedSourceSha256;
    if (sourceChanged) issues.push({ code: 'COMPLETED_SOURCE_CHANGED', message: '已完成批次之后的源码发生变化，旧保存结论不代表当前现场' });
    const reconciliation = { checkedAt: new Date().toISOString(), document: current.state.document, integrity, issues,
      pendingDesignators: live.pending.map(component => component.designator), confirmedCreatedCount: owned.length,
      canResume: !transaction.closedAt && issues.length === 0, canClose: unresolved.length === 0 };
    transaction.reconciliation = reconciliation;
    await persist();
    if (options.close) {
      if (unresolved.length) fail('IN_FLIGHT_OUTCOME_UNKNOWN', '已回读现场，但旧写入没有确定终态，不能结束批次或解除活动标记');
      transaction.closedAt ||= new Date().toISOString();
      reconciliation.canResume = false;
      transaction.status = 'closed';
      delete transaction.lastError;
      await persist();
      if (active?.runDir === runDir) await unlink(activePath);
      return { ok: true, status: 'closed', readOnly: true, runDir, saved: null, saveChecked: false, reconciliation,
        guidance: '已结束本地事务，现场对象和原始回执均保留；按当前现场重新规划尚未完成的工作，不重放旧 apply。' };
    }
    if (transaction.closedAt) {
      if (options.apply) fail('BATCH_CLOSED', '旧批次已结束，不能继续写入；请按当前现场建立新计划');
      return { ok: true, status: 'closed', readOnly: true, runDir, saved: null, saveChecked: false, reconciliation };
    }
    // Resume inspection remains useful even when sources, scripts or the live document have changed.
    if (options.resume && !options.apply && issues.length) return { ok: true, status: 'needs-reconciliation', readOnly: true, runDir,
      saved: null, saveChecked: false, reconciliation, pendingCount: live.pending.length, confirmedCreatedCount: owned.length };
    if (unresolved.length) fail('IN_FLIGHT_OUTCOME_UNKNOWN', '已保存只读回读，但旧写入缺少确定终态；不能启动新写入或结束批次');
    let pending = reconcile(current.state, prepared.baseline, owned, desired);
    if (transaction.completedSourceSha256) {
      if (sourceChanged) fail('COMPLETED_SOURCE_CHANGED', '已完成批次的源文件又有变化；不把旧保存结论套用到当前现场');
      need(pending.length === 0, '完成记录与当前对象不一致');
      transaction.status = 'completed';
      delete transaction.lastError;
      await persist();
      if (active?.runDir === runDir) await unlink(activePath);
      return { ok: true, status: 'already-completed', readOnly: true, runDir, placedCount: owned.length, saved: null, saveChecked: false,
        recordedSaved: true, verification: transaction.verification, drc: 'not-run', reconciliation };
    }
    if (!options.apply) return { ok: true, status: 'planned', readOnly: true, runDir, pendingCount: pending.length, confirmedCreatedCount: owned.length,
      saved: null, saveChecked: false, limitations: prepared.limitations, reconciliation };
    requireCurrentInputs(integrity);
    while (pending.length) {
      // Always validate the first representative before scaling to the configured chunk size.
      const size = owned.length ? (input.batchSize ?? 10) : 1;
      const batchPlan = { ...prepared.placementPlan, components: pending.slice(0, size), failurePolicy: 'preserve' };
      const planned = expected(await dispatch(PLACE, { mode: 'plan', plan: batchPlan, expectedDocumentUuid: input.expectedDocumentUuid, expectedProjectUuid: input.expectedProjectUuid }), 'planned');
      const applied = await dispatch(PLACE, planned.applyRequest, true);
      current = await inspect(input);
      owned = receipts(transaction);
      pending = reconcile(current.state, prepared.baseline, owned, desired);
      expected(applied, 'applied'); // A failed chunk stops this invocation, even after a useful partial result.
      const verification = expected(await dispatch(PLACE, { mode: 'verify', created: owned, expectedDocumentUuid: input.expectedDocumentUuid, expectedProjectUuid: input.expectedProjectUuid }), 'verified');
      transaction.verification = verification.verification;
      transaction.status = 'placing';
      await persist();
      options.onProgress?.({ runDir, placedCount: owned.length, pendingCount: pending.length });
    }
    // Re-read all owned IDs before saving, including a resume after a failed save.
    const verified = expected(await dispatch(PLACE, { mode: 'verify', created: owned, expectedDocumentUuid: input.expectedDocumentUuid, expectedProjectUuid: input.expectedProjectUuid }), 'verified');
    transaction.verification = verified.verification;
    const savePlan = expected(await dispatch(SAVE, { mode: 'plan', expectedDocumentUuid: input.expectedDocumentUuid, expectedProjectUuid: input.expectedProjectUuid, runDrc: false }), 'planned');
    const saved = expected(await dispatch(SAVE, savePlan.applyRequest, true), 'applied');
    if (saved.saved !== true) fail('SAVE_NOT_CONFIRMED', '没有确认保存');
    current = await inspect(input, true);
    reconcile(current.state, prepared.baseline, owned, desired);
    await writeFile(join(runDir, 'after-' + randomUUID() + '.esch'), current.backupSource, { flag: 'wx' });
    transaction.completedSourceSha256 = sha(canonicalSource(current.backupSource));
    transaction.status = 'completed';
    delete transaction.lastError;
    transaction.completedAt = new Date().toISOString();
    await persist();
    await unlink(activePath);
    return { ok: true, status: 'placed-saved', runDir, placedCount: owned.length, saved: true, verification: transaction.verification,
      drc: 'not-run', scope: 'component-placement-only', limitations: ['未连线、未做整图 DRC；器件库身份回读的未知覆盖见 verification。', '未检查所有非器件图元；完整源码备份供对账，不提供自动整图恢复。'] };
  } catch (error) {
    if (transaction) {
      if (!transaction.closedAt) transaction.status = 'needs-reconciliation';
      transaction.lastError = { code: error.code || 'BATCH_FAILED', message: error.message };
      try { await persist(); } catch { /* Do not hide the original failure. */ }
    }
    error.runDir = runDir;
    throw error;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') { console.log(HELP); return; }
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name in flags) fail('INVALID_ARGUMENT', '重复参数：' + name);
    if (name === '--apply' || name === '--close') { flags[name] = true; continue; }
    if (!['--project-root', '--input-file', '--window-id', '--resume'].includes(name) || !argv[index + 1] || argv[index + 1].startsWith('--')) fail('INVALID_ARGUMENT', '未知或不完整参数：' + name);
    flags[name] = argv[++index];
  }
  need(flags['--window-id'], '--window-id 必填');
  const result = await runComponentBatch({ projectRoot: flags['--project-root'], inputFile: flags['--input-file'], resume: flags['--resume'], apply: flags['--apply'] === true, close: flags['--close'] === true, windowId: flags['--window-id'],
    onProgress: progress => process.stderr.write(JSON.stringify({ status: 'batch-verified', ...progress }) + '\n') });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ ok: false, status: 'needs-reconciliation', error: { code: error.code || 'BATCH_FAILED', message: error.message }, runDir: error.runDir })); process.exitCode = 1; });
}
