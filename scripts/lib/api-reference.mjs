import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const defaultCorpus = new URL('../../adapters/easyeda-pro/api-reference/corpus.json', import.meta.url);
const entryKinds = new Set(['class', 'interface', 'enum', 'type']);
const queryKinds = new Set([...entryKinds, 'method', 'property']);
const digest = text => createHash('sha256').update(text).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const unescape = text => String(text).replace(/\\([_\[\]()*#.])/g, '$1');
const normalized = text => unescape(text).normalize('NFKC').toLowerCase();
const wordsIn = text => new Set(normalized(text.replace(/([a-z0-9])([A-Z])/g, '$1 $2')).split(/[^\p{L}\p{N}]+/u));
const glossary = { 焊盘: ['pad'], 封装: ['footprint'], 器件: ['component', 'device'], 引脚: ['pin'], 网络: ['net'], 网表: ['netlist'], 图元: ['primitive'], 属性: ['property', 'attribute'], 坐标: ['coordinate'], 板框: ['outline'], 孔: ['hole'] };
const compact = (text, maximum = 360) => {
  const value = String(text).replace(/\s+/g, ' ').trim();
  return value.length > maximum ? value.slice(0, maximum) + '…' : value;
};
const plain = text => unescape(text)
  .replace(/<!--[^]*?-->/g, '').replace(/<[^>]*>/g, ' ')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();

function headingPositions(text) {
  const positions = [];
  let offset = 0, fence = null;
  for (const line of text.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    } else if (!fence) {
      const heading = line.match(/^###\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/);
      if (heading) positions.push({ offset, anchor: heading[1] });
    }
    offset += line.length + 1;
  }
  return positions;
}

function members(entry) {
  const positions = headingPositions(entry.text), result = [];
  for (let i = 0; i < positions.length; i++) {
    const { offset, anchor } = positions[i];
    const text = entry.text.slice(offset, positions[i + 1]?.offset ?? entry.text.length).trim();
    const heading = text.match(/^# (.+)$/m);
    const title = heading ? plain(heading[1]) : '';
    if (!title.startsWith(entry.id + '.')) continue;
    const suffix = title.match(/\s+(method|property)$/);
    if (!suffix) continue;
    const name = title.slice(entry.id.length + 1, suffix.index).replace(/\(.*\)$/, '');
    result.push({ id: entry.id + '#' + anchor, entryId: entry.id, anchor, name, kind: suffix[1], text, sourceUrl: entry.sourceUrl.replace(/\.html$/, '.' + anchor.toLowerCase() + '.html') });
  }
  if (entry.kind === 'enum') {
    for (const row of entry.text.matchAll(/<tr>([^]*?)<\/tr>/g)) {
      const cells = [...row[1].matchAll(/<td>([^]*?)<\/td>/g)].map(match => plain(match[1]));
      if (cells.length < 2 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(cells[0])) continue;
      const name = cells[0];
      result.push({ id: entry.id + '#' + name, entryId: entry.id, anchor: name, name, kind: 'enum-member', text: row[0], sourceUrl: entry.sourceUrl });
    }
  }
  return result;
}

function signature(text) {
  return text.match(/```(?:typescript|ts)\s*\n([^]*?)\n```/)?.[1]?.trim() ?? null;
}

function summary(text) {
  const intro = text.split(/^##\s/m)[0];
  return compact(plain(intro.replace(/^#{1,3} .*$/gm, '').replace(/^>.*$/gm, '')));
}

export async function loadCorpus(file = defaultCorpus) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (data.schemaVersion !== 1 || !data.source || !Array.isArray(data.entries)) fail('INVALID_CORPUS', 'Expected the versioned API reference corpus.');
  const entries = [], byId = new Map(), items = [];
  for (const entry of data.entries) {
    if (!entry || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.id) || !entryKinds.has(entry.kind) || typeof entry.text !== 'string' || typeof entry.sourceUrl !== 'string' || !entry.sourceUrl.startsWith('https://prodocs.lceda.cn/') || entry.sha256 !== digest(entry.text)) fail('INVALID_CORPUS_ENTRY', 'Invalid API reference entry or text checksum.');
    const key = normalized(entry.id);
    if (byId.has(key)) fail('DUPLICATE_CORPUS_ID', entry.id);
    const document = { ...entry, summary: summary(entry.text), members: members(entry) };
    entries.push(document); byId.set(key, document); items.push(document);
    for (const member of document.members) {
      const memberKey = normalized(member.id);
      if (byId.has(memberKey)) fail('DUPLICATE_CORPUS_ID', member.id);
      const item = { ...member, summary: summary(member.text) };
      byId.set(memberKey, item); items.push(item);
    }
  }
  return { source: data.source, entries, byId, items };
}

function limitValue(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail('INVALID_LIMIT', 'limit must be an integer between 1 and 50.');
  return limit;
}

const envelope = corpus => ({ readOnly: true, source: corpus.source, evidenceScope: 'Historical documentation only; current EDA API availability and behavior are not verified.' });
function documentationNotes(item) {
  const text = item.members ? item.text.slice(0, headingPositions(item.text)[0]?.offset ?? item.text.length) : item.text;
  const collected = new Map();
  let section = '', exampleDepth = null, fence = null;
  for (const line of text.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      if (exampleDepth !== null && heading[1].length <= exampleDepth) exampleDepth = null;
      if (/^(?:examples?\b|示例|例子)/i.test(plain(heading[2]))) exampleDepth = heading[1].length;
      section = normalized(plain(heading[2]));
      continue;
    }
    if (exampleDepth !== null) continue;
    const quote = line.match(/^>\s?(.*)$/);
    const kind = quote ? 'notice' : /^(?:remarks?|limitations?|warnings?|deprecated|obsolete|注意|备注|限制|弃用)$/.test(section) ? section : null;
    if (kind) {
      if (!collected.has(kind)) collected.set(kind, []);
      collected.get(kind).push(quote ? quote[1] : line);
    }
  }
  const all = [...collected].map(([kind, lines]) => ({ kind, raw: plain(lines.join('\n')) })).filter(note => note.raw);
  const flagText = all.map(note => `${note.kind}: ${note.raw}`).join('\n');
  const statusFlags = [];
  for (const [name, pattern] of [
    ['deprecated', /\b(?:deprecated|obsolete)\b|已弃用|已废弃/i],
    ['beta', /\bbeta\b/i],
    ['alpha', /\balpha\b/i],
    ['experimental', /\bexperimental\b|实验性/i],
  ]) if (pattern.test(flagText)) statusFlags.push(name);
  const notes = all.slice(0, 4).map(note => ({ kind: note.kind, text: compact(note.raw, 800), truncated: note.raw.length > 800 }));
  return { statusFlags, notes, notesTruncated: all.length > notes.length };
}
const descriptor = item => ({ id: item.id, kind: item.kind, ...(item.entryId ? { entryId: item.entryId } : {}), summary: item.summary, sourceUrl: item.sourceUrl, ...documentationNotes(item) });

export function searchReference(corpus, { query, kind, limit = 8 } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 240) fail('INVALID_QUERY', 'Provide a nonempty query of at most 240 characters.');
  limitValue(limit);
  if (kind !== undefined && !queryKinds.has(kind)) fail('INVALID_KIND', 'Use class, interface, enum, type, method or property.');
  const words = normalized(query.trim()).split(/\s+/);
  const groups = words.map(word => [...new Set([word, ...(glossary[word] ?? [])])]);
  const matches = [];
  for (const item of corpus.items) {
    if (kind && item.kind !== kind) continue;
    const id = normalized(item.id), title = normalized(item.summary), text = normalized(item.text);
    const tokenSets = {};
    const contains = (field, word, translated) => {
      const value = field === 'id' ? id : field === 'summary' ? title : text;
      if (!translated) return value.includes(word);
      tokenSets[field] ??= wordsIn(item[field]);
      return tokenSets[field].has(word) || tokenSets[field].has(word + 's');
    };
    let score = 0;
    for (const alternatives of groups) {
      let best = 0;
      for (const word of alternatives) {
        const translated = word !== alternatives[0];
        best = Math.max(best, id === word || id.endsWith('#' + word) ? 100 : contains('id', word, translated) ? 30 : contains('summary', word, translated) ? 8 : contains('text', word, translated) ? 1 : 0);
      }
      if (!best) { score = 0; break; }
      score += best;
    }
    if (score) matches.push({ item, score });
  }
  matches.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  return { ...envelope(corpus), status: matches.length ? 'matched' : 'no-match', query, expandedTerms: groups, total: matches.length, limit, results: matches.slice(0, limit).map(({ item }) => descriptor(item)) };
}

function resolveItem(corpus, input) {
  const id = unescape(input.trim()), key = normalized(id);
  const exact = corpus.byId.get(key);
  if (exact) return [exact];
  const separator = id.includes('#') ? '#' : id.includes('.') ? '.' : null;
  if (separator) {
    const [parent, member, ...rest] = id.split(separator);
    if (rest.length || !parent || !member) return [];
    const entry = corpus.byId.get(normalized(parent));
    if (!entry?.members) return [];
    const requested = normalized(member.replace(/\(\)$/, ''));
    return entry.members.filter(item => normalized(item.name) === requested || normalized(item.anchor) === requested).map(item => corpus.byId.get(normalized(item.id)));
  }
  const requested = key.replace(/\(\)$/, '');
  return corpus.items.filter(item => item.entryId && normalized(item.name) === requested);
}

function relatedTypes(corpus, item) {
  const head = item.members ? item.text.slice(0, headingPositions(item.text)[0]?.offset ?? item.text.length) : item.text;
  const names = new Set((signature(head) ?? '').match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
  for (const link of head.matchAll(/\]\((?:\.\.?\/)*(?:classes|interfaces|enums|types)?\/?([A-Za-z_][A-Za-z0-9_]*)\.md(?:#[^)]*)?\)/g)) names.add(link[1]);
  return [...names].map(name => corpus.byId.get(normalized(name))).filter(entry => entry?.members && entry.id !== (item.entryId ?? item.id)).map(descriptor);
}

export function showReference(corpus, { id, full = false } = {}) {
  if (typeof id !== 'string' || !id.trim() || id.length > 240 || typeof full !== 'boolean') fail('INVALID_ID', 'Provide an entry id or entry#member id.');
  const choices = resolveItem(corpus, id);
  if (!choices.length) return { ...envelope(corpus), status: 'not-found', requestedId: id };
  if (choices.length > 1) return { ...envelope(corpus), status: 'ambiguous', requestedId: id, total: choices.length, choices: choices.slice(0, 20).map(descriptor), hint: 'Select an explicit entry#member id; overloads have separate ids.' };
  const item = choices[0], declaration = signature(item.text), related = relatedTypes(corpus, item);
  const result = { ...envelope(corpus), status: 'found', ...descriptor(item), full, signature: declaration && declaration.length <= 2400 ? declaration : null, signatureOmitted: Boolean(declaration && declaration.length > 2400), relatedTotal: related.length, relatedTypes: related.slice(0, 12) };
  if (full) { result.text = item.text; result.textSha256 = digest(item.text); }
  else if (item.members) { result.memberCount = item.members.length; result.members = item.members.slice(0, 12).map(member => ({ id: member.id, kind: member.kind })); result.hint = 'Use show --id <entry#member> for a member, or --full for the complete stored text.'; }
  else result.hint = 'Use --full for the complete member text, parameters, remarks and examples.';
  return result;
}
