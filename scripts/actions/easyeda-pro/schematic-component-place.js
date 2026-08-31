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

  function summarizeComponent(comp) {
    const componentState = callGetter(comp, 'getState_Component', {}) || {};
    const directLibraryUuid = callGetter(comp, 'getState_LibraryUuid');
    const directUuid = callGetter(comp, 'getState_Uuid');
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
      libraryUuid: directLibraryUuid || componentState.libraryUuid || componentState.library_uuid || null,
      uuid: directUuid || componentState.uuid || componentState.deviceUuid || null,
      providerLibraryUuid: directLibraryUuid || null,
      providerDeviceUuid: directUuid || null,
    };
  }

  function sameNumber(actual, expected) {
    return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= 1e-6;
  }

  function providerIdentityStatus(actual, expected) {
    if (!actual?.providerLibraryUuid || !actual?.providerDeviceUuid) return 'unknown';
    return actual.providerLibraryUuid === expected.libraryUuid && actual.providerDeviceUuid === expected.uuid ? 'verified' : 'mismatch';
  }

  function componentMatches(actual, expected) {
    return actual
      && actual.primitiveId === expected.primitiveId
      && actual.designator === expected.designator
      && sameNumber(actual.x, expected.x)
      && sameNumber(actual.y, expected.y)
      && sameNumber(actual.rotation, expected.rotation)
      && actual.mirror === expected.mirror
      && actual.addIntoBom === expected.addIntoBom
      && actual.addIntoPcb === expected.addIntoPcb
      && providerIdentityStatus(actual, expected) !== 'mismatch';
  }

  function verificationCoverage(actualById, expected) {
    const identity = expected.map((component) => providerIdentityStatus(actualById.get(component.primitiveId), component));
    return {
      primitiveIdentity: 'verified',
      designator: 'verified',
      geometry: 'verified',
      providerDeviceIdentity: identity.every((status) => status === 'verified') ? 'verified' : 'unknown',
      providerDeviceIdentityVerifiedCount: identity.filter((status) => status === 'verified').length,
      providerDeviceIdentityUnknownCount: identity.filter((status) => status === 'unknown').length,
    };
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
      components: components.map((component) => ({
        primitiveId: component.primitiveId,
        designator: component.designator,
        libraryUuid: component.libraryUuid,
        uuid: component.uuid,
        x: component.x,
        y: component.y,
        rotation: component.rotation,
        mirror: component.mirror,
        addIntoBom: component.addIntoBom,
        addIntoPcb: component.addIntoPcb,
      })).sort((left, right) => String(left.primitiveId).localeCompare(String(right.primitiveId))),
    }));

    return { document, components, inspectionFingerprint };
  }

  function normalizePlan(plan, expectedDocumentUuid = null) {
    if (!plan || typeof plan !== 'object') fail('INVALID_PLAN', 'plan must be an object');
    const placementPlan = plan.kind === 'flitrealize.schematic-placement-plan' && plan.schemaVersion === 1;
    if (placementPlan && plan.targetProvider !== 'easyeda-pro') {
      fail('PLAN_PROVIDER_MISMATCH', 'SchematicPlacementPlan targetProvider must be easyeda-pro.');
    }
    const sourceItems = placementPlan ? plan.components : plan.items;
    if (!Array.isArray(sourceItems)) fail('INVALID_PLAN', 'PlacementPlan components or legacy plan.items must be an array');
    const items = sourceItems.map((item, index) => {
      const binding = placementPlan ? item.bindings?.easyedaPro : item;
      const libraryUuid = binding?.libraryUuid;
      const uuid = binding?.deviceUuid ?? binding?.uuid;
      const x = placementPlan ? item.position?.x : item.x;
      const y = placementPlan ? item.position?.y : item.y;
      if (!libraryUuid || typeof libraryUuid !== 'string') {
        fail('INVALID_PLAN_ITEM', `Item ${index}: libraryUuid is required`);
      }
      if (!uuid || typeof uuid !== 'string') {
        fail('INVALID_PLAN_ITEM', `Item ${index}: uuid/deviceUuid is required`);
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        fail('INVALID_PLAN_ITEM', `Item ${index}: x and y must be finite numbers`);
      }
      if (typeof item.designator !== 'string' || !item.designator.trim()) {
        fail('INVALID_PLAN_ITEM', `Item ${index}: designator is required`);
      }
      return {
        index,
        designator: item.designator.trim(),
        libraryUuid,
        uuid,
        x,
        y,
        rotation: item.rotation ?? 0,
        mirror: item.mirror ?? false,
        addIntoBom: placementPlan ? item.includeInBom !== false : item.addIntoBom ?? true,
        addIntoPcb: placementPlan ? item.includeInPcb !== false : item.addIntoPcb ?? true,
        subPartName: item.subPartName ?? undefined,
      };
    });
    return {
      items,
      expectedDocumentUuid: expectedDocumentUuid ?? plan.expectedDocumentUuid ?? null,
      sourcePlacementPlanFingerprint: placementPlan
        ? plan.fingerprints?.plan ?? null
        : plan.sourcePlacementPlanFingerprint ?? null,
      sourceBlockingDiagnostics: placementPlan
        ? (plan.diagnostics || []).filter((diagnostic) => diagnostic?.severity === 'error').map((diagnostic) => ({
            code: diagnostic.code ?? 'SOURCE_PLAN_ERROR',
            designator: diagnostic.designator ?? null,
          }))
        : [],
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
    if (!plan.expectedDocumentUuid) {
      globalIssues.push({ code: 'DOCUMENT_IDENTITY_REQUIRED' });
    }
    if (plan.sourceBlockingDiagnostics.length) {
      globalIssues.push({
        code: 'SOURCE_PLACEMENT_PLAN_BLOCKED',
        count: plan.sourceBlockingDiagnostics.length,
        diagnostics: plan.sourceBlockingDiagnostics,
      });
    }
    const plannedDesignators = new Set();
    for (const item of plan.items) {
      if (plannedDesignators.has(item.designator)) globalIssues.push({ code: 'DUPLICATE_PLAN_DESIGNATOR', designator: item.designator });
      plannedDesignators.add(item.designator);
    }
    const existingDesignators = new Set(state.components.map((component) => component.designator).filter(Boolean));
    for (const designator of plannedDesignators) {
      if (existingDesignators.has(designator)) globalIssues.push({ code: 'DESIGNATOR_ALREADY_EXISTS', designator });
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
        schemaVersion: 2,
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
        let actual = summarizeComponent(primitive);
        if (actual.designator !== item.designator) {
          const modified = await eda.sch_PrimitiveComponent.modify(primitiveId, { designator: item.designator });
          if (modified === false) fail('SET_DESIGNATOR_FAILED', `EasyEDA rejected designator ${item.designator}.`);
          const readback = await optionalCall('sch_PrimitiveComponent', 'get', primitiveId);
          if (readback.value) {
            actual = summarizeComponent(readback.value);
            if (actual.designator !== item.designator) fail('SET_DESIGNATOR_READBACK_FAILED', `Component ${primitiveId} did not retain designator ${item.designator}.`);
          }
        }
        created.push({
          index: item.index,
          primitiveId,
          designator: item.designator,
          libraryUuid: item.libraryUuid,
          uuid: item.uuid,
          x: item.x,
          y: item.y,
          rotation: item.rotation,
          mirror: item.mirror,
          addIntoBom: item.addIntoBom,
          addIntoPcb: item.addIntoPcb,
        });
      }

      const after = await captureState();
      const afterById = new Map(after.components.map((c) => [c.primitiveId, c]));
      const missing = created.filter((component) => !componentMatches(afterById.get(component.primitiveId), component));
      const beforeIds = new Set(before.components.map((c) => c.primitiveId));
      const collateralMissing = [...beforeIds].filter((id) => !afterById.has(id));
      if (missing.length > 0 || collateralMissing.length > 0) {
        fail('POST_APPLY_INVARIANT_FAILED', JSON.stringify({ missingOrChanged: missing.length, collateralMissing: collateralMissing.length }));
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
        verification: verificationCoverage(afterById, created),
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
      state: {
        document: state.document,
        inspectionFingerprint: state.inspectionFingerprint,
        componentCount: state.components.length,
        components: state.components,
      },
    };
  }
  if (mode === 'plan') {
    const plan = normalizePlan(request.plan, request.expectedDocumentUuid);
    const state = await captureState();
    const analysis = await analyzePlan(state, plan);
    return {
      schemaVersion: 2,
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
        ? { mode: 'apply', request: { plan, expectedPlanFingerprint: analysis.planFingerprint } }
        : null,
    };
  }
  if (mode === 'apply') {
    const applySource = operationRequest(request);
    const fingerprint = applySource.expectedPlanFingerprint;
    const planSource = applySource.plan || request.plan;
    const docUuid = applySource.expectedDocumentUuid || request.expectedDocumentUuid;
    if (typeof fingerprint !== 'string' || !fingerprint) {
      fail('INVALID_APPLY_REQUEST', 'apply requires expectedPlanFingerprint from a dry-run.');
    }
    return applyPlan(normalizePlan(planSource, docUuid), fingerprint);
  }
  if (mode === 'verify') {
    const input = operationRequest(request);
    if (!Array.isArray(input.created) || !input.expectedDocumentUuid) {
      fail('INVALID_VERIFY_REQUEST', 'verify requires expectedDocumentUuid and created readback records.');
    }
    const state = await captureState();
    if (state.document?.uuid !== input.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'Verify request belongs to another schematic.');
    const byId = new Map(state.components.map((c) => [c.primitiveId, c]));
    const issues = input.created
      .filter((expected) => !componentMatches(byId.get(expected.primitiveId), expected))
      .map((expected) => ({ code: 'COMPONENT_MISSING_OR_CHANGED', primitiveId: expected.primitiveId, index: expected.index ?? null }));
    return {
      schemaVersion: 2,
      status: issues.length === 0 ? 'verified' : 'mismatch',
      readOnly: true,
      inspectionFingerprint: state.inspectionFingerprint,
      verification: issues.length ? null : verificationCoverage(byId, input.created),
      issues,
    };
  }
  if (mode === 'rollback') {
    const input = operationRequest(request);
    if (!input.expectedDocumentUuid || !input.expectedCurrentFingerprint || !input.expectedRestoredFingerprint || !Array.isArray(input.created)) {
      fail('INVALID_ROLLBACK_REQUEST', 'rollback requires document identity, current/restored fingerprints, and created records.');
    }
    const current = await captureState();
    if (current.document?.uuid !== input.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'Rollback request belongs to another schematic.');
    if (current.inspectionFingerprint !== input.expectedCurrentFingerprint) fail('STALE_ROLLBACK', 'Current schematic differs from the expected applied state.');
    const byId = new Map(current.components.map((c) => [c.primitiveId, c]));
    const changed = input.created.filter((expected) => !componentMatches(byId.get(expected.primitiveId), expected));
    if (changed.length > 0) fail('STALE_ROLLBACK', 'One or more created components changed after apply.');
    const rollback = await rollbackCreated(input.created);
    const restored = await captureState();
    return {
      schemaVersion: 2,
      status: rollback.remaining === 0 && restored.inspectionFingerprint === input.expectedRestoredFingerprint
        ? 'rolled-back'
        : 'rollback-incomplete',
      rollback,
      restoredInspectionFingerprint: restored.inspectionFingerprint,
      expectedRestoredFingerprint: input.expectedRestoredFingerprint,
      saved: false,
    };
  }
  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
