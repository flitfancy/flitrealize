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
    const document = documentProbe.value
      ? { uuid: documentProbe.value.uuid ?? null, parentProjectUuid: documentProbe.value.parentProjectUuid ?? null, documentType: documentProbe.value.documentType ?? null }
      : null;
    const componentsProbe = await optionalCall('sch_PrimitiveComponent', 'getAll');
    const components = Array.isArray(componentsProbe.value) ? componentsProbe.value.map(summarizeComponent) : [];
    const wiresProbe = await optionalCall('sch_PrimitiveWire', 'getAll');
    const wires = Array.isArray(wiresProbe.value) ? wiresProbe.value.map(summarizeWire) : [];
    const inspectionFingerprint = hashText(stableStringify({
      documentUuid: document?.uuid,
      components: components.sort((left, right) => String(left.primitiveId).localeCompare(String(right.primitiveId))),
      wires: wires.sort((left, right) => String(left.primitiveId).localeCompare(String(right.primitiveId))),
    }));
    return { document, componentCount: components.length, wireCount: wires.length, inspectionFingerprint };
  }

  function assertIdentity(state, expectedDocumentUuid, expectedInspectionFingerprint = null) {
    if (!expectedDocumentUuid) fail('DOCUMENT_IDENTITY_REQUIRED', 'expectedDocumentUuid is required.');
    if (state.document?.uuid !== expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'Request belongs to another schematic.');
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
      const passed = await eda.sch_Drc.check(strict, false, false);
      return { available: true, passed: Boolean(passed), error: passed ? null : 'sch_Drc.check returned false' };
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
    assertIdentity(state, expectedDocumentUuid);
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
          expectedInspectionFingerprint: state.inspectionFingerprint,
          strict,
        },
      },
    };
  }
  if (mode === 'apply') {
    const input = operationRequest(request);
    const before = await captureState();
    assertIdentity(before, input.expectedDocumentUuid, input.expectedInspectionFingerprint);
    const save = await saveDocument();
    const after = await captureState();
    const drc = save.saved ? await runDrc(input.strict !== false) : { available: false, passed: null, error: 'DRC skipped because save failed' };
    const issues = [];
    if (!save.saved) issues.push({ code: 'SAVE_FAILED', message: save.error });
    if (save.saved && !drc.available) issues.push({ code: 'DRC_UNAVAILABLE', message: drc.error });
    else if (drc.available && !drc.passed) issues.push({ code: 'DRC_FAILED', message: drc.error });
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
    assertIdentity(state, input.expectedDocumentUuid, input.expectedInspectionFingerprint ?? null);
    const drc = await runDrc(input.strict !== false);
    const issues = [];
    if (!drc.available) issues.push({ code: 'DRC_UNAVAILABLE', message: drc.error });
    else if (!drc.passed) issues.push({ code: 'DRC_FAILED', message: drc.error });
    return {
      schemaVersion: 2,
      status: issues.length ? 'verify-failed' : 'verified',
      readOnly: true,
      saved: false,
      drc,
      inspectionFingerprint: state.inspectionFingerprint,
      issues,
    };
  }
  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
