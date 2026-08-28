return await (async () => {
  const request = typeof flitrealizeInput === 'undefined'
    ? { mode: 'inspect' }
    : flitrealizeInput;
  const allowedCounts = new Set([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32]);
  const allowedRoles = new Set(['signal', 'reference-plane', 'power-plane', 'mixed']);
  const allowedInnerTypes = new Set(['SIGNAL', 'PLANE']);

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function clone(value) {
    if (value === undefined) return null;
    return JSON.parse(JSON.stringify(value));
  }

  function orderedCopperIds(count) {
    return [1, ...Array.from({ length: count - 2 }, (_, index) => 15 + index), 2];
  }

  function isInnerLayer(id) {
    return Number.isInteger(id) && id >= 15 && id <= 44;
  }

  function publicLayer(layer) {
    return {
      id: Number(layer.id),
      name: layer.name ?? null,
      type: layer.type ?? null,
      color: layer.color ?? null,
      transparency: layer.transparency ?? null,
      layerStatus: layer.layerStatus ?? null,
      locked: layer.locked ?? null,
    };
  }

  function layerFingerprint(state) {
    return JSON.stringify({
      documentUuid: state.document.uuid,
      copperLayerCount: state.copperLayerCount,
      layers: state.layers.map(({ id, name, type }) => ({ id, name, type })),
    });
  }

  async function captureState() {
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if (!document || document.documentType !== 3) {
      fail('PCB_DOCUMENT_REQUIRED', 'The active EasyEDA document is not a PCB.');
    }
    const project = await eda.dmt_Project.getCurrentProjectInfo();
    const allLayers = await eda.pcb_Layer.getAllLayers();
    const copperById = new Map(
      allLayers
        .map(publicLayer)
        .filter((layer) => layer.layerStatus !== 0)
        .filter((layer) => layer.id === 1 || layer.id === 2 || isInnerLayer(layer.id))
        .map((layer) => [layer.id, layer]),
    );
    const activeInnerIds = [...copperById.keys()]
      .filter(isInnerLayer)
      .sort((left, right) => left - right);
    const copperLayerCount = activeInnerIds.length + 2;
    const layers = orderedCopperIds(copperLayerCount).map((id) => copperById.get(id));
    if (layers.some((layer) => !layer)) {
      fail('NONCONTIGUOUS_COPPER_LAYERS', 'The active copper-layer IDs are not contiguous.');
    }

    let physicalStackingConfiguration = null;
    let physicalStackReadError = null;
    if (typeof eda.pcb_Layer.getCurrentPhysicalStackingConfiguration === 'function') {
      try {
        physicalStackingConfiguration = clone(
          await eda.pcb_Layer.getCurrentPhysicalStackingConfiguration(),
        );
      } catch (error) {
        physicalStackReadError = error.message;
      }
    }

    const state = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      project: project
        ? { uuid: project.uuid, name: project.name, friendlyName: project.friendlyName }
        : null,
      document: {
        uuid: document.uuid,
        tabId: document.tabId,
        documentType: document.documentType,
        parentProjectUuid: document.parentProjectUuid ?? null,
      },
      copperLayerCount,
      layers,
      physicalStackingConfiguration,
      physicalStackReadError,
    };
    state.fingerprint = layerFingerprint(state);
    return state;
  }

  function normalizePlan(rawPlan) {
    if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
      fail('INVALID_LAYER_PLAN', 'plan must be an object.');
    }
    if (rawPlan.schemaVersion !== 1) {
      fail('INVALID_LAYER_PLAN', 'plan.schemaVersion must be 1.');
    }
    if (typeof rawPlan.expectedDocumentUuid !== 'string' || !rawPlan.expectedDocumentUuid) {
      fail('INVALID_LAYER_PLAN', 'plan.expectedDocumentUuid is required for document identity.');
    }
    const count = Number(rawPlan.copperLayerCount);
    if (!allowedCounts.has(count)) {
      fail('INVALID_LAYER_PLAN', 'copperLayerCount must be an even value from 2 through 32.');
    }
    if (!Array.isArray(rawPlan.layers)) {
      fail('INVALID_LAYER_PLAN', 'plan.layers must be an ordered array.');
    }
    const expectedIds = orderedCopperIds(count);
    if (rawPlan.layers.length !== expectedIds.length) {
      fail('INVALID_LAYER_PLAN', 'plan.layers must describe every active copper layer.');
    }

    const layers = rawPlan.layers.map((rawLayer, index) => {
      const id = Number(rawLayer?.id);
      if (id !== expectedIds[index]) {
        fail('INVALID_LAYER_PLAN', `plan.layers[${index}].id must be ${expectedIds[index]}.`);
      }
      const role = rawLayer.role;
      if (!allowedRoles.has(role)) {
        fail('INVALID_LAYER_PLAN', `Unsupported role for layer ${id}: ${role}`);
      }
      const layer = { id, role };
      if (isInnerLayer(id)) {
        const type = rawLayer.type ?? 'SIGNAL';
        if (!allowedInnerTypes.has(type)) {
          fail('INVALID_LAYER_PLAN', `Inner layer ${id} type must be SIGNAL or PLANE.`);
        }
        layer.type = type;
        if (rawLayer.name !== undefined) {
          if (typeof rawLayer.name !== 'string' || !rawLayer.name.trim()) {
            fail('INVALID_LAYER_PLAN', `Inner layer ${id} name must be a non-empty string.`);
          }
          layer.name = rawLayer.name.trim();
        }
      }
      if (role === 'reference-plane' || role === 'power-plane') {
        if (typeof rawLayer.net !== 'string' || !rawLayer.net.trim()) {
          fail('INVALID_LAYER_PLAN', `Plane role on layer ${id} requires an intended net.`);
        }
        layer.net = rawLayer.net.trim();
      }
      return layer;
    });

    return {
      schemaVersion: 1,
      expectedDocumentUuid: rawPlan.expectedDocumentUuid,
      copperLayerCount: count,
      layers,
      physicalStackSource: typeof rawPlan.physicalStackSource === 'string'
        ? rawPlan.physicalStackSource
        : null,
      impedanceTargets: Array.isArray(rawPlan.impedanceTargets)
        ? clone(rawPlan.impedanceTargets)
        : [],
    };
  }

  function comparePlan(state, plan) {
    const issues = [];
    if (state.document.uuid !== plan.expectedDocumentUuid) {
      issues.push({ code: 'DOCUMENT_MISMATCH', expected: plan.expectedDocumentUuid, actual: state.document.uuid });
    }
    if (state.copperLayerCount !== plan.copperLayerCount) {
      issues.push({ code: 'COPPER_LAYER_COUNT', expected: plan.copperLayerCount, actual: state.copperLayerCount });
    }
    const actualById = new Map(state.layers.map((layer) => [layer.id, layer]));
    for (const expected of plan.layers) {
      const actual = actualById.get(expected.id);
      if (!actual) {
        issues.push({ code: 'MISSING_LAYER', layerId: expected.id });
        continue;
      }
      if (isInnerLayer(expected.id) && expected.name && actual.name !== expected.name) {
        issues.push({ code: 'LAYER_NAME', layerId: expected.id, expected: expected.name, actual: actual.name });
      }
      if (isInnerLayer(expected.id) && actual.type !== expected.type) {
        issues.push({ code: 'LAYER_TYPE', layerId: expected.id, expected: expected.type, actual: actual.type });
      }
    }
    return issues;
  }

  function planeFollowUp(plan) {
    return plan.layers
      .filter((layer) => layer.role === 'reference-plane' || layer.role === 'power-plane')
      .map((layer) => ({
        layerId: layer.id,
        role: layer.role,
        intendedNet: layer.net,
        requiredEvidence: layer.type === 'PLANE'
          ? 'Verify internal-plane regions and assigned net.'
          : 'Create/rebuild the positive-layer pour and read back realized copper.',
      }));
  }

  async function restoreSnapshot(snapshot) {
    const current = await captureState();
    const originalById = new Map(snapshot.layers.map((layer) => [layer.id, layer]));
    const restoreIssues = [];

    for (const layer of current.layers.filter((item) => isInnerLayer(item.id))) {
      const original = originalById.get(layer.id);
      if (!original) continue;
      const property = {};
      if (original.name !== layer.name) property.name = original.name;
      if (original.type !== layer.type) property.type = original.type;
      if (Object.keys(property).length > 0) {
        const restored = await eda.pcb_Layer.modifyLayer(layer.id, property);
        if (!restored) restoreIssues.push({ code: 'RESTORE_LAYER_FAILED', layerId: layer.id });
      }
    }

    if (current.copperLayerCount > snapshot.copperLayerCount) {
      const reduced = await eda.pcb_Layer.setTheNumberOfCopperLayers(snapshot.copperLayerCount);
      if (!reduced) restoreIssues.push({ code: 'RESTORE_LAYER_COUNT_FAILED' });
    } else if (current.copperLayerCount < snapshot.copperLayerCount) {
      restoreIssues.push({ code: 'RESTORE_WOULD_ADD_LAYERS' });
    }

    const restoredState = await captureState();
    if (restoredState.fingerprint !== snapshot.fingerprint) {
      restoreIssues.push({ code: 'RESTORE_FINGERPRINT_MISMATCH' });
    }
    return { restoredState, restoreIssues };
  }

  async function applyPlan(plan) {
    const before = await captureState();
    if (before.document.uuid !== plan.expectedDocumentUuid) {
      fail('DOCUMENT_MISMATCH', `Expected PCB ${plan.expectedDocumentUuid}, got ${before.document.uuid}.`);
    }
    if (plan.copperLayerCount < before.copperLayerCount) {
      fail(
        'LAYER_DECREASE_REQUIRES_SEPARATE_REVIEW',
        'This action does not reduce copper-layer count; populated inner layers require destructive review.',
      );
    }

    try {
      if (plan.copperLayerCount > before.copperLayerCount) {
        const increased = await eda.pcb_Layer.setTheNumberOfCopperLayers(plan.copperLayerCount);
        if (!increased) fail('SET_LAYER_COUNT_FAILED', 'EasyEDA rejected the requested copper-layer count.');
      }

      let current = await captureState();
      const actualById = new Map(current.layers.map((layer) => [layer.id, layer]));
      for (const expected of plan.layers.filter((layer) => isInnerLayer(layer.id))) {
        const actual = actualById.get(expected.id);
        if (!actual) fail('MISSING_LAYER', `Inner layer ${expected.id} was not created.`);
        const property = {};
        if (expected.name && actual.name !== expected.name) property.name = expected.name;
        if (actual.type !== expected.type) property.type = expected.type;
        if (Object.keys(property).length > 0) {
          const modified = await eda.pcb_Layer.modifyLayer(expected.id, property);
          if (!modified) fail('MODIFY_LAYER_FAILED', `EasyEDA rejected properties for layer ${expected.id}.`);
        }
      }

      current = await captureState();
      const issues = comparePlan(current, plan);
      if (issues.length > 0) {
        fail('LAYER_READBACK_MISMATCH', JSON.stringify(issues));
      }
      return {
        status: 'applied',
        before,
        after: current,
        planeFollowUp: planeFollowUp(plan),
        saved: false,
      };
    } catch (error) {
      const rollback = await restoreSnapshot(before);
      return {
        status: rollback.restoreIssues.length === 0 ? 'rolled-back' : 'rollback-incomplete',
        error: { code: error.code ?? 'APPLY_FAILED', message: error.message },
        before,
        ...rollback,
        saved: false,
      };
    }
  }

  const mode = request?.mode ?? 'inspect';
  if (mode === 'inspect') {
    return { status: 'inspected', readOnly: true, state: await captureState() };
  }
  if (mode === 'plan') {
    const plan = normalizePlan(request.plan);
    return { status: 'planned', readOnly: true, plan, planeFollowUp: planeFollowUp(plan) };
  }
  if (mode === 'verify') {
    const plan = normalizePlan(request.plan);
    const state = await captureState();
    const issues = comparePlan(state, plan);
    return {
      status: issues.length === 0 ? 'verified' : 'mismatch',
      readOnly: true,
      issues,
      state,
      planeFollowUp: planeFollowUp(plan),
    };
  }
  if (mode === 'apply') {
    return applyPlan(normalizePlan(request.plan));
  }
  if (mode === 'rollback') {
    if (!request.snapshot || typeof request.expectedCurrentFingerprint !== 'string') {
      fail('INVALID_ROLLBACK', 'rollback requires snapshot and expectedCurrentFingerprint.');
    }
    const current = await captureState();
    if (current.document.uuid !== request.snapshot.document?.uuid) {
      fail('DOCUMENT_MISMATCH', 'Rollback snapshot belongs to a different PCB document.');
    }
    if (current.fingerprint !== request.expectedCurrentFingerprint) {
      fail('STALE_ROLLBACK', 'Current layer structure differs from the expected applied state.');
    }
    const rollback = await restoreSnapshot(request.snapshot);
    return {
      status: rollback.restoreIssues.length === 0 ? 'rolled-back' : 'rollback-incomplete',
      ...rollback,
      saved: false,
    };
  }
  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
