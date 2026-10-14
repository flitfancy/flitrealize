import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runPcbCreate, summarizePcbCreate } from '../../scripts/pcb-create.mjs';
import { fixture as layoutFixture } from '../helpers/pcb-layout-execution-fixture.mjs';
import { loadAction } from '../helpers/action-harness.mjs';

async function fixture(t) {
  const f = await layoutFixture(t);
  f.pads.splice(f.pads.findIndex(pad => pad.PrimitiveId === 'testpad'), 1);
  const contract = { kind: 'flitrealize.schematic-contract', schemaVersion: 1, project: { id: 'project', revision: '1' }, blocks: [{ id: 'test', purpose: 'isolated conversion', components: ['U1', 'U2'] }], powerDomains: [], interfaces: [], components: ['U1', 'U2'].map(designator => ({ designator, role: 'test load', identity: { selection: 'generic', value: '10k' }, footprint: { selection: 'exact', name: 'FIXTURE' }, pinMapCoverage: 'complete', pins: [{ number: '1', function: 'LOAD', classification: 'passive' }], includeInPcb: true, includeInBom: true, bindings: { easyedaPro: { pinMap: { '1': ['1'] } } } })), nets: ['N0', 'N1'].map((name, index) => ({ name, kind: 'signal', endpoints: [{ component: 'U' + (index + 1), pin: '1' }] })), constraints: [], exceptions: [] };
  const input = { contractFile: 'contract.json', expectedProjectUuid: 'project', expectedSchematicUuid: 'schematic', expectedSchematicPageUuid: 'page' };
  const control = f.control;
  Object.assign(control, { creates: 0, associations: 0, createArgs: [], associationArgs: [], imports: 0, importArgs: [], importResult: true, pageCount: 1, schematicSource: '{"type":"DOCHEAD"}||{}|\n{"type":"TEXT","id":"test"}||{"value":"source"}|', componentReads: 0, sourceBoardName: null,
    boards: [{ uuid: 'existing-board-id', name: 'existing-board', schematicUuid: 'unrelated-source', pcbUuid: 'existing-pcb' }],
    pcbInventory: [{ uuid: 'existing-pcb', parentProjectUuid: 'project', parentBoardName: 'existing-board' }] });
  control.document = { uuid: 'page', parentProjectUuid: 'project', documentType: 1 };
  f.eda.dmt_Project = { getCurrentProjectInfo: async () => { throw Error('Full project lookup must not be called.'); } };
  f.eda.dmt_Schematic = { getSchematicInfo: async () => ({ uuid: 'schematic', itemType: control.sourceItemType ?? 'Schematic', parentProjectUuid: 'project', parentBoardName: control.sourceBoardName ?? undefined, page: Array.from({ length: control.pageCount }, (_, index) => ({ uuid: index === 0 ? 'page' : 'other-page' })) }) };
  f.eda.dmt_Pcb = {
    createPcb: async boardName => {
      control.creates++; control.createArgs.push(boardName);
      if (control.createThrows) throw Error('reply lost after create');
      if (control.returnExisting) return 'existing-pcb';
      const board = control.boards.find(board => board.name === boardName);
      if (boardName && (!board || board.pcbUuid)) return undefined;
      control.pcbInventory.push({ uuid: 'new-pcb', parentProjectUuid: 'project', parentBoardName: boardName });
      if (board) board.pcbUuid = 'new-pcb';
      if (control.afterCreate) await control.afterCreate();
      return 'new-pcb';
    },
    getPcbInfo: async uuid => control.pcbInventory.find(pcb => pcb.uuid === uuid),
    getAllPcbsInfo: async () => structuredClone(control.pcbInventory)
  };
  f.eda.dmt_Board = {
    getAllBoardsInfo: async () => control.boards.map(board => ({ uuid: board.uuid, name: board.name, parentProjectUuid: 'project', schematic: board.schematicUuid ? { uuid: board.schematicUuid, parentProjectUuid: 'project' } : undefined, pcb: board.pcbUuid ? { uuid: board.pcbUuid, parentProjectUuid: 'project' } : undefined })),
    createBoard: async (schematicUuid, pcbUuid) => {
      control.associations++; control.associationArgs.push({ schematicUuid, pcbUuid });
      if (control.associationResult === false) return undefined;
      control.boards.push({ uuid: 'new-board-id', name: 'new-board', schematicUuid, pcbUuid });
      control.sourceBoardName = 'new-board'; control.pcbInventory.find(pcb => pcb.uuid === pcbUuid).parentBoardName = 'new-board';
      if (control.afterAssociation) await control.afterAssociation();
      if (control.associationThrows) throw Error('reply lost after Board association');
      return 'new-board';
    }
  };
  f.eda.dmt_EditorControl = { openDocument: async uuid => { control.document = { uuid, parentProjectUuid: 'project', documentType: uuid === 'new-pcb' ? 3 : 1 }; if (control.afterOpen) await control.afterOpen(); return uuid; } };
  f.eda.pcb_Document.importChanges = async (uuid, force) => {
    control.imports++; control.importArgs.push({ uuid, force });
    // The installed handler ignores uuid and resolves its source from Board membership.
    const board = control.boards.find(board => board.pcbUuid === control.document.uuid);
    assert.equal(board?.schematicUuid, 'schematic', 'Same-Board source is required before native import.');
    if (control.importThrows) throw Error('lost import reply');
    return control.importResult;
  };
  const pcbSource = f.eda.sys_FileManager.getDocumentSource;
  f.eda.sys_FileManager.getDocumentSource = async () => control.document.documentType === 1 ? control.schematicSource : pcbSource();
  const components = f.eda.pcb_PrimitiveComponent.getAll;
  f.eda.pcb_PrimitiveComponent.getAll = async () => { control.componentReads++; return components(); };
  f.eda.pcb_Net = {
    getNetlist: async () => JSON.stringify({ version: 1, components: Object.fromEntries(f.components.map((component, index) => [component.PrimitiveId, { props: { Designator: component.Designator, 'Unique ID': component.PrimitiveId }, pinInfoMap: { a: { number: '1', net: 'N' + index } } }])) }),
    getAllNetsName: async () => ['N0', 'N1'],
  };
  await writeFile(join(f.projectRoot, 'contract.json'), JSON.stringify(contract));
  await writeFile(join(f.projectRoot, 'input.json'), JSON.stringify(input));
  const native = await loadAction('pcb-create', 'easyeda-pro');
  const invokeAction = async (_action, payload, context) => ({ success: true, result: await native(f.eda, payload) });
  const options = { projectRoot: f.projectRoot, inputFile: 'input.json', windowId: 'isolated-window', invokeAction, transport: f.transport };
  return { ...f, control, contract, input, native, options, async writeContract() { await writeFile(join(f.projectRoot, 'contract.json'), JSON.stringify(contract)); } };
}
const resume = (f, result, apply = false) => ({ ...f.options, inputFile: undefined, resume: result.runDir, apply });

test('planning freezes source and Board inventory without creation, import, PCB primitive reads or save', async t => {
  const f = await fixture(t), result = await runPcbCreate(f.options);
  assert.equal(result.status, 'planned'); assert.equal(result.ok, true);
  assert.equal(f.control.creates, 0); assert.equal(f.control.imports, 0); assert.equal(f.control.componentReads, 0); assert.equal(f.control.saves, 0);
  assert.equal(result.saved, null); assert.equal(result.saveAttempted, false);
  assert.equal(result.boardMode, 'create-board'); assert.equal(f.control.associations, 0);
});

test('new PCB conversion reuses one full native read, shared audits and a light post-save source check', async t => {
  const f = await fixture(t), result = await runPcbCreate({ ...f.options, apply: true });
  assert.equal(result.status, 'created-saved', JSON.stringify(result.error)); assert.equal(result.ok, true); assert.equal(result.createdPcbUuid, 'new-pcb');
  assert.equal(f.control.creates, 1); assert.equal(f.control.imports, 1); assert.equal(f.control.componentReads, 1); assert.equal(f.control.saves, 1);
  assert.deepEqual(f.control.importArgs, [{ uuid: 'schematic', force: true }]);
  assert.deepEqual(f.control.associationArgs, [{ schematicUuid: 'schematic', pcbUuid: 'new-pcb' }]);
  assert.equal(result.boardAssociation.boardName, 'new-board'); assert.equal(result.createdBoardName, 'new-board');
  assert.deepEqual(f.calls, ['snapshot', 'save', 'source']);
  const summary = summarizePcbCreate(result);
  assert.equal(summary.checks.network, 'matched'); assert.equal(summary.checks.footprints, 'matched');
  assert.ok(summary.calls.every(call => call.milliseconds >= 0 && call.inputBytes > 0));
  assert.ok(!JSON.stringify(summary).includes('pinInfoMap'));
  assert.ok(JSON.stringify(summary).length < 4000);
});

test('repeated apply requires the original run and a completed resume does not recreate or reimport', async t => {
  const f = await fixture(t), created = await runPcbCreate({ ...f.options, apply: true });
  await assert.rejects(runPcbCreate({ ...f.options, apply: true }), { code: 'EXISTING_CREATION_RUN' });
  const checked = await runPcbCreate(resume(f, created));
  assert.equal(checked.status, 'created-saved', JSON.stringify(checked.error));
  assert.equal(f.control.creates, 1); assert.equal(f.control.imports, 1); assert.equal(f.control.componentReads, 1); assert.equal(f.control.saves, 1);
});

test('a planned run can apply the frozen plan but rejects a changed schematic before creating', async t => {
  const f = await fixture(t), plan = await runPcbCreate(f.options);
  const applied = await runPcbCreate(resume(f, plan, true));
  assert.equal(applied.status, 'created-saved', JSON.stringify(applied.error)); assert.equal(f.control.creates, 1);
  const other = await fixture(t), otherPlan = await runPcbCreate(other.options);
  other.control.schematicSource += '\n{"type":"TEXT","id":"change"}||{}|';
  const stopped = await runPcbCreate(resume(other, otherPlan, true));
  assert.equal(stopped.error.code, 'SCHEMATIC_CHANGED'); assert.equal(other.control.creates, 0);
});

test('wrong project, multiple pages and an existing PCB input are rejected before creation', async t => {
  const f = await fixture(t); f.control.document.parentProjectUuid = 'other-project';
  const project = await runPcbCreate({ ...f.options, apply: true }); assert.equal(project.error.code, 'PROJECT_MISMATCH'); assert.equal(f.control.creates, 0);
  const pages = await fixture(t); pages.control.pageCount = 2;
  const result = await runPcbCreate({ ...pages.options, apply: true }); assert.equal(result.error.code, 'SINGLE_PAGE_REQUIRED'); assert.equal(pages.control.creates, 0);
  const existing = await fixture(t); existing.input.createdPcbUuid = 'user-board'; await writeFile(join(existing.projectRoot, 'input.json'), JSON.stringify(existing.input));
  await assert.rejects(runPcbCreate({ ...existing.options, apply: true }), { code: 'INVALID_INPUT' }); assert.equal(existing.control.creates, 0);
});

test('a readable exact document is sufficient without the full project API', async t => {
  const f = await fixture(t); delete f.eda.dmt_Project;
  const result = await runPcbCreate({ ...f.options, apply: true });
  assert.equal(result.status, 'created-saved', JSON.stringify(result.error));
  assert.equal(f.control.creates, 1); assert.equal(f.control.imports, 1); assert.equal(f.control.saves, 1);
});

test('document, source ancestry and created PCB ancestry remain exact', async t => {
  for (const change of [
    f => { f.control.document.uuid = 'other-page'; },
    f => { f.control.document.documentType = 3; },
    f => { f.eda.dmt_Schematic.getSchematicInfo = async () => ({ uuid: 'schematic', parentProjectUuid: 'other-project', page: [{ uuid: 'page' }] }); },
    f => { f.eda.dmt_Schematic.getSchematicInfo = async () => ({ uuid: 'other-schematic', parentProjectUuid: 'project', page: [{ uuid: 'page' }] }); },
  ]) {
    const f = await fixture(t); change(f);
    const result = await runPcbCreate({ ...f.options, apply: true });
    assert.equal(result.status, 'blocked'); assert.equal(f.control.creates, 0); assert.equal(f.control.imports, 0);
    assert.ok(['DOCUMENT_MISMATCH', 'SCHEMATIC_MISMATCH'].includes(result.error.code));
  }
  const f = await fixture(t);
  f.eda.dmt_Pcb.getPcbInfo = async uuid => ({ uuid, parentProjectUuid: 'other-project' });
  const result = await runPcbCreate({ ...f.options, apply: true });
  assert.equal(result.error.code, 'CREATED_PCB_MISMATCH'); assert.equal(result.createdPcbUuid, 'new-pcb');
  assert.equal(f.control.imports, 0); assert.equal(f.control.saves, 0);
});

test('save recovery rejects a current document in a different project before opening or saving', async t => {
  const f = await fixture(t); f.control.saveResult = false;
  const result = await runPcbCreate({ ...f.options, apply: true });
  f.control.document.parentProjectUuid = 'other-project'; f.control.saveResult = true;
  let opens = 0; f.eda.dmt_EditorControl.openDocument = async () => { opens++; throw Error('Must not open another document.'); };
  const blocked = await runPcbCreate(resume(f, result, true));
  assert.equal(blocked.error.code, 'PROJECT_MISMATCH'); assert.equal(opens, 0);
  assert.equal(f.control.creates, 1); assert.equal(f.control.imports, 1); assert.equal(f.control.saves, 1);
});

test('failed import retains its new UUID and never retries creation or import', async t => {
  const f = await fixture(t); f.control.importResult = false;
  const result = await runPcbCreate({ ...f.options, apply: true });
  assert.equal(result.status, 'blocked'); assert.equal(result.createdPcbUuid, 'new-pcb'); assert.equal(result.saved, null); assert.equal(result.saveAttempted, false);
  const retried = await runPcbCreate(resume(f, result, true));
  assert.equal(retried.error.code, 'IMPORT_NOT_REPLAYABLE'); assert.equal(f.control.creates, 1); assert.equal(f.control.imports, 1);
});

test('a known failed save resumes only the save chain', async t => {
  const f = await fixture(t); f.control.saveResult = false;
  const result = await runPcbCreate({ ...f.options, apply: true }); assert.equal(result.saved, false); assert.equal(result.saveAttempted, true);
  f.control.saveResult = true;
  const recovered = await runPcbCreate(resume(f, result, true));
  assert.equal(recovered.status, 'created-saved', JSON.stringify(recovered.error)); assert.equal(recovered.error, undefined);
  assert.equal(f.control.creates, 1); assert.equal(f.control.imports, 1); assert.equal(f.control.componentReads, 1); assert.equal(f.control.saves, 2);
});

test('a changed source after import blocks save recovery without modifying it', async t => {
  const f = await fixture(t); f.control.saveResult = false;
  const result = await runPcbCreate({ ...f.options, apply: true });
  f.components[0].X += 20; f.control.saveResult = true;
  const blocked = await runPcbCreate(resume(f, result, true));
  assert.equal(blocked.error.code, 'SOURCE_CHANGED_RECONCILE'); assert.equal(f.control.saves, 1); assert.equal(f.control.creates, 1);
});

test('unknown creation replies retain the activity pointer and block all replay', async t => {
  const f = await fixture(t);
  const invokeAction = async (action, input, context) => { const response = await f.options.invokeAction(action, input, context); return input.mode === 'apply' ? { success: false, status: 'unknown' } : response; };
  const result = await runPcbCreate({ ...f.options, invokeAction, apply: true });
  assert.equal(result.status, 'outcome-unknown'); assert.equal(f.control.creates, 1);
  assert.equal(result.creationAttempted, null); assert.equal(result.creation, 'unconfirmed');
  assert.equal(summarizePcbCreate(result).creationAttempted, null);
  assert.equal(summarizePcbCreate(result).creation, 'unconfirmed');
  const recovered = await runPcbCreate({ ...resume(f, result, true), invokeAction });
  assert.equal(recovered.status, 'outcome-unknown'); assert.equal(f.control.creates, 1); assert.equal(f.control.imports, 1);
  assert.ok((await readdir(join(f.projectRoot, 'evidence'))).includes('.pcb-create-active.json'));
});

test('a durable successful creation receipt permits readback after a lost wrapper reply', async t => {
  const f = await fixture(t);
  const invokeAction = async (action, input, context) => {
    const response = await f.options.invokeAction(action, input, context);
    if (input.mode === 'apply') { await writeFile(context.reportFile, JSON.stringify({ response }), { flag: 'wx' }); throw Error('wrapper lost reply'); }
    return response;
  };
  const unknown = await runPcbCreate({ ...f.options, invokeAction, apply: true }); assert.equal(unknown.status, 'outcome-unknown');
  const recovered = await runPcbCreate(resume(f, unknown, true));
  assert.equal(recovered.status, 'created-saved', JSON.stringify(recovered.error)); assert.equal(f.control.creates, 1); assert.equal(f.control.imports, 1);
});

test('explicit net and footprint differences are reported; policy-only footprint coverage remains unverified', async t => {
  const wrong = await fixture(t); wrong.pads[0].Net = 'WRONG'; wrong.components[0].Footprint.name = 'WRONG';
  const result = await runPcbCreate({ ...wrong.options, apply: true });
  assert.equal(result.status, 'created-differences'); assert.equal(result.saved, true); assert.equal(result.ok, false);
  const unknown = await fixture(t); unknown.contract.components[0].footprint = { selection: 'policy', policy: '0603' }; await unknown.writeContract();
  const partial = await runPcbCreate({ ...unknown.options, apply: true });
  assert.equal(partial.status, 'created-unverified'); assert.equal(partial.checks.footprints.status, 'unverified'); assert.equal(partial.ok, false);
});

test('frozen inputs, original-session save recovery and process locks cannot be bypassed', async t => {
  const f = await fixture(t), plan = await runPcbCreate(f.options);
  await assert.rejects(runPcbCreate({ ...resume(f, plan, true), windowId: 'different-session' }), { code: 'ORIGINAL_SESSION_REQUIRED' });
  await writeFile(join(plan.runDir, 'contract.json'), '{}');
  await assert.rejects(runPcbCreate(resume(f, plan, true)), { code: 'FROZEN_INPUT_CHANGED' });
  assert.equal(f.control.creates, 0);
});

test('edited frozen source or PCB snapshot is rejected instead of adopting a second design', async t => {
  const f = await fixture(t), plan = await runPcbCreate(f.options);
  await writeFile(join(plan.runDir, 'source.esch'), 'edited frozen source');
  const blocked = await runPcbCreate(resume(f, plan, true));
  assert.equal(blocked.error.code, 'FROZEN_SOURCE_CHANGED'); assert.equal(f.control.creates, 0);
  const other = await fixture(t), saved = await runPcbCreate({ ...other.options, apply: true });
  const path = join(saved.runDir, 'snapshot.json'), snapshot = JSON.parse(await readFile(path, 'utf8'));
  snapshot.pads[0].net = 'EDITED'; await writeFile(path, JSON.stringify(snapshot));
  const stale = await runPcbCreate(resume(other, saved, true));
  assert.equal(stale.error.code, 'FROZEN_SNAPSHOT_CHANGED'); assert.equal(other.control.creates, 1); assert.equal(other.control.saves, 1);
});

test('a blocked resumed target and an unexpected Board association stop before saving or importing', async t => {
  const f = await fixture(t); f.control.saveResult = false;
  const created = await runPcbCreate({ ...f.options, apply: true });
  f.eda.dmt_Pcb.getPcbInfo = async uuid => ({ uuid, parentProjectUuid: 'project', parentBoardName: 'existing-user-board' });
  const blocked = await runPcbCreate(resume(f, created, true));
  assert.equal(blocked.error.code, 'BOARD_ASSOCIATION_MISMATCH'); assert.equal(f.control.saves, 1); assert.equal(f.control.imports, 1);
  const fresh = await fixture(t);
  fresh.eda.dmt_Pcb.getPcbInfo = async uuid => ({ uuid, parentProjectUuid: 'project', parentBoardName: 'unexpected-board' });
  const wrong = await runPcbCreate({ ...fresh.options, apply: true });
  assert.equal(wrong.error.code, 'CREATED_PCB_ASSOCIATION_UNEXPECTED'); assert.equal(wrong.createdPcbUuid, 'new-pcb'); assert.equal(fresh.control.imports, 0); assert.equal(fresh.control.saves, 0);
});

test('a lost post-save source reply preserves the separately confirmed saved fact', async t => {
  const f = await fixture(t), transport = async context => context.phase === 'source' ? { success: false, status: 'unknown' } : f.transport(context);
  const result = await runPcbCreate({ ...f.options, transport, apply: true });
  assert.equal(result.status, 'blocked'); assert.equal(result.saved, true); assert.equal(result.saveAttempted, true); assert.equal(result.ok, false);
  assert.equal(f.control.saves, 1); assert.equal(f.control.creates, 1);
});

test('a creation exception without a UUID remains unknown and cannot be retried', async t => {
  const f = await fixture(t); f.control.createThrows = true;
  const result = await runPcbCreate({ ...f.options, apply: true });
  assert.equal(result.status, 'outcome-unknown'); assert.equal(result.createdPcbUuid, null);
  assert.equal(summarizePcbCreate(result).creation, 'unconfirmed');
  assert.equal(summarizePcbCreate(result).creationAttempted, true);
  const again = await runPcbCreate(resume(f, result, true));
  assert.equal(again.status, 'outcome-unknown'); assert.equal(f.control.creates, 1); assert.equal(f.control.imports, 0);
});

test('a returned pre-existing UUID is never imported into or reported as a newly created PCB', async t => {
  const f = await fixture(t); f.control.returnExisting = true;
  const result = await runPcbCreate({ ...f.options, apply: true });
  assert.equal(result.error.code, 'EXISTING_PCB_RETURNED'); assert.equal(result.createdPcbUuid, null); assert.equal(result.rejectedPcbUuid, 'existing-pcb');
  assert.equal(f.control.imports, 0); assert.equal(f.control.saves, 0); assert.equal(f.control.document.uuid, 'page');
});

test('an occupied source Board stops during planning before creating or associating anything', async t => {
  const f = await fixture(t); f.control.boards[0].schematicUuid = 'schematic'; f.control.sourceBoardName = 'existing-board';
  const result = await runPcbCreate({ ...f.options, apply: true });
  assert.equal(result.error.code, 'SOURCE_BOARD_HAS_PCB'); assert.match(result.error.message, /never replaces/);
  assert.equal(f.control.creates, 0); assert.equal(f.control.associations, 0); assert.equal(f.control.imports, 0);
  assert.ok(!(await readdir(join(f.projectRoot, 'evidence'))).includes('.pcb-create-active.json'));
});

test('an existing source Board without a PCB receives one new PCB without creating another Board', async t => {
  const f = await fixture(t);
  f.control.boards.push({ uuid: 'source-board-id', name: 'source-board', schematicUuid: 'schematic', pcbUuid: null }); f.control.sourceBoardName = 'source-board';
  delete f.eda.dmt_Board.createBoard;
  const result = await runPcbCreate({ ...f.options, apply: true });
  assert.equal(result.status, 'created-saved', JSON.stringify(result.error));
  assert.deepEqual(f.control.createArgs, ['source-board']); assert.equal(f.control.associations, 0); assert.equal(result.createdBoardName, undefined);
  assert.equal(result.boardAssociation.boardUuid, 'source-board-id'); assert.equal(result.boardMode, 'existing-empty-board');
  assert.equal(f.control.boards[0].pcbUuid, 'existing-pcb');
});

test('missing public Board APIs and inconsistent source membership are actionable preflight blockers', async t => {
  const missing = await fixture(t); delete missing.eda.dmt_Board.createBoard;
  const result = await runPcbCreate({ ...missing.options, apply: true });
  assert.equal(result.error.code, 'BOARD_ASSOCIATION_API_UNAVAILABLE'); assert.match(result.error.message, /No PCB was created/);
  assert.equal(missing.control.creates, 0);
  const inconsistent = await fixture(t); inconsistent.control.sourceBoardName = 'unlisted-board';
  const blocked = await runPcbCreate({ ...inconsistent.options, apply: true }); assert.equal(blocked.error.code, 'SOURCE_BOARD_MISMATCH'); assert.equal(inconsistent.control.creates, 0);
  const cbb = await fixture(t); cbb.control.sourceItemType = 'CBB Schematic';
  const unsupported = await runPcbCreate({ ...cbb.options, apply: true }); assert.equal(unsupported.error.code, 'CBB_SOURCE_UNSUPPORTED'); assert.equal(cbb.control.creates, 0);
});

test('Board inventory changes since a frozen plan stop before creating a PCB', async t => {
  const f = await fixture(t), plan = await runPcbCreate(f.options);
  f.control.boards[0].name = 'renamed-existing-board';
  const result = await runPcbCreate(resume(f, plan, true));
  assert.equal(result.error.code, 'BOARD_PLAN_CHANGED'); assert.equal(f.control.creates, 0); assert.equal(f.control.imports, 0);
});

test('a wrong source association or changed old Board stops before import and retains the new PCB', async t => {
  for (const change of [
    f => { f.control.boards.at(-1).schematicUuid = 'different-source'; },
    f => { f.control.boards[0].pcbUuid = 'replaced-old-pcb'; },
  ]) {
    const f = await fixture(t); f.control.afterAssociation = () => change(f);
    const result = await runPcbCreate({ ...f.options, apply: true });
    assert.equal(result.createdPcbUuid, 'new-pcb'); assert.equal(f.control.imports, 0); assert.equal(f.control.saves, 0);
    assert.ok(['BOARD_ASSOCIATION_MISMATCH', 'BOARD_TREE_CHANGED'].includes(result.error.code));
  }
});

test('association changes while opening the new PCB stop before import', async t => {
  const f = await fixture(t); f.control.afterOpen = () => { f.control.sourceBoardName = 'different-board'; };
  const result = await runPcbCreate({ ...f.options, apply: true });
  assert.equal(result.error.code, 'BOARD_ASSOCIATION_MISMATCH'); assert.equal(f.control.imports, 0); assert.equal(f.control.saves, 0);
});

test('a known failed Board creation retains its PCB and never retries association or import', async t => {
  const f = await fixture(t); f.control.associationResult = false;
  const result = await runPcbCreate({ ...f.options, apply: true });
  assert.equal(result.error.code, 'BOARD_ASSOCIATION_NOT_CONFIRMED'); assert.equal(result.createdPcbUuid, 'new-pcb');
  const resumed = await runPcbCreate(resume(f, result, true));
  assert.equal(resumed.error.code, 'BOARD_ASSOCIATION_REQUIRED'); assert.equal(f.control.creates, 1); assert.equal(f.control.associations, 1); assert.equal(f.control.imports, 0);
});

test('unknown Board association and import outcomes block every automatic replay', async t => {
  for (const phase of ['associationThrows', 'importThrows']) {
    const f = await fixture(t); f.control[phase] = true;
    const result = await runPcbCreate({ ...f.options, apply: true });
    assert.equal(result.status, 'outcome-unknown'); assert.equal(result.createdPcbUuid, 'new-pcb');
    const resumed = await runPcbCreate(resume(f, result, true));
    assert.equal(resumed.status, 'outcome-unknown'); assert.equal(resumed.error.code, 'UNRESOLVED_WRITE');
    assert.equal(f.control.creates, 1); assert.equal(f.control.associations, 1); assert.equal(f.control.imports, phase === 'importThrows' ? 1 : 0);
  }
});

test('tampered frozen Board plan or association blocks creation or save recovery', async t => {
  const f = await fixture(t), plan = await runPcbCreate(f.options);
  await writeFile(join(plan.runDir, 'board-plan.json'), '{}');
  const blocked = await runPcbCreate(resume(f, plan, true)); assert.equal(blocked.error.code, 'FROZEN_BOARD_PLAN_CHANGED'); assert.equal(f.control.creates, 0);
  const saved = await fixture(t); saved.control.saveResult = false;
  const result = await runPcbCreate({ ...saved.options, apply: true });
  await writeFile(join(result.runDir, 'board-association.json'), '{}'); saved.control.saveResult = true;
  const stopped = await runPcbCreate(resume(saved, result, true)); assert.equal(stopped.error.code, 'FROZEN_BOARD_PLAN_CHANGED'); assert.equal(saved.control.saves, 1);
});

test('a legacy plan without Board preflight is blocked instead of creating another free PCB', async t => {
  const f = await fixture(t), plan = await runPcbCreate(f.options);
  const record = JSON.parse(await readFile(join(plan.runDir, 'result.json'), 'utf8')); delete record.boardPlanHash;
  await writeFile(join(plan.runDir, 'result.json'), JSON.stringify(record));
  const result = await runPcbCreate(resume(f, plan, true));
  assert.equal(result.error.code, 'FROZEN_BOARD_PLAN_CHANGED'); assert.equal(f.control.creates, 0); assert.equal(f.control.associations, 0);
});
