return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;
  const MAX_WIRES_PER_APPLY = 200;

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

  function summarizeWire(wire) {
    return {
      primitiveId: callGetter(wire, 'getState_PrimitiveId'),
      net: callGetter(wire, 'getState_Net', ''),
      lineWidth: finiteOrNull(callGetter(wire, 'getState_LineWidth')),
      lineType: callGetter(wire, 'getState_LineType'),
    };
  }

  function wireMatches(actual, expected) {
    return actual
      && actual.primitiveId === expected.primitiveId
      && actual.net === expected.net;
  }

  async function captureState() {
    const documentProbe = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    const document = documentProbe.value
      ? { uuid: documentProbe.value.uuid ?? null, parentProjectUuid: documentProbe.value.parentProjectUuid ?? null }
      : null;

    const wiresProbe = await optionalCall('sch_PrimitiveWire', 'getAll');
    const wires = Array.isArray(wiresProbe.value)
      ? wiresProbe.value.map(summarizeWire)
      : [];

    const inspectionFingerprint = hashText(stableStringify({
      documentUuid: document?.uuid,
      wireCount: wires.length,
      wireIds: wires.map((w) => w.primitiveId).sort(),
    }));

    return { document, wires, inspectionFingerprint };
  }

  function normalizePlan(plan) {
    if (!plan || !Array.isArray(plan.wires)) fail('INVALID_PLAN', 'plan.wires must be an array');
    const wires = plan.wires.map((item, index) => {
      if (!item.net || typeof item.net !== 'string') {
        fail('INVALID_PLAN_ITEM', `Wire ${index}: net is required`);
      }
      if (!Array.isArray(item.points) || item.points.length < 2) {
        fail('INVALID_PLAN_ITEM', `Wire ${index}: points must be an array of at least 2 {x, y} pairs`);
      }
      for (const [pi, pt] of item.points.entries()) {
        if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
          fail('INVALID_PLAN_ITEM', `Wire ${index}, point ${pi}: x and y must be finite numbers`);
        }
      }
      return {
        index,
        net: item.net,
        points: item.points,
        color: item.color ?? undefined,
        lineWidth: item.lineWidth ?? undefined,
        lineType: item.lineType ?? undefined,
      };
    });
    return {
      wires,
      expectedDocumentUuid: plan.expectedDocumentUuid ?? null,
    };
  }

  async function analyzePlan(state, plan) {
    const globalIssues = [];
    if (plan.expectedDocumentUuid && state.document?.uuid !== plan.expectedDocumentUuid) {
      globalIssues.push({ code: 'DOCUMENT_MISMATCH', expected: plan.expectedDocumentUuid, actual: state.document?.uuid });
    }
    if (plan.wires.length > MAX_WIRES_PER_APPLY) {
      globalIssues.push({ code: 'TOO_MANY_WIRES', count: plan.wires.length, max: MAX_WIRES_PER_APPLY });
    }

    const planFingerprint = hashText(stableStringify({
      inspectionFingerprint: state.inspectionFingerprint,
      plan,
      globalIssueCodes: globalIssues.map((i) => i.code),
    }));

    return {
      applyReady: globalIssues.length === 0 && plan.wires.length > 0,
      planFingerprint,
      globalIssues,
      wireCount: plan.wires.length,
    };
  }

  async function rollbackCreated(created) {
    const ids = created.map((item) => item.primitiveId).filter(Boolean);
    if (ids.length === 0) return { deleted: true, remaining: 0 };
    let deleted = false;
    try {
      deleted = await eda.sch_PrimitiveWire.delete(ids);
    } catch {
      deleted = false;
    }
    const allProbe = await optionalCall('sch_PrimitiveWire', 'getAll');
    const remaining = Array.isArray(allProbe.value)
      ? allProbe.value.map(summarizeWire).filter((w) => ids.includes(w.primitiveId))
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
        analysis,
      };
    }

    const created = [];
    try {
      for (const item of plan.wires) {
        const line = item.points.map((pt) => [pt.x, pt.y]);
        const primitive = await eda.sch_PrimitiveWire.create(
          line,
          item.net,
          item.color,
          item.lineWidth,
          item.lineType,
        );
        if (!primitive) fail('CREATE_WIRE_FAILED', `EasyEDA rejected wire at index ${item.index}.`);
        const primitiveId = callGetter(primitive, 'getState_PrimitiveId');
        if (!primitiveId) fail('CREATE_WIRE_WITHOUT_ID', `Wire at index ${item.index} has no primitive ID.`);
        created.push({ index: item.index, primitiveId, ...summarizeWire(primitive) });
      }

      const after = await captureState();
      const afterById = new Map(after.wires.map((w) => [w.primitiveId, w]));
      const missing = created.filter((w) => !afterById.has(w.primitiveId));
      if (missing.length > 0) {
        fail('POST_APPLY_INVARIANT_FAILED', JSON.stringify({ missing: missing.length }));
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
        wireCount: state.wires.length,
        wires: state.wires,
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
        wireCount: state.wires.length,
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
    const byId = new Map(state.wires.map((w) => [w.primitiveId, w]));
    const issues = request.created
      .filter((expected) => !wireMatches(byId.get(expected.primitiveId), expected))
      .map((expected) => ({ code: 'WIRE_MISSING_OR_CHANGED', primitiveId: expected.primitiveId, index: expected.index ?? null }));
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
    const byId = new Map(current.wires.map((w) => [w.primitiveId, w]));
    const changed = request.created.filter((expected) => !wireMatches(byId.get(expected.primitiveId), expected));
    if (changed.length > 0) fail('STALE_ROLLBACK', 'One or more created wires changed after apply.');
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
