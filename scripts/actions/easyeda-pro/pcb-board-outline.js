// Create a rectangular board outline on BOARD_OUTLINE via Polyline (not Line).
return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;
  const mode = request.mode ?? 'inspect';
  const BOARD_OUTLINE_LAYER = 11;
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const getter = (object, name, fallback = null) => {
    try {
      return typeof object?.[name] === 'function' ? object[name]() : fallback;
    } catch {
      return fallback;
    }
  };
  if (!['inspect', 'plan', 'apply', 'verify', 'save'].includes(mode)) fail('INVALID_MODE', 'Unsupported mode: ' + mode);

  function targetInput(value) {
    if (typeof value?.expectedDocumentUuid !== 'string' || !value.expectedDocumentUuid
      || typeof value?.expectedProjectUuid !== 'string' || !value.expectedProjectUuid) {
      fail('TARGET_REQUIRED', 'Explicit project and PCB UUIDs are required.');
    }
    return { expectedProjectUuid: value.expectedProjectUuid, expectedDocumentUuid: value.expectedDocumentUuid };
  }

  async function assertTarget(target) {
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    const project = await eda.dmt_Project.getCurrentProjectInfo();
    if (Number(document?.documentType) !== 3 || document?.uuid !== target.expectedDocumentUuid
      || project?.uuid !== target.expectedProjectUuid) {
      fail('TARGET_MISMATCH', 'Active project or PCB differs from the requested target.');
    }
  }

  function normalizeRect(value) {
    const originX = Number(value?.originX ?? 0);
    const originY = Number(value?.originY ?? 0);
    const widthMil = Number(value?.widthMil);
    const heightMil = Number(value?.heightMil);
    if (![originX, originY, widthMil, heightMil].every(Number.isFinite)) {
      fail('INVALID_RECT', 'Rectangle needs finite originX/originY/widthMil/heightMil.');
    }
    if (widthMil <= 0 || heightMil <= 0) fail('INVALID_RECT', 'widthMil and heightMil must be positive.');
    return { originX, originY, widthMil, heightMil };
  }

  function rectPath(rect) {
    const x0 = rect.originX;
    const y0 = rect.originY;
    const x1 = rect.originX + rect.widthMil;
    const y1 = rect.originY + rect.heightMil;
    return [x0, y0, 'L', x1, y0, x1, y1, x0, y1, x0, y0];
  }

  function normalizePath(value) {
    if (!Array.isArray(value) || value.length < 10) fail('INVALID_PATH', 'path needs a closed polyline source (at least a rectangle).');
    if (!value.every((entry) => entry === 'L' || entry === 'ARC' || Number.isFinite(Number(entry)))) {
      fail('INVALID_PATH', 'path entries must be finite numbers or L/ARC markers.');
    }
    return [...value];
  }

  function outlinePlan(requestValue, existing) {
    const replace = requestValue.replace === true;
    if (existing.length && !replace) {
      fail('OUTLINE_ALREADY_EXISTS', 'Board outline polyline already exists; pass replace:true only after reviewing the live outline.');
    }
    if (replace && existing.length !== 1) {
      fail('OUTLINE_REPLACE_REQUIRES_SINGLE', 'replace:true requires exactly one existing board-outline polyline.');
    }
    let source;
    let label;
    if (requestValue.rect) {
      const rect = normalizeRect(requestValue.rect);
      source = rectPath(rect);
      label = { kind: 'rectangle', ...rect };
    } else if (requestValue.path) {
      source = normalizePath(requestValue.path);
      label = { kind: 'path', points: source.filter((entry) => entry !== 'L' && entry !== 'ARC').length / 2 };
    } else {
      fail('OUTLINE_GEOMETRY_REQUIRED', 'Provide rect {originX,originY,widthMil,heightMil} or an explicit path.');
    }
    const widthMil = Number.isFinite(Number(requestValue.lineWidthMil)) ? Number(requestValue.lineWidthMil) : 10;
    if (!(widthMil > 0)) fail('INVALID_LINE_WIDTH', 'lineWidthMil must be positive.');
    return { replace, source, lineWidthMil: widthMil, geometry: label, existingIds: existing.map((item) => getter(item, 'getState_PrimitiveId')) };
  }

  async function listOutlines() {
    if (typeof eda.pcb_PrimitivePolyline?.getAll !== 'function') fail('CAPABILITY_MISSING', 'pcb_PrimitivePolyline.getAll is required.');
    const items = await eda.pcb_PrimitivePolyline.getAll(BOARD_OUTLINE_LAYER);
    if (!Array.isArray(items)) fail('OUTLINE_READ_FAILED', 'Outline polyline list was not an array.');
    return items.map((item) => ({
      primitiveId: getter(item, 'getState_PrimitiveId'),
      layer: Number(getter(item, 'getState_Layer')),
      lineWidthMil: Number(getter(item, 'getState_LineWidth')),
      source: getter(item, 'getState_Polygon')?.getSource?.() ?? getter(item, 'getState_Polygon')?.source ?? null,
      raw: item,
    }));
  }

  const target = targetInput(request.plan ?? request);
  await assertTarget(target);
  const existing = await listOutlines();
  const display = {
    mechanism: 'board-outline-polyline',
    boardOutlineLayer: BOARD_OUTLINE_LAYER,
    uses: 'pcb_PrimitivePolyline.create + pcb_MathPolygon.createPolygon',
    not: 'pcb_PrimitiveLine cannot create layer 11 outlines',
  };

  if (mode === 'inspect') {
    return {
      status: 'inspected',
      readOnly: true,
      ...display,
      outlines: existing.map(({ raw, ...summary }) => summary),
      count: existing.length,
    };
  }

  if (mode === 'verify') {
    const after = await listOutlines();
    const issues = [];
    if (after.length !== 1) issues.push({ code: 'OUTLINE_COUNT', count: after.length });
    else {
      const outline = after[0];
      if (outline.layer !== BOARD_OUTLINE_LAYER) issues.push({ code: 'OUTLINE_LAYER', layer: outline.layer });
      if (!Array.isArray(outline.source) || outline.source.length < 10) issues.push({ code: 'OUTLINE_SOURCE_MISSING' });
    }
    return {
      status: issues.length ? 'mismatch' : 'verified',
      readOnly: true,
      ...display,
      issues,
      outlines: after.map(({ raw, ...summary }) => summary),
    };
  }

  if (mode === 'save') {
    if (typeof eda.pcb_Document?.save !== 'function') fail('CAPABILITY_MISSING', 'pcb_Document.save is required.');
    await assertTarget(target);
    const after = await listOutlines();
    if (after.length !== 1) fail('STALE_SAVE', 'Exactly one board outline must exist before save.');
    if (await eda.pcb_Document.save() !== true) fail('SAVE_FAILED', 'PCB save did not confirm success.');
    const saved = await listOutlines();
    if (saved.length !== 1) fail('SAVE_READBACK_CHANGED', 'Outline count changed while saving.');
    return { status: 'applied', saved: true, ...display, outlines: saved.map(({ raw, ...summary }) => summary) };
  }

  const planInput = request.plan ?? request;
  const planned = outlinePlan(planInput, existing);
  if (mode === 'plan') {
    return {
      status: 'planned',
      readOnly: true,
      ...display,
      plan: {
        schemaVersion: 1,
        ...target,
        replace: planned.replace,
        path: planned.source,
        lineWidthMil: planned.lineWidthMil,
        geometry: planned.geometry,
        expectedExistingIds: planned.existingIds,
      },
      applyRequest: {
        mode: 'apply',
        plan: {
          schemaVersion: 1,
          ...target,
          replace: planned.replace,
          path: planned.source,
          lineWidthMil: planned.lineWidthMil,
        },
      },
    };
  }

  // apply
  if (typeof eda.pcb_MathPolygon?.createPolygon !== 'function') fail('CAPABILITY_MISSING', 'pcb_MathPolygon.createPolygon is required.');
  if (typeof eda.pcb_PrimitivePolyline?.create !== 'function') fail('CAPABILITY_MISSING', 'pcb_PrimitivePolyline.create is required.');
  await assertTarget(target);
  const live = await listOutlines();
  if (live.length !== existing.length || live.some((item, index) => item.primitiveId !== existing[index]?.primitiveId)) {
    fail('OUTLINE_CHANGED', 'Board outline set changed after planning; inspect again.');
  }
  let removed = [];
  if (planned.replace) {
    const previous = live[0];
    if (typeof eda.pcb_PrimitivePolyline?.delete !== 'function') fail('CAPABILITY_MISSING', 'pcb_PrimitivePolyline.delete is required for replace.');
    if (await eda.pcb_PrimitivePolyline.delete(previous.raw) !== true) fail('OUTLINE_DELETE_FAILED', 'Could not remove the previous outline.');
    removed = [previous.primitiveId];
  }
  let created = null;
  try {
    const polygon = eda.pcb_MathPolygon.createPolygon(planned.source);
    created = await eda.pcb_PrimitivePolyline.create('', BOARD_OUTLINE_LAYER, polygon, planned.lineWidthMil, false);
    if (!created) fail('OUTLINE_CREATE_FAILED', 'Polyline.create returned no object.');
    const layer = Number(getter(created, 'getState_Layer'));
    const lineWidthMil = Number(getter(created, 'getState_LineWidth'));
    const source = getter(created, 'getState_Polygon')?.getSource?.() ?? null;
    if (layer !== BOARD_OUTLINE_LAYER || !Array.isArray(source) || source.length < 10) {
      fail('OUTLINE_READBACK_FAILED', 'Created outline did not read back as a layer-11 closed polyline.');
    }
    const primitiveId = getter(created, 'getState_PrimitiveId');
    return {
      status: 'applied',
      saved: false,
      ...display,
      createdId: primitiveId,
      removedIds: removed,
      outline: { primitiveId, layer, lineWidthMil, source },
      verifyRequest: { mode: 'verify', ...target },
      saveRequest: { mode: 'save', ...target },
    };
  } catch (error) {
    let rolledBack = false;
    if (created && typeof eda.pcb_PrimitivePolyline?.delete === 'function') {
      try {
        rolledBack = await eda.pcb_PrimitivePolyline.delete(created) === true;
      } catch {
        rolledBack = false;
      }
    }
    return {
      status: 'apply-failed',
      saved: false,
      ...display,
      error: { code: error.code ?? 'WRITE_FAILED', message: error.message },
      removedIds: removed,
      createdRolledBack: rolledBack,
      recovery: rolledBack
        ? 'Failed create was deleted; previous outline remains only if replace did not complete deletion first.'
        : 'Inspect live board-outline polylines before retrying; do not assume the board is unchanged.',
    };
  }
})();
