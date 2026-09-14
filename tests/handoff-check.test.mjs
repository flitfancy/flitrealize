import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../scripts/handoff-check.mjs', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'flitrealize-handoff-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, '项目');
  await mkdir(root);
  const contents = { 'source.json': '{"revision":1}', 'readback.json': '{"observed":true}', 'runner.mjs': 'throw new Error("must never execute");' };
  for (const [path, content] of Object.entries(contents)) await writeFile(join(root, path), content);
  const checkpoint = {
    schemaVersion: 1, updatedAt: '2026-09-11T12:00:00Z', projectRoot: root, stage: 'pcb-layout', objective: '整理布局，不布线',
    target: { provider: 'easyeda-pro', projectId: 'project-a', documentId: 'board-a' },
    entrypoint: { root: 'project', path: 'runner.mjs', sha256: digest(contents['runner.mjs']), args: ['--plan'] },
    nextAction: '先回读用户手动修改后的布局', openItems: ['尚未保存'],
    artifacts: [
      { id: 'source', path: 'source.json', sha256: digest(contents['source.json']) },
      { id: 'readback', path: 'readback.json', sha256: digest(contents['readback.json']) },
    ],
    checks: [
      { id: 'layout', status: 'verified', scope: '仅核对 U1 坐标', checkedAt: '2026-09-11T11:59:00Z', inputs: ['source'], evidence: ['readback'], limitations: ['没有检查其他元件'] },
      { id: 'save', status: 'unknown', scope: '保存状态', checkedAt: null, inputs: ['source'], evidence: [], limitations: [] },
    ],
  };
  async function save(value = checkpoint) {
    await writeFile(join(root, 'CURRENT_HANDOFF.md'), '# 测试项目\n\n## 0. 当前交接\n\n```flitrealize-handoff\n' + JSON.stringify(value, null, 2) + '\n```\n\n## 3. PCB\n\n人工维护的其他章节。\n');
  }
  await save();
  return { parent, root, checkpoint, save };
}

function run(root, ...args) {
  const result = spawnSync(process.execPath, [runner, ...args, '--project-root', root], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, FLITREALIZE_HOME: join(root, 'unexpected-host') },
  });
  assert.equal(result.error, undefined);
  return { code: result.status, output: JSON.parse(result.stdout || result.stderr) };
}

test('handoff checks references without promoting recorded verification or save state', async t => {
  const { root } = await fixture(t);
  const before = await readFile(join(root, 'CURRENT_HANDOFF.md'));
  const names = await readdir(root);
  const { code, output } = run(root, 'inspect');
  assert.equal(code, 0);
  assert.equal(output.recordStatus, 'consistent');
  assert.equal(output.readOnly, true);
  assert.equal(output.liveEdaChecked, false);
  assert.equal(output.checks[0].recordedStatus, 'verified');
  assert.equal(output.checks[0].referenceIntegrity, 'current');
  assert.equal(output.checks[1].recordedStatus, 'unknown');
  assert.deepEqual(output.openItems, ['尚未保存']);
  assert.equal(output.stage, 'pcb-layout');
  assert.equal(output.ok, undefined);
  assert.deepEqual(await readFile(join(root, 'CURRENT_HANDOFF.md')), before);
  assert.deepEqual(await readdir(root), names);
});

test('source, evidence and entrypoint changes require reconciliation', async t => {
  const { root } = await fixture(t);
  for (const file of ['source.json', 'readback.json', 'runner.mjs']) {
    const prior = await readFile(join(root, file));
    await writeFile(join(root, file), 'changed');
    const { code, output } = run(root, 'inspect');
    assert.equal(code, 1);
    assert.equal(output.recordStatus, 'needs-reconciliation');
    assert(output.issues.some(issue => issue.code === 'HASH_MISMATCH'));
    if (file !== 'runner.mjs') assert.equal(output.checks[0].referenceIntegrity, 'outdated');
    await writeFile(join(root, file), prior);
  }
});

test('missing evidence and wrong project are not accepted', async t => {
  const { root, parent, checkpoint, save } = await fixture(t);
  checkpoint.projectRoot = parent;
  await save();
  assert.equal(run(root, 'inspect').output.error.code, 'PROJECT_ROOT_MISMATCH');
  checkpoint.projectRoot = root;
  await save();
  await rm(join(root, 'readback.json'));
  const { code, output } = run(root, 'inspect');
  assert.equal(code, 1);
  assert(output.issues.some(issue => issue.code === 'MISSING_FILE'));
  assert.equal(output.checks[0].referenceIntegrity, 'outdated');
});

test('legacy and missing handoffs are explicit and never auto-created', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'CURRENT_HANDOFF.md'), '# 旧项目\n布局已完成，下一步请回读确认。');
  assert.equal(run(root, 'inspect').output.recordStatus, 'legacy');
  assert.equal(run(root, 'inspect').code, 2);
  await rm(join(root, 'CURRENT_HANDOFF.md'));
  assert.equal(run(root, 'inspect').output.error.code, 'MISSING_HANDOFF');
  assert(!(await readdir(root)).includes('CURRENT_HANDOFF.md'));
});

test('malformed, duplicate and unsupported checkpoints fail clearly', async t => {
  const { root, checkpoint, save } = await fixture(t);
  for (const change of [
    value => { value.schemaVersion = 2; },
    value => { value.checks[0].status = 'success'; },
    value => { value.artifacts.push(value.artifacts[0]); },
    value => { value.checks[0].inputs = ['nonexistent']; },
    value => { value.checks[0].evidence = []; },
    value => { value.checks[0].inputs = []; },
    value => { value.checks[0].saved = true; },
    value => { value.artifacts[0].sha256 = 'todo'; },
  ]) {
    const value = structuredClone(checkpoint);
    change(value);
    await save(value);
    assert.equal(run(root, 'inspect').code, 2);
  }
  await save();
  const text = await readFile(join(root, 'CURRENT_HANDOFF.md'), 'utf8');
  await writeFile(join(root, 'CURRENT_HANDOFF.md'), text + text);
  assert.equal(run(root, 'inspect').output.error.code, 'MULTIPLE_CHECKPOINTS');
  await writeFile(join(root, 'CURRENT_HANDOFF.md'), '```flitrealize-handoff\n{bad}\n```');
  assert.equal(run(root, 'inspect').output.error.code, 'INVALID_CHECKPOINT');
});

test('unsafe, temporary and symlink-escaped artifact paths are rejected', async t => {
  const { root, parent, checkpoint, save } = await fixture(t);
  for (const path of ['../outside.json', '/outside.json', 'dir\\file', '.flitrealize/runs/a.json', 'source.json:stream', 'a/../source.json']) {
    const value = structuredClone(checkpoint);
    value.artifacts[0].path = path;
    await save(value);
    assert.equal(run(root, 'inspect').code, 2);
  }
  const outside = join(parent, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'evidence.json'), 'outside');
  await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  checkpoint.artifacts[0].path = 'linked/evidence.json';
  await save();
  const result = run(root, 'inspect');
  assert.equal(result.code, 1);
  assert(result.output.issues.some(issue => issue.code === 'UNSAFE_PATH'));
});

test('fingerprint is read-only and accepts only an explicit in-scope file', async t => {
  const { root } = await fixture(t);
  const result = run(root, 'fingerprint', '--file', 'source.json');
  assert.equal(result.code, 0);
  assert.equal(result.output.sha256, digest(await readFile(join(root, 'source.json'))));
  assert.equal(result.output.readOnly, true);
  assert.equal(run(root, 'fingerprint', '--file', '../outside').code, 2);
  assert.equal(run(root, 'fingerprint', '--file', '.').code, 2);
  assert.equal(run(root, 'inspect', '--apply').code, 2);
  assert.equal(run(root, 'fingerprint').code, 2);
});

test('unused source changes do not erase unaffected recorded checks', async t => {
  const { root, checkpoint, save } = await fixture(t);
  await writeFile(join(root, 'other.json'), 'before');
  checkpoint.artifacts.push({ id: 'other', path: 'other.json', sha256: digest('before') });
  checkpoint.checks.push({ id: 'other-check', status: 'blocked', scope: '等待资料', checkedAt: null, inputs: ['other'], evidence: [], limitations: ['缺资料'] });
  await save();
  await writeFile(join(root, 'other.json'), 'after');
  const { output } = run(root, 'inspect');
  assert.equal(output.checks[0].referenceIntegrity, 'current');
  assert.equal(output.checks[2].referenceIntegrity, 'outdated');
  assert.equal(output.checks[2].recordedStatus, 'blocked');
});

test('skill entrypoint fingerprints resolve relative to the installed checker', async t => {
  const { root, checkpoint, save } = await fixture(t);
  const fingerprint = run(root, 'fingerprint', '--root', 'skill', '--file', 'scripts/handoff-check.mjs');
  assert.equal(fingerprint.code, 0);
  assert.equal(fingerprint.output.sha256, digest(await readFile(runner)));
  checkpoint.entrypoint = { root: 'skill', path: 'scripts/handoff-check.mjs', sha256: fingerprint.output.sha256, args: ['--help'] };
  await save();
  assert.equal(run(root, 'inspect').output.entrypoint.integrity, 'current');
});

test('early project can have no EDA target, script or completed checks', async t => {
  const { root, checkpoint, save } = await fixture(t);
  Object.assign(checkpoint, { stage: 'requirements', target: null, entrypoint: null, artifacts: [], checks: [], openItems: ['输出负载待确认'] });
  await save();
  const result = run(root, 'inspect');
  assert.equal(result.code, 0);
  assert.equal(result.output.target, null);
  assert.deepEqual(result.output.openItems, ['输出负载待确认']);
  assert.deepEqual(result.output.checks, []);
  checkpoint.updatedAt = 'not-a-date';
  await save();
  assert.equal(run(root, 'inspect').code, 2);
});

test('project root junction is accepted but handoff symlink escape is not', async t => {
  const { root, parent } = await fixture(t);
  const alias = join(parent, 'project-alias');
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(run(alias, 'inspect').code, 0);
  const externalRoot = join(parent, 'external-project');
  await mkdir(externalRoot);
  await symlink(root, join(externalRoot, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  // The fingerprint must not follow an escaped directory even for a handoff file.
  const escaped = run(externalRoot, 'fingerprint', '--file', 'redirect/CURRENT_HANDOFF.md');
  assert.equal(escaped.code, 2);
  assert.equal(escaped.output.error.code, 'UNSAFE_PATH');
});
