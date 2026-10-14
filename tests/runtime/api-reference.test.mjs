import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadCorpus, searchReference, showReference } from '../../scripts/lib/api-reference.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const corpus = await loadCorpus();
const sha = text => createHash('sha256').update(text).digest('hex');
const run = args => spawnSync(process.execPath, [join(root, 'scripts/api-reference.mjs'), ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
async function temporaryTask(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'flitrealize-api-reference-'));
  try { return await fn(directory); }
  finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('flitrealize-api-reference-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('official corpus retains the pinned complete document inventory and source provenance', async () => {
  assert.equal(corpus.source.version, '1.1.44');
  assert.equal(corpus.source.status, 'official-repository-snapshot');
  assert.equal(corpus.source.commit, '20e08dd62ec4faa5eb527332df2c29c9dc0fbaf4');
  assert.equal(corpus.source.currentApiAvailability, 'not-verified');
  const provenance = JSON.parse(await readFile(join(root, 'adapters/easyeda-pro/api-reference/provenance.json'), 'utf8'));
  assert.ok(provenance.selection.entryCount > 0);
  assert.equal(corpus.entries.length, provenance.selection.entryCount);
  assert.equal(new Set(corpus.entries.map(entry => entry.id)).size, corpus.entries.length);
  const counts = Object.fromEntries(Object.keys(provenance.selection.counts).map(kind =>
    [kind, corpus.entries.filter(entry => entry.kind === kind).length]));
  assert.deepEqual(counts, provenance.selection.counts);
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), corpus.entries.length);
  assert.match(provenance.archive.sha256, /^[a-f0-9]{64}$/);
  assert.equal(provenance.attribution.author, 'JLCEDA');
  assert.equal(provenance.attribution.licenseDeclaration, 'MIT');
  assert.ok(corpus.entries.every(entry => entry.sourceFile.startsWith('references/') && /^[a-f0-9]{64}$/.test(entry.sourceSha256)));
});

test('method and Chinese geometry queries return bounded relevant definitions', () => {
  const methods = searchReference(corpus, { query: 'getAllPins', kind: 'method', limit: 4 });
  assert.equal(methods.status, 'matched');
  assert.equal(methods.results[0].id, 'IPCB_PrimitiveComponent#getallpins');
  assert.ok(methods.results.every(item => item.kind === 'method'));
  for (const query of ['焊盘', '封装']) {
    const result = searchReference(corpus, { query, limit: 8 });
    assert.equal(result.status, 'matched');
    assert.ok(result.results.length <= 8);
    assert.ok(!result.results.some(item => /#padding$/i.test(item.id)));
    assert.ok(result.results.some(item => /pad|footprint/i.test(item.id)));
  }
  assert.equal(searchReference(corpus, { query: 'certainly-no-such-api' }).status, 'no-match');
});

test('domain filters use ownership rather than cross-domain words and include namespace properties', () => {
  const rows = [
    ['PCB_PrimitiveVia#get', 'PCB_PrimitiveVia', 'get', 'method'],
    ['IPCB_PrimitiveVia#get', 'IPCB_PrimitiveVia', 'get', 'method'],
    ['EPCB_LayerId#GET', 'EPCB_LayerId', 'GET', 'enum-member'],
    ['TPCB_Test#get', 'TPCB_Test', 'get', 'method'],
    ['LIB_Device#get', 'LIB_Device', 'get', 'method'],
    ['DMT_Project#get', 'DMT_Project', 'get', 'method'],
    ['PNL_Document#get', 'PNL_Document', 'get', 'method'],
    ['SCH_Document#get', 'SCH_Document', 'get', 'method'],
    ['SYS_Test#get', 'SYS_Test', 'get', 'method'],
    ['EDA#pcb_Net', 'EDA', 'pcb_Net', 'property'],
    ['EDA#lib_Device', 'EDA', 'lib_Device', 'property'],
  ];
  const model = { source: { status: 'fixture' }, byId: new Map(), items: rows.map(([id, entryId, name, kind]) => ({ id, entryId, name, kind, summary: 'get references PCB_PrimitiveVia and LIB_Device', text: '# ' + id + '\nget references PCB_PrimitiveVia and LIB_Device', sourceUrl: 'https://prodocs.lceda.cn/en/api/reference/fixture.html' })) };
  const ids = options => searchReference(model, { query: 'get', limit: 50, ...options }).results.map(item => item.id).sort();
  assert.deepEqual(ids({ domain: 'pcb' }), ['EDA#pcb_Net', 'EPCB_LayerId#GET', 'IPCB_PrimitiveVia#get', 'PCB_PrimitiveVia#get', 'TPCB_Test#get'].sort());
  assert.deepEqual(ids({ domain: 'document' }), ['DMT_Project#get', 'PNL_Document#get']);
  for (const [alias, canonical] of [['SCH', 'schematic'], ['dmt', 'document'], ['pnl', 'document'], ['lib', 'library'], ['sys', 'system']]) {
    assert.deepEqual(ids({ domain: alias }), ids({ domain: canonical }));
    assert.equal(searchReference(model, { query: 'get', domain: alias }).domain, canonical);
  }
});

test('exact owning-entry filters retain overloads and reject prefix or conflicting-domain matches', () => {
  const result = searchReference(corpus, { query: 'get', kind: 'method', class: 'pcb_primitivevia', domain: 'PCB', limit: 50 });
  assert.equal(result.class, 'PCB_PrimitiveVia');
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every(item => item.entryId === 'PCB_PrimitiveVia'));
  assert.ok(result.results.some(item => item.id === 'PCB_PrimitiveVia#get'));
  assert.ok(result.results.some(item => item.id === 'PCB_PrimitiveVia#get_1'));
  const iface = searchReference(corpus, { query: 'get', class: 'IPCB_PrimitiveVia', limit: 50 });
  assert.ok(iface.results.length > 0);
  assert.ok(iface.results.every(item => (item.entryId ?? item.id) === 'IPCB_PrimitiveVia'));
  for (const options of [{ class: 'PCB_PrimitiveVi' }, { class: 'PCB_PrimitiveVia', domain: 'library' }]) {
    const empty = searchReference(corpus, { query: 'get', ...options });
    assert.equal(empty.status, 'no-match');
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.results, []);
    assert.equal(empty.hasMore, false);
  }
});

test('paging traverses a stable filtered order once and preserves totals at all boundaries', () => {
  const options = { query: 'get', domain: 'pcb', kind: 'method', limit: 50 };
  const first = searchReference(corpus, { ...options, offset: 0 });
  assert.ok(first.total > first.limit);
  assert.equal(first.hasMore, true);
  assert.deepEqual(searchReference(corpus, { ...options, offset: 0 }), first);
  const ids = [];
  for (let offset = 0; offset < first.total; offset += options.limit) {
    const page = searchReference(corpus, { ...options, offset });
    assert.equal(page.total, first.total);
    assert.equal(page.offset, offset);
    assert.equal(page.hasMore, offset + page.results.length < first.total);
    ids.push(...page.results.map(item => item.id));
  }
  assert.equal(ids.length, first.total);
  assert.equal(new Set(ids).size, first.total);
  const last = searchReference(corpus, { ...options, offset: first.total - 1 });
  assert.equal(last.results.length, 1);
  assert.equal(last.hasMore, false);
  for (const offset of [first.total, first.total + 1, Number.MAX_SAFE_INTEGER]) {
    const empty = searchReference(corpus, { ...options, offset });
    assert.equal(empty.status, 'matched');
    assert.equal(empty.total, first.total);
    assert.deepEqual(empty.results, []);
    assert.equal(empty.hasMore, false);
  }
  const missing = searchReference(corpus, { query: 'certainly-no-such-api', domain: 'pcb', offset: 0 });
  assert.equal(missing.status, 'no-match');
  assert.equal(missing.total, 0);
  assert.equal(missing.hasMore, false);
});

test('legacy search output and ranking remain unchanged without new options', () => {
  const legacy = searchReference(corpus, { query: 'get' });
  assert.equal(legacy.limit, 8);
  assert.deepEqual(Object.keys(legacy), ['readOnly', 'source', 'evidenceScope', 'status', 'query', 'expandedTerms', 'total', 'limit', 'results']);
  const paged = searchReference(corpus, { query: 'get', offset: 0 });
  assert.deepEqual(paged.results, legacy.results);
  assert.equal(paged.total, legacy.total);
  const cli = run(['search', '--query', 'get', '--domain', 'pcb', '--class', 'PCB_PrimitiveVia', '--kind', 'method', '--limit', '2', '--offset', '2']);
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.equal(result.offset, 2);
  assert.equal(result.class, 'PCB_PrimitiveVia');
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every(item => item.entryId === 'PCB_PrimitiveVia'));
});

test('filter and paging arguments report invalid, duplicate and missing values', () => {
  for (const [field, value, code] of [
    ['offset', -1, 'INVALID_OFFSET'], ['offset', 0.5, 'INVALID_OFFSET'], ['offset', NaN, 'INVALID_OFFSET'], ['offset', null, 'INVALID_OFFSET'], ['offset', Number.MAX_SAFE_INTEGER + 1, 'INVALID_OFFSET'],
    ['domain', 'invented', 'INVALID_DOMAIN'], ['domain', null, 'INVALID_DOMAIN'],
    ['class', '', 'INVALID_CLASS'], ['class', '../PCB_PrimitiveVia', 'INVALID_CLASS'], ['class', 'PCB_PrimitiveVia#get', 'INVALID_CLASS'],
  ]) assert.throws(() => searchReference(corpus, { query: 'get', [field]: value }), { code });
  for (const args of [
    ['search', '--query', 'get', '--offset', '-1'], ['search', '--query', 'get', '--offset', '1.5'], ['search', '--query', 'get', '--offset', 'NaN'], ['search', '--query', 'get', '--offset', ''],
    ['search', '--query', 'get', '--domain', 'invented'], ['search', '--query', 'get', '--class', ''],
    ['search', '--query', 'get', '--offset', '0', '--offset', '1'], ['search', '--query', 'get', '--domain', 'pcb', '--domain', 'pcb'],
    ['search', '--query', 'get', '--class', 'PCB_PrimitiveVia', '--class', 'PCB_PrimitiveVia'],
    ['search', '--query', 'get', '--offset'], ['search', '--query', 'get', '--class'], ['show', '--id', 'PCB_PrimitiveVia', '--offset', '0'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(JSON.parse(result.stderr).status, 'error');
  }
});

test('default member output contains an intact signature and type references, not examples', () => {
  const result = showReference(corpus, { id: 'IPCB\\_PrimitiveComponent#getAllPins' });
  assert.equal(result.status, 'found');
  assert.equal(result.signature, 'function getAllPins(): Promise<Array<IPCB_PrimitiveComponentPad>>;');
  assert.ok(result.relatedTypes.some(item => item.id === 'IPCB_PrimitiveComponentPad'));
  assert.equal(Object.hasOwn(result, 'text'), false);
  assert.ok(JSON.stringify(result).length < 2000);
});

test('explicit full show returns only the complete selected member without cutting its example', () => {
  const result = showReference(corpus, { id: 'IPCB_PrimitiveComponent#getallpins', full: true });
  assert.equal(result.status, 'found');
  assert.ok(result.text.startsWith('### getallpins\n'));
  assert.match(result.text, /function getAllPins\(\): Promise<Array<IPCB_PrimitiveComponentPad>>;/);
  assert.match(result.text, /console\.log\('firstPinPrimitiveId:', pinInfos\[0\]\.primitiveId\);\s*```$/);
  assert.ok(!result.text.includes('### getstate_addintobom'));
  assert.equal(result.textSha256, sha(result.text));
});

test('default search and show retain deprecation and edition restrictions from documentation', () => {
  const old = showReference(corpus, { id: 'SCH_Netlist#getnetlist' });
  assert.ok(old.statusFlags.includes('deprecated'));
  assert.ok(old.notes.some(note => /obsolete/i.test(note.text) && /SCH_ManufactureData\.getNetlistFile/.test(note.text)));
  const search = searchReference(corpus, { query: 'SCH_Netlist#getnetlist' });
  assert.ok(search.results[0].statusFlags.includes('deprecated'));
  const manufacture = showReference(corpus, { id: 'PCB_ManufactureData#getmanufacturedata' });
  assert.ok(manufacture.statusFlags.includes('beta'));
  assert.ok(manufacture.notes.some(note => note.kind === 'remarks' && /only valid for the private deployment edition/i.test(note.text)));
  assert.ok(manufacture.notes.some(note => /throw Error/.test(note.text)));
  assert.equal(Object.hasOwn(manufacture, 'text'), false);
  const ordinary = showReference(corpus, { id: 'IPCB_PrimitiveComponent#getstate_pads' });
  assert.deepEqual(ordinary.statusFlags, []);
  assert.deepEqual(ordinary.notes, []);
});

test('examples do not mark an API deprecated and long remarks disclose their truncation', async () => temporaryTask(async directory => {
  const text = '# Demo class\n\n### ordinary\n\n# Demo.ordinary() method\n\n## Signature\n\n```typescript\nordinary(): void;\n```\n\n## Remarks\n\n' + 'An ordinary documented limitation. '.repeat(40) + '\n\n## Example\n\n> Warning: This API is now obsolete.\n\n```text\n## Deprecated\nThis API is beta.\n```\n\n### old\n\n# Demo.old() method\n\n> Warning: This API is deprecated.\n';
  const file = join(directory, 'fixture.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, source: { status: 'fixture' }, entries: [{ id: 'Demo', kind: 'class', text, sha256: sha(text), sourceUrl: 'https://prodocs.lceda.cn/en/api/reference/pro-api.demo.html' }] }));
  const model = await loadCorpus(file), result = showReference(model, { id: 'Demo#ordinary' });
  assert.deepEqual(result.statusFlags, []);
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].truncated, true);
  assert.ok(result.notes[0].text.length <= 801);
  assert.ok(!result.notes[0].text.includes('obsolete'));
  assert.deepEqual(showReference(model, { id: 'Demo' }).statusFlags, []);
  assert.ok(showReference(model, { id: 'Demo#old' }).statusFlags.includes('deprecated'));
}));

test('overloads and unqualified members report ambiguity; unknown members never fall back to a class', () => {
  const overloaded = showReference(corpus, { id: 'PCB_PrimitiveComponent.get' });
  assert.equal(overloaded.status, 'ambiguous');
  assert.deepEqual(overloaded.choices.map(item => item.id), ['PCB_PrimitiveComponent#get', 'PCB_PrimitiveComponent#get_1']);
  assert.equal(showReference(corpus, { id: 'getAllPins' }).status, 'ambiguous');
  assert.equal(showReference(corpus, { id: 'PCB_PrimitiveComponent#notAFunction' }).status, 'not-found');
  assert.match(showReference(corpus, { id: 'PCB_PrimitiveComponent#get_1' }).signature, /primitiveIds: Array<string>/);
  assert.equal(showReference(corpus, { id: 'EPCB_LayerId#BOARD_OUTLINE' }).kind, 'enum-member');
});

test('query metacharacters are literal and invalid inputs are explicit', () => {
  assert.doesNotThrow(() => searchReference(corpus, { query: '[.*+$()' }));
  for (const options of [{ query: '' }, { query: 'pad', kind: 'invented' }, { query: 'pad', limit: 0 }, { query: 'pad', limit: 1.5 }]) assert.throws(() => searchReference(corpus, options));
  for (const args of [['search', '--query', 'pad', '--query', 'hole'], ['show', '--id', 'IPCB_PrimitivePad', '--full', '--full'], ['show', '--id'], ['search', '--query', 'pad', '--unsafe']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).status, 'error');
  }
});

test('corpus validation rejects duplicate identities and modified source text', async () => temporaryTask(async directory => {
  const raw = JSON.parse(await readFile(join(root, 'adapters/easyeda-pro/api-reference/corpus.json'), 'utf8'));
  const file = join(directory, 'fixture.json');
  raw.entries = [raw.entries[0], { ...raw.entries[0] }];
  await writeFile(file, JSON.stringify(raw));
  await assert.rejects(loadCorpus(file), { code: 'DUPLICATE_CORPUS_ID' });
  raw.entries = [{ ...raw.entries[0], text: raw.entries[0].text + 'modified' }];
  await writeFile(file, JSON.stringify(raw));
  await assert.rejects(loadCorpus(file), { code: 'INVALID_CORPUS_ENTRY' });
}));

test('member boundaries ignore Markdown headings inside examples', async () => temporaryTask(async directory => {
  const text = '# Demo class\n\nExample.\n\n### first\n\n# Demo.first() method\n\n## Signature\n\n```typescript\nfirst(): void;\n```\n\n## Example\n\n```text\n### fake\n# Demo.fake() method\n```\n\n### second\n\n# Demo.second() method\n\n## Signature\n\n```typescript\nsecond(): void;\n```\n';
  const file = join(directory, 'fixture.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, source: { status: 'fixture' }, entries: [{ id: 'Demo', kind: 'class', text, sha256: sha(text), sourceUrl: 'https://prodocs.lceda.cn/en/api/reference/pro-api.demo.html' }] }));
  const model = await loadCorpus(file), result = showReference(model, { id: 'Demo#first', full: true });
  assert.match(result.text, /### fake/);
  assert.ok(!result.text.includes('### second'));
  assert.equal(showReference(model, { id: 'Demo#fake' }).status, 'not-found');
}));

test('isolated lookup needs only its scripts and corpus and creates no application state', async () => temporaryTask(async directory => {
  const installed = join(directory, 'installed');
  for (const relative of ['scripts/api-reference.mjs', 'scripts/lib/api-reference.mjs', 'scripts/lib/cli-entrypoint.mjs', 'adapters/easyeda-pro/api-reference/corpus.json']) {
    const target = join(installed, relative);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, relative), target);
  }
  const result = spawnSync(process.execPath, [join(installed, 'scripts/api-reference.mjs'), 'search', '--query', '封装', '--limit', '2'], { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, FLITREALIZE_HOME: join(directory, 'unregistered') } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results.length, 2);
  assert.deepEqual(await readdir(directory), ['installed']);
}));
