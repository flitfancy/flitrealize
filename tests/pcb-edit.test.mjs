import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPcbEdit } from '../scripts/pcb-edit.mjs';
import { pcbFixture } from './helpers/pcb-tools-fixture.mjs';
import { pcbActionExecutor } from './helpers/pcb-edit-fixture.mjs';
import { loadAction } from './helpers/action-harness.mjs';

const inputs = {
  'pcb-net-color': { rules: [{ nets: ['PWR'], color: '#FF0000' }] },
  'pcb-trace-width': { rules: [{ net: 'PWR', primitiveIds: ['l1'], targetWidthMil: 25 }] },
  'pcb-placement': { boardBounds: { minX: 0, minY: 0, maxX: 1000, maxY: 500 }, lockedDesignators: ['U1'], reservedRegions: [], placements: [{ designator: 'R1', x: 200, y: 200 }] },
};
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const routing = await loadAction('pcb-routing-plan');

test('routing kind reaches the color wrapper, opaque readback and save', async t => {
  for (const [style, expected] of [
    [{ kind: 'power' }, { r: 216, g: 92, b: 92, alpha: 1 }],
    [{ kind: 'i2c_scl' }, { r: 40, g: 116, b: 91, alpha: 1 }],
    [{ kind: 'i2c_sda' }, { r: 70, g: 130, b: 180, alpha: 1 }],
    [{ color: '#112233' }, { r: 17, g: 34, b: 51, alpha: 1 }],
    [{ kind: 'power', color: '#112233' }, { r: 17, g: 34, b: 51, alpha: 1 }],
  ]) {
    const f = await fixture(t, 'pcb-net-color');
    const generated = await routing(null, { ...f.target, rules: { units: 'mil', classes: [
      { name: 'PWR', nets: ['PWR'], priority: 1, widthMil: 25, ...style },
    ] } });
    assert.ok(generated.colorPlanRequest, 'Routing must emit a color request for kind as well as color');
    await writeFile(f.inputFile, JSON.stringify(generated.colorPlanRequest));
    const result = await runPcbEdit({ ...f.options, apply: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.saved, true);
    assert.deepEqual(f.calls, ['plan', 'apply']);
    assert.deepEqual(f.scene.netClasses.find(c => c.name === 'PWR').color, expected);
  }
});

test('color preview and apply expose the same assignments through the command entrypoint', async t => {
  const f = await fixture(t, 'pcb-net-color', { save: true, rules: [{ name: 'PWR', kind: 'power' }] });
  const preview = await runPcbEdit(f.options);
  assert.equal(preview.saved, null);
  assert.equal(f.scene.saves, 0);
  const planned = (await json(preview.steps[0].reportFile)).response.result;
  assert.deepEqual(preview.assignments, planned.assignments);
  assert.equal(preview.changedCount, planned.changedCount);
  const applied = await runPcbEdit({ ...f.options, apply: true });
  assert.deepEqual(applied.assignments, preview.assignments);
  assert.equal(applied.changedCount, preview.changedCount);
  assert.equal(applied.saved, true);
  const repeated = await runPcbEdit({ ...f.options, apply: true });
  assert.equal(repeated.changedCount, 0);
  assert.deepEqual(repeated.assignments, preview.assignments);
  assert.equal(f.scene.writes.length, 2);
});

test('routing preserves multi-class selection and same-kind colors through apply', async t => {
  const f = await fixture(t, 'pcb-net-color');
  const generated = await routing(null, { ...f.target, rules: { units: 'mil', classes: [
    { name: 'PWR', nets: ['PWR'], priority: 1, widthMil: 25, kind: 'power' },
    { name: 'SIG', nets: ['SIG'], priority: 2, widthMil: 8, kind: 'power' },
  ] } });
  await writeFile(f.inputFile, JSON.stringify(generated.colorPlanRequest));
  const result = await runPcbEdit({ ...f.options, apply: true });
  assert.equal(result.ok, true);
  assert.equal(result.changedCount, 2);
  assert.deepEqual(result.assignments.map(c => c.hex), ['#D85C5C', '#D85C5C']);
  assert.deepEqual(f.scene.netClasses.map(c => [c.name, c.nets]), [['PWR', ['PWR']], ['SIG', ['SIG']]]);
  assert.equal(f.scene.saves, 1);
});

test('upstream requires complete coloring input and the corrected request can be passed directly to coloring', async t => {
  const f = await fixture(t, 'pcb-net-color');
  const input = { ...f.target, requireColor: true, netNames: ['PWR', 'SIG'], rules: { units: 'mil', classes: [
    { name: 'PWR', nets: ['PWR'], priority: 1, widthMil: 25, kind: 'power' },
    { name: 'SIG', nets: ['SIG'], priority: 2, widthMil: 8 },
  ] } };
  await assert.rejects(routing(null, input), { code: 'COLOR_KIND_REQUIRED' });
  assert.equal(f.scene.writes.length, 0);
  input.rules.classes[1].kind = 'enable';
  const generated = await routing(null, input);
  await writeFile(f.inputFile, JSON.stringify(generated.colorPlanRequest));
  const result = await runPcbEdit({ ...f.options, apply: true });
  assert.equal(result.ok, true);
  assert.equal(result.saved, true);
  assert.deepEqual(result.assignments.map(c => [c.name, c.nets, c.hex]), [
    ['PWR', ['PWR'], '#D85C5C'], ['SIG', ['SIG'], '#009B77'],
  ]);
});

test('routing rejects partial color groups; unspecified styling stays unchanged and unknown kinds cannot write', async t => {
  const f = await fixture(t, 'pcb-net-color');
  for (const style of [{ kind: 'power' }, { color: '#112233' }]) {
    await assert.rejects(routing(null, { ...f.target, selectNets: ['PWR'], rules: { units: 'mil', classes: [
      { name: 'PWR', nets: ['PWR', 'PWR2'], priority: 1, widthMil: 25, ...style },
    ] } }), { code: 'PARTIAL_CLASS_COLOR' });
  }
  const input = { ...f.target, rules: { units: 'mil', classes: [
    { name: 'PWR', nets: ['PWR'], priority: 1, widthMil: 25 },
  ] } };
  assert.equal((await routing(null, input)).colorPlanRequest, undefined);
  input.rules.classes[0].kind = 'unknown-kind';
  const generated = await routing(null, input);
  await writeFile(f.inputFile, JSON.stringify(generated.colorPlanRequest));
  const result = await runPcbEdit({ ...f.options, apply: true });
  assert.equal(result.ok, false);
  assert.equal(f.scene.writes.length, 0);
  assert.equal(f.scene.saves, 0);
});

async function fixture(t, action = 'pcb-trace-width', overrides = {}) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'flitrealize-pcb-edit-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const { scene, eda, target } = pcbFixture();
  if (action === 'pcb-placement') scene.lines = [];
  const inputFile = join(projectRoot, 'input.json');
  await writeFile(inputFile, JSON.stringify({ ...target, ...inputs[action], ...overrides }));
  const execute = pcbActionExecutor(eda), calls = [];
  const invoke = async (name, input, context) => { calls.push(input.mode); return execute(name, input, context); };
  return { projectRoot, scene, eda, target, inputFile, calls, invoke, options: { projectRoot, action, inputFile, invoke } };
}

test('default plans preserve source and retain a separate report for each supported PCB Action', async t => {
  for (const action of Object.keys(inputs)) {
    const f = await fixture(t, action);
    const source = await f.eda.sys_FileManager.getDocumentSource();
    const result = await runPcbEdit(f.options);
    assert.equal(result.status, 'planned'); assert.equal(result.ok, true); assert.equal(result.readOnly, true);
    assert.deepEqual(f.calls, ['plan']); assert.equal(f.scene.writes.length, 0); assert.equal(f.scene.saves, 0);
    assert.equal(await f.eda.sys_FileManager.getDocumentSource(), source);
    assert.equal((await json(result.steps[0].reportFile)).response.result.status, 'planned');
    assert.deepEqual(await json(result.reportFile), result);
  }
});

test('wrapper uses two calls for color and the separate verification/save flow for layout and width', async t => {
  for (const action of Object.keys(inputs)) {
    const f = await fixture(t, action);
    const result = await runPcbEdit({ ...f.options, apply: true });
    assert.equal(result.status, 'verified', JSON.stringify(result));
    assert.equal(result.ok, true); assert.equal(result.saved, true); assert.equal(result.readOnly, false);
    assert.deepEqual(f.calls, action === 'pcb-net-color' ? ['plan', 'apply'] : ['plan', 'apply', 'verify', 'save', 'verify']);
    assert.equal(f.scene.saves, 1); assert.equal(f.scene.writes.length, action === 'pcb-net-color' ? 2 : 1);
    for (const step of result.steps) {
      assert.equal((await json(step.inputFile)).mode, step.mode);
      assert.equal((await json(step.reportFile)).mode, step.mode);
    }
    if (action !== 'pcb-net-color') assert.equal((await json(result.resumeSaveReport)).response.result.status, 'applied');
  }
});

test('color wrapper preserves save outcomes and stops after a failed or unknown apply', async t => {
  for (const failure of ['write', 'save', 'after-save', 'transport']) {
    const f = await fixture(t, 'pcb-net-color');
    if (failure === 'write') f.eda.pcb_Drc.createNetClass = async () => false;
    if (failure === 'save') f.eda.pcb_Document.save = async () => false;
    if (failure === 'after-save') f.eda.pcb_Document.save = async () => {
      f.scene.netClasses.find(c => c.name === 'PWR').color.alpha = 0;
      return true;
    };
    const invoke = async (action, input, context) => {
      if (failure === 'transport' && input.mode === 'apply') throw Object.assign(new Error('lost reply'), { code: 'ETIMEDOUT' });
      return f.invoke(action, input, context);
    };
    const result = await runPcbEdit({ ...f.options, invoke, apply: true });
    assert.equal(result.ok, false);
    assert.equal(result.saved, failure === 'write' ? false : failure === 'after-save' ? true : null);
    assert.equal(result.status, failure === 'transport' ? 'outcome-unknown' : 'apply-failed');
    assert.deepEqual(result.steps.map(s => s.mode), ['plan', 'apply']);
    assert.equal(result.resumeSaveReport, undefined);
    assert.equal(result.changedCount, null, 'A failed apply must not report the preview count as completed work');
  }
});

test('color rejects a returned result for another PCB even when action and status match', async t => {
  const f = await fixture(t, 'pcb-net-color');
  const invoke = async (...args) => {
    const report = await f.invoke(...args);
    if (args[1].mode === 'apply') report.response.result.target = { ...f.target, expectedDocumentUuid: 'foreign-pcb' };
    return report;
  };
  const result = await runPcbEdit({ ...f.options, invoke, apply: true });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'outcome-unknown');
  assert.equal(result.saved, null);
});

test('routing rejects invalid class names and incomplete targets instead of generating unusable requests', async () => {
  const { target } = pcbFixture();
  const rules = { units: 'mil', classes: [{ name: 'PWR', nets: ['PWR'], kind: 'power', priority: 1, widthMil: 25 }] };
  await assert.rejects(routing(null, { ...target, rules: { ...rules, classes: [{ ...rules.classes[0], name: ' PWR ' }] } }), { code: 'INVALID_CLASS' });
  await assert.rejects(routing(null, { expectedProjectUuid: target.expectedProjectUuid, rules }), { code: 'TARGET_REQUIRED' });
  await assert.rejects(routing(null, { ...target, expectedDocumentUuid: ' ', rules }), { code: 'TARGET_REQUIRED' });
  assert.equal((await routing(null, { rules })).colorPlanRequest, undefined);
});

const scenarios = [
  { name: 'left', placements: [{ designator: 'R1', x: 200, y: 200 }] },
  { name: 'right', placements: [{ designator: 'R1', x: 600, y: 200 }] },
];
test('candidate comparisons never choose a scenario implicitly and an explicit choice is applied', async t => {
  const f = await fixture(t, 'pcb-placement', { scenarios });
  const planned = await runPcbEdit(f.options);
  assert.equal(planned.status, 'planned'); assert.equal(planned.candidates.length, 2);
  const missing = await runPcbEdit({ ...f.options, apply: true });
  assert.equal(missing.status, 'selection-required'); assert.equal(f.scene.writes.length, 0);
  const chosen = await runPcbEdit({ ...f.options, apply: true, candidate: 'right' });
  assert.equal(chosen.status, 'verified'); assert.equal(chosen.selectedCandidate, 'right');
  assert.equal(f.scene.components.find(item => item.designator === 'R1').x, 600);
});

test('duplicate names, unknown candidates and blocked candidates cannot write', async t => {
  for (const [candidates, name, code] of [
    [[scenarios[0], scenarios[0]], 'left', 'DUPLICATE_CANDIDATE_NAME'],
    [scenarios, 'missing', 'CANDIDATE_NOT_FOUND'],
    [[{ name: 'overlap', placements: [{ designator: 'R1', x: 100, y: 100 }] }], 'overlap', 'BLOCKED_PLAN'],
  ]) {
    const f = await fixture(t, 'pcb-placement', { scenarios: candidates });
    const result = await runPcbEdit({ ...f.options, apply: true, candidate: name });
    assert.equal(result.ok, false); assert.equal(result.error.code, code);
    assert.equal(f.scene.writes.length, 0); assert.equal(f.scene.saves, 0);
  }
});

test('failed writes stop with their partial-change report and do not verify or save', async t => {
  const f = await fixture(t);
  f.scene.afterWrite = () => { throw new Error('simulated failure after mutation'); };
  const result = await runPcbEdit({ ...f.options, apply: true });
  assert.equal(result.status, 'apply-failed'); assert.equal(result.ok, false);
  assert.deepEqual(f.calls, ['plan', 'apply']); assert.equal(f.scene.writes.length, 1); assert.equal(f.scene.saves, 0);
  assert.equal((await json(result.steps[1].reportFile)).response.result.attempted.length, 1);
  assert.equal(result.resumeSaveReport, undefined);
});

test('verification mismatch stops before saving while retaining the successful apply report', async t => {
  const f = await fixture(t);
  const invoke = async (action, input, context) => {
    if (input.mode === 'verify') f.scene.lines[0].lineWidth = 99;
    return f.invoke(action, input, context);
  };
  const result = await runPcbEdit({ ...f.options, invoke, apply: true });
  assert.equal(result.status, 'verify-failed'); assert.equal(f.scene.saves, 0);
  assert.deepEqual(f.calls, ['plan', 'apply', 'verify']); assert.ok(result.resumeSaveReport);
});

test('a change after saving fails the final verification and preserves the confirmed save result', async t => {
  const f = await fixture(t);
  let verifications = 0;
  const invoke = async (action, input, context) => {
    if (input.mode === 'verify' && ++verifications === 2) f.scene.lines[0].lineWidth = 99;
    return f.invoke(action, input, context);
  };
  const result = await runPcbEdit({ ...f.options, invoke, apply: true });
  assert.equal(result.status, 'verify-after-save-failed'); assert.equal(result.saved, true); assert.equal(result.ok, false);
  assert.equal(f.scene.saves, 1); assert.equal(result.steps.at(-1).status, 'mismatch');
});

test('save failure resumes from either workflow or apply report without replaying edits', async t => {
  for (const kind of ['workflow', 'apply']) {
    const f = await fixture(t);
    f.eda.pcb_Document.save = async () => { f.scene.saves++; return false; };
    const failed = await runPcbEdit({ ...f.options, apply: true });
    assert.equal(failed.status, 'save-failed'); assert.equal(failed.saved, null); assert.ok(failed.saveRequest);
    await assert.rejects(readFile(failed.saveAttemptFile), { code: 'ENOENT' });
    const oldReport = await readFile(failed.reportFile, 'utf8');
    f.eda.pcb_Document.save = async () => { f.scene.saves++; return true; };
    f.calls.length = 0;
    const result = await runPcbEdit({ projectRoot: f.projectRoot, invoke: f.invoke, apply: true,
      resumeSave: kind === 'workflow' ? failed.reportFile : failed.resumeSaveReport });
    assert.equal(result.status, 'verified', JSON.stringify(result)); assert.equal(result.saved, true);
    assert.deepEqual(f.calls, ['verify', 'save', 'verify']); assert.equal(f.scene.writes.length, 1);
    assert.equal(await readFile(failed.reportFile, 'utf8'), oldReport);
    assert.notEqual(result.reportFile, failed.reportFile);
    await assert.rejects(readFile(result.saveAttemptFile), { code: 'ENOENT' });
  }
});

test('save recovery rejects a changed live fingerprint and cannot silently reapply', async t => {
  const f = await fixture(t);
  const applied = await runPcbEdit({ ...f.options, apply: true });
  const saves = f.scene.saves;
  f.scene.lines[0].lineWidth = 99; f.calls.length = 0;
  const result = await runPcbEdit({ projectRoot: f.projectRoot, invoke: f.invoke, apply: true, resumeSave: applied.resumeSaveReport });
  assert.equal(result.status, 'verify-failed'); assert.equal(f.scene.saves, saves);
  assert.deepEqual(f.calls, ['verify']); assert.equal(f.scene.writes.length, 1);
});

test('save recovery validates action, successful apply, project-local location and request targets', async t => {
  const f = await fixture(t);
  const result = await runPcbEdit({ ...f.options, apply: true });
  const good = await json(result.resumeSaveReport);
  const mutations = [
    report => { report.mode = 'plan'; },
    report => { report.action = 'schematic-reflow'; },
    report => { report.response.result.status = 'apply-failed'; },
    report => { report.response.result.saveRequest.expectedDocumentUuid = 'another-pcb'; },
    report => { report.response.result.verifyRequest.expectedFingerprint = 'changed'; },
  ];
  f.calls.length = 0;
  for (const [index, mutate] of mutations.entries()) {
    const changed = structuredClone(good); mutate(changed);
    const path = join(f.projectRoot, `invalid-${index}.json`);
    await writeFile(path, JSON.stringify(changed));
    await assert.rejects(runPcbEdit({ projectRoot: f.projectRoot, invoke: f.invoke, apply: true, resumeSave: path }));
  }
  const raw = join(f.projectRoot, 'raw-request.json');
  await writeFile(raw, JSON.stringify(result.saveRequest));
  await assert.rejects(runPcbEdit({ projectRoot: f.projectRoot, invoke: f.invoke, apply: true, resumeSave: raw }), { code: 'INVALID_APPLY_REPORT' });
  await assert.rejects(runPcbEdit({ projectRoot: f.projectRoot, invoke: f.invoke, resumeSave: result.reportFile }), { code: 'INVALID_RESUME' });
  await assert.rejects(runPcbEdit({ projectRoot: f.projectRoot, invoke: f.invoke, apply: true, action: 'pcb-placement', resumeSave: result.reportFile }), { code: 'ACTION_MISMATCH' });
  const other = await fixture(t);
  await assert.rejects(runPcbEdit({ projectRoot: other.projectRoot, invoke: f.invoke, apply: true, resumeSave: result.reportFile }), { code: 'REPORT_OUTSIDE_PROJECT' });
  assert.deepEqual(f.calls, []);
});

test('copied legacy apply reports without project ownership cannot authorize saving', async t => {
  const f = await fixture(t);
  const result = await runPcbEdit({ ...f.options, apply: true });
  const report = await json(result.resumeSaveReport);
  delete report.projectRoot;
  const other = await fixture(t);
  const copied = join(other.projectRoot, 'legacy-apply.json');
  await writeFile(copied, JSON.stringify(report));
  const saves = f.scene.saves;
  await assert.rejects(runPcbEdit({ projectRoot: other.projectRoot, invoke: f.invoke, apply: true, resumeSave: copied }), { code: 'PROJECT_OWNERSHIP_REQUIRED' });
  assert.equal(f.scene.saves, saves);
});

test('unknown saves block recovery through result, original apply, and reformatted copies', async t => {
  const f = await fixture(t);
  const invoke = async (action, input, context) => {
    if (input.mode === 'save') throw Object.assign(new Error('save still pending after transport timeout'), { code: 'ETIMEDOUT' });
    return f.invoke(action, input, context);
  };
  const result = await runPcbEdit({ ...f.options, invoke, apply: true });
  assert.equal(result.status, 'outcome-unknown');
  const marker = await json(result.saveAttemptFile);
  assert.equal(marker.reportFile, result.reportFile);
  const copied = join(f.projectRoot, 'copied-apply.json');
  const apply = await json(result.resumeSaveReport);
  await writeFile(copied, JSON.stringify(Object.fromEntries(Object.entries(apply).reverse())));
  const before = [...f.calls];
  for (const resumeSave of [result.reportFile, result.resumeSaveReport, copied]) {
    await assert.rejects(runPcbEdit({ projectRoot: f.projectRoot, invoke: f.invoke, apply: true, resumeSave }), { code: 'SAVE_RECOVERY_UNRESOLVED' });
  }
  assert.deepEqual(f.calls, before); assert.equal(f.scene.saves, 0);
  assert.deepEqual(await json(result.saveAttemptFile), marker);
});

test('an unknown save during recovery also blocks the older definite-failure result and original apply', async t => {
  const f = await fixture(t);
  f.eda.pcb_Document.save = async () => false;
  const first = await runPcbEdit({ ...f.options, apply: true });
  const invoke = async (action, input, context) => {
    if (input.mode === 'save') return { schemaVersion: 2, action, mode: 'save', response: { success: false, status: 'error', error: { code: 'ETIMEDOUT', message: 'save still in flight' } } };
    return f.invoke(action, input, context);
  };
  const second = await runPcbEdit({ projectRoot: f.projectRoot, apply: true, resumeSave: first.reportFile, invoke });
  assert.equal(second.status, 'outcome-unknown');
  assert.equal(second.saveAttemptFile, first.saveAttemptFile);
  for (const resumeSave of [first.reportFile, first.resumeSaveReport, second.reportFile]) {
    await assert.rejects(runPcbEdit({ projectRoot: f.projectRoot, invoke: f.invoke, apply: true, resumeSave }), { code: 'SAVE_RECOVERY_UNRESOLVED' });
  }
});

test('in-flight saves exclude concurrent recovery and release the marker after confirmed completion', async t => {
  const f = await fixture(t);
  let began, finish;
  const started = new Promise(resolve => { began = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const invoke = async (action, input, context) => {
    if (input.mode === 'save') { began(context); await pending; }
    return f.invoke(action, input, context);
  };
  const running = runPcbEdit({ ...f.options, invoke, apply: true });
  const context = await started;
  try {
    const active = await json(join(dirname(context.reportFile), 'result.json'));
    assert.equal(active.status, 'save-running');
    for (const resumeSave of [active.reportFile, active.resumeSaveReport]) {
      await assert.rejects(runPcbEdit({ projectRoot: f.projectRoot, invoke: f.invoke, apply: true, resumeSave }), { code: 'SAVE_RECOVERY_UNRESOLVED' });
    }
    assert.equal(f.scene.saves, 0);
  } finally { finish(); }
  const result = await running;
  assert.equal(result.status, 'verified'); assert.equal(f.scene.saves, 1);
  await assert.rejects(readFile(result.saveAttemptFile), { code: 'ENOENT' });
});

test('a terminal reply for another action or PCB cannot release an unresolved save attempt', async t => {
  for (const wrongTarget of [false, true]) {
    const f = await fixture(t);
    const invoke = async (action, input, context) => input.mode === 'save'
      ? { action: wrongTarget ? action : 'pcb-placement', mode: 'save', response: { success: true,
        result: { status: 'applied', saved: true, ...(wrongTarget ? { state: { target: { ...f.target, expectedDocumentUuid: 'foreign-pcb' } } } : {}) } } }
      : f.invoke(action, input, context);
    const result = await runPcbEdit({ ...f.options, invoke, apply: true });
    assert.equal(result.status, 'outcome-unknown'); assert.equal(result.error.code, wrongTarget ? 'TARGET_MISMATCH' : 'INVALID_ACTION_REPORT');
    assert.equal((await json(result.saveAttemptFile)).reportFile, result.reportFile);
    await assert.rejects(runPcbEdit({ projectRoot: f.projectRoot, invoke: f.invoke, apply: true, resumeSave: result.resumeSaveReport }), { code: 'SAVE_RECOVERY_UNRESOLVED' });
  }
});

test('returned requests cannot switch the target before apply', async t => {
  const f = await fixture(t);
  const invoke = async (...args) => {
    const report = await f.invoke(...args);
    report.response.result.applyRequest.plan.expectedDocumentUuid = 'foreign-pcb';
    return report;
  };
  const result = await runPcbEdit({ ...f.options, invoke, apply: true });
  assert.equal(result.error.code, 'TARGET_MISMATCH'); assert.equal(f.scene.writes.length, 0);
  assert.deepEqual(f.calls, ['plan']);
});

test('transport loss during apply retains an unknown report and never progresses to save', async t => {
  const f = await fixture(t);
  const invoke = async (action, input, context) => {
    if (input.mode === 'apply') throw Object.assign(new Error('simulated transport loss'), { code: 'ETIMEDOUT' });
    return f.invoke(action, input, context);
  };
  const result = await runPcbEdit({ ...f.options, invoke, apply: true });
  assert.equal(result.status, 'outcome-unknown'); assert.equal(result.resumeSaveReport, undefined);
  assert.equal((await json(result.steps.at(-1).reportFile)).response.executionOutcome, 'unknown');
  assert.equal(f.scene.saves, 0); assert.equal(result.steps.length, 2);
});

test('CLI uses the real runner and preserves a missing-adapter report in isolated host state', async t => {
  const f = await fixture(t);
  const completed = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/pcb-edit.mjs', import.meta.url)),
    '--project-root', f.projectRoot, '--action', 'pcb-net-color', '--input-file', f.inputFile], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, FLITREALIZE_HOME: join(f.projectRoot, 'unregistered-state') },
  });
  assert.equal(completed.status, 1, completed.stderr);
  const result = JSON.parse(completed.stdout);
  assert.equal(result.status, 'plan-failed'); assert.equal(result.readOnly, true); assert.equal(result.steps.length, 1);
  const report = await json(result.steps[0].reportFile);
  assert.equal(report.response.error.code, 'EDA_HOST_ERROR');
  // Windows TEMP may use an 8.3 alias; the runner records the canonical directory.
  assert.equal(report.projectRoot, await realpath(f.projectRoot));
});
