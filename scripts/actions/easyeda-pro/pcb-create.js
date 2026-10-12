return await (async () => {
  const input = flitrealizeInput ?? {}, mode = input.mode ?? 'inspect';
  const result = { status: 'blocked', createdPcbUuid: null, creationAttempted: false, associationAttempted: false, createdBoardName: null, boardAssociation: null, imported: null, saved: null, saveAttempted: false, stages: [] };
  const fail = (code, message = code) => { throw Object.assign(Error(message), { code }); };
  const text = value => typeof value === 'string' && value.trim();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const stableSource = source => source.split(/\r?\n/).filter(line => !line.startsWith('{"type":"DOCHEAD"')).join('\n');
  const project = async () => {
    const info = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if (info?.parentProjectUuid !== input.expectedProjectUuid) fail('PROJECT_MISMATCH');
    return info;
  };
  const current = async (uuid, type) => {
    const info = await project();
    if (info?.uuid !== uuid || info.documentType !== type) fail('DOCUMENT_MISMATCH');
    return info;
  };
  async function schematic() {
    const info = await eda.dmt_Schematic.getSchematicInfo(input.expectedSchematicUuid);
    if (info?.uuid !== input.expectedSchematicUuid || info.parentProjectUuid !== input.expectedProjectUuid) fail('SCHEMATIC_MISMATCH');
    if (!Array.isArray(info.page) || info.page.length !== 1 || info.page[0].uuid !== input.expectedSchematicPageUuid) fail('SINGLE_PAGE_REQUIRED');
    if (info.itemType === 'CBB Schematic') fail('CBB_SOURCE_UNSUPPORTED');
    return info;
  }
  async function source() {
    await current(input.expectedSchematicPageUuid, 1);
    const info = await schematic();
    const value = await eda.sys_FileManager.getDocumentSource();
    if (!text(value)) fail('SCHEMATIC_SOURCE_UNAVAILABLE');
    if (input.expectedSource !== undefined && stableSource(value) !== input.expectedSource) fail('SCHEMATIC_CHANGED');
    await current(input.expectedSchematicPageUuid, 1);
    return { info, value: stableSource(value) };
  }
  async function tree() {
    await project();
    const boards = await eda.dmt_Board.getAllBoardsInfo(), pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
    if (!Array.isArray(boards) || boards.some(board => !text(board?.uuid) || !text(board.name) || board.parentProjectUuid !== input.expectedProjectUuid || [board.schematic, board.pcb].some(child => child && (!text(child.uuid) || child.parentProjectUuid !== input.expectedProjectUuid)))) fail('BOARD_INVENTORY_UNAVAILABLE');
    if (!Array.isArray(pcbs) || pcbs.some(pcb => !text(pcb?.uuid) || pcb.parentProjectUuid !== input.expectedProjectUuid)) fail('PCB_INVENTORY_UNAVAILABLE');
    if (new Set(boards.map(board => board.uuid)).size !== boards.length || new Set(boards.map(board => board.name)).size !== boards.length || new Set(pcbs.map(pcb => pcb.uuid)).size !== pcbs.length) fail('BOARD_INVENTORY_AMBIGUOUS');
    return { boards: boards.map(board => ({ uuid: board.uuid, name: board.name, schematicUuid: board.schematic?.uuid ?? null, pcbUuid: board.pcb?.uuid ?? null })).sort((a, b) => a.uuid.localeCompare(b.uuid)), pcbIds: pcbs.map(pcb => pcb.uuid).sort() };
  }
  async function preflight(info) {
    const inventory = await tree(), matches = inventory.boards.filter(board => board.schematicUuid === input.expectedSchematicUuid);
    if (matches.length > 1 || (info.parentBoardName ? matches.length !== 1 || matches[0].name !== info.parentBoardName : matches.length !== 0)) fail('SOURCE_BOARD_MISMATCH');
    const board = matches[0];
    if (board?.pcbUuid) fail('SOURCE_BOARD_HAS_PCB', 'The source Board already has a PCB; this entry never replaces it. Use an explicitly selected unassigned schematic copy in an isolated project, or a Board without a PCB, then make a new plan.');
    if (!board && typeof eda.dmt_Board.createBoard !== 'function') fail('BOARD_ASSOCIATION_API_UNAVAILABLE', 'A free schematic needs the public dmt_Board.createBoard API before import. No PCB was created; establish an isolated Board without a PCB and replan.');
    return { mode: board ? 'existing-empty-board' : 'create-board', boardUuid: board?.uuid ?? null, boardName: board?.name ?? null, beforeBoards: inventory.boards, beforePcbIds: inventory.pcbIds };
  }
  async function association(pcbUuid, expected, plan) {
    if (!expected || !text(expected.boardUuid) || !text(expected.boardName) || expected.schematicUuid !== input.expectedSchematicUuid || expected.pcbUuid !== pcbUuid || expected.projectUuid !== input.expectedProjectUuid || !['create-board', 'existing-empty-board'].includes(expected.mode)) fail('BOARD_ASSOCIATION_REQUIRED');
    const info = await schematic(), pcb = await eda.dmt_Pcb.getPcbInfo(pcbUuid), inventory = await tree();
    if (pcb?.uuid !== pcbUuid || pcb.parentProjectUuid !== input.expectedProjectUuid) fail('CREATED_PCB_MISMATCH');
    const board = inventory.boards.find(board => board.uuid === expected.boardUuid);
    if (!board || board.name !== expected.boardName || board.schematicUuid !== input.expectedSchematicUuid || board.pcbUuid !== pcbUuid || info.parentBoardName !== expected.boardName || pcb.parentBoardName !== expected.boardName) fail('BOARD_ASSOCIATION_MISMATCH', 'The exact source schematic and newly created PCB must belong to the same verified Board; import was not retried.');
    if (plan) {
      const expectedBoards = plan.beforeBoards.map(before => before.uuid === plan.boardUuid && plan.mode === 'existing-empty-board' ? { ...before, pcbUuid } : before);
      if (plan.mode === 'create-board') {
        if (plan.beforeBoards.some(before => before.uuid === board.uuid || before.name === board.name)) fail('EXISTING_BOARD_RETURNED');
        expectedBoards.push(board);
      }
      expectedBoards.sort((a, b) => a.uuid.localeCompare(b.uuid));
      if (!same(inventory.boards, expectedBoards) || !same(inventory.pcbIds, [...plan.beforePcbIds, pcbUuid].sort())) fail('BOARD_TREE_CHANGED', 'An existing Board or PCB inventory changed outside this creation; reconcile it before any import.');
    }
    await project();
    return expected;
  }
  let pendingWrite = null;
  async function write(name, call) {
    pendingWrite = name;
    const start = Date.now();
    try { const value = await call(); pendingWrite = null; return value; }
    finally { result.stages.push({ name, milliseconds: Date.now() - start }); }
  }
  try {
    if (!['inspect', 'apply', 'verify'].includes(mode)) fail('UNSUPPORTED_ACTION_MODE');
    if (!['expectedProjectUuid', 'expectedSchematicUuid', 'expectedSchematicPageUuid'].every(key => text(input[key]))) fail('TARGET_REQUIRED');
    const commonMethods = [['dmt_SelectControl', 'getCurrentDocumentInfo'], ['dmt_Schematic', 'getSchematicInfo'], ['dmt_Board', 'getAllBoardsInfo'], ['dmt_Pcb', 'getPcbInfo'], ['dmt_Pcb', 'getAllPcbsInfo'], ['dmt_EditorControl', 'openDocument']];
    const methods = mode === 'verify' ? commonMethods : [...commonMethods, ['sys_FileManager', 'getDocumentSource'], ['dmt_Pcb', 'createPcb'], ['pcb_Document', 'importChanges'], ['pcb_Document', 'save'], ['pcb_Net', 'getNetlist'], ['pcb_PrimitiveComponent', 'getAll'], ['pcb_PrimitivePad', 'getAll'], ['pcb_Primitive', 'getPrimitivesBBox']];
    const unavailable = methods.filter(([owner, method]) => typeof eda?.[owner]?.[method] !== 'function').map(([owner, method]) => owner + '.' + method);
    if (unavailable.length) fail('PCB_CREATE_API_UNAVAILABLE', unavailable.join(', '));
    if (mode === 'verify') {
      if (!text(input.createdPcbUuid)) fail('CREATED_PCB_REQUIRED');
      await project();
      await association(input.createdPcbUuid, input.expectedBoardAssociation, input.expectedBoardPlan);
      await eda.dmt_EditorControl.openDocument(input.createdPcbUuid);
      await current(input.createdPcbUuid, 3);
      return { ...result, status: 'verified', createdPcbUuid: input.createdPcbUuid, boardAssociation: input.expectedBoardAssociation, target: { projectUuid: input.expectedProjectUuid, pcbUuid: input.createdPcbUuid } };
    }
    const captured = await source(), boardPlan = await preflight(captured.info);
    if (mode === 'inspect') return { ...result, status: 'inspected', expectedSource: captured.value, boardPlan, target: { projectUuid: input.expectedProjectUuid, schematicUuid: input.expectedSchematicUuid, pageUuid: input.expectedSchematicPageUuid }, capabilities: { checked: methods.map(([owner, method]) => owner + '.' + method) }, scope: 'one-page-source;new-pcb;same-board-verified;no-existing-pcb-update;no-upstream-electrical-revalidation' };
    if (!text(input.expectedSource)) fail('SOURCE_PLAN_REQUIRED');
    if (!input.expectedBoardPlan) fail('BOARD_PLAN_REQUIRED', 'The frozen plan has no Board preflight. Make a current plan before creating any PCB; do not bypass an earlier unknown run.');
    if (!same(boardPlan, input.expectedBoardPlan)) fail('BOARD_PLAN_CHANGED', 'Board membership or PCB inventory changed since planning. No PCB was created.');
    if (input.createdPcbUuid !== undefined) fail('NEW_PCB_ONLY');
    result.creationAttempted = true;
    const returned = await write('createPcb', () => boardPlan.mode === 'existing-empty-board' ? eda.dmt_Pcb.createPcb(boardPlan.boardName) : eda.dmt_Pcb.createPcb());
    if (!text(returned)) fail('PCB_CREATION_NOT_CONFIRMED');
    if (boardPlan.beforePcbIds.includes(returned)) { result.returnedPcbUuid = returned; result.creation = 'rejected-existing-id'; fail('EXISTING_PCB_RETURNED'); }
    result.createdPcbUuid = returned;
    const pcb = await eda.dmt_Pcb.getPcbInfo(returned);
    if (pcb?.uuid !== returned || pcb.parentProjectUuid !== input.expectedProjectUuid) fail('CREATED_PCB_MISMATCH');
    let boardName = boardPlan.boardName;
    if (boardPlan.mode === 'create-board') {
      if (pcb.parentBoardName) fail('CREATED_PCB_ASSOCIATION_UNEXPECTED');
      await current(input.expectedSchematicPageUuid, 1);
      const info = await schematic(), inventory = await tree();
      if (info.parentBoardName || !same(inventory.boards, boardPlan.beforeBoards) || !same(inventory.pcbIds, [...boardPlan.beforePcbIds, returned].sort())) fail('BOARD_TREE_CHANGED');
      result.associationAttempted = true;
      boardName = await write('createBoard', () => eda.dmt_Board.createBoard(input.expectedSchematicUuid, returned));
      if (!text(boardName)) fail('BOARD_ASSOCIATION_NOT_CONFIRMED', 'The new PCB is retained; Board creation was not confirmed. Do not recreate or reimport.');
      result.createdBoardName = boardName;
    }
    const inventory = await tree(), board = inventory.boards.find(board => board.name === boardName);
    if (!board) fail('BOARD_ASSOCIATION_NOT_CONFIRMED');
    result.boardAssociation = { mode: boardPlan.mode, boardUuid: board.uuid, boardName, schematicUuid: input.expectedSchematicUuid, pcbUuid: returned, projectUuid: input.expectedProjectUuid };
    await association(returned, result.boardAssociation, boardPlan);
    await eda.dmt_EditorControl.openDocument(returned);
    await current(returned, 3);
    await association(returned, result.boardAssociation, boardPlan);
    result.importAttempted = true;
    result.imported = await write('importChanges', () => eda.pcb_Document.importChanges(input.expectedSchematicUuid, true));
    if (result.imported !== true) fail('SCHEMATIC_IMPORT_NOT_CONFIRMED');
    await current(returned, 3);
    await association(returned, result.boardAssociation, boardPlan);
    result.status = 'applied';
    result.target = { projectUuid: input.expectedProjectUuid, pcbUuid: returned };
  } catch (error) {
    result.status = pendingWrite || result.creationAttempted && !result.createdPcbUuid && result.creation !== 'rejected-existing-id' ? 'outcome-unknown' : result.creationAttempted ? 'apply-failed' : 'blocked';
    result.uncertainWrite = result.status === 'outcome-unknown';
    result.pendingWrite = pendingWrite;
    result.error = { code: error.code ?? 'PCB_CREATE_FAILED', message: error.message };
    result.creation ??= result.createdPcbUuid ? 'confirmed' : result.creationAttempted ? 'unconfirmed' : 'not-attempted';
  }
  return result;
})();
