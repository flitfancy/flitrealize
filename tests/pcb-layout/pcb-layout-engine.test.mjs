import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { layoutImplementationRecords } from '../../scripts/pcb-layout/pcb-layout-engine.mjs';
import { layoutEngineIdentity, skillDirectory } from '../../scripts/pcb-layout/pcb-layout-project.mjs';

const ignored = [
  'scripts/providers/easyeda-pro/routing-native.js',
  'scripts/providers/easyeda-pro/routing-provider.mjs',
  'scripts/providers/easyeda-pro/pcb-layout-native/source.js',
  'scripts/pcb-layout/pcb-layout-solver-report.mjs',
  'scripts/pcb-layout/pcb-layout-catalog-report.mjs',
  'scripts/pcb-layout/pcb-layout-model-report.mjs',
  'scripts/pcb-layout/pcb-layout-report-ui.mjs',
  'scripts/pcb-layout/pcb-layout-spacing-report.mjs',
  'scripts/pcb-layout/pcb-layout-spacing-policy-report.mjs',
];
async function copyImplementation(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'layout-engine-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new Set([...(await layoutImplementationRecords(skillDirectory)).map(([file]) => file), ...ignored]);
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.copyFile(path.join(skillDirectory, file), path.join(root, file));
  }
  return root;
}
const identity = root => layoutEngineIdentity({ skillRoot: root });
async function mutate(root, file, change, check) {
  const target = path.join(root, file), original = await fs.readFile(target, 'utf8');
  try { await fs.writeFile(target, change(original)); await check(); }
  finally { await fs.writeFile(target, original); }
}

test('layout dependency closure includes transitive, generated-native, worker, Python and host code', async () => {
  const files = new Set((await layoutImplementationRecords(skillDirectory)).map(([file]) => file));
  for (const file of [
    'scripts/pcb-layout/pcb-layout-prepare.mjs', 'scripts/pcb-layout/pcb-footprint-audit.mjs',
    'scripts/pcb-layout/pcb-layout-solver-core.mjs', 'scripts/pcb-layout/pcb-layout-mechanical-plan.mjs',
    'scripts/pcb-layout/pcb-layout-solver-worker.mjs', 'scripts/pcb-layout/pcb-layout-cpsat.py', 'scripts/pcb-layout/pcb-layout-blocks.py',
    'scripts/providers/easyeda-pro/pcb-layout-input.mjs', 'scripts/providers/easyeda-pro/pcb-layout-board.mjs',
    'scripts/providers/easyeda-pro/pcb-layout-native/runtime.js',
    ...['inspect', 'apply', 'verify', 'save'].map(phase => 'scripts/providers/easyeda-pro/pcb-layout-native/' + phase + '.js'),
    'scripts/eda-host.mjs', 'scripts/lib/state-paths.mjs', 'scripts/providers/easyeda-pro/cli-channel.mjs',
    'adapters/easyeda-pro/scripts/bridge-control.mjs', 'adapters/easyeda-pro/scripts/bridge-server.mjs', 'adapters/easyeda-pro/scripts/request-store.mjs',
    'adapters/easyeda-pro/package.json', 'adapters/easyeda-pro/package-lock.json',
    'scripts/pcb-routing/geometry.mjs', 'schemas/pcb-layout-intent.v1.schema.json',
  ]) assert.ok(files.has(file), file);
  for (const file of ignored) assert.equal(files.has(file), false, file);
});

test('algorithm, validation, common copper geometry and dynamic execution changes invalidate candidates', async t => {
  const root = await copyImplementation(t), before = await identity(root);
  for (const file of [
    'scripts/pcb-layout/pcb-layout-solver-core.mjs', 'scripts/pcb-layout/pcb-layout-prepare.mjs',
    'scripts/pcb-layout/pcb-footprint-audit.mjs', 'scripts/pcb-layout/pcb-layout-solver-worker.mjs',
    'scripts/pcb-layout/pcb-layout-cpsat.py', 'scripts/pcb-layout/pcb-layout-blocks.py',
    'scripts/pcb-layout/pcb-layout-assembly-policy.mjs', 'scripts/providers/easyeda-pro/pcb-layout-board.mjs',
    'scripts/providers/easyeda-pro/pcb-layout-native/runtime.js', 'scripts/providers/easyeda-pro/pcb-layout-native/apply.js', 'scripts/providers/easyeda-pro/pcb-layout-native/preflight.js',
    'scripts/providers/easyeda-pro/pcb-layout-native/verify.js', 'scripts/providers/easyeda-pro/pcb-layout-native/save.js',
    'scripts/pcb-routing/geometry.mjs', 'scripts/eda-host.mjs', 'scripts/lib/state-paths.mjs',
    'scripts/providers/easyeda-pro/cli-channel.mjs', 'adapters/easyeda-pro/scripts/bridge-server.mjs',
    'adapters/easyeda-pro/scripts/request-store.mjs',
  ]) await mutate(root, file, text => text + (file.endsWith('.py') ? '\nFINGERPRINT_REGRESSION = 1\n' : '\nconst fingerprintRegression = 1;\n'), async () => assert.notDeepEqual(await identity(root), before, file));
  await mutate(root, 'schemas/pcb-layout-intent.v1.schema.json', text => JSON.stringify({ ...JSON.parse(text), required: [...(JSON.parse(text).required ?? []), 'newRequiredField'] }), async () => assert.notDeepEqual(await identity(root), before));
  await mutate(root, 'adapters/easyeda-pro/package.json', text => { const p = JSON.parse(text); p.dependencies.ws = 'changed'; return JSON.stringify(p); }, async () => assert.notDeepEqual(await identity(root), before));
  await mutate(root, 'adapters/easyeda-pro/package-lock.json', text => { const p = JSON.parse(text); p.packages['node_modules/ws'].integrity = 'changed'; return JSON.stringify(p); }, async () => assert.notDeepEqual(await identity(root), before));
});

test('independent routing, converter source and pure presentation changes keep layout identity', async t => {
  const root = await copyImplementation(t), before = await identity(root);
  for (const file of ignored) await mutate(root, file, text => text + '\n// independent change\n', async () => assert.deepEqual(await identity(root), before, file));
  await mutate(root, 'scripts/actions/manifest.json', text => { const p = JSON.parse(text); p.workflows = {}; p.actions = {}; return JSON.stringify(p); }, async () => assert.deepEqual(await identity(root), before));
  await mutate(root, 'scripts/actions/manifest.json', text => { const p = JSON.parse(text); p.providers['easyeda-pro'].kind = 'other'; return JSON.stringify(p); }, async () => assert.notDeepEqual(await identity(root), before));
});

test('new relative imports and literal resources are followed; missing or undeclared dynamic edges fail closed', async t => {
  const root = await copyImplementation(t), before = await identity(root), owner = 'scripts/pcb-layout/pcb-layout-solver-core.mjs';
  const extra = path.join(root, 'scripts/pcb-layout/fingerprint-extra.mjs');
  await fs.writeFile(extra, 'export const value = 1;');
  await mutate(root, owner, text => text + "\nimport './fingerprint-extra.mjs';\n", async () => {
    const first = await identity(root); assert.notDeepEqual(first, before);
    await fs.writeFile(extra, 'export const value = 2;'); assert.notDeepEqual(await identity(root), first);
    await fs.unlink(extra); await assert.rejects(identity(root), /ENOENT/);
  });
  await mutate(root, owner, text => text + '\nawait import(unregisteredModule);\n', async () => assert.rejects(identity(root), /UNDECLARED_DYNAMIC_IMPORT/));
  await mutate(root, owner, text => text + '\nnew URL(variableResource, import.meta.url);\n', async () => assert.rejects(identity(root), /UNDECLARED_DYNAMIC_RESOURCE/));
  await mutate(root, 'scripts/eda-host.mjs', text => text + '\nawait import(unregisteredModule);\n', async () => assert.rejects(identity(root), /UNDECLARED_DYNAMIC_IMPORT/));
  await mutate(root, 'scripts/providers/easyeda-pro/pcb-layout.mjs', text => text + '\nnew URL(unregisteredResource, import.meta.url);\n', async () => assert.rejects(identity(root), /UNDECLARED_DYNAMIC_RESOURCE/));
  await mutate(root, 'scripts/pcb-layout/pcb-layout-execution.mjs', text => text + "\nstep('new-phase');\n", async () => assert.rejects(identity(root), /UNDECLARED_NATIVE_PHASE/));
  await fs.unlink(path.join(root, 'scripts/providers/easyeda-pro/pcb-layout-native/apply.js'));
  await assert.rejects(identity(root), /ENOENT/);
});

test('identity ignores checkout paths and mtimes', async t => {
  const root = await copyImplementation(t), before = await identity(skillDirectory);
  assert.deepEqual(await identity(root), before);
  await fs.utimes(path.join(root, 'scripts/pcb-layout/pcb-layout-solver-core.mjs'), new Date(0), new Date(0));
  assert.deepEqual(await identity(root), before);
});

test('a separate layout entry can bind its own dependency closure without coupling default candidates', async t => {
  const root = await copyImplementation(t), before = await identity(root);
  const entry = 'scripts/fine-entry-fixture.mjs', dependency = 'scripts/fine-fixture-model.mjs';
  await fs.writeFile(path.join(root, entry), "import './fine-fixture-model.mjs';\n");
  await fs.writeFile(path.join(root, dependency), 'export const mode = 1;');
  assert.deepEqual(await identity(root), before);
  const options = { skillRoot: root, entrypoints: [entry] }, first = await layoutEngineIdentity(options);
  assert.notDeepEqual(first, before);
  await fs.writeFile(path.join(root, dependency), 'export const mode = 2;');
  assert.notDeepEqual(await layoutEngineIdentity(options), first);
  assert.deepEqual(await identity(root), before);
  await assert.rejects(layoutEngineIdentity({ skillRoot: root, entrypoints: ['../outside.mjs'] }), /INVALID_LAYOUT_ENGINE_ENTRYPOINT/);
  await assert.rejects(layoutEngineIdentity({ skillRoot: root, entrypoints: ['C' + ':/outside.mjs'] }), /INVALID_LAYOUT_ENGINE_ENTRYPOINT/);
});

test('schema descriptions and formatting keep identity; fields with annotation names remain constraints',async t=>{
 const root=await copyImplementation(t),before=await identity(root),file='schemas/pcb-layout-intent.v1.schema.json';
 await mutate(root,file,text=>{const p=JSON.parse(text);p.title='新标题';p.description='更新说明';p.$comment='Documentation only';return JSON.stringify(p,null,4);},async()=>assert.deepEqual(await identity(root),before));
 await mutate(root,file,text=>{const p=JSON.parse(text);p.properties={...p.properties,title:{type:'number'}};return JSON.stringify(p);},async()=>assert.notDeepEqual(await identity(root),before));
 await mutate(root,file,text=>{const p=JSON.parse(text);p.default={schemaVersion:2};return JSON.stringify(p);},async()=>assert.notDeepEqual(await identity(root),before));
});
