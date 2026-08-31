return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;
  const MAX_WIRES_PER_APPLY = 200;
  const APPLY_BATCH_SIZE = 20;

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
    if (typeof eda?.[namespace]?.[method] !== 'function') return { value: null, error: null, unsupported: true };
    try {
      return { value: await eda[namespace][method](...args), error: null, unsupported: false };
    } catch (error) {
      return { value: null, error: error.message, unsupported: false };
    }
  }

  function normalizePoints(value) {
    if (!Array.isArray(value)) return [];
    if (value.every((entry) => Number.isFinite(Number(entry)))) {
      const points = [];
      for (let index = 0; index + 1 < value.length; index += 2) {
        points.push({ x: Number(value[index]), y: Number(value[index + 1]) });
      }
      return points;
    }
    return value.map((entry) => {
      if (Array.isArray(entry) && entry.length >= 2 && Number.isFinite(Number(entry[0])) && Number.isFinite(Number(entry[1]))) {
        return { x: Number(entry[0]), y: Number(entry[1]) };
      }
      if (entry && Number.isFinite(entry.x) && Number.isFinite(entry.y)) return { x: Number(entry.x), y: Number(entry.y) };
      return null;
    }).filter(Boolean);
  }

  function pointsEqual(left, right) {
    const a = normalizePoints(left);
    const b = normalizePoints(right);
    if (a.length !== b.length) return false;
    const forward = a.every((point, index) => point.x === b[index].x && point.y === b[index].y);
    if (forward) return true;
    return a.every((point, index) => {
      const opposite = b[b.length - 1 - index];
      return point.x === opposite.x && point.y === opposite.y;
    });
  }

  function summarizeWire(wire) {
    return {
      primitiveId: callGetter(wire, 'getState_PrimitiveId'),
      net: callGetter(wire, 'getState_Net', '') || '',
      points: normalizePoints(callGetter(wire, 'getState_Line', callGetter(wire, 'getState_Points', []))),
      color: callGetter(wire, 'getState_Color'),
      lineWidth: finiteOrNull(callGetter(wire, 'getState_LineWidth')),
      lineType: callGetter(wire, 'getState_LineType'),
    };
  }

  async function summarizePin(pin, componentId) {
    const number = String(callGetter(pin, 'getState_PinNumber', callGetter(pin, 'getState_Number', callGetter(pin, 'getState_Name', ''))) || '');
    if (!number) return null;
    const nativeId = callGetter(pin, 'getState_PrimitiveId', callGetter(pin, 'getState_Id', `${componentId}:${number}`));
    const x = finiteOrNull(callGetter(pin, 'getState_X'));
    const y = finiteOrNull(callGetter(pin, 'getState_Y'));
    return {
      number,
      nativeId,
      position: x !== null && y !== null ? { x, y } : null,
      rotation: finiteOrNull(callGetter(pin, 'getState_Rotation')),
      noConnect: callGetter(pin, 'getState_NoConnect', false) === true,
    };
  }

  async function summarizeComponent(component) {
    const nativeId = callGetter(component, 'getState_PrimitiveId');
    const designator = callGetter(component, 'getState_Designator');
    if (!nativeId || !designator) return null;
    const pinsProbe = await optionalCall('sch_PrimitiveComponent', 'getAllPinsByPrimitiveId', nativeId);
    const pins = Array.isArray(pinsProbe.value)
      ? (await Promise.all(pinsProbe.value.map((pin) => summarizePin(pin, nativeId)))).filter(Boolean)
      : [];
    const x = finiteOrNull(callGetter(component, 'getState_X'));
    const y = finiteOrNull(callGetter(component, 'getState_Y'));
    return {
      designator,
      nativeId,
      position: x !== null && y !== null ? { x, y } : null,
      rotation: finiteOrNull(callGetter(component, 'getState_Rotation')),
      mirror: callGetter(component, 'getState_Mirror', false) === true,
      pins,
      pinCoverage: pinsProbe.unsupported ? 'unsupported' : pinsProbe.error ? 'error' : 'ok',
    };
  }

  function geometryEvidence(components, wires) {
    return {
      components: components.map((component) => ({
        designator: component.designator,
        nativeId: component.nativeId,
        position: component.position,
        rotation: component.rotation,
        mirror: component.mirror,
        pins: component.pins.map((pin) => ({
          number: pin.number,
          nativeId: pin.nativeId,
          position: pin.position,
          rotation: pin.rotation,
          noConnect: pin.noConnect,
        })).sort((left, right) => left.number.localeCompare(right.number)),
      })).sort((left, right) => left.designator.localeCompare(right.designator)),
      wires: wires.map((wire) => ({
        primitiveId: wire.primitiveId,
        net: wire.net,
        points: wire.points,
        lineWidth: wire.lineWidth,
        lineType: wire.lineType,
      })).sort((left, right) => String(left.primitiveId).localeCompare(String(right.primitiveId))),
    };
  }

  async function captureState() {
    const documentProbe = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    const document = documentProbe.value
      ? { uuid: documentProbe.value.uuid ?? null, parentProjectUuid: documentProbe.value.parentProjectUuid ?? null, documentType: documentProbe.value.documentType ?? null }
      : null;
    const componentsProbe = await optionalCall('sch_PrimitiveComponent', 'getAll');
    const componentValues = Array.isArray(componentsProbe.value) ? componentsProbe.value : [];
    const components = (await Promise.all(componentValues.map(summarizeComponent))).filter(Boolean);
    const wiresProbe = await optionalCall('sch_PrimitiveWire', 'getAll');
    const wires = Array.isArray(wiresProbe.value) ? wiresProbe.value.map(summarizeWire) : [];
    const evidence = geometryEvidence(components, wires);
    const geometryFingerprint = hashText(stableStringify(evidence));
    const inspectionFingerprint = hashText(stableStringify({
      documentUuid: document?.uuid,
      geometryFingerprint,
    }));
    return {
      document,
      components,
      wires,
      geometryFingerprint,
      inspectionFingerprint,
      coverage: {
        components: componentsProbe.unsupported ? 'unsupported' : componentsProbe.error ? 'error' : 'queried',
        wires: wiresProbe.unsupported ? 'unsupported' : wiresProbe.error ? 'error' : 'queried',
        pins: components.some((component) => component.pinCoverage !== 'ok') ? 'incomplete' : 'queried',
      },
    };
  }

  function normalizeWire(item, index) {
    if (!Array.isArray(item.points) || item.points.length < 2) {
      fail('INVALID_PLAN_ITEM', `Wire ${index}: points must contain at least two positions.`);
    }
    const points = item.points.map((point, pointIndex) => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        fail('INVALID_PLAN_ITEM', `Wire ${index}, point ${pointIndex}: x and y must be finite numbers.`);
      }
      return { x: Number(point.x), y: Number(point.y) };
    });
    if (typeof item.net !== 'string' || !item.net.trim()) fail('INVALID_PLAN_ITEM', `Wire ${index}: net is required.`);
    return {
      index,
      key: typeof item.key === 'string' && item.key ? item.key : `${item.net}:${index}`,
      net: item.net.trim(),
      endpoint: item.endpoint || null,
      points,
      color: item.color ?? null,
      lineWidth: item.lineWidth ?? null,
      lineType: item.lineType ?? null,
    };
  }

  function normalizePlan(value) {
    if (!value || typeof value !== 'object') fail('INVALID_PLAN', 'plan must be an object.');
    const wirePlan = value.kind === 'flitrealize.schematic-wire-plan' && value.schemaVersion === 1;
    const sourceWires = wirePlan ? value.wires : value.wires ?? value.items;
    if (!Array.isArray(sourceWires)) fail('INVALID_PLAN', 'WirePlan wires or legacy plan.wires/items must be an array.');
    return {
      wires: sourceWires.map(normalizeWire),
      expectedDocumentUuid: wirePlan ? value.document?.nativeId ?? null : value.expectedDocumentUuid ?? null,
      sourceGeometryFingerprint: wirePlan ? value.source?.geometryFingerprint ?? null : value.sourceGeometryFingerprint ?? null,
      sourceSnapshotFingerprint: wirePlan ? value.source?.snapshotFingerprint ?? null : value.sourceSnapshotFingerprint ?? null,
      sourceWirePlanFingerprint: wirePlan ? value.fingerprints?.plan ?? null : value.sourceWirePlanFingerprint ?? null,
      unresolved: wirePlan && Array.isArray(value.unresolved) ? value.unresolved : [],
    };
  }

  function analyzePlan(state, plan) {
    const globalIssues = [];
    if (!plan.expectedDocumentUuid) globalIssues.push({ code: 'DOCUMENT_IDENTITY_REQUIRED' });
    else if (state.document?.uuid !== plan.expectedDocumentUuid) {
      globalIssues.push({ code: 'DOCUMENT_MISMATCH', expected: plan.expectedDocumentUuid, actual: state.document?.uuid });
    }
    if (!plan.sourceGeometryFingerprint) globalIssues.push({ code: 'SOURCE_GEOMETRY_REQUIRED' });
    else if (state.geometryFingerprint !== plan.sourceGeometryFingerprint) {
      globalIssues.push({ code: 'SOURCE_GEOMETRY_STALE', expected: plan.sourceGeometryFingerprint, actual: state.geometryFingerprint });
    }
    if (plan.unresolved.length) globalIssues.push({ code: 'WIRE_PLAN_UNRESOLVED', count: plan.unresolved.length });
    if (plan.wires.length > MAX_WIRES_PER_APPLY) globalIssues.push({ code: 'TOO_MANY_WIRES', count: plan.wires.length, max: MAX_WIRES_PER_APPLY });
    const keys = new Set();
    const segments = new Set();
    for (const wire of plan.wires) {
      if (keys.has(wire.key)) globalIssues.push({ code: 'DUPLICATE_WIRE_KEY', key: wire.key });
      keys.add(wire.key);
      const segmentKey = stableStringify({ net: wire.net, points: wire.points });
      if (segments.has(segmentKey)) globalIssues.push({ code: 'DUPLICATE_WIRE_SEGMENT', key: wire.key });
      segments.add(segmentKey);
    }
    const planFingerprint = hashText(stableStringify({
      documentUuid: state.document?.uuid,
      geometryFingerprint: state.geometryFingerprint,
      plan,
      globalIssues,
    }));
    return {
      applyReady: plan.wires.length > 0 && globalIssues.length === 0,
      noOp: plan.wires.length === 0 && globalIssues.length === 0,
      wireCount: plan.wires.length,
      unresolvedCount: plan.unresolved.length,
      globalIssues,
      planFingerprint,
    };
  }

  async function getWiresByIds(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return [];
    if (typeof eda?.sch_PrimitiveWire?.get !== 'function') fail('CAPABILITY_UNAVAILABLE', 'sch_PrimitiveWire.get is unavailable.');
    try {
      const value = await eda.sch_PrimitiveWire.get(unique);
      if (Array.isArray(value)) return value.filter(Boolean).map(summarizeWire);
      if (value && unique.length === 1) return [summarizeWire(value)];
    } catch {
      // Fall back to one deterministic read per primitive ID.
    }
    const values = await Promise.all(unique.map(async (id) => {
      try {
        return await eda.sch_PrimitiveWire.get(id);
      } catch {
        return null;
      }
    }));
    return values.filter(Boolean).map(summarizeWire);
  }

  function wireMatchesRequest(actual, expected) {
    if (!actual || actual.net !== expected.net || !pointsEqual(actual.points, expected.points)) return false;
    if (expected.color !== null && actual.color !== expected.color) return false;
    if (expected.lineWidth !== null && actual.lineWidth !== expected.lineWidth) return false;
    if (expected.lineType !== null && actual.lineType !== expected.lineType) return false;
    return true;
  }

  function wireMatchesRecord(actual, expected) {
    return actual
      && actual.primitiveId === expected.primitiveId
      && actual.net === expected.net
      && pointsEqual(actual.points, expected.points)
      && actual.color === expected.color
      && actual.lineWidth === expected.lineWidth
      && actual.lineType === expected.lineType;
  }

  function targetedFingerprint(wires) {
    return hashText(stableStringify(wires.map((wire) => ({
      primitiveId: wire.primitiveId,
      net: wire.net,
      points: normalizePoints(wire.points),
      color: wire.color ?? null,
      lineWidth: wire.lineWidth ?? null,
      lineType: wire.lineType ?? null,
    })).sort((left, right) => String(left.primitiveId).localeCompare(String(right.primitiveId)))));
  }

  async function deleteAndVerify(created) {
    const ids = created.map((wire) => wire.primitiveId).filter(Boolean);
    if (!ids.length) return { deleted: true, remaining: 0, remainingIds: [], coverage: 'targeted-by-id' };
    let deleted = false;
    try {
      deleted = await eda.sch_PrimitiveWire.delete(ids);
    } catch {
      deleted = false;
    }
    const remaining = await getWiresByIds(ids);
    return {
      deleted: Boolean(deleted),
      remaining: remaining.length,
      remainingIds: remaining.map((wire) => wire.primitiveId),
      coverage: 'targeted-by-id',
    };
  }

  function globalEnumerationCoverage(before, after, createdIds) {
    if (after.coverage.wires !== 'queried') return 'unknown';
    const afterIds = new Set(after.wires.map((wire) => wire.primitiveId));
    const beforeIds = new Set(before.wires.map((wire) => wire.primitiveId));
    const protectedMissing = [...beforeIds].filter((id) => !afterIds.has(id));
    const createdMissing = createdIds.filter((id) => !afterIds.has(id));
    return protectedMissing.length || createdMissing.length ? 'inconsistent' : 'consistent';
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
        state: { document: before.document, inspectionFingerprint: before.inspectionFingerprint, geometryFingerprint: before.geometryFingerprint },
        analysis,
      };
    }
    const created = [];
    const createdIds = [];
    try {
      for (let offset = 0; offset < plan.wires.length; offset += APPLY_BATCH_SIZE) {
        const batch = plan.wires.slice(offset, offset + APPLY_BATCH_SIZE);
        const batchCreated = [];
        for (const item of batch) {
          const line = item.points.flatMap((point) => [point.x, point.y]);
          const primitive = await eda.sch_PrimitiveWire.create(line, item.net, item.color, item.lineWidth, item.lineType);
          if (!primitive) fail('CREATE_WIRE_FAILED', `EasyEDA rejected wire ${item.key}.`);
          const primitiveId = callGetter(primitive, 'getState_PrimitiveId');
          if (!primitiveId) fail('CREATE_WIRE_WITHOUT_ID', `Wire ${item.key} has no primitive ID.`);
          createdIds.push(primitiveId);
          batchCreated.push({ item, primitiveId });
        }
        const readback = await getWiresByIds(batchCreated.map((entry) => entry.primitiveId));
        const byId = new Map(readback.map((wire) => [wire.primitiveId, wire]));
        for (const entry of batchCreated) {
          const actual = byId.get(entry.primitiveId);
          if (!wireMatchesRequest(actual, entry.item)) {
            fail('WIRE_READBACK_MISMATCH', `Wire ${entry.item.key} did not retain the requested net, geometry, or style.`);
          }
          created.push({
            index: entry.item.index,
            key: entry.item.key,
            endpoint: entry.item.endpoint,
            ...actual,
          });
        }
      }
      const targeted = await getWiresByIds(created.map((wire) => wire.primitiveId));
      const targetedById = new Map(targeted.map((wire) => [wire.primitiveId, wire]));
      const mismatches = created.filter((wire) => !wireMatchesRecord(targetedById.get(wire.primitiveId), wire));
      if (mismatches.length) fail('POST_APPLY_TARGETED_VERIFY_FAILED', `${mismatches.length} created wire(s) failed ID-based verification.`);
      const after = await captureState();
      const expectedCreatedFingerprint = targetedFingerprint(created);
      return {
        schemaVersion: 2,
        status: 'applied',
        readOnly: false,
        saved: false,
        beforeInspectionFingerprint: before.inspectionFingerprint,
        afterInspectionFingerprint: after.inspectionFingerprint,
        planFingerprint: analysis.planFingerprint,
        created,
        verification: {
          coverage: 'targeted-by-id',
          verifiedCount: targeted.length,
          globalWireEnumeration: globalEnumerationCoverage(before, after, created.map((wire) => wire.primitiveId)),
        },
        rollbackRequest: {
          mode: 'rollback',
          request: {
            expectedDocumentUuid: plan.expectedDocumentUuid,
            expectedCreatedFingerprint,
            expectedRestoredFingerprint: before.inspectionFingerprint,
            created,
          },
        },
      };
    } catch (error) {
      const rollbackTargets = createdIds.map((primitiveId) => created.find((wire) => wire.primitiveId === primitiveId) || { primitiveId });
      const rollback = await deleteAndVerify(rollbackTargets);
      const restored = await captureState();
      return {
        schemaVersion: 2,
        status: rollback.remaining === 0 && restored.inspectionFingerprint === before.inspectionFingerprint
          ? 'rolled-back'
          : rollback.remaining === 0 ? 'rolled-back-targeted' : 'rollback-incomplete',
        error: { code: error.code ?? 'APPLY_FAILED', message: error.message },
        createdBeforeFailure: rollbackTargets,
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
        geometryFingerprint: state.geometryFingerprint,
        componentCount: state.components.length,
        wireCount: state.wires.length,
        coverage: state.coverage,
      },
    };
  }
  if (mode === 'plan') {
    const plan = normalizePlan(request.plan);
    const state = await captureState();
    const analysis = analyzePlan(state, plan);
    return {
      schemaVersion: 2,
      status: analysis.noOp ? 'planned-noop' : analysis.applyReady ? 'planned' : 'planned-with-blockers',
      readOnly: true,
      state: {
        document: state.document,
        inspectionFingerprint: state.inspectionFingerprint,
        geometryFingerprint: state.geometryFingerprint,
        wireCount: state.wires.length,
        coverage: state.coverage,
      },
      plan,
      analysis,
      applyRequest: analysis.applyReady
        ? { mode: 'apply', request: { plan, expectedPlanFingerprint: analysis.planFingerprint } }
        : null,
    };
  }
  if (mode === 'apply') {
    const input = operationRequest(request);
    if (typeof input.expectedPlanFingerprint !== 'string' || !input.expectedPlanFingerprint) {
      fail('INVALID_APPLY_REQUEST', 'apply requires expectedPlanFingerprint from plan mode.');
    }
    return applyPlan(normalizePlan(input.plan), input.expectedPlanFingerprint);
  }
  if (mode === 'verify') {
    const input = operationRequest(request);
    if (!Array.isArray(input.created) || !input.expectedDocumentUuid) {
      fail('INVALID_VERIFY_REQUEST', 'verify requires expectedDocumentUuid and created readback records.');
    }
    const documentProbe = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    if (documentProbe.value?.uuid !== input.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'Verify request belongs to another schematic.');
    const actual = await getWiresByIds(input.created.map((wire) => wire.primitiveId));
    const byId = new Map(actual.map((wire) => [wire.primitiveId, wire]));
    const issues = input.created
      .filter((expected) => !wireMatchesRecord(byId.get(expected.primitiveId), expected))
      .map((expected) => ({ code: 'WIRE_MISSING_OR_CHANGED', primitiveId: expected.primitiveId, index: expected.index ?? null }));
    return {
      schemaVersion: 2,
      status: issues.length ? 'mismatch' : 'verified',
      readOnly: true,
      coverage: 'targeted-by-id',
      verifiedCount: actual.length,
      targetedFingerprint: targetedFingerprint(actual),
      issues,
    };
  }
  if (mode === 'rollback') {
    const input = operationRequest(request);
    if (!input.expectedDocumentUuid || !input.expectedCreatedFingerprint || !input.expectedRestoredFingerprint || !Array.isArray(input.created)) {
      fail('INVALID_ROLLBACK_REQUEST', 'rollback requires document identity, created/restored fingerprints, and created records.');
    }
    const documentProbe = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    if (documentProbe.value?.uuid !== input.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'Rollback request belongs to another schematic.');
    const currentTargets = await getWiresByIds(input.created.map((wire) => wire.primitiveId));
    if (targetedFingerprint(currentTargets) !== input.expectedCreatedFingerprint) {
      fail('STALE_ROLLBACK', 'One or more created wires changed after apply.');
    }
    const rollback = await deleteAndVerify(input.created);
    const restored = await captureState();
    return {
      schemaVersion: 2,
      status: rollback.remaining
        ? 'rollback-incomplete'
        : restored.inspectionFingerprint === input.expectedRestoredFingerprint ? 'rolled-back' : 'rolled-back-targeted',
      rollback,
      restoredInspectionFingerprint: restored.inspectionFingerprint,
      expectedRestoredFingerprint: input.expectedRestoredFingerprint,
      globalWireEnumeration: restored.coverage.wires,
      saved: false,
    };
  }
  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
