import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadCorpus, searchReference, showReference } from '../scripts/lib/api-reference.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const corpus = await loadCorpus();
const sha = text => createHash('sha256').update(text).digest('hex');
const run = args => spawnSync(process.execPath, [join(root, 'scripts/api-reference.mjs'), ...args], { encoding: 'utf8', windowsHide: true });
async function temporaryTask(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'flitrealize-api-reference-'));
  try { return await fn(directory); }
  finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('flitrealize-api-reference-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('historical corpus retains complete document inventory and source provenance', async () => {
  assert.equal(corpus.entries.length, 346);
  assert.equal(corpus.source.version, '1.1.22');
  assert.equal(corpus.source.status, 'historical-snapshot');
  assert.equal(corpus.source.currentApiAvailability, 'not-verified');
  const provenance = JSON.parse(await readFile(join(root, 'adapters/easyeda-pro/api-reference/provenance.json'), 'utf8'));
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

test('default member output contains an intact signature and type references, not examples', () => {
  const result = showReference(corpus, { id: 'IPCB\\_PrimitiveComponent#getAllPins' });
  assert.equal(result.status, 'found');
  assert.equal(result.signature, 'public getAllPins(): Promise<Array<IPCB_PrimitiveComponentPad>>;');
  assert.ok(result.relatedTypes.some(item => item.id === 'IPCB_PrimitiveComponentPad'));
  assert.equal(Object.hasOwn(result, 'text'), false);
  assert.ok(JSON.stringify(result).length < 2000);
});

test('explicit full show returns only the complete selected member without cutting its example', () => {
  const result = showReference(corpus, { id: 'IPCB_PrimitiveComponent#getallpins', full: true });
  assert.equal(result.status, 'found');
  assert.ok(result.text.startsWith('### getallpins\n'));
  assert.match(result.text, /public getAllPins\(\): Promise<Array<IPCB_PrimitiveComponentPad>>;/);
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
  const result = spawnSync(process.execPath, [join(installed, 'scripts/api-reference.mjs'), 'search', '--query', '封装', '--limit', '2'], { cwd: directory, encoding: 'utf8', windowsHide: true, env: { ...process.env, FLITREALIZE_HOME: join(directory, 'unregistered') } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results.length, 2);
  assert.deepEqual(await readdir(directory), ['installed']);
}));
