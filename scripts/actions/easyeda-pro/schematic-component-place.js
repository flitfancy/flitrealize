return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;
  const MAX_COMPONENTS_PER_APPLY = 50;

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

  async function optionalCall(namespace, method) {
    if (typeof eda?.[namespace]?.[method] !== 'function') return { value: null, error: null };
    try {
      return { value: await eda[namespace][method](), error: null };
    } catch (error) {
      return { value: null, error: error.message };
    }
  }

  function summarizeComponent(comp) {
    return {
      primitiveId: callGetter(comp, 'getState_PrimitiveId'),
      designator: callGetter(comp, 'getState_Designator'),
      x: finiteOrNull(callGetter(comp, 'getState_X')),
      y: finiteOrNull(callGetter(comp, 'getState_Y')),
      rotation: finiteOrNull(callGetter(comp, 'getState_Rotation')),
      mirror: callGetter(comp, 'getState_Mirror', false),
      addIntoBom: callGetter(comp, 'getState_AddIntoBom'),
      addIntoPcb: callGetter(comp, 'getState_AddIntoPcb'),
      componentType: callGetter(comp, 'getState_ComponentType'),
      libraryUuid: callGetter(comp, 'getState_LibraryUuid'),
      uuid: callGetter(comp, 'getState_Uuid'),
    };
  }

  function componentMatches(actual, expected) {
    return actual
      && actual.primitiveId === expected.primitiveId
      && actual.libraryUuid === expected.libraryUuid
      && actual.uuid === expected.uuid
      && actual.x === expected.x
      && actual.y === expected.y;
  }

  async function captureState() {
    const documentProbe = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    const document = documentProbe.value
      ? { uuid: documentProbe.value.uuid ?? null, parentProjectUuid: documentProbe.value.parentProjectUuid ?? null }
      : null;

    const componentsProbe = await optionalCall('sch_PrimitiveComponent', 'getAll');
    const components = Array.isArray(componentsProbe.value)
      ? componentsProbe.value.map(summarizeComponent)
      : [];

    const inspectionFingerprint = hashText(stableStringify({
      documentUuid: document?.uuid,
      componentCount: components.length,
      componentIds: components.map((c) => c.primitiveId).sort(),
    }));

    return { document, components, inspectionFingerprint };
  }

  function normalizePlan(plan) {
    if (!plan || !Array.isArray(plan.items)) fail('INVALID_PLAN', 'plan.items must be an array');
    const items = plan.items.map((item, index) => {
      if (!item.libraryUuid || typeof item.libraryUuid !== 'string') {
        fail('INVALID_PLAN_ITEM', `Item ${index}: libraryUuid is required`);
      }
      if (!item.uuid || typeof item.uuid !== 'string') {
        fail('INVALID_PLAN_ITEM', `Item ${index}: uuid is required`);
      }
      if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) {
        fail('INVALID_PLAN_ITEM', `Item ${index}: x and y must be finite numbers`);
      }
      return {
        index,
        libraryUuid: item.libraryUuid,
        uuid: item.uuid,
        x: item.x,
        y: item.y,
        rotation: item.rotation ?? 0,
        mirror: item.mirror ?? false,
        addIntoBom: item.addIntoBom ?? true,
        addIntoPcb: item.addIntoPcb ?? true,
        subPartName: item.subPartName ?? undefined,
      };
    });
    return {
      items,
      expectedDocumentUuid: plan.expectedDocumentUuid ?? null,
    };
  }

  async function analyzePlan(state, plan) {
    const globalIssues = [];
    if (plan.expectedDocumentUuid && state.document?.uuid !== plan.expectedDocumentUuid) {
      globalIssues.push({ code: 'DOCUMENT_MISMATCH', expected: plan.expectedDocumentUuid, actual: state.document?.uuid });
    }
    if (plan.items.length > MAX_COMPONENTS_PER_APPLY) {
      globalIssues.push({ code: 'TOO_MANY_COMPONENTS', count: plan.items.length, max: MAX_COMPONENTS_PER_APPLY });
    }

    const planFingerprint = hashText(stableStringify({
      inspectionFingerprint: state.inspectionFingerprint,
      plan,
      globalIssueCodes: globalIssues.map((i) => i.code),
    }));

    return {
      applyReady: globalIssues.length === 0 && plan.items.length > 0,
      planFingerprint,
      globalIssues,
      itemCount: plan.items.length,
    };
  }

  async function rollbackCreated(created) {
    const ids = created.map((item) => item.primitiveId).filter(Boolean);
    if (ids.length === 0) return { deleted: true, remaining: 0 };
    let deleted = false;
    try {
      deleted = await eda.sch_PrimitiveComponent.delete(ids);
    } catch {
      deleted = false;
    }
    const allProbe = await optionalCall('sch_PrimitiveComponent', 'getAll');
    const remaining = Array.isArray(allProbe.value)
      ? allProbe.value.map(summarizeComponent).filter((c) => ids.includes(c.primitiveId))
      : [];
    return { deleted: Boolean(deleted), remaining: remaining.length };
  }

  async function applyPlan(plan, expectedPlanFingerprint) {
    const before = await captureState();
    const analysis = await analyzePlan(before, plan);
    if (!analysis.applyReady || analysis.planFingerprint !== expectedPlanFingerprint) {
      return {
        status: 'blocked',
        readOnly: true,
        reason: analysis.planFingerprint !== expectedPlanFingerprint ? 'PLAN_FINGERPRINT_MISMATCH' : 'PLAN_NOT_APPLY_READY',
        state: { inspectionFingerprint: before.inspectionFingerprint, componentCount: before.components.length },
        analysis,
      };
    }

    const created = [];
    try {
      for (const item of plan.items) {
        const componentRef = { libraryUuid: item.libraryUuid, uuid: item.uuid };
        const primitive = await eda.sch_PrimitiveComponent.create(
          componentRef,
          item.x,
          item.y,
          item.subPartName,
          item.rotation,
          item.mirror,
          item.addIntoBom,
          item.addIntoPcb,
        );
        if (!primitive) fail('CREATE_COMPONENT_FAILED', `EasyEDA rejected component at index ${item.index}.`);
        const primitiveId = callGetter(primitive, 'getState_PrimitiveId');
        if (!primitiveId) fail('CREATE_COMPONENT_WITHOUT_ID', `Component at index ${item.index} has no primitive ID.`);
        created.push({
          index: item.index,
          primitiveId,
          ...summarizeComponent(primitive),
        });
      }

      const after = await captureState();
      const afterById = new Map(after.components.map((c) => [c.primitiveId, c]));
      const missing = created.filter((c) => !afterById.has(c.primitiveId));
      const beforeIds = new Set(before.components.map((c) => c.primitiveId));
      const collateralMissing = [...beforeIds].filter((id) => !afterById.has(id));
      if (missing.length > 0 || collateralMissing.length > 0) {
        fail('POST_APPLY_INVARIANT_FAILED', JSON.stringify({ missing: missing.length, collateralMissing: collateralMissing.length }));
      }
      return {
        status: 'applied',
        readOnly: false,
        saved: false,
        beforeInspectionFingerprint: before.inspectionFingerprint,
        afterInspectionFingerprint: after.inspectionFingerprint,
        planFingerprint: analysis.planFingerprint,
        created,
        rollbackRequest: {
          mode: 'rollback',
          expectedDocumentUuid: plan.expectedDocumentUuid,
          expectedCurrentFingerprint: after.inspectionFingerprint,
          expectedRestoredFingerprint: before.inspectionFingerprint,
          created,
        },
      };
    } catch (error) {
      const rollback = await rollbackCreated(created);
      const restored = await captureState();
      return {
        status: rollback.remaining === 0 && restored.inspectionFingerprint === before.inspectionFingerprint
          ? 'rolled-back'
          : 'rollback-incomplete',
        error: { code: error.code ?? 'APPLY_FAILED', message: error.message },
        createdBeforeFailure: created,
        rollback,
        restoredInspectionFingerprint: restored.inspectionFingerprint,
        expectedRestoredFingerprint: before.inspectionFingerprint,
        saved: false,
      };
    }
  }

  const mode = request.mode ?? 'inspect';
  if (mode === 'inspect') {
    const state = await captureState();
    return {
      schemaVersion: 1,
      status: 'inspected',
      readOnly: true,
      state: {
        document: state.document,
        inspectionFingerprint: state.inspectionFingerprint,
        componentCount: state.components.length,
        components: state.components,
      },
    };
  }
  if (mode === 'plan') {
    const plan = normalizePlan(request.plan);
    const state = await captureState();
    const analysis = await analyzePlan(state, plan);
    return {
      schemaVersion: 1,
      status: analysis.applyReady ? 'planned' : 'planned-with-blockers',
      readOnly: true,
      state: {
        document: state.document,
        inspectionFingerprint: state.inspectionFingerprint,
        componentCount: state.components.length,
      },
      plan,
      analysis,
      applyRequest: analysis.applyReady
        ? { mode: 'apply', plan, expectedPlanFingerprint: analysis.planFingerprint }
        : null,
    };
  }
  if (mode === 'apply') {
    if (typeof request.expectedPlanFingerprint !== 'string' || !request.expectedPlanFingerprint) {
      fail('INVALID_APPLY_REQUEST', 'apply requires expectedPlanFingerprint from a dry-run.');
    }
    return applyPlan(normalizePlan(request.plan), request.expectedPlanFingerprint);
  }
  if (mode === 'verify') {
    if (!Array.isArray(request.created) || !request.expectedDocumentUuid) {
      fail('INVALID_VERIFY_REQUEST', 'verify requires expectedDocumentUuid and created readback records.');
    }
    const state = await captureState();
    if (state.document?.uuid !== request.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'Verify request belongs to another schematic.');
    const byId = new Map(state.components.map((c) => [c.primitiveId, c]));
    const issues = request.created
      .filter((expected) => !componentMatches(byId.get(expected.primitiveId), expected))
      .map((expected) => ({ code: 'COMPONENT_MISSING_OR_CHANGED', primitiveId: expected.primitiveId, index: expected.index ?? null }));
    return {
      schemaVersion: 1,
      status: issues.length === 0 ? 'verified' : 'mismatch',
      readOnly: true,
      inspectionFingerprint: state.inspectionFingerprint,
      issues,
    };
  }
  if (mode === 'rollback') {
    if (!request.expectedDocumentUuid || !request.expectedCurrentFingerprint || !request.expectedRestoredFingerprint || !Array.isArray(request.created)) {
      fail('INVALID_ROLLBACK_REQUEST', 'rollback requires document identity, current/restored fingerprints, and created records.');
    }
    const current = await captureState();
    if (current.document?.uuid !== request.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'Rollback request belongs to another schematic.');
    if (current.inspectionFingerprint !== request.expectedCurrentFingerprint) fail('STALE_ROLLBACK', 'Current schematic differs from the expected applied state.');
    const byId = new Map(current.components.map((c) => [c.primitiveId, c]));
    const changed = request.created.filter((expected) => !componentMatches(byId.get(expected.primitiveId), expected));
    if (changed.length > 0) fail('STALE_ROLLBACK', 'One or more created components changed after apply.');
    const rollback = await rollbackCreated(request.created);
    const restored = await captureState();
    return {
      schemaVersion: 1,
      status: rollback.remaining === 0 && restored.inspectionFingerprint === request.expectedRestoredFingerprint
        ? 'rolled-back'
        : 'rollback-incomplete',
      rollback,
      restoredInspectionFingerprint: restored.inspectionFingerprint,
      expectedRestoredFingerprint: request.expectedRestoredFingerprint,
      saved: false,
    };
  }
  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
