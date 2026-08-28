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

  async function captureState() {
    const documentProbe = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    const document = documentProbe.value
      ? { uuid: documentProbe.value.uuid ?? null, parentProjectUuid: documentProbe.value.parentProjectUuid ?? null }
      : null;

    const componentsProbe = await optionalCall('sch_PrimitiveComponent', 'getAll');
    const componentCount = Array.isArray(componentsProbe.value) ? componentsProbe.value.length : 0;

    const wiresProbe = await optionalCall('sch_PrimitiveWire', 'getAll');
    const wireCount = Array.isArray(wiresProbe.value) ? wiresProbe.value.length : 0;

    const inspectionFingerprint = hashText(stableStringify({
      documentUuid: document?.uuid,
      componentCount,
      wireCount,
    }));

    return { document, componentCount, wireCount, inspectionFingerprint };
  }

  async function saveDocument() {
    if (typeof eda?.sch_Document?.save !== 'function') {
      return { saved: false, error: 'sch_Document.save is unavailable' };
    }
    try {
      const result = await eda.sch_Document.save();
      return { saved: Boolean(result), error: null };
    } catch (error) {
      return { saved: false, error: error.message };
    }
  }

  async function runDrc(strict = true) {
    if (typeof eda?.sch_Drc?.check !== 'function') {
      return { available: false, passed: null, error: 'sch_Drc.check is unavailable' };
    }
    try {
      const passed = await eda.sch_Drc.check(strict, false, false);
      return { available: true, passed: Boolean(passed), error: null };
    } catch (error) {
      return { available: true, passed: false, error: error.message };
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
        componentCount: state.componentCount,
        wireCount: state.wireCount,
      },
    };
  }
  if (mode === 'verify') {
    const strict = request.strict !== false;
    const beforeSave = await captureState();
    const saveResult = await saveDocument();
    const afterSave = await captureState();
    const drcResult = await runDrc(strict);
    const issues = [];
    if (!saveResult.saved) issues.push({ code: 'SAVE_FAILED', message: saveResult.error });
    if (drcResult.available && !drcResult.passed) issues.push({ code: 'DRC_FAILED', message: drcResult.error ?? 'DRC check returned false' });
    return {
      schemaVersion: 1,
      status: issues.length === 0 ? 'verified' : 'verify-failed',
      readOnly: true,
      saved: saveResult.saved,
      drc: drcResult,
      inspectionFingerprint: afterSave.inspectionFingerprint,
      issues,
      beforeSave: {
        inspectionFingerprint: beforeSave.inspectionFingerprint,
        componentCount: beforeSave.componentCount,
        wireCount: beforeSave.wireCount,
      },
    };
  }
  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
