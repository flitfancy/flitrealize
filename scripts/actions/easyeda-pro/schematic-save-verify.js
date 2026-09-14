return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;

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
      x: callGetter(component, 'getState_X'),
      y: callGetter(component, 'getState_Y'),
      rotation: callGetter(component, 'getState_Rotation'),
      mirror: callGetter(component, 'getState_Mirror', false),
    };
  }

  function summarizeWire(wire) {
    return {
      primitiveId: callGetter(wire, 'getState_PrimitiveId'),
      net: callGetter(wire, 'getState_Net', ''),
      line: callGetter(wire, 'getState_Line', callGetter(wire, 'getState_Points', [])),
      lineWidth: callGetter(wire, 'getState_LineWidth'),
      lineType: callGetter(wire, 'getState_LineType'),
    };
  }

  async function captureState() {
    const documentProbe = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    if (!documentProbe.value?.uuid || documentProbe.value.documentType !== 1) fail('STATE_READ_FAILED', 'Cannot read the active schematic identity.');
    const document = documentProbe.value
      ? { uuid: documentProbe.value.uuid ?? null, parentProjectUuid: documentProbe.value.parentProjectUuid ?? null, documentType: documentProbe.value.documentType ?? null }
      : null;
    const componentsProbe = await optionalCall('sch_PrimitiveComponent', 'getAll');
    if (!Array.isArray(componentsProbe.value)) fail('STATE_READ_FAILED', 'Cannot read components before saving.');
    const components = Array.isArray(componentsProbe.value) ? componentsProbe.value.map(summarizeComponent) : [];
    const wiresProbe = await optionalCall('sch_PrimitiveWire', 'getAll');
    if (!Array.isArray(wiresProbe.value)) fail('STATE_READ_FAILED', 'Cannot read wires before saving.');
    const wires = Array.isArray(wiresProbe.value) ? wiresProbe.value.map(summarizeWire) : [];
    const finalDocument = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    if (finalDocument.value?.uuid !== document.uuid || finalDocument.value?.parentProjectUuid !== document.parentProjectUuid || finalDocument.value?.documentType !== 1) fail('DOCUMENT_MISMATCH', 'Schematic changed during readback.');
    const inspectionFingerprint = hashText(stableStringify({
      documentUuid: document?.uuid,
      projectUuid: document?.parentProjectUuid,
      components: components.sort((left, right) => String(left.primitiveId).localeCompare(String(right.primitiveId))),
      wires: wires.sort((left, right) => String(left.primitiveId).localeCompare(String(right.primitiveId))),
    }));
    return { document, componentCount: components.length, wireCount: wires.length, inspectionFingerprint };
  }

  function assertIdentity(state, expectedDocumentUuid, expectedInspectionFingerprint = null, expectedProjectUuid = null) {
    if (!expectedDocumentUuid) fail('DOCUMENT_IDENTITY_REQUIRED', 'expectedDocumentUuid is required.');
    if (state.document?.uuid !== expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'Request belongs to another schematic.');
    if (expectedProjectUuid && state.document?.parentProjectUuid !== expectedProjectUuid) fail('PROJECT_MISMATCH', 'Request belongs to another project.');
    if (expectedInspectionFingerprint && state.inspectionFingerprint !== expectedInspectionFingerprint) {
      fail('STALE_SCHEMATIC', 'The schematic changed after the save/verify request was planned.');
    }
  }

  async function saveDocument() {
    if (typeof eda?.sch_Document?.save !== 'function') return { saved: false, error: 'sch_Document.save is unavailable' };
    try {
      const result = await eda.sch_Document.save();
      return { saved: Boolean(result), error: result ? null : 'sch_Document.save returned false' };
    } catch (error) {
      return { saved: false, error: error.message };
    }
  }

  async function runDrc(strict = true) {
    if (typeof eda?.sch_Drc?.check !== 'function') return { available: false, passed: null, error: 'sch_Drc.check is unavailable' };
    try {
      const result = await eda.sch_Drc.check(strict, false, true);
      // Some provider versions return detailed items; others return aggregated counts or a boolean.
      if (typeof result === 'boolean') return { available: true, passed: result, error: result ? null : 'sch_Drc.check returned false', detailCoverage: 'unavailable' };
      if (!Array.isArray(result)) return { available: true, passed: null, error: 'Unrecognized DRC response', detailCoverage: 'unknown' };
      const counts = { fatalError: 0, error: 0, warn: 0 };
      let recognized = true;
      for (const item of result) {
        if (!Object.hasOwn(counts, item?.type) || (item.count !== undefined && (!Number.isInteger(item.count) || item.count < 0))) { recognized = false; continue; }
        counts[item.type] += item.count ?? 1;
      }
      const passed = recognized && Object.values(counts).every(count => count === 0);
      return { available: true, passed: recognized ? passed : null, counts, results: result,
        detailCoverage: recognized ? result.some(item => item.count !== undefined) ? 'counts-only' : 'items' : 'unknown',
        error: !recognized ? 'Unrecognized DRC items' : passed ? null : 'Schematic DRC reported violations' };
    } catch (error) {
      return { available: true, passed: false, error: error.message };
    }
  }

  function operationRequest(root) {
    return root.request || root.applyRequest || root;
  }

  const mode = request.mode ?? 'inspect';
  if (mode === 'inspect') {
    const state = await captureState();
    return { schemaVersion: 2, status: 'inspected', readOnly: true, state };
  }
  if (mode === 'plan') {
    const state = await captureState();
    const expectedDocumentUuid = request.expectedDocumentUuid ?? state.document?.uuid;
    assertIdentity(state, expectedDocumentUuid, null, request.expectedProjectUuid);
    const strict = request.strict !== false;
    return {
      schemaVersion: 2,
      status: 'planned',
      readOnly: true,
      state,
      applyRequest: {
        mode: 'apply',
        request: {
          expectedDocumentUuid,
          expectedProjectUuid: request.expectedProjectUuid ?? null,
          expectedInspectionFingerprint: state.inspectionFingerprint,
          strict,
          runDrc: request.runDrc !== false,
        },
      },
    };
  }
  if (mode === 'apply') {
    const input = operationRequest(request);
    const before = await captureState();
    assertIdentity(before, input.expectedDocumentUuid, input.expectedInspectionFingerprint, input.expectedProjectUuid);
    const save = await saveDocument();
    const after = await captureState();
    const targetChanged = after.document?.uuid !== before.document?.uuid || after.document?.parentProjectUuid !== before.document?.parentProjectUuid;
    const drc = !save.saved ? { available: false, passed: null, error: 'DRC skipped because save failed' }
      : targetChanged ? { available: false, passed: null, error: 'DRC skipped because the document changed during save' }
      : input.runDrc === false ? { available: null, passed: null, skipped: true } : await runDrc(input.strict !== false);
    const final = await captureState();
    const issues = [];
    if (!save.saved) issues.push({ code: 'SAVE_FAILED', message: save.error });
    if (save.saved && input.runDrc !== false && !drc.available) issues.push({ code: 'DRC_UNAVAILABLE', message: drc.error });
    else if (drc.available && !drc.passed) issues.push({ code: 'DRC_FAILED', message: drc.error });
    if (after.document?.uuid !== before.document?.uuid || after.document?.parentProjectUuid !== before.document?.parentProjectUuid || after.inspectionFingerprint !== before.inspectionFingerprint) issues.push({ code: 'SAVE_READBACK_CHANGED' });
    if (final.document?.uuid !== before.document?.uuid || final.document?.parentProjectUuid !== before.document?.parentProjectUuid || final.inspectionFingerprint !== after.inspectionFingerprint) issues.push({ code: 'DRC_READBACK_CHANGED' });
    return {
      schemaVersion: 2,
      status: issues.length ? 'apply-failed' : 'applied',
      readOnly: false,
      saved: save.saved,
      drc,
      beforeInspectionFingerprint: before.inspectionFingerprint,
      inspectionFingerprint: after.inspectionFingerprint,
      issues,
    };
  }
  if (mode === 'verify') {
    const input = operationRequest(request);
    const state = await captureState();
    assertIdentity(state, input.expectedDocumentUuid, input.expectedInspectionFingerprint ?? null, input.expectedProjectUuid);
    const drc = input.runDrc === false ? { available: null, passed: null, skipped: true } : await runDrc(input.strict !== false);
    const final = await captureState();
    assertIdentity(final, state.document.uuid, state.inspectionFingerprint, state.document.parentProjectUuid);
    const issues = [];
    if (input.runDrc !== false && !drc.available) issues.push({ code: 'DRC_UNAVAILABLE', message: drc.error });
    else if (drc.available && !drc.passed) issues.push({ code: 'DRC_FAILED', message: drc.error });
    return {
      schemaVersion: 2,
      status: issues.length ? 'verify-failed' : 'verified',
      readOnly: true,
      saved: null,
      saveChecked: false,
      drc,
      inspectionFingerprint: state.inspectionFingerprint,
      issues,
    };
  }
  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
