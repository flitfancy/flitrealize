import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderFacts, runHandoffSync } from '../scripts/handoff-sync.mjs';

const START = '<!-- flitrealize:facts:start -->';
const END = '<!-- flitrealize:facts:end -->';
const prefix = '# 项目文稿\r\n\r\n人工理由：CELL_N 不与 GND 合并。\r\n' + START;
const suffix = END + '\r\n\r\n## 后续工作\r\n用户手写的安排。\r\n';
const unknown = /未知|未核验|未确认|未报告|unknown/i;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function data() {
  const contract = {
    kind: 'flitrealize.schematic-contract', schemaVersion: 1, project: { id: 'example', revision: 'A0' },
    blocks: [{ id: 'power', purpose: 'Power path', components: ['U1', 'J1', 'TP1'] }],
    components: [
      { designator: 'U1', role: 'Power controller', identity: { mpn: 'ExampleIC', value: 'Controller' }, footprint: { name: 'QFN-4' },
        pins: [{ number: 'OUT', function: 'regulated output', classification: 'power-out' }, { number: 'NC', function: 'unused', classification: 'no-connect' }],
        bindings: { easyedaPro: { pinMap: { OUT: ['1'], NC: ['2'] } } } },
      { designator: 'J1', role: 'Output header', identity: { mpn: 'Header-1' }, footprint: { name: 'P2.54' },
        pins: [{ number: '1', function: 'Output', classification: 'power-out' }],
        bindings: { easyedaPro: { pinMap: { '1': ['1'] } } } },
      { designator: 'TP1', role: 'PCB test pad', pins: [{ number: '1', function: 'Output', classification: 'passive' }] },
    ],
    nets: [{ name: 'VOUT', endpoints: [{ component: 'U1', pin: 'OUT' }, { component: 'J1', pin: '1' }, { component: 'TP1', pin: '1' }] }],
  };
  const snapshot = {
    kind: 'flitrealize.schematic-snapshot', schemaVersion: 1, provider: 'easyeda-pro',
    capturedAt: '2026-09-12T12:00:00.000Z',
    project: { id: 'native-project', nativeId: 'native-project' }, document: { id: 'native-sheet', nativeId: 'native-sheet', type: 'schematic' },
    components: [
      { designator: 'U1', nativeId: 'u1', value: 'Controller', pins: [
        { number: '1', net: 'VOUT', noConnect: false }, { number: '2', net: null, noConnect: true },
        { number: 'MP1', net: null, noConnect: true },
      ] },
      { designator: 'J1', nativeId: 'j1', value: 'Header-1', pins: [{ number: '1', net: null, noConnect: false }] },
    ],
  };
  const connections = {
    expectedProjectUuid: 'native-project', expectedDocumentUuid: 'native-sheet',
    deferredComponents: [{ designator: 'TP1', reason: 'PCB-only test pad' }],
    providerPinNoConnect: [{ designator: 'U1', pin: 'MP1', reason: 'Isolated mechanical tab' }],
  };
  return { contract, snapshot, connections };
}

async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'flitrealize-facts-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const values = data();
  for (const [name, value] of Object.entries(values)) await writeFile(join(projectRoot, `${name}.json`), JSON.stringify(value));
  await writeFile(join(projectRoot, 'CURRENT_HANDOFF.md'), prefix + '\r\n\r\n' + suffix);
  const options = { projectRoot, contractFile: 'contract.json', snapshotFile: 'snapshot.json', connectionsFile: 'connections.json' };
  return { ...values, options, projectRoot, handoff: join(projectRoot, 'CURRENT_HANDOFF.md') };
}

// File contents, mtimes and directory inventory catch accidental evidence/cache writes.
async function inventory(root, relative = '') {
  const result = [];
  for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(relative, entry.name), info = await stat(join(root, path));
    result.push({ path, mtime: info.mtimeMs, content: entry.isFile() ? digest(await readFile(join(root, path))) : null });
    if (entry.isDirectory()) result.push(...await inventory(root, path));
  }
  return result;
}

async function blockedWithoutWrites(options) {
  const before = await inventory(options.projectRoot);
  let result;
  try { result = await runHandoffSync({ ...options, mode: 'apply' }); }
  catch (error) { result = { ok: false, error }; }
  assert.equal(result.ok, false, 'invalid input must not report a successful apply');
  assert.deepEqual(await inventory(options.projectRoot), before);
}

function rows(markdown, designator) {
  return markdown.split(/\r?\n/).filter(line => line.startsWith('|') && line.includes(designator));
}

test('preview and check never create files or touch mtimes', async t => {
  const f = await fixture(t), before = await inventory(f.projectRoot);
  const preview = await runHandoffSync(f.options);
  assert.equal(preview.ok, true);
  assert.equal(preview.readOnly, true);
  assert.equal(preview.written, false);
  assert.equal(preview.changed, true);
  assert.match(preview.markdown, /VOUT/);
  const check = await runHandoffSync({ ...f.options, mode: 'check' });
  assert.equal(check.ok, false, 'an empty generated region is not synchronized');
  assert.equal(check.written, false);
  assert.deepEqual(await inventory(f.projectRoot), before);
});

test('apply preserves all human text, repeated apply is a no-op and check passes', async t => {
  const f = await fixture(t);
  const first = await runHandoffSync({ ...f.options, mode: 'apply' });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(first.written, true);
  const text = await readFile(f.handoff, 'utf8');
  assert.ok(text.startsWith(prefix));
  assert.ok(text.endsWith(suffix));
  assert.match(text.slice(prefix.length), /^\s*<!-- flitrealize:facts:sha256=[0-9a-f]{64} -->/);
  await utimes(f.handoff, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  const before = await inventory(f.projectRoot);
  const second = await runHandoffSync({ ...f.options, mode: 'apply' });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(second.written, false);
  const check = await runHandoffSync({ ...f.options, mode: 'check' });
  assert.equal(check.ok, true);
  assert.equal(check.changed, false);
  assert.deepEqual(await inventory(f.projectRoot), before);
});

test('changed source refreshes only generated facts without changing observation time', async t => {
  const f = await fixture(t);
  await runHandoffSync({ ...f.options, mode: 'apply' });
  f.contract.components[0].identity.mpn = 'RevisedIC';
  await writeFile(join(f.projectRoot, 'contract.json'), JSON.stringify(f.contract));
  const before = await inventory(f.projectRoot);
  const check = await runHandoffSync({ ...f.options, mode: 'check' });
  assert.equal(check.ok, false);
  assert.deepEqual(await inventory(f.projectRoot), before);
  const update = await runHandoffSync({ ...f.options, mode: 'apply' });
  assert.equal(update.written, true);
  const text = await readFile(f.handoff, 'utf8');
  assert.match(text, /RevisedIC/);
  assert.match(text, /2026-09-12T12:00:00\.000Z/);
  assert.ok(text.startsWith(prefix) && text.endsWith(suffix));
});

test('missing, duplicate, reversed and partial markers block writes', async t => {
  const f = await fixture(t);
  for (const body of [
    '# User has not selected a generated region', START + '\n', END + '\n' + START,
    START + '\n' + START + '\n' + END, START + '\n' + END + '\n' + END,
  ]) {
    await writeFile(f.handoff, body);
    await blockedWithoutWrites(f.options);
  }
  await rm(f.handoff);
  await blockedWithoutWrites(f.options);
});

test('unowned contents and human edits within generated region are never overwritten', async t => {
  const f = await fixture(t);
  await writeFile(f.handoff, prefix + '\nUser-owned table\n' + suffix);
  await blockedWithoutWrites(f.options);
  await writeFile(f.handoff, prefix + '\n\n' + suffix);
  await runHandoffSync({ ...f.options, mode: 'apply' });
  const prior = await readFile(f.handoff, 'utf8');
  assert.match(prior, /VOUT/);
  await writeFile(f.handoff, prior.replace('VOUT', 'USER_EDIT'));
  await blockedWithoutWrites(f.options);
});

test('no snapshot keeps all observed implementation unknown', () => {
  const f = data(), before = JSON.stringify(f);
  const markdown = renderFacts({ contract: f.contract, connections: f.connections });
  assert.match(markdown, unknown);
  const componentRows = rows(markdown, 'U1');
  assert.ok(componentRows.length > 0);
  assert.ok(componentRows.every(line => !/\|\s*(已实现|已回读|observed|realized)\s*\|/i.test(line)));
  assert.match(markdown, /VOUT/);
  assert.equal(JSON.stringify(f), before, 'rendering must not mutate inputs');
});

test('physical mappings, intentional NC and explicit deferrals remain distinct from unknown nets', () => {
  const f = data(), markdown = renderFacts(f);
  const u1 = rows(markdown, 'U1');
  assert.ok(u1.some(line => line.includes('regulated output') && line.includes('VOUT') && /\|\s*1\s*\|/.test(line)));
  assert.ok(u1.some(line => /\|\s*2\s*\|/.test(line) && /NC/.test(line)));
  assert.ok(u1.some(line => line.includes('MP1') && line.includes('Isolated mechanical tab')));
  assert.ok(rows(markdown, 'TP1').some(line => line.includes('PCB-only test pad')));
  const j1 = rows(markdown, 'J1').find(line => line.includes('VOUT'));
  assert.ok(j1, 'expected network must still be present even without a measured net');
  assert.match(j1, unknown);
  assert.doesNotMatch(j1, /\|\s*(断开|未连接|disconnected)\s*\|/i, 'null net is missing evidence, not proof of disconnection');
});

test('a missing physical mapping is not invented from matching pin numbers', () => {
  const f = data();
  delete f.contract.components[1].bindings;
  const markdown = renderFacts(f);
  const expected = rows(markdown, 'J1').find(line => line.includes('VOUT'));
  assert.match(expected, /映射未提供|映射未知/);
  assert.ok(rows(markdown, 'J1').some(line => line.includes('映射未覆盖') && /\|\s*1\s*\|/.test(line)));
});

test('Markdown metacharacters cannot inject rows, links or HTML through facts', () => {
  const f = data();
  f.contract.components[0].role = 'A | B\n<script>bad</script> [link](https://example.test)';
  const markdown = renderFacts(f);
  assert.doesNotMatch(markdown, /<script>|\[link\]\(https:\/\/example\.test\)/);
  assert.doesNotMatch(markdown, /^<script>/m);
  assert.ok(rows(markdown, 'U1').some(line => line.includes('A') && line.includes('B')));
});

test('target mismatch blocks apply and leaves the entire project untouched', async t => {
  const f = await fixture(t);
  f.connections.expectedDocumentUuid = 'different-sheet';
  await writeFile(join(f.projectRoot, 'connections.json'), JSON.stringify(f.connections));
  await blockedWithoutWrites(f.options);
});

test('successful inspect report is accepted, failed or wrong-action envelopes are not', async t => {
  const f = await fixture(t);
  const report = { action: 'schematic-inspect', mode: 'inspect', provider: 'easyeda-pro', response: { success: true, result: { status: 'inspected-with-gaps', snapshot: f.snapshot } } };
  await writeFile(join(f.projectRoot, 'snapshot.json'), JSON.stringify(report));
  const preview = await runHandoffSync(f.options);
  assert.equal(preview.ok, true);
  assert.match(preview.markdown, /2026-09-12T12:00:00\.000Z/);
  for (const malformed of [
    { ...report, response: { ...report.response, success: false } },
    { ...report, action: 'schematic-save-verify' },
    { ...report, response: { success: true, result: { snapshot: { ...f.snapshot, schemaVersion: 999 } } } },
  ]) {
    await writeFile(join(f.projectRoot, 'snapshot.json'), JSON.stringify(malformed));
    await blockedWithoutWrites(f.options);
  }
});

test('CLI preview is compact by default and prints tables only when explicitly requested', async t => {
  const f = await fixture(t), before = await inventory(f.projectRoot);
  const runner = fileURLToPath(new URL('../scripts/handoff-sync.mjs', import.meta.url));
  const args = [runner, '--project-root', f.projectRoot, '--contract', 'contract.json', '--snapshot', 'snapshot.json', '--connections', 'connections.json'];
  for (const print of [false, true]) {
    const result = spawnSync(process.execPath, [...args, ...(print ? ['--print'] : [])], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.readOnly, true);
    assert.equal(Object.hasOwn(output, 'markdown'), print);
  }
  assert.deepEqual(await inventory(f.projectRoot), before);
});
