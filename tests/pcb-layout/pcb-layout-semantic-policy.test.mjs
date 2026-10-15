import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { prepareFixture } from '../helpers/pcb-layout-prepare-fixture.mjs';
import { prepareLayoutInputs } from '../../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { convertSemanticInputs } from '../../scripts/pcb-layout/pcb-layout-semantic.mjs';
import { compileSemanticCpSatProblem, runCpsatLayout } from '../../scripts/pcb-layout/pcb-layout-cpsat.mjs';
import { main as layoutMain } from '../../scripts/pcb-layout.mjs';
import { executeHostAction, loadManifest, resolveActionRequest } from '../../scripts/action-runner.mjs';

function fixture() {
  const bundle = prepareFixture();
  bundle.snapshot.sourceKind = 'synthetic-example';
  bundle.config.hard.boardBounds = { minX: -100, minY: -100, maxX: 400, maxY: 300 };
  return bundle;
}
const invalidPolicies = [
  [{ roles: {} }, /RETIRED_SEMANTIC_POLICY:.*roles.*Contract\.blocks/],
  [{ associationWeights: {} }, /RETIRED_SEMANTIC_POLICY:.*associationWeights/],
  [{ groupScope: 'relations' }, /RETIRED_SEMANTIC_POLICY:.*groupScope: relations/],
  [{ groupScope: 'declared-block', groupScpoe: 'relations' }, /UNKNOWN_SEMANTIC_POLICY_FIELD: groupScpoe/],
  [{ groupScope: 'inferred' }, /INVALID_SEMANTIC_GROUP_SCOPE/],
  [{ groupScope: null }, /INVALID_SEMANTIC_GROUP_SCOPE/],
  [null, /INVALID_SEMANTIC_POLICY/],
  [[], /INVALID_SEMANTIC_POLICY/]
];

test('semantic policy accepts only the declared membership contract without a legacy placeholder', () => {
  const bundle = fixture(), model = prepareLayoutInputs(bundle).model, before = JSON.stringify(bundle);
  const baseline = convertSemanticInputs(model);
  for (const policy of [{}, { groupScope: 'declared-block' }]) {
    assert.deepEqual(convertSemanticInputs(model, policy), baseline);
    assert.deepEqual(compileSemanticCpSatProblem(model, {}, { semanticPolicy: policy }).semantic, baseline);
  }
  assert.equal(Object.hasOwn(baseline.policy, 'legacyPolicy'), false);
  assert.deepEqual(baseline.groups.map(group => group.members), [['U1', 'C1']]);
  assert.equal(JSON.stringify(bundle), before);
});

test('retired and misspelled semantic parameters reject even with a supplied solver problem', async () => {
  for (const [policy, error] of invalidPolicies) {
    const model = prepareLayoutInputs(fixture()).model;
    assert.throws(() => convertSemanticInputs(model, policy), error);
    assert.throws(() => compileSemanticCpSatProblem(model, {}, { semanticPolicy: policy }), error);
    await assert.rejects(runCpsatLayout(model, {}, { semanticPolicy: policy, problem: {} }), error);
    model.config.semanticPolicy = policy;
    assert.throws(() => convertSemanticInputs(model), error);
    await assert.rejects(runCpsatLayout(model, {}, { problem: {} }), error);
  }
});

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'layout-semantic-policy-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = fixture();
  bundle.config.contractFile = 'design/contract.json';
  bundle.config.mechanicalRulesFile = 'design/mechanical.json';
  await fs.mkdir(path.join(root, 'design'));
  for (const [file, value] of [['design/contract.json', bundle.contract], ['design/mechanical.json', bundle.mechanical], ['snapshot.json', bundle.snapshot]]) {
    await fs.writeFile(path.join(root, file), JSON.stringify(value));
  }
  const configFile = path.join(root, 'design/PCB_LAYOUT_CONSTRAINTS.v1.json');
  return { root, bundle, configFile, args: ['--project-root', root, '--snapshot', path.join(root, 'snapshot.json')] };
}

test('CLI policy files and project configuration cannot silently keep retired or unknown fields', async t => {
  const f = await project(t), policyFile = path.join(f.root, 'semantic-policy.json');
  for (const policy of [{}, { groupScope: 'declared-block' }]) {
    await fs.writeFile(f.configFile, JSON.stringify(f.bundle.config));
    await fs.writeFile(policyFile, JSON.stringify(policy));
    const result = await layoutMain([...f.args, '--mode', 'semantic', '--semantic-policy', policyFile], { log() {} });
    assert.equal(result.status, 'semantic-ready');
    assert.equal(result.nativeWrites, 0);
  }
  for (const [policy, error] of [invalidPolicies[0], invalidPolicies[3]]) {
    for (const source of ['file', 'config']) for (const mode of ['semantic', 'solve']) {
      const config = { ...f.bundle.config, ...(source === 'config' ? { semanticPolicy: policy } : {}) };
      await fs.writeFile(f.configFile, JSON.stringify(config));
      await fs.writeFile(policyFile, JSON.stringify(policy));
      const args = [...f.args, '--mode', mode, ...(source === 'file' ? ['--semantic-policy', policyFile] : []),
        ...(mode === 'solve' ? ['--backend', 'cpsat', '--python', path.join(f.root, 'must-not-run.exe')] : [])];
      await assert.rejects(layoutMain(args, { log() {} }), error);
    }
  }
  await fs.writeFile(f.configFile, JSON.stringify({ ...f.bundle.config, semanticPolicy: { groupScope: 'relations' } }));
  await assert.rejects(layoutMain([...f.args, '--mode', 'prepare'], { log() {} }), /RETIRED_SEMANTIC_POLICY/);
});

test('Host Actions enforce the same policy on explicit and inherited inputs before solver execution', async () => {
  const manifest = await loadManifest();
  const invoke = input => executeHostAction(resolveActionRequest(manifest, 'pcb-functional-layout', input), input);
  const result = await invoke({ bundle: fixture(), semanticPolicy: { groupScope: 'declared-block' } });
  assert.equal(result.result.status, 'planned');
  assert.equal(result.result.nativeWrites, 0);
  for (const [policy, error] of [invalidPolicies[0], invalidPolicies[3]]) {
    for (const source of ['explicit', 'config']) for (const mode of ['semantic', 'solve']) {
      const bundle = fixture();
      if (source === 'config') bundle.config.semanticPolicy = policy;
      await assert.rejects(invoke({ bundle, mode, ...(source === 'explicit' ? { semanticPolicy: policy } : {}), options: { problem: {} } }), error);
    }
  }
});
