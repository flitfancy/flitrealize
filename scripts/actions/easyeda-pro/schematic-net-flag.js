return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;
  const VALID_IDENTIFICATIONS = new Set(['Power', 'Ground', 'AnalogGround', 'ProtectGround']);
  const VALID_DIRECTIONS = new Set(['IN', 'OUT', 'BI']);
  const MAX_ITEMS_PER_APPLY = 100;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function callGetter(object, name, fallback = null) {
    try {
      return typeof object?.[name] === 'function' ? object[name]() : fallback;
    } catch {
      return fallback;
    }
  }

  function finiteOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
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

  async function optionalCall(namespace, method, ...args) {
    if (typeof eda?.[namespace]?.[method] !== 'function') return { value: null, error: null };
    try {
      return { value: await eda[namespace][method](...args), error: null };
    } catch (error) {
      return { value: null, error: error.message };
    }
  }

  function summarizeComponent(component) {
    return {
      primitiveId: callGetter(component, 'getState_PrimitiveId'),
      designator: callGetter(component, 'getState_Designator'),
      net: callGetter(component, 'getState_Net', ''),
      componentType: callGetter(component, 'getState_ComponentType'),
      x: finiteOrNull(callGetter(component, 'getState_X')),
      y: finiteOrNull(callGetter(component, 'getState_Y')),
      rotation: finiteOrNull(callGetter(component, 'getState_Rotation')),
      mirror: callGetter(component, 'getState_Mirror', false) === true,
    };
  }

  function flagMatches(actual, expected) {
    return actual
      && actual.primitiveId === expected.primitiveId
      && actual.net === expected.net
      && actual.componentType === expected.componentType
      && actual.x === expected.x
      && actual.y === expected.y
      && actual.rotation === expected.rotation
      && actual.mirror === expected.mirror;
  }

  async function captureState() {
    const documentProbe = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    const document = documentProbe.value
      ? { uuid: documentProbe.value.uuid ?? null, parentProjectUuid: documentProbe.value.parentProjectUuid ?? null }
      : null;
    const allComponents = await optionalCall('sch_PrimitiveComponent', 'getAll');
    const components = Array.isArray(allComponents.value) ? allComponents.value.map(summarizeComponent) : [];
    const inspectionFingerprint = hashText(stableStringify({
      documentUuid: document?.uuid,
      components: components.map((component) => ({
        primitiveId: component.primitiveId,
        designator: component.designator,
        net: component.net,
        componentType: component.componentType,
        x: component.x,
        y: component.y,
        rotation: component.rotation,
        mirror: component.mirror,
      })).sort((left, right) => String(left.primitiveId).localeCompare(String(right.primitiveId))),
    }));
    return { document, components, inspectionFingerprint };
  }

  function normalizePlan(value, expectedDocumentUuid = null) {
    const sourceItems = Array.isArray(value) ? value : value?.items;
    if (!Array.isArray(sourceItems)) fail('INVALID_REQUEST', 'items must be an array');
    const items = sourceItems.map((item, index) => {
      if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) fail('INVALID_ITEM', `Item ${index}: x and y must be finite numbers`);
      if (typeof item.net !== 'string' || !item.net.trim()) fail('INVALID_ITEM', `Item ${index}: net name is required`);
      const common = {
        index,
        net: item.net.trim(),
        x: item.x,
        y: item.y,
        rotation: item.rotation ?? 0,
        mirror: item.mirror ?? false,
      };
      if (item.kind === 'netFlag') {
        if (!VALID_IDENTIFICATIONS.has(item.identification)) {
          fail('INVALID_ITEM', `Item ${index}: identification must be one of ${[...VALID_IDENTIFICATIONS].join(', ')}`);
        }
        return { ...common, kind: 'netFlag', identification: item.identification };
      }
      if (item.kind === 'netPort') {
        if (!VALID_DIRECTIONS.has(item.direction)) {
          fail('INVALID_ITEM', `Item ${index}: direction must be one of ${[...VALID_DIRECTIONS].join(', ')}`);
        }
        return { ...common, kind: 'netPort', direction: item.direction };
      }
      fail('INVALID_ITEM', `Item ${index}: kind must be 'netFlag' or 'netPort'`);
    });
    const planObject = Array.isArray(value) ? {} : value;
    return { items, expectedDocumentUuid: expectedDocumentUuid ?? planObject?.expectedDocumentUuid ?? null };
  }

  function analyzePlan(state, plan) {
    const globalIssues = [];
    if (!plan.expectedDocumentUuid) globalIssues.push({ code: 'DOCUMENT_IDENTITY_REQUIRED' });
    else if (state.document?.uuid !== plan.expectedDocumentUuid) {
      globalIssues.push({ code: 'DOCUMENT_MISMATCH', expected: plan.expectedDocumentUuid, actual: state.document?.uuid });
    }
    if (plan.items.length > MAX_ITEMS_PER_APPLY) globalIssues.push({ code: 'TOO_MANY_ITEMS', count: plan.items.length, max: MAX_ITEMS_PER_APPLY });
    const itemKeys = new Set();
    for (const item of plan.items) {
      const key = stableStringify({
        kind: item.kind,
        net: item.net,
        x: item.x,
        y: item.y,
        rotation: item.rotation,
        mirror: item.mirror,
        identification: item.identification ?? null,
        direction: item.direction ?? null,
      });
      if (itemKeys.has(key)) globalIssues.push({ code: 'DUPLICATE_PLAN_ITEM', index: item.index });
      itemKeys.add(key);
    }
    const planFingerprint = hashText(stableStringify({
      inspectionFingerprint: state.inspectionFingerprint,
      plan,
      globalIssueCodes: globalIssues.map((issue) => issue.code),
    }));
    return {
      applyReady: plan.items.length > 0 && globalIssues.length === 0,
      itemCount: plan.items.length,
      globalIssues,
      planFingerprint,
    };
  }

  async function rollbackCreated(created) {
    const ids = created.map((item) => item.primitiveId).filter(Boolean);
    if (!ids.length) return { deleted: true, remaining: 0 };
    let deleted = false;
    try {
      deleted = await eda.sch_PrimitiveComponent.delete(ids);
    } catch {
      deleted = false;
    }
    const probe = await optionalCall('sch_PrimitiveComponent', 'getAll');
    const remaining = Array.isArray(probe.value)
      ? probe.value.map(summarizeComponent).filter((component) => ids.includes(component.primitiveId))
      : ids;
    return { deleted: Boolean(deleted), remaining: remaining.length };
  }

  async function applyPlan(plan, expectedPlanFingerprint) {
    const before = await captureState();
    const analysis = analyzePlan(before, plan);
    if (!analysis.applyReady || analysis.planFingerprint !== expectedPlanFingerprint) {
      return {
        schemaVersion: 2,
        status: 'blocked',
        readOnly: true,
        reason: analysis.planFingerprint !== expectedPlanFingerprint ? 'PLAN_FINGERPRINT_MISMATCH' : 'PLAN_NOT_APPLY_READY',
        analysis,
      };
    }

    const created = [];
    try {
      for (const item of plan.items) {
        const primitive = item.kind === 'netFlag'
          ? await eda.sch_PrimitiveComponent.createNetFlag(item.identification, item.net, item.x, item.y, item.rotation, item.mirror)
          : await eda.sch_PrimitiveComponent.createNetPort(item.direction, item.net, item.x, item.y, item.rotation, item.mirror);
        if (!primitive) fail('CREATE_FLAG_FAILED', `EasyEDA rejected ${item.kind} at index ${item.index}.`);
        const primitiveId = callGetter(primitive, 'getState_PrimitiveId');
        if (!primitiveId) fail('CREATE_FLAG_WITHOUT_ID', `${item.kind} at index ${item.index} has no primitive ID.`);
        created.push({ ...item, primitiveId, componentType: callGetter(primitive, 'getState_ComponentType') });
      }
      const after = await captureState();
      const afterById = new Map(after.components.map((component) => [component.primitiveId, component]));
      const missingOrChanged = created.filter((item) => !flagMatches(afterById.get(item.primitiveId), item));
      const beforeIds = new Set(before.components.map((component) => component.primitiveId));
      const collateralMissing = [...beforeIds].filter((id) => !afterById.has(id));
      if (missingOrChanged.length || collateralMissing.length) {
        fail('POST_APPLY_INVARIANT_FAILED', JSON.stringify({ missingOrChanged: missingOrChanged.length, collateralMissing: collateralMissing.length }));
      }
      return {
        schemaVersion: 2,
        status: 'applied',
        readOnly: false,
        saved: false,
        beforeInspectionFingerprint: before.inspectionFingerprint,
        afterInspectionFingerprint: after.inspectionFingerprint,
        planFingerprint: analysis.planFingerprint,
        created,
        rollbackRequest: {
          mode: 'rollback',
          request: {
            expectedDocumentUuid: plan.expectedDocumentUuid,
            expectedCurrentFingerprint: after.inspectionFingerprint,
            expectedRestoredFingerprint: before.inspectionFingerprint,
            created,
          },
        },
      };
    } catch (error) {
      const rollback = await rollbackCreated(created);
      const restored = await captureState();
      return {
        schemaVersion: 2,
        status: rollback.remaining === 0 && restored.inspectionFingerprint === before.inspectionFingerprint ? 'rolled-back' : 'rollback-incomplete',
        error: { code: error.code ?? 'APPLY_FAILED', message: error.message },
        createdBeforeFailure: created,
        rollback,
        restoredInspectionFingerprint: restored.inspectionFingerprint,
        expectedRestoredFingerprint: before.inspectionFingerprint,
        saved: false,
      };
    }
  }

  function operationRequest(root) {
    return root.request || root.applyRequest || root;
  }

  const mode = request.mode ?? 'inspect';
  if (mode === 'inspect') {
    const state = await captureState();
    return {
      schemaVersion: 2,
      status: 'inspected',
      readOnly: true,
      state: { document: state.document, inspectionFingerprint: state.inspectionFingerprint, componentCount: state.components.length },
    };
  }
  if (mode === 'plan') {
    const plan = normalizePlan(request.plan ?? request.items, request.expectedDocumentUuid);
    const state = await captureState();
    const analysis = analyzePlan(state, plan);
    return {
      schemaVersion: 2,
      status: analysis.applyReady ? 'planned' : 'planned-with-blockers',
      readOnly: true,
      state: { document: state.document, inspectionFingerprint: state.inspectionFingerprint, componentCount: state.components.length },
      plan,
      analysis,
      applyRequest: analysis.applyReady ? { mode: 'apply', request: { plan, expectedPlanFingerprint: analysis.planFingerprint } } : null,
    };
  }
  if (mode === 'apply') {
    const applySource = operationRequest(request);
    const fingerprint = applySource.expectedPlanFingerprint;
    const planSource = applySource.plan || request.plan || request.items;
    const docUuid = applySource.expectedDocumentUuid || request.expectedDocumentUuid;
    if (typeof fingerprint !== 'string' || !fingerprint) {
      fail('INVALID_APPLY_REQUEST', 'apply requires expectedPlanFingerprint from plan mode.');
    }
    return applyPlan(normalizePlan(planSource, docUuid), fingerprint);
  }
  if (mode === 'verify') {
    const input = operationRequest(request);
    if (!input.expectedDocumentUuid || !Array.isArray(input.created)) {
      fail('INVALID_VERIFY_REQUEST', 'verify requires expectedDocumentUuid and created readback records.');
    }
    const state = await captureState();
    if (state.document?.uuid !== input.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'Verify request belongs to another schematic.');
    const byId = new Map(state.components.map((component) => [component.primitiveId, component]));
    const issues = input.created
      .filter((expected) => !flagMatches(byId.get(expected.primitiveId), expected))
      .map((expected) => ({ code: 'FLAG_MISSING_OR_CHANGED', primitiveId: expected.primitiveId, index: expected.index ?? null }));
    return { schemaVersion: 2, status: issues.length ? 'mismatch' : 'verified', readOnly: true, inspectionFingerprint: state.inspectionFingerprint, issues };
  }
  if (mode === 'rollback') {
    const input = operationRequest(request);
    if (!input.expectedDocumentUuid || !input.expectedCurrentFingerprint || !input.expectedRestoredFingerprint || !Array.isArray(input.created)) {
      fail('INVALID_ROLLBACK_REQUEST', 'rollback requires document identity, current/restored fingerprints, and created records.');
    }
    const current = await captureState();
    if (current.document?.uuid !== input.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'Rollback request belongs to another schematic.');
    if (current.inspectionFingerprint !== input.expectedCurrentFingerprint) fail('STALE_ROLLBACK', 'Current schematic differs from the expected applied state.');
    const byId = new Map(current.components.map((component) => [component.primitiveId, component]));
    if (input.created.some((expected) => !flagMatches(byId.get(expected.primitiveId), expected))) {
      fail('STALE_ROLLBACK', 'One or more created flags changed after apply.');
    }
    const rollback = await rollbackCreated(input.created);
    const restored = await captureState();
    return {
      schemaVersion: 2,
      status: rollback.remaining === 0 && restored.inspectionFingerprint === input.expectedRestoredFingerprint ? 'rolled-back' : 'rollback-incomplete',
      rollback,
      restoredInspectionFingerprint: restored.inspectionFingerprint,
      expectedRestoredFingerprint: input.expectedRestoredFingerprint,
      saved: false,
    };
  }
  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
