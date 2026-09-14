#!/usr/bin/env node
/** Offline schematic fact tables. No EDA calls, workflow hooks, or project state store. */
import { readFile, realpath, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const START = '<!-- flitrealize:facts:start -->';
const END = '<!-- flitrealize:facts:end -->';
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const requireThat = (condition, message) => { if (!condition) fail('INVALID_INPUT', message); };
const text = value => value == null || value === '' ? '未提供' : String(value);
const cell = value => text(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\|/g, '&#124;').replace(/\r\n|\r|\n/g, '<br>').replace(/[`*\[\]\\_]/g, char => '\\' + char);
const key = (ref, pin) => JSON.stringify([ref, String(pin)]);
function unique(items, field, label) {
  requireThat(Array.isArray(items), `${label} must be an array.`);
  const result = new Map();
  for (const item of items) {
    requireThat(item && typeof item[field] === 'string' && item[field].trim() && !result.has(item[field]), `${label}: missing or duplicate ${field}.`);
    result.set(item[field], item);
  }
  return result;
}
function table(headers, rows) {
  return [headers, headers.map(() => '---'), ...rows].map(row => '| ' + row.map(cell).join(' | ') + ' |').join('\n');
}

export function renderFacts({ contract, snapshot = null, connections = {}, sources = [] }) {
  requireThat(contract?.kind === 'flitrealize.schematic-contract' && contract.schemaVersion === 1, 'SchematicContract v1 is required.');
  const parts = unique(contract.components, 'designator', 'Contract components');
  const nets = unique(contract.nets, 'name', 'Contract nets');
  const intents = new Map();
  for (const part of parts.values()) unique(part.pins, 'number', `${part.designator} pins`);
  for (const net of nets.values()) {
    requireThat(Array.isArray(net.endpoints), 'Net endpoints must be an array.');
    for (const endpoint of net.endpoints) {
      requireThat(parts.get(endpoint.component)?.pins.some(pin => pin.number === String(endpoint.pin)), 'A net references an undeclared pin.');
      const id = key(endpoint.component, endpoint.pin);
      requireThat(!intents.has(id), 'A Contract pin occurs in multiple net endpoints.');
      intents.set(id, net.name);
    }
  }
  if (snapshot) {
    requireThat(snapshot.kind === 'flitrealize.schematic-snapshot' && snapshot.schemaVersion === 1
      && snapshot.document?.type === 'schematic' && snapshot.project?.nativeId && snapshot.document?.nativeId
      && typeof snapshot.provider === 'string' && snapshot.provider.trim()
      && typeof snapshot.capturedAt === 'string' && Number.isFinite(Date.parse(snapshot.capturedAt)), 'A timestamped SchematicSnapshot v1 is required.');
    for (const [field, actual] of [['expectedProjectUuid', snapshot.project.nativeId], ['expectedDocumentUuid', snapshot.document.nativeId]]) {
      if (connections[field] != null && connections[field] !== actual) fail('TARGET_MISMATCH', 'Snapshot and connection configuration target different documents/projects.');
    }
  }
  const observed = unique(snapshot?.components || [], 'designator', 'Snapshot components');
  for (const part of observed.values()) unique(part.pins, 'number', `${part.designator} observed pins`);
  const deferred = unique(connections.deferredComponents || [], 'designator', 'Deferred components');
  for (const item of deferred.values()) requireThat(parts.has(item.designator) && typeof item.reason === 'string' && item.reason.trim(), 'A deferral requires a Contract component and reason.');
  const extraNc = new Map();
  for (const item of connections.providerPinNoConnect || []) {
    requireThat(parts.has(item.designator) && typeof item.pin === 'string' && item.pin.trim() && typeof item.reason === 'string' && item.reason.trim(), 'An extra NC declaration requires a component, pin and reason.');
    const id = key(item.designator, item.pin);
    requireThat(!extraNc.has(id), 'Duplicate extra NC declaration.');
    extraNc.set(id, item);
  }
  const observedNets = new Map();
  for (const net of snapshot?.nets || []) for (const endpoint of net.endpoints || []) {
    const id = key(endpoint.component, endpoint.pin);
    const values = observedNets.get(id) || new Set();
    if (net.name) values.add(net.name);
    observedNets.set(id, values);
  }
  const lines = ['### 原理图事实表（由指定输入生成）', '',
    '设计列来自 Contract；观察列仅描述所给快照，不重新检查现场，也不证明保存、DRC 或电气功能通过。', ''];
  for (const source of sources) lines.push(`- ${cell(source.label)}：${cell(source.path)}；SHA256：${cell(source.sha256)}`);
  lines.push(snapshot ? `- 快照：${cell(snapshot.provider)} / ${cell(snapshot.project.nativeId)} / ${cell(snapshot.document.nativeId)}；采集时间：${cell(snapshot.capturedAt)}` : '- 未提供快照：所有实际实现状态均未核验。', '');
  const blocks = contract.blocks || [];
  requireThat(Array.isArray(blocks), 'Contract blocks must be an array.');
  const assigned = new Set();
  const groups = [];
  for (const block of blocks) {
    requireThat(Array.isArray(block.components), 'Block components must be an array.');
    const refs = block.components.filter(ref => {
      requireThat(parts.has(ref), 'A block references an unknown component.');
      if (assigned.has(ref)) return false;
      assigned.add(ref); return true;
    });
    if (refs.length) groups.push({ name: block.id, refs });
  }
  const remaining = [...parts.keys()].filter(ref => !assigned.has(ref));
  if (remaining.length) groups.push({ name: '未分组', refs: remaining });
  const exceptions = [];
  function observation(ref, physical) {
    if (!snapshot) return '未核验（无快照）';
    const part = observed.get(ref);
    if (!part) return '快照中未见器件';
    if (physical == null) return '映射未提供';
    const pin = part.pins.find(item => item.number === physical);
    if (!pin) return '快照中未见引脚';
    const actualNets = new Set(observedNets.get(key(ref, physical)) || []);
    if (pin.net) actualNets.add(pin.net);
    const nc = pin.noConnect === true ? 'NC=是' : pin.noConnect === false ? 'NC=否' : 'NC 未报告';
    return `${nc}；${actualNets.size ? '报告网络：' + [...actualNets].join(' / ') : '网络未报告（不等于未连接）'}`;
  }
  for (const group of groups) {
    const componentRows = [], pinRows = [];
    for (const ref of group.refs) {
      const part = parts.get(ref), live = observed.get(ref), delay = deferred.get(ref);
      componentRows.push([ref, part.role, part.identity?.mpn || part.identity?.value, part.identity?.value,
        part.footprint?.name, live ? `快照中存在；Value=${text(live.value)}；封装=${text(live.footprint)}` : snapshot ? '快照中未见' : '未核验（无快照）']);
      if (delay) exceptions.push([ref, '明确延期', delay.reason, live ? '快照中已存在，需核对延期声明' : snapshot ? '快照中未见' : '未核验']);
      else if (snapshot && !live) exceptions.push([ref, '实现缺项', '未声明延期', '快照中未见']);
      const bindingKey = snapshot?.provider === 'easyeda-pro' ? 'easyedaPro' : snapshot?.provider;
      const availableMaps = Object.values(part.bindings || {}).map(binding => binding.pinMap).filter(Boolean);
      const pinMap = bindingKey ? part.bindings?.[bindingKey]?.pinMap : availableMaps.length === 1 ? availableMaps[0] : null;
      const covered = new Set();
      for (const pin of part.pins) {
        const net = intents.get(key(ref, pin.number));
        requireThat(!(net && pin.classification === 'no-connect'), 'A pin is both NC and a net endpoint.');
        const mapping = pinMap?.[pin.number];
        const physicals = mapping == null ? [null] : Array.isArray(mapping) ? mapping : [mapping];
        requireThat(physicals.length > 0 && physicals.every(value => value === null || (typeof value === 'string' && value.trim())), 'Invalid pin mapping.');
        for (const physical of physicals) {
          if (physical != null) {
            requireThat(!covered.has(physical) && !extraNc.has(key(ref, physical)), 'Ambiguous physical pin mapping or extra NC overlaps a Contract pin.');
            covered.add(physical);
          }
          const intent = pin.classification === 'no-connect' ? 'NC' : net || '未分配网络';
          pinRows.push([ref, pin.number, physical, pin.function, intent, pin.defaultState, observation(ref, physical)]);
          if (pin.classification === 'no-connect') exceptions.push([`${ref}.${text(physical)}`, 'Contract NC', pin.function, observation(ref, physical)]);
        }
      }
      for (const item of extraNc.values()) if (item.designator === ref) {
        covered.add(item.pin);
        pinRows.push([ref, '额外物理引脚', item.pin, item.reason, '声明 NC', null, observation(ref, item.pin)]);
        exceptions.push([`${ref}.${item.pin}`, '额外 NC', item.reason, observation(ref, item.pin)]);
      }
      for (const pin of live?.pins || []) if (!covered.has(pin.number)) {
        pinRows.push([ref, '映射未覆盖', pin.number, pin.name, '意图待核对', null, observation(ref, pin.number)]);
        exceptions.push([`${ref}.${pin.number}`, '映射未覆盖', '不根据悬空状态推断 NC', observation(ref, pin.number)]);
      }
    }
    lines.push(`#### ${cell(group.name)}`, '', table(['位号', '作用', '设计型号/规格', '设计值', '设计封装', '快照观察'], componentRows), '',
      table(['位号', 'Contract 引脚', '映射物理引脚', '语义功能', '设计网络/状态', '声明默认状态', '快照观察'], pinRows), '');
  }
  for (const ref of observed.keys()) if (!parts.has(ref)) exceptions.push([ref, '额外器件', '不在 Contract 中', '快照中存在']);
  lines.push('#### NC、延期与待核对项', '', exceptions.length ? table(['对象', '类别', '设计声明/原因', '快照观察'], exceptions) : '无已声明 NC、延期或缺项；不代表电气审查通过。');
  return lines.join('\n') + '\n';
}

export async function runHandoffSync({ projectRoot, contractFile, snapshotFile, connectionsFile, mode = 'preview' }) {
  requireThat(projectRoot && contractFile && ['preview', 'check', 'apply'].includes(mode), 'projectRoot, contractFile and a valid mode are required.');
  const root = await realpath(resolve(projectRoot));
  const inputs = [];
  async function local(path) {
    const resolved = await realpath(resolve(root, path));
    const rel = relative(root, resolved);
    requireThat(rel && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel), 'Files must stay inside the project.');
    requireThat((await lstat(resolved)).isFile(), 'Input must be a regular file.');
    return resolved;
  }
  async function input(path, label) {
    const file = await local(path), bytes = await readFile(file);
    inputs.push({ file, bytes, label, path: relative(root, file).replace(/\\/g, '/'), sha256: digest(bytes) });
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  }
  const contract = await input(contractFile, 'Contract');
  let snapshot = snapshotFile ? await input(snapshotFile, 'Snapshot') : null;
  if (snapshot?.response) {
    requireThat(snapshot.action === 'schematic-inspect' && snapshot.response.success === true
      && ['inspected', 'inspected-with-gaps'].includes(snapshot.response.result?.status), 'Only a successful schematic-inspect report can supply a snapshot.');
    snapshot = snapshot.response.result.snapshot;
    requireThat(snapshot, 'Report contains no snapshot.');
  }
  const connections = connectionsFile ? await input(connectionsFile, 'Declarations') : {};
  const markdown = renderFacts({ contract, snapshot, connections, sources: inputs });
  const target = join(root, 'CURRENT_HANDOFF.md');
  let original;
  try { original = await readFile(await local('CURRENT_HANDOFF.md'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const matches = original == null ? [] : [...original.matchAll(/^<!-- flitrealize:facts:(start|end) -->\r?$/gm)];
  const valid = matches.length === 2 && matches[0][1] === 'start' && matches[1][1] === 'end';
  const newline = original?.includes('\r\n') ? '\r\n' : '\n';
  const body = `<!-- flitrealize:facts:sha256=${digest(markdown)} -->\n${markdown}`;
  const region = START + '\n' + body + END;
  const replacement = region.replace(/\n/g, newline);
  const before = valid ? original.slice(matches[0].index + START.length, matches[1].index).replace(/\r\n/g, '\n').replace(/^\n/, '') : null;
  const receipt = before?.match(/^<!-- flitrealize:facts:sha256=([a-f0-9]{64}) -->\n/);
  const trusted = before != null && (!before.trim() || (receipt && digest(before.slice(receipt[0].length)) === receipt[1]));
  const proposed = valid ? original.slice(0, matches[0].index) + replacement + original.slice(matches[1].index + END.length) : null;
  const changed = proposed !== original || !valid;
  const result = { ok: mode !== 'check' || (valid && trusted && !changed), status: !valid ? 'missing-or-invalid-region' : !trusted ? 'edited-region' : changed ? 'needs-update' : 'current',
    changed, written: false, readOnly: true, liveEdaChecked: false, meaning: 'document-projection-only' };
  if (mode === 'preview') return { ...result, markdown: region };
  if (mode === 'check') return result;
  if (!valid) fail('REGION_REQUIRED', 'Place one empty facts start/end region in the existing handoff first; no file or region is created automatically.');
  if (!trusted) fail('EDITED_REGION', 'Generated content was edited or lacks its receipt; inspect the preview before replacing it.');
  if (!changed) return result;
  const info = await lstat(target);
  requireThat(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'The handoff must be a regular unlinked file.');
  requireThat(!inputs.some(item => item.file === target), 'The handoff cannot be an input.');
  for (const item of inputs) if (!(await readFile(item.file)).equals(item.bytes)) fail('INPUT_CHANGED', 'An input changed during generation.');
  const temporary = join(root, `.handoff-sync-${randomUUID()}.tmp`);
  let created = false;
  try {
    await writeFile(temporary, proposed, { flag: 'wx', mode: info.mode }); created = true;
    const current = await lstat(target);
    if (current.ino !== info.ino || current.dev !== info.dev || current.nlink !== 1 || await readFile(target, 'utf8') !== original) fail('HANDOFF_CHANGED', 'Handoff changed before replacement.');
    await rename(temporary, target); created = false;
  } finally { if (created) await unlink(temporary); }
  return { ...result, status: 'updated', written: true, readOnly: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {}; let print = false;
    for (let i = 2; i < process.argv.length; i += 1) {
      const arg = process.argv[i];
      if (arg === '--help') {
        console.log('handoff-sync.mjs --project-root PROJECT --contract FILE [--snapshot FILE] [--connections FILE] [--print | --check | --apply]\nDefault: compact offline preview. --print includes generated Markdown. --check is read-only. --apply updates only an existing marked facts region, only when changed. No EDA calls or evidence/status files. See references/0.1-continuation.md.');
        process.exit(0);
      }
      if (arg === '--print') { print = true; continue; }
      if (['--apply', '--check'].includes(arg)) { requireThat(!options.mode, 'Choose one mode.'); options.mode = arg.slice(2); continue; }
      const name = { '--project-root': 'projectRoot', '--contract': 'contractFile', '--snapshot': 'snapshotFile', '--connections': 'connectionsFile' }[arg];
      requireThat(name && !options[name] && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `Unknown or incomplete option: ${arg}`);
      options[name] = process.argv[++i];
    }
    requireThat(!print || !options.mode, '--print is only available in preview mode.');
    const result = await runHandoffSync(options);
    if (!print) delete result.markdown;
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ ok: false, code: error.code || 'HANDOFF_SYNC_ERROR', error: error.message })); process.exitCode = 2; }
}
