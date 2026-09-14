#!/usr/bin/env node
/** Read-only local integrity checks for the checkpoint in CURRENT_HANDOFF.md. */
import { readFile, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = { readOnly: true, liveEdaChecked: false, meaning: 'local-record-integrity-only' };
const HELP = `只读续接检查，不执行记录中的命令，不连接 EDA，不更新交接或哈希。
node scripts/handoff-check.mjs inspect --project-root <绝对项目路径>
node scripts/handoff-check.mjs fingerprint --project-root <绝对项目路径> --file <项目相对文件>
node scripts/handoff-check.mjs fingerprint --project-root <绝对项目路径> --root skill --file scripts/<入口>
退出码：0 本地引用一致或指纹读取成功；1 引用缺失/变化；2 旧格式、缺少交接或输入无效。
0 不表示板级验证、保存或阶段验收通过。格式与续接方法见 references/0.1-continuation.md。`;

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function requireValue(condition, message) { if (!condition) fail('INVALID_CHECKPOINT', message); }
function object(value, fields, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} 必须是对象`);
  requireValue(Object.keys(value).every(key => fields.includes(key)), `${label} 包含未知字段`);
}
function text(value, label) { requireValue(typeof value === 'string' && value.trim(), `${label} 必须是非空文字`); }
function list(value, label) { requireValue(Array.isArray(value), `${label} 必须是数组`); }
function texts(value, label) { list(value, label); value.forEach(item => text(item, label)); }
function hash(value) { requireValue(typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value), 'sha256 必须是实际的 64 位十六进制摘要'); }
function timestamp(value, label) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), `${label} 必须是带时区的 ISO 时间`);
}
function portablePath(value) {
  text(value, 'path');
  requireValue(!/[\\:\x00-\x1f]/.test(value) && !isAbsolute(value) &&
    value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)), 'path 必须是无越界的 / 分隔相对文件路径');
  requireValue(!value.split('/').some(part => part.toLowerCase() === '.flitrealize'), '稳定证据不能只保存在 .flitrealize 临时运行目录');
}
function uniqueIds(items, label) {
  list(items, label);
  const ids = new Set();
  for (const item of items) {
    requireValue(typeof item?.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(item.id) && !ids.has(item.id), `${label} 的 id 必须唯一且只含字母、数字、_ 或 -`);
    ids.add(item.id);
  }
  return ids;
}

function validateCheckpoint(value) {
  object(value, ['schemaVersion', 'updatedAt', 'projectRoot', 'stage', 'objective', 'target', 'entrypoint', 'nextAction', 'openItems', 'artifacts', 'checks'], 'checkpoint');
  requireValue(value.schemaVersion === 1, '仅支持 schemaVersion 1');
  timestamp(value.updatedAt, 'updatedAt');
  for (const key of ['projectRoot', 'stage', 'objective', 'nextAction']) text(value[key], key);
  requireValue(isAbsolute(value.projectRoot), 'projectRoot 必须是绝对路径');
  texts(value.openItems, 'openItems');
  if (value.target !== null) {
    object(value.target, ['provider', 'projectId', 'documentId'], 'target');
    for (const key of ['provider', 'projectId', 'documentId']) text(value.target[key], `target.${key}`);
  }
  if (value.entrypoint !== null) {
    object(value.entrypoint, ['root', 'path', 'sha256', 'args'], 'entrypoint');
    requireValue(['project', 'skill'].includes(value.entrypoint.root), 'entrypoint.root 必须是 project 或 skill');
    portablePath(value.entrypoint.path);
    hash(value.entrypoint.sha256);
    texts(value.entrypoint.args, 'entrypoint.args');
  }
  const ids = uniqueIds(value.artifacts, 'artifacts');
  for (const artifact of value.artifacts) {
    object(artifact, ['id', 'path', 'sha256'], 'artifact');
    portablePath(artifact.path);
    requireValue(artifact.path.toLowerCase() !== 'current_handoff.md', '不要为主文稿记录自身哈希');
    hash(artifact.sha256);
  }
  uniqueIds(value.checks, 'checks');
  for (const check of value.checks) {
    object(check, ['id', 'status', 'scope', 'checkedAt', 'inputs', 'evidence', 'limitations'], 'check');
    requireValue(['planned', 'applied', 'verified', 'blocked', 'unknown'].includes(check.status), `check ${check.id} 的 status 无效`);
    text(check.scope, 'check.scope');
    for (const key of ['inputs', 'evidence']) {
      texts(check[key], `check.${key}`);
      requireValue(new Set(check[key]).size === check[key].length && check[key].every(id => ids.has(id)), `check.${key} 含重复或未登记的 artifact id`);
    }
    texts(check.limitations, 'check.limitations');
    if (['applied', 'verified'].includes(check.status)) {
      requireValue(check.inputs.length > 0 && check.evidence.length > 0, 'applied/verified 必须关联输入版本和结果证据');
      timestamp(check.checkedAt, 'check.checkedAt');
    } else if (check.checkedAt !== null) timestamp(check.checkedAt, 'check.checkedAt');
  }
  return value;
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
async function localFile(root, path) {
  portablePath(path);
  const resolvedRoot = await realpath(root);
  const file = await realpath(resolve(resolvedRoot, path));
  if (!inside(resolvedRoot, file) || relative(resolvedRoot, file).split(sep).some(part => part.toLowerCase() === '.flitrealize')) fail('UNSAFE_PATH', `文件越出允许目录或落入临时目录：${path}`);
  if (!(await stat(file)).isFile()) fail('NOT_A_FILE', `不是普通文件：${path}`);
  return file;
}
async function fileHash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function inspectFile(root, record) {
  try {
    const actualSha256 = await fileHash(await localFile(root, record.path));
    if (actualSha256 !== record.sha256.toLowerCase()) return { path: record.path, integrity: 'outdated', code: 'HASH_MISMATCH', actualSha256 };
    return { path: record.path, integrity: 'current' };
  } catch (error) {
    return { path: record.path, integrity: 'unavailable', code: error.code === 'ENOENT' ? 'MISSING_FILE' : error.code || 'FILE_READ_ERROR' };
  }
}

function parseCheckpoint(markdown) {
  const openings = [...markdown.matchAll(/^```flitrealize-handoff[^\S\r\n]*\r?$/gm)];
  if (!openings.length) return null;
  if (openings.length !== 1) fail('MULTIPLE_CHECKPOINTS', '主文稿只能有一个当前续接记录，不追加历史副本');
  const rest = markdown.slice(openings[0].index + openings[0][0].length);
  const end = /^```[^\S\r\n]*\r?$/m.exec(rest);
  if (!end) fail('INVALID_CHECKPOINT', '续接记录缺少代码块结束标记');
  let value;
  try { value = JSON.parse(rest.slice(0, end.index)); }
  catch { fail('INVALID_CHECKPOINT', '续接记录不是有效 JSON'); }
  return validateCheckpoint(value);
}

async function inspect(projectRoot) {
  let handoff;
  try { handoff = await localFile(projectRoot, 'CURRENT_HANDOFF.md'); }
  catch (error) {
    if (error.code === 'ENOENT') fail('MISSING_HANDOFF', '当前项目没有 CURRENT_HANDOFF.md；从本项目制品恢复，不自动创建空状态');
    throw error;
  }
  const checkpoint = parseCheckpoint(await readFile(handoff, 'utf8'));
  if (!checkpoint) return { code: 2, output: { ...BASE, recordStatus: 'legacy', guidance: '保留旧主文稿，按 0.1 读取当前交接与相关制品；需要长期续接时再补记录。缺少结构块不表示项目被阻塞。' } };
  let recordedRoot;
  try { recordedRoot = await realpath(checkpoint.projectRoot); } catch { /* mismatched or unavailable root */ }
  if (recordedRoot !== projectRoot) fail('PROJECT_ROOT_MISMATCH', '交接记录与指定项目根目录不一致；先确认项目，不从另一目录读取证据');
  const artifacts = await Promise.all(checkpoint.artifacts.map(async record => ({ id: record.id, ...await inspectFile(projectRoot, record) })));
  const entrypoint = checkpoint.entrypoint === null ? null : {
    ...checkpoint.entrypoint,
    ...await inspectFile(checkpoint.entrypoint.root === 'skill' ? SKILL_ROOT : projectRoot, checkpoint.entrypoint),
  };
  const issues = [...artifacts, ...(entrypoint ? [{ id: 'entrypoint', ...entrypoint }] : [])]
    .filter(item => item.integrity !== 'current')
    .map(({ id, path, code, actualSha256 }) => ({ id, path, code, ...(actualSha256 ? { actualSha256 } : {}) }));
  const currentIds = new Set(artifacts.filter(item => item.integrity === 'current').map(item => item.id));
  const checks = checkpoint.checks.map(({ status, ...check }) => ({
    ...check, recordedStatus: status,
    referenceIntegrity: [...check.inputs, ...check.evidence].every(id => currentIds.has(id)) ? 'current' : 'outdated',
  }));
  return { code: issues.length ? 1 : 0, output: {
    ...BASE, recordStatus: issues.length ? 'needs-reconciliation' : 'consistent',
    updatedAt: checkpoint.updatedAt, projectRoot, stage: checkpoint.stage, objective: checkpoint.objective,
    target: checkpoint.target, entrypoint, nextAction: checkpoint.nextAction, openItems: checkpoint.openItems,
    artifacts, checks, issues,
    guidance: '只比较本地记录与字节版本，不证明报告内容、EDA 现场、保存或阶段验收。按当前用户请求核对目标；变化只使相关结论待复核，不覆盖现场，不重放旧 apply。',
  } };
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(HELP + '\n'); return; }
  const [command, ...rest] = args;
  if (!['inspect', 'fingerprint'].includes(command)) fail('INVALID_ARGUMENT', '使用 inspect 或 fingerprint；--help 查看说明');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1];
    if (!['--project-root', ...(command === 'fingerprint' ? ['--file', '--root'] : [])].includes(flag) || !value || value.startsWith('--') || flag in options) fail('INVALID_ARGUMENT', `无效或重复参数：${flag}`);
    options[flag] = value;
  }
  if (!options['--project-root'] || !isAbsolute(options['--project-root'])) fail('INVALID_ARGUMENT', '--project-root 必须为明确的绝对项目路径');
  const projectRoot = await realpath(options['--project-root']);
  if (!(await stat(projectRoot)).isDirectory()) fail('INVALID_ARGUMENT', '--project-root 必须为目录');
  let result;
  if (command === 'inspect') result = await inspect(projectRoot);
  else {
    const root = options['--root'] || 'project';
    if (!options['--file'] || !['project', 'skill'].includes(root)) fail('INVALID_ARGUMENT', 'fingerprint 需要 --file；--root 只能是 project 或 skill');
    const file = await localFile(root === 'skill' ? SKILL_ROOT : projectRoot, options['--file']);
    result = { code: 0, output: { ...BASE, root, path: options['--file'], sha256: await fileHash(file) } };
  }
  process.stdout.write(JSON.stringify(result.output, null, 2) + '\n');
  process.exitCode = result.code;
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(JSON.stringify({ ...BASE, recordStatus: 'invalid', error: { code: error.code || 'HANDOFF_READ_ERROR', message: error.message } }) + '\n');
  process.exitCode = 2;
});
