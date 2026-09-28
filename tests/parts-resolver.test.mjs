import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { generateDatasheets, validateInput } from '../scripts/parts/parts-resolver.mjs';

const pdf = Buffer.from('%PDF-1.7\nsynthetic test bytes\n');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'parts-resolver-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('parts-resolver-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const databaseRoot = path.join(root, 'database'), projectRoot = path.join(root, 'project');
  await fs.mkdir(databaseRoot); await fs.mkdir(projectRoot);
  const calls = [];
  const options = { projectRoot, databaseRoot, fetchImpl: async url => { calls.push(url); throw Error('unexpected network call'); } };
  async function cached(name, identity, bytes = pdf) {
    const dir = path.join(databaseRoot, name); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'datasheet.pdf'), bytes);
    await fs.writeFile(path.join(dir, 'part.json'), JSON.stringify({ version: 1, ...identity, pdfSha256: digest(bytes) }));
    return dir;
  }
  const run = async part => (await generateDatasheets({ parts: [part] }, options)).manifest.results[0];
  return { root, options, databaseRoot, projectRoot, calls, cached, run };
}

test('complete input accepts known fields and rejects non-string identity values', () => {
  assert.deepEqual(validateInput({ parts: [{ lcsc: 'C101', manufacturer: 'Example', mpn: 'ABC-1', keywords: ['switch'] }] }), []);
  assert.ok(validateInput({ lcsc: 'C101' }).length);
  for (const part of [null, [], { lcsc: 'C101', manufacturer: 123 }, { lcsc: 'C101', mpn: false }]) assert.ok(validateInput({ parts: [part] }).length);
  assert.deepEqual(validateInput({ parts: [{ mpn: 'SHARED', manufacturer: 'A' }, { mpn: 'SHARED', manufacturer: 'B' }] }), []);
});

test('a matching supplier cache is reused without network or cache writes', async t => {
  const f = await fixture(t), dir = await f.cached('C101', { mpn: 'ABC-1', manufacturer: 'Example' });
  const before = await fs.readFile(path.join(dir, 'part.json'));
  const result = await f.run({ lcsc: 'C101', mpn: 'abc-1', manufacturer: 'Example' });
  assert.equal(result.result, 'local'); assert.equal(result.mpn, 'ABC-1'); assert.equal(result.manufacturer, 'Example');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await fs.readFile(path.join(dir, 'part.json')), before);
});

test('a supplier-code hit cannot conceal a conflicting requested MPN or manufacturer', async t => {
  const f = await fixture(t), dir = await f.cached('C101', { mpn: 'ABC-1', manufacturer: 'Example' });
  const before = await fs.readFile(path.join(dir, 'part.json'));
  for (const request of [{ lcsc: 'C101', mpn: 'ABC-2' }, { lcsc: 'C101', manufacturer: 'Different' }]) {
    const result = await f.run(request);
    assert.equal(result.result, 'error'); assert.equal(result.code, 'PART_IDENTITY_CONFLICT');
    assert.ok(result.conflicts.length > 0);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await fs.readFile(path.join(dir, 'part.json')), before);
});

test('MPN punctuation is retained and manufacturer narrows an otherwise ambiguous cache', async t => {
  const f = await fixture(t);
  await f.cached('vendor-a', { mpn: 'ABC-1', manufacturer: 'A' });
  await f.cached('vendor-b', { mpn: 'ABC-1', manufacturer: 'B' });
  assert.equal((await f.run({ mpn: 'ABC1' })).result, 'needs_lookup');
  const ambiguous = await f.run({ mpn: 'ABC-1' });
  assert.equal(ambiguous.result, 'error'); assert.equal(ambiguous.code, 'AMBIGUOUS_PART_CACHE');
  const selected = await f.run({ mpn: 'ABC-1', manufacturer: 'B' });
  assert.equal(selected.result, 'local'); assert.equal(selected.manufacturer, 'B');
  assert.deepEqual(f.calls, []);
});

test('a changed PDF with a recorded checksum is not returned as a valid local cache', async t => {
  const f = await fixture(t), dir = await f.cached('part', { mpn: 'ABC-1' });
  await fs.writeFile(path.join(dir, 'datasheet.pdf'), Buffer.from('%PDF-1.7\nchanged\n'));
  const result = await f.run({ mpn: 'ABC-1' });
  assert.equal(result.result, 'needs_lookup'); assert.deepEqual(f.calls, []);
});

test('duplicate cache copies of the same recorded identity are reusable without ambiguity', async t => {
  const f = await fixture(t);
  await f.cached('second-copy', { mpn: 'ABC-1', manufacturer: 'Example' });
  const selected = await f.cached('first-copy', { mpn: 'abc-1', manufacturer: 'EXAMPLE' });
  const result = await f.run({ mpn: 'ABC-1', manufacturer: 'Example' });
  assert.equal(result.result, 'local');
  assert.equal(path.resolve(result.localData), path.resolve(selected));
  assert.deepEqual(f.calls, []);
});

test('a damaged PDF does not erase the identity of an occupied cache directory', async t => {
  const f = await fixture(t), dir = await f.cached('MPN_ABC_A', { mpn: 'ABC_A', manufacturer: 'Example' });
  await fs.writeFile(path.join(dir, 'datasheet.pdf'), Buffer.from('damaged'));
  const recordBefore = await fs.readFile(path.join(dir, 'part.json'));
  f.options.fetchImpl = async url => { f.calls.push(url); return new Response(pdf); };
  const result = await f.run({ mpn: 'ABC/A', manufacturer: 'Example', url: 'https://example.test/abc.pdf' });
  assert.equal(result.result, 'error');
  assert.equal(result.code, 'PART_IDENTITY_CONFLICT');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await fs.readFile(path.join(dir, 'part.json')), recordBefore);
  assert.equal(await fs.readFile(path.join(dir, 'datasheet.pdf'), 'utf8'), 'damaged');
  const repaired = await f.run({ mpn: 'ABC_A', manufacturer: 'Example', url: 'https://example.test/original.pdf' });
  assert.equal(repaired.result, 'downloaded');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await fs.readFile(path.join(dir, 'datasheet.pdf')), pdf);
});

test('LCSC identity conflicts are reported before downloading or creating a cache record', async t => {
  const f = await fixture(t);
  f.options.fetchImpl = async url => {
    f.calls.push(url);
    const product = { '@type': 'Product', sku: 'C101', brand: { name: 'Example' }, mpn: 'ABC-2', subjectOf: [{ name: 'datasheet', url: 'https://example.test/datasheet.pdf' }] };
    return new Response('<script type="application/ld+json">' + JSON.stringify(product) + '</script>');
  };
  const result = await f.run({ lcsc: 'C101', mpn: 'ABC-1', manufacturer: 'Example' });
  assert.equal(result.result, 'error'); assert.equal(result.code, 'PART_IDENTITY_CONFLICT');
  assert.equal(f.calls.length, 1); assert.deepEqual(await fs.readdir(f.databaseRoot), []);
});

test('an explicit PDF URL is acquired once and then reused with its recorded source and checksum', async t => {
  const f = await fixture(t);
  f.options.fetchImpl = async url => { f.calls.push(url); return new Response(pdf); };
  const part = { mpn: 'ABC-1', manufacturer: 'Example', url: 'https://example.test/abc.pdf' };
  const first = await f.run(part); assert.equal(first.result, 'downloaded');
  const record = JSON.parse(await fs.readFile(path.join(first.localData, 'part.json')));
  assert.equal(record.datasheetUrl, part.url); assert.equal(record.pdfSha256, digest(pdf));
  const second = await f.run(part); assert.equal(second.result, 'local'); assert.equal(f.calls.length, 1);
});

test('a storage-name collision never replaces a different valid cached identity', async t => {
  const f = await fixture(t), dir = await f.cached('MPN_ABC_A', { mpn: 'ABC_A', manufacturer: 'Example' });
  const before = await fs.readFile(path.join(dir, 'part.json'));
  const result = await f.run({ mpn: 'ABC/A', manufacturer: 'Example', url: 'https://example.test/abc.pdf' });
  assert.equal(result.result, 'error'); assert.equal(result.code, 'PART_IDENTITY_CONFLICT');
  assert.deepEqual(f.calls, []); assert.deepEqual(await fs.readFile(path.join(dir, 'part.json')), before);
});
