return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;
  const VALID_RULE_TYPES = new Set([2, 5, 6, 7, 8, 9]);
  const VALID_REGION_LAYERS = new Set([1, 2, 12, ...Array.from({ length: 30 }, (_, index) => 15 + index)]);
  const MAX_REGIONS_PER_APPLY = 20;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function getter(object, name, fallback = null) {
    try {
      return typeof object?.[name] === 'function' ? object[name]() : fallback;
    } catch {
      return fallback;
    }
  }

  function clone(value) {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function hashText(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a32-${hash.toString(16).padStart(8, '0')}`;
  }

  async function getAll(api) {
    if (typeof api?.getAll !== 'function') return [];
    const result = await api.getAll();
    return Array.isArray(result) ? result : [];
  }

  function primitiveId(item) {
    return getter(item, 'getState_PrimitiveId');
  }

  function polygonSource(item) {
    const polygon = getter(item, 'getState_ComplexPolygon');
    return clone(getter(polygon, 'getSource', []));
  }

  function summarizeRegion(item) {
    return {
      primitiveId: primitiveId(item),
      name: getter(item, 'getState_RegionName', ''),
      layer: Number(getter(item, 'getState_Layer')),
      ruleTypes: (Array.isArray(getter(item, 'getState_RuleType', [])) ? getter(item, 'getState_RuleType', []) : [])
        .map(Number).filter(Number.isFinite).sort((left, right) => left - right),
      lineWidth: Number(getter(item, 'getState_LineWidth', 0)),
      primitiveLock: Boolean(getter(item, 'getState_PrimitiveLock', false)),
      polygonSource: polygonSource(item),
    };
  }

  function summarizeLine(item) {
    return {
      id: primitiveId(item),
      net: getter(item, 'getState_Net', ''),
      layer: Number(getter(item, 'getState_Layer')),
      startX: Number(getter(item, 'getState_StartX')),
      startY: Number(getter(item, 'getState_StartY')),
      endX: Number(getter(item, 'getState_EndX')),
      endY: Number(getter(item, 'getState_EndY')),
      width: Number(getter(item, 'getState_LineWidth', 0)),
    };
  }

  async function captureProtected() {
    const [lines, arcs, polylines, vias, components, pours] = await Promise.all([
      getAll(eda.pcb_PrimitiveLine),
      getAll(eda.pcb_PrimitiveArc),
      getAll(eda.pcb_PrimitivePolyline),
      getAll(eda.pcb_PrimitiveVia),
      getAll(eda.pcb_PrimitiveComponent),
      getAll(eda.pcb_PrimitivePour),
    ]);
    const payload = {
      lines: lines.map(summarizeLine).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      arcs: arcs.map((item) => ({ ...summarizeLine(item), angle: Number(getter(item, 'getState_ArcAngle', 0)) })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      polylines: polylines.map((item) => ({
        id: primitiveId(item),
        net: getter(item, 'getState_Net', ''),
        layer: Number(getter(item, 'getState_Layer')),
        source: clone(getter(getter(item, 'getState_Polygon'), 'getSource', [])),
      })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      vias: vias.map((item) => ({
        id: primitiveId(item),
        net: getter(item, 'getState_Net', ''),
        x: Number(getter(item, 'getState_X')),
        y: Number(getter(item, 'getState_Y')),
        diameter: Number(getter(item, 'getState_Diameter', 0)),
        holeDiameter: Number(getter(item, 'getState_HoleDiameter', 0)),
      })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      components: components.map((item) => ({
        id: primitiveId(item),
        designator: getter(item, 'getState_Designator', ''),
        layer: Number(getter(item, 'getState_Layer')),
        x: Number(getter(item, 'getState_X')),
        y: Number(getter(item, 'getState_Y')),
        rotation: Number(getter(item, 'getState_Rotation', 0)),
      })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      pours: pours.map((item) => ({
        id: primitiveId(item),
        net: getter(item, 'getState_Net', ''),
        layer: Number(getter(item, 'getState_Layer')),
        source: clone(getter(getter(item, 'getState_ComplexPolygon'), 'getSource', [])),
      })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    };
    return {
      counts: Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, value.length])),
      fingerprint: hashText(stableStringify(payload)),
    };
  }

  async function captureState() {
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if (!document || Number(document.documentType) !== 3) fail('PCB_DOCUMENT_REQUIRED', 'The active EasyEDA document is not a PCB.');
    const [regions, protectedState] = await Promise.all([
      getAll(eda.pcb_PrimitiveRegion),
      captureProtected(),
    ]);
    const state = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      document: {
        uuid: document.uuid,
        tabId: document.tabId,
        documentType: document.documentType,
        parentProjectUuid: document.parentProjectUuid ?? null,
      },
      regions: regions.map(summarizeRegion).sort((a, b) => String(a.primitiveId).localeCompare(String(b.primitiveId))),
      protected: protectedState,
    };
    state.inspectionFingerprint = hashText(stableStringify({
      documentUuid: state.document.uuid,
      regions: state.regions,
      protectedFingerprint: state.protected.fingerprint,
    }));
    return state;
  }

  function normalizePlan(rawPlan, state) {
    if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) fail('INVALID_KEEPOUT_PLAN', 'plan must be an object.');
    if (rawPlan.schemaVersion !== 1) fail('INVALID_KEEPOUT_PLAN', 'plan.schemaVersion must be 1.');
    if (typeof rawPlan.expectedDocumentUuid !== 'string' || !rawPlan.expectedDocumentUuid) fail('INVALID_KEEPOUT_PLAN', 'expectedDocumentUuid is required.');
    if (typeof rawPlan.expectedInspectionFingerprint !== 'string' || !rawPlan.expectedInspectionFingerprint) fail('INVALID_KEEPOUT_PLAN', 'expectedInspectionFingerprint is required.');
    if (!Array.isArray(rawPlan.regions) || rawPlan.regions.length === 0 || rawPlan.regions.length > MAX_REGIONS_PER_APPLY) {
      fail('INVALID_KEEPOUT_PLAN', `regions must contain 1-${MAX_REGIONS_PER_APPLY} entries.`);
    }
    const names = new Set();
    const regions = rawPlan.regions.map((rawRegion, index) => {
      const name = typeof rawRegion?.name === 'string' ? rawRegion.name.trim() : '';
      if (!name) fail('INVALID_KEEPOUT_PLAN', `regions[${index}].name is required.`);
      if (names.has(name) || state.regions.some((item) => item.name === name)) fail('KEEPOUT_NAME_EXISTS', `Region name already exists: ${name}`);
      names.add(name);
      const layer = Number(rawRegion.layer);
      if (!VALID_REGION_LAYERS.has(layer)) fail('INVALID_KEEPOUT_PLAN', `Unsupported region layer ${layer}.`);
      const ruleTypes = [...new Set((Array.isArray(rawRegion.ruleTypes) ? rawRegion.ruleTypes : []).map(Number))].sort((a, b) => a - b);
      if (ruleTypes.length === 0 || ruleTypes.some((item) => !VALID_RULE_TYPES.has(item))) fail('INVALID_KEEPOUT_PLAN', `Invalid ruleTypes for ${name}.`);
      const source = clone(rawRegion.polygonSource);
      if (!Array.isArray(source) || source.length < 3) fail('INVALID_KEEPOUT_PLAN', `polygonSource is required for ${name}.`);
      const lineWidth = Number(rawRegion.lineWidth ?? 10);
      if (!Number.isFinite(lineWidth) || lineWidth <= 0) fail('INVALID_KEEPOUT_PLAN', `lineWidth must be positive for ${name}.`);
      return {
        name,
        layer,
        ruleTypes,
        polygonSource: source,
        polygonSourceFingerprint: hashText(stableStringify(source)),
        lineWidth,
        primitiveLock: Boolean(rawRegion.primitiveLock ?? true),
        rationale: typeof rawRegion.rationale === 'string' ? rawRegion.rationale : null,
      };
    });
    return {
      schemaVersion: 1,
      expectedDocumentUuid: rawPlan.expectedDocumentUuid,
      expectedInspectionFingerprint: rawPlan.expectedInspectionFingerprint,
      regions,
    };
  }

  async function deleteCreated(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return { deleted: true, remainingIds: [] };
    const deleted = await eda.pcb_PrimitiveRegion.delete(unique);
    const remaining = (await getAll(eda.pcb_PrimitiveRegion)).map(primitiveId).filter((id) => unique.includes(id));
    return { deleted: Boolean(deleted) && remaining.length === 0, remainingIds: remaining };
  }

  async function applyPlan(plan) {
    const before = await captureState();
    if (before.document.uuid !== plan.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', `Expected ${plan.expectedDocumentUuid}, got ${before.document.uuid}.`);
    if (before.inspectionFingerprint !== plan.expectedInspectionFingerprint) fail('STALE_KEEPOUT_PLAN', 'PCB geometry or regions changed after planning.');
    const createdIds = [];
    try {
      for (const expected of plan.regions) {
        const polygon = eda.pcb_MathPolygon.createPolygon(expected.polygonSource);
        if (!polygon) fail('POLYGON_CREATE_FAILED', `EasyEDA rejected the polygon for ${expected.name}.`);
        const created = await eda.pcb_PrimitiveRegion.create(
          expected.layer,
          polygon,
          expected.ruleTypes,
          expected.name,
          expected.lineWidth,
          expected.primitiveLock,
        );
        if (!created) fail('KEEPOUT_CREATE_FAILED', `EasyEDA rejected ${expected.name}.`);
        const id = primitiveId(created);
        createdIds.push(id);
        const refreshed = await eda.pcb_PrimitiveRegion.get(id);
        const actual = summarizeRegion(refreshed);
        const nameMismatch = actual.name !== undefined && actual.name !== null && actual.name !== '' && actual.name !== expected.name;
        const polygonMismatch = hashText(stableStringify(actual.polygonSource)) !== expected.polygonSourceFingerprint;
        if (nameMismatch || actual.layer !== expected.layer || stableStringify(actual.ruleTypes) !== stableStringify(expected.ruleTypes) || polygonMismatch) {
          fail('KEEPOUT_READBACK_MISMATCH', `${expected.name} did not read back exactly: ${stableStringify({
            expected: { name: expected.name, layer: expected.layer, ruleTypes: expected.ruleTypes, polygonSourceFingerprint: expected.polygonSourceFingerprint },
            actual: { name: actual.name, layer: actual.layer, ruleTypes: actual.ruleTypes, polygonSourceFingerprint: hashText(stableStringify(actual.polygonSource)) },
          })}`);
        }
      }
      const after = await captureState();
      if (after.protected.fingerprint !== before.protected.fingerprint) fail('PROTECTED_GEOMETRY_CHANGED', 'Copper, vias, components, or existing pours changed while creating Keepouts.');
      const createdRegions = after.regions.filter((item) => createdIds.includes(item.primitiveId));
      if (createdRegions.length !== createdIds.length) fail('KEEPOUT_EVIDENCE_INCOMPLETE', 'Not every created Keepout was found in independent readback.');
      return {
        status: 'applied',
        saved: false,
        plan,
        createdRegionIds: createdIds,
        createdRegions,
        before: { inspectionFingerprint: before.inspectionFingerprint, regionCount: before.regions.length, protectedFingerprint: before.protected.fingerprint },
        after: { inspectionFingerprint: after.inspectionFingerprint, regionCount: after.regions.length, protectedFingerprint: after.protected.fingerprint },
        rollbackRequest: {
          mode: 'rollback',
          expectedDocumentUuid: after.document.uuid,
          expectedCurrentInspectionFingerprint: after.inspectionFingerprint,
          createdRegionIds: createdIds,
        },
      };
    } catch (error) {
      const rollback = await deleteCreated(createdIds);
      return {
        status: rollback.deleted ? 'rolled-back' : 'rollback-incomplete',
        saved: false,
        error: { code: error.code ?? 'APPLY_FAILED', message: error.message },
        createdRegionIds: createdIds,
        rollback,
      };
    }
  }

  async function verifyPlan(plan, expectedRegionIds = []) {
    const state = await captureState();
    const issues = [];
    for (let index = 0; index < plan.regions.length; index += 1) {
      const expected = plan.regions[index];
      const expectedId = expectedRegionIds[index] ?? null;
      const matches = state.regions.filter((item) => expectedId
        ? item.primitiveId === expectedId
        : (
          item.layer === expected.layer
          && stableStringify(item.ruleTypes) === stableStringify(expected.ruleTypes)
          && hashText(stableStringify(item.polygonSource)) === expected.polygonSourceFingerprint
        ));
      if (matches.length !== 1) {
        issues.push({ code: 'KEEPOUT_COUNT', name: expected.name, count: matches.length });
        continue;
      }
      const actual = matches[0];
      if (actual.name !== undefined && actual.name !== null && actual.name !== '' && actual.name !== expected.name) issues.push({ code: 'KEEPOUT_NAME', name: expected.name, actual: actual.name });
      if (actual.layer !== expected.layer) issues.push({ code: 'KEEPOUT_LAYER', name: expected.name, expected: expected.layer, actual: actual.layer });
      if (stableStringify(actual.ruleTypes) !== stableStringify(expected.ruleTypes)) issues.push({ code: 'KEEPOUT_RULES', name: expected.name });
      if (hashText(stableStringify(actual.polygonSource)) !== expected.polygonSourceFingerprint) issues.push({ code: 'KEEPOUT_POLYGON', name: expected.name });
    }
    return { status: issues.length === 0 ? 'verified' : 'mismatch', readOnly: true, saved: false, issues, state };
  }

  const mode = request?.mode ?? 'inspect';
  if (mode === 'inspect') return { status: 'inspected', readOnly: true, state: await captureState() };
  if (mode === 'plan') {
    const state = await captureState();
    const plan = normalizePlan(request.plan, state);
    if (state.document.uuid !== plan.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'The plan targets another PCB.');
    if (state.inspectionFingerprint !== plan.expectedInspectionFingerprint) fail('STALE_KEEPOUT_PLAN', 'The inspection fingerprint is stale.');
    return { status: 'planned', readOnly: true, plan, existingRegionCount: state.regions.length };
  }
  if (mode === 'apply') {
    const state = await captureState();
    return applyPlan(normalizePlan(request.plan, state));
  }
  if (mode === 'verify') {
    const state = await captureState();
    const excluded = new Set(Array.isArray(request.expectedRegionIds) ? request.expectedRegionIds : []);
    const normalizationState = { ...state, regions: state.regions.filter((item) => !excluded.has(item.primitiveId)) };
    return verifyPlan(normalizePlan(request.plan, normalizationState), [...excluded]);
  }
  if (mode === 'rollback') {
    const state = await captureState();
    if (state.document.uuid !== request.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'Rollback targets another PCB.');
    if (typeof request.expectedCurrentInspectionFingerprint === 'string' && state.inspectionFingerprint !== request.expectedCurrentInspectionFingerprint) fail('STALE_ROLLBACK', 'The PCB changed after the Keepout transaction.');
    const rollback = await deleteCreated(Array.isArray(request.createdRegionIds) ? request.createdRegionIds : []);
    return { status: rollback.deleted ? 'rolled-back' : 'rollback-incomplete', saved: false, rollback, after: await captureState() };
  }
  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
