import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runSchematicConnect } from '../../scripts/schematic-connect.mjs';
import { connectFixture } from '../helpers/connect-fixture.mjs';
import { loadAction } from '../helpers/action-harness.mjs';

const options = fixture => ({ projectRoot: fixture.root, inputFile: fixture.inputFile, invoke: fixture.invoke });
const apply = fixture => runSchematicConnect({ ...options(fixture), apply: true });
const mutations = eda => eda.calls.filter(call => call.mutates).map(call => call.action);
const explain = result => JSON.stringify(result.error || result, null, 2);

test('default connect planning uses live source evidence and never writes EDA', async t => {
  const f = await connectFixture(t);
  const result = await runSchematicConnect(options(f));
  assert.equal(result.status, 'planned', explain(result));
  assert.equal(result.ok, true);
  assert.equal(result.readOnly, true);
  assert.deepEqual(result.pending, { wires: 2, markers: 2, noConnect: 2 });
  assert.deepEqual(mutations(f.eda), []);
  assert.equal(f.eda.wires.length, 0);
  assert.equal(f.eda.saveCount, 0);
});

test('apply creates wires, hidden-name markers and NC before complete reflow, strict save and final audit', async t => {
  const f = await connectFixture(t, { reflow: true });
  const result = await apply(f);
  assert.equal(result.status, 'connected-saved', explain(result));
  assert.equal(result.ok, true);
  assert.deepEqual(mutations(f.eda), ['schematic-wire-create', 'schematic-net-flag', 'schematic-no-connect', 'schematic-reflow', 'schematic-save-verify']);
  assert.equal(f.eda.wires.length, 2);
  assert.equal(f.eda.markers.length, 2);
  assert(f.eda.markers.every(marker => marker.visible === false));
  assert(f.eda.parts.every(part => part.pins[1].noConnected === true));
  assert.equal(result.saved, true);
  assert.equal(result.checks.drc.passed, true);
  assert.equal(result.checks.reflow.status, 'verified');
  assert.equal(result.checks.noConnect.status, 'verified');
  assert.deepEqual(f.eda.drcArgs, [true, false, true]);
  assert.equal(f.eda.calls.at(-1).action, 'schematic-component-place', 'the final source read includes native occupancy');
  const audit = JSON.parse(await readFile(join(result.runDir, 'saved-audit.json'), 'utf8'));
  assert.equal(audit.verified, true);
  assert(await readFile(join(result.runDir, 'before.esch'), 'utf8'));
});

test('a repeated apply preserves existing wires and markers without duplicate creation', async t => {
  const f = await connectFixture(t);
  const first = await apply(f);
  assert.equal(first.ok, true, explain(first));
  const beforeIds = [...f.eda.wires, ...f.eda.markers].map(row => row.id);
  const planned = await runSchematicConnect(options(f));
  assert.equal(planned.ok, true, explain(planned));
  assert.deepEqual(planned.pending, { wires: 0, markers: 0, noConnect: 0 });
  const beforeNcApplies = f.eda.calls.filter(call => call.action === 'schematic-no-connect' && call.mode === 'apply').length;
  const beforeNcWrites = f.eda.ncWrites;
  const repeated = await apply(f);
  assert.equal(repeated.ok, true, explain(repeated));
  assert.equal(f.eda.wireCreates, 2);
  assert.equal(f.eda.markerCreates, 2);
  assert.deepEqual([...f.eda.wires, ...f.eda.markers].map(row => row.id), beforeIds);
  assert.equal(repeated.checks.noConnect.status, 'verified');
  assert.equal(repeated.checks.noConnect.declaredCount, 2);
  assert.equal(f.eda.calls.filter(call => call.action === 'schematic-no-connect' && call.mode === 'apply').length, beforeNcApplies);
  assert.equal(f.eda.ncWrites, beforeNcWrites);
});

test('an empty NC set is still assessed and recorded; omitted reflow stays explicit', async t => {
  const f = await connectFixture(t, { withNc: false });
  const result = await apply(f);
  assert.equal(result.ok, true, explain(result));
  assert.equal(result.checks.noConnect.status, 'not-applicable');
  assert.equal(result.checks.noConnect.declaredCount, 0);
  assert.equal(f.eda.ncWrites, 0);
  assert.equal(result.checks.reflow.status, 'not-requested');
  assert.equal(f.eda.reflowCount, 0);
});

test('a missing marker on an existing named stub is repaired without another wire', async t => {
  const f = await connectFixture(t);
  assert.equal((await apply(f)).ok, true);
  const retainedMarker = f.eda.markers[1].id;
  f.eda.markers.splice(0, 1);
  const result = await apply(f);
  assert.equal(result.ok, true, explain(result));
  assert.equal(f.eda.wireCreates, 2);
  assert.equal(f.eda.markerCreates, 3);
  assert.equal(f.eda.markers.length, 2);
  assert(f.eda.markers.some(marker => marker.id === retainedMarker));
});

test('more than 30 endpoints are replanned against each preceding batch', async t => {
  const f = await connectFixture(t, { count: 31, withNc: false });
  const result = await apply(f);
  assert.equal(result.ok, true, explain(result));
  assert.equal(f.eda.wires.length, 31);
  assert.equal(f.eda.markers.length, 31);
  assert.equal(mutations(f.eda).filter(action => action === 'schematic-wire-create').length, 2);
  assert.equal(mutations(f.eda).filter(action => action === 'schematic-net-flag').length, 2);
});

test('a wrong target or changed source blocks writes before creating objects', async t => {
  const wrong = await connectFixture(t);
  wrong.eda.document.uuid = 'unrelated-schematic';
  const failed = await apply(wrong);
  assert.equal(failed.ok, false);
  assert.equal(wrong.eda.wireCreates, 0);
  const stale = await connectFixture(t);
  let inspections = 0;
  const invoke = async (action, request, context) => {
    if (action === 'schematic-inspect' && ++inspections === 2) stale.eda.note = 'user edited between planning and write';
    return stale.invoke(action, request, context);
  };
  const blocked = await runSchematicConnect({ ...options(stale), invoke, apply: true });
  assert.equal(blocked.error.code, 'LOCAL_CHANGE_UNPROVEN');
  assert.equal(stale.eda.wireCreates, 0);
  assert.equal(stale.eda.saveCount, 0);
});

test('a Contract pin assigned both NC and a network blocks all mutation', async t => {
  const f = await connectFixture(t);
  f.contract.nets[0].endpoints.push({ component: 'U1', pin: '2' });
  await f.writeContract();
  const result = await apply(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONNECTIONS_BLOCKED');
  assert(result.checks.connections.diagnostics.some(diagnostic => diagnostic.code === 'PIN_INTENT_CONFLICT'));
  assert.deepEqual(mutations(f.eda), []);
});

test('saving successfully with failed strict DRC never reports the schematic complete', async t => {
  const f = await connectFixture(t);
  f.eda.drcResult = [{ type: 'warn', count: 1 }];
  const result = await apply(f);
  assert.equal(result.ok, false);
  assert.equal(result.saved, true);
  assert.equal(result.checks.drc.passed, false);
  assert.equal(result.status, 'blocked');
  assert.equal(f.eda.saveCount, 1);
  assert.equal(f.eda.drcCount, 2);
});

test('a lost mutation reply stops the run and retains its active ownership file', async t => {
  const f = await connectFixture(t);
  const invoke = async (action, request, context) => {
    const record = await f.invoke(action, request, context);
    if (action === 'schematic-wire-create' && request.mode === 'apply') throw new Error('transport reply lost');
    return record;
  };
  const lost = await runSchematicConnect({ ...options(f), invoke, apply: true });
  assert.equal(lost.status, 'outcome-unknown');
  assert.equal(lost.ok, false);
  assert.equal(f.eda.wires.length, 2, 'the write happened even though the response was lost');
  assert.equal(f.eda.markerCreates, 0);
  assert.equal(f.eda.saveCount, 0);
  assert((await readdir(join(f.root, 'evidence', 'schematic-connect'))).some(name => name.endsWith('.active.json')));
  const retry = await apply(f);
  assert.equal(retry.ok, false);
  assert.equal(retry.error.code, 'UNRESOLVED_RUN');
  assert.equal(f.eda.wireCreates, 2);
});

test('an Action reporting an uncertain partial create keeps the workflow blocked against retry', async t => {
  const f = await connectFixture(t);
  const create = f.eda.sch_PrimitiveWire.create;
  f.eda.sch_PrimitiveWire.create = async (...args) => {
    await create(...args);
    throw new Error('provider created a wire but lost its ID response');
  };
  const result = await apply(f);
  assert.equal(result.status, 'outcome-unknown', explain(result));
  assert.equal(result.ok, false);
  assert.equal(f.eda.wires.length, 1);
  assert.equal(f.eda.markerCreates, 0);
  const retried = await apply(f);
  assert.equal(retried.error.code, 'UNRESOLVED_RUN');
  assert.equal(f.eda.wires.length, 1);
});

test('save-time changes outside component geometry invalidate the final source evidence', async t => {
  const f = await connectFixture(t);
  f.eda.afterSave = () => { f.eda.note = 'source changed while saving'; };
  const result = await apply(f);
  assert.equal(result.ok, false);
  assert.equal(result.saved, true);
  assert.equal(result.checks.drc.passed, true);
  assert.equal(result.error.code, 'EXECUTION_SOURCE_CHANGED');
});

test('existing manually routed wires are not replaced by the isolated-stub workflow', async t => {
  const f = await connectFixture(t);
  const manual = { id: 'manual-wire', net: 'SENSE', points: [20, 100, 60, 100, 60, 120], color: null, lineWidth: null, lineType: null, visible: true };
  f.eda.wires.push(manual);
  const result = await apply(f);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONNECTIONS_BLOCKED');
  assert(result.checks.connections.diagnostics.some(diagnostic => diagnostic.code === 'EXISTING_TOPOLOGY_UNSUPPORTED'));
  assert.deepEqual(f.eda.wires, [manual]);
  assert.equal(f.eda.wireCreates, 0);
});

test('check verifies a completed schematic without saving or mutating it', async t => {
  const f = await connectFixture(t);
  assert.equal((await apply(f)).ok, true);
  const before = mutations(f.eda).length;
  const checked = await runSchematicConnect({ ...options(f), check: true });
  assert.equal(checked.status, 'checked', explain(checked));
  assert.equal(checked.ok, true);
  assert.equal(checked.readOnly, true);
  assert.equal(checked.saved, null);
  assert.equal(mutations(f.eda).length, before);
  assert.equal(f.eda.saveCount, 1);
  assert.equal(f.eda.drcCount, 3);
});

test('an unrelated BOM flag edit survives local wiring with the original wire-plan provenance', async t => {
  const f = await connectFixture(t);
  f.input.designators = ['U1'];
  f.contract.nets[0].endpoints = [{ component: 'U1', pin: '1' }];
  await f.writeContract();
  await f.writeInput();
  let inspections = 0;
  const invoke = async (action, request, context) => {
    if (action === 'schematic-inspect' && ++inspections === 2) f.eda.parts[1].addIntoBom = false;
    return f.invoke(action, request, context);
  };
  const done = await runSchematicConnect({ ...options(f), invoke, apply: true });
  assert.equal(done.ok, true, explain(done));
  assert.equal(f.eda.parts[1].addIntoBom, false);
  assert.equal(f.eda.wireCreates, 1);
  assert.equal(done.preservedChanges.length, 1);
  const original = JSON.parse(await readFile(join(done.runDir, 'initial-plan.json'), 'utf8'));
  const step = done.steps.find(step => step.name === 'wire-0-plan');
  const request = JSON.parse(await readFile(step.inputFile, 'utf8'));
  assert.deepEqual(request.plan.source, original.wirePlan.source, 'candidate provenance must not be refreshed');
  assert.equal(request.plan.fingerprints.plan, original.wirePlan.fingerprints.plan);
});

test('target Value and pin-network changes block local connect before the first mutation', async t => {
  for (const field of ['value', 'pin', 'network', 'duplicate']) await t.test(field, async t => {
    const f = await connectFixture(t);
    let inspections = 0;
    const invoke = async (action, request, context) => {
      if (action === 'schematic-inspect' && ++inspections === 2) {
        if (field === 'value') f.eda.parts[0].value = 'OTHER';
        else if (field === 'pin') f.eda.parts[0].pins[0].x += 1;
        else if (field === 'network') f.eda.parts[0].pins[0].noConnected = true;
        else f.eda.parts.push({ ...structuredClone(f.eda.parts[0]), id: 'duplicate-target' });
      }
      return f.invoke(action, request, context);
    };
    const result = await runSchematicConnect({ ...options(f), invoke, apply: true });
    assert.equal(result.error.code, 'RELATED_SCHEMATIC_CHANGED');
    assert.equal(f.eda.wireCreates, 0);
    assert.equal(f.eda.saveCount, 0);
  });
});

test('a related network member move blocks, and a legacy wire plan still requires unchanged full geometry', async t => {
  const f = await connectFixture(t);
  f.input.designators = ['U1'];
  await f.writeInput();
  let inspections = 0;
  const invoke = async (action, request, context) => {
    if (action === 'schematic-inspect' && ++inspections === 2) f.eda.parts[1].x += 10;
    return f.invoke(action, request, context);
  };
  const result = await runSchematicConnect({ ...options(f), invoke, apply: true });
  assert.equal(result.error.code, 'RELATED_SCHEMATIC_CHANGED');
  assert.equal(f.eda.wireCreates, 0);
  const original = JSON.parse(await readFile(join(result.runDir, 'initial-plan.json'), 'utf8'));
  const action = await loadAction('schematic-wire-create', 'easyeda-pro');
  delete original.wirePlan.source.nativeSource;
  delete original.wirePlan.source.localDependencies;
  const lower = await action(f.eda, { mode: 'plan', plan: original.wirePlan });
  assert(lower.analysis.globalIssues.some(issue => issue.code === 'SOURCE_GEOMETRY_STALE'));
});

test('source changes between local plan and apply are blocked without creating wires', async t => {
  const f = await connectFixture(t);
  const invoke = async (action, request, context) => {
    if (action === 'schematic-wire-create' && request.mode === 'apply') f.eda.note = 'racing change';
    return f.invoke(action, request, context);
  };
  const result = await runSchematicConnect({ ...options(f), invoke, apply: true });
  assert.equal(result.error.code, 'EXECUTION_SOURCE_CHANGED');
  assert.equal(result.status, 'blocked');
  assert.equal(f.eda.wireCreates, 0);
});

test('a save failure can retry saving without recreating finished connections', async t => {
  const f = await connectFixture(t);
  f.eda.saveResult = false;
  const failed = await apply(f);
  assert.equal(failed.ok, false);
  assert.equal(failed.saved, false);
  const ids = [...f.eda.wires, ...f.eda.markers].map(row => row.id);
  f.eda.saveResult = true;
  assert.equal((await apply(f)).ok, true);
  assert.equal(f.eda.wireCreates, 2);
  assert.equal(f.eda.markerCreates, 2);
  assert.deepEqual([...f.eda.wires, ...f.eda.markers].map(row => row.id), ids);
});

test('whole-source reflow retains its strict barrier for unrelated preflight edits', async t => {
  const f = await connectFixture(t, { reflow: true });
  f.input.designators = ['U1'];
  await f.writeInput();
  // Change specifically at reflow preflight, after the NC readback has been recorded.
  const invoker = async (action, request, context) => {
    if (context.name?.startsWith('pre-write-inspect') && f.eda.parts[0].pins[1].noConnected && f.eda.markers.length) f.eda.parts[1].addIntoBom = false;
    return f.invoke(action, request, context);
  };
  const result = await runSchematicConnect({ ...options(f), invoke: invoker, apply: true });
  assert.equal(result.error.code, 'STALE_SCHEMATIC');
  assert.equal(f.eda.reflowCount, 0);
});

test('whole-source marker imports preserve an unknown outcome rather than replaying', async t => {
  const f = await connectFixture(t);
  const set = f.eda.sys_FileManager.setDocumentSource;
  f.eda.sys_FileManager.setDocumentSource = async source => { await set(source); throw new Error('import reply lost'); };
  const result = await apply(f);
  assert.equal(result.status, 'outcome-unknown');
  assert.equal(f.eda.markerCreates, 2);
  const repeat = await apply(f);
  assert.equal(repeat.error.code, 'UNRESOLVED_RUN');
  assert.equal(f.eda.markerCreates, 2);
});

test('a source race during one NC write stops before modifying the next pin', async t => {
  const f = await connectFixture(t);
  const modify = f.eda.sch_PrimitivePin.modify;
  f.eda.sch_PrimitivePin.modify = async (...args) => { const result = await modify(...args); f.eda.note = 'racing note'; return result; };
  const result = await apply(f);
  assert.equal(result.error.code, 'EXECUTION_SOURCE_CHANGED');
  assert.equal(f.eda.ncWrites, 1);
  assert.equal(f.eda.saveCount, 0);
});

function nativeBounds(eda, textBounds = { minX: 800, minY: 800, maxX: 900, maxY: 820 }) {
  eda.sch_Primitive = { async getPrimitivesBBox([id]) {
    if (id === 'note') return textBounds;
    const part = eda.parts.find(part => part.id === id);
    if (part) return { minX: Math.min(part.x, ...part.pins.map(pin => pin.x)) - 2, maxX: Math.max(part.x, ...part.pins.map(pin => pin.x)) + 2,
      minY: Math.min(part.y, ...part.pins.map(pin => pin.y)) - 2, maxY: Math.max(part.y, ...part.pins.map(pin => pin.y)) + 2 };
    return null;
  } };
}
async function isolatedFixture(t) {
  const f = await connectFixture(t); f.input.designators = ['U1'];
  f.contract.nets[0].endpoints = [{ component: 'U1', pin: '1' }];
  await f.writeInput(); await f.writeContract(); return f;
}

test('an unrelated move and remote source text retain the original candidate and user content', async t => {
  for (const kind of ['move', 'text']) await t.test(kind, async t => {
    const f = await isolatedFixture(t); nativeBounds(f.eda); let inspections = 0;
    const invoke = async (action, request, context) => {
      if (action === 'schematic-inspect' && ++inspections === 2) {
        if (kind === 'move') f.eda.parts[1].x += 10; else f.eda.note = 'keep this remote note';
      }
      return f.invoke(action, request, context);
    };
    const result = await runSchematicConnect({ ...options(f), invoke, apply: true });
    assert.equal(result.ok, true, explain(result)); assert.equal(result.preservedChanges.length, 1);
    if (kind === 'move') assert.equal(f.eda.parts[1].x, 210); else assert.equal(f.eda.note, 'keep this remote note');
    const original = JSON.parse(await readFile(join(result.runDir, 'initial-plan.json'), 'utf8'));
    const request = JSON.parse(await readFile(result.steps.find(step => step.name === 'wire-0-plan').inputFile, 'utf8'));
    assert.deepEqual(request.plan.source, original.wirePlan.source);
    assert.equal(request.plan.fingerprints.plan, original.wirePlan.fingerprints.plan);
    assert.notEqual(request.plan.executionSource, request.plan.source.nativeSource);
  });
});
test('a moved obstacle, missing bounds or changed settings cannot pass local preflight', async t => {
  for (const kind of ['obstacle', 'missing-bounds', 'settings']) await t.test(kind, async t => {
    const f = await isolatedFixture(t); if (kind === 'obstacle') nativeBounds(f.eda);
    let inspections = 0; const originalSource = f.eda.source;
    const invoke = async (action, request, context) => {
      if (action === 'schematic-inspect' && ++inspections === 2) {
        if (kind === 'obstacle') f.eda.parts[1].x = 30;
        else if (kind === 'missing-bounds') f.eda.parts[1].x += 10;
        else f.eda.source = () => originalSource() + '\n{"type":"SETTINGS","id":"settings"}||{"grid":4}|';
      }
      return f.invoke(action, request, context);
    };
    const result = await runSchematicConnect({ ...options(f), invoke, apply: true });
    assert.equal(result.error.code, kind === 'obstacle' ? 'TARGET_OCCUPIED' : 'LOCAL_CHANGE_UNPROVEN', explain(result));
    assert.equal(f.eda.wireCreates, 0); assert.equal(f.eda.saveCount, 0);
  });
});
test('an existing related wire or port change rejects the local candidate', async t => {
  for (const kind of ['wire', 'port']) await t.test(kind, async t => {
    const f = await connectFixture(t); assert.equal((await apply(f)).ok, true); let inspections = 0;
    const invoke = async (action, request, context) => {
      if (action === 'schematic-inspect' && ++inspections === 2) {
        if (kind === 'wire') f.eda.wires[0].points[2] += 1; else f.eda.markers[0].x += 1;
      }
      return f.invoke(action, request, context);
    };
    const result = await runSchematicConnect({ ...options(f), invoke, apply: true });
    assert.equal(result.error.code, 'RELATED_SCHEMATIC_CHANGED', explain(result)); assert.equal(f.eda.saveCount, 1);
  });
});
test('the connection workflow preserves old complete DRC records and blocks a same-count replacement', async t => {
  for (const changed of [false, true]) await t.test(String(changed), async t => {
    const f = await connectFixture(t);
    const old = { type: 'warn', rule: 'unrelated-old-rule', primitives: ['part-2'] };
    f.eda.sch_Drc.check = async () => f.eda.wires.length && changed ? [{ ...old, rule: 'new-rule' }] : [old];
    const result = await apply(f); assert.equal(result.ok, !changed, explain(result)); assert.equal(result.saved, true);
    assert.equal(result.checks.drc.passed, false); assert.equal(result.checks.drc.comparison.passed, !changed);
    const baseline = result.steps.find(step => step.name === 'drc-baseline');
    assert(baseline); assert(result.steps.indexOf(baseline) < result.steps.findIndex(step => step.mutates));
  });
});

test('a thrown save is unknown and cannot be retried as a known save failure', async t => {
  const f = await connectFixture(t);
  f.eda.sch_Document.save = async () => { f.eda.saveCount++; throw new Error('save reply lost'); };
  const result = await apply(f); assert.equal(result.status, 'outcome-unknown'); assert.equal(result.saved, null);
  assert.equal((await apply(f)).error.code, 'UNRESOLVED_RUN'); assert.equal(f.eda.saveCount, 1);
});
