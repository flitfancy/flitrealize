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

  function summarizeWire(wire) {
    return {
      primitiveId: callGetter(wire, 'getState_PrimitiveId'),
      net: callGetter(wire, 'getState_Net', ''),
      lineWidth: finiteOrNull(callGetter(wire, 'getState_LineWidth')),
      lineType: callGetter(wire, 'getState_LineType'),
      points: callGetter(wire, 'getState_Points'),
    };
  }

  async function captureState() {
    const documentProbe = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    const document = documentProbe.value
      ? {
        uuid: documentProbe.value.uuid ?? null,
        tabId: documentProbe.value.tabId ?? null,
        documentType: documentProbe.value.documentType ?? null,
        parentProjectUuid: documentProbe.value.parentProjectUuid ?? null,
      }
      : null;

    const componentsProbe = await optionalCall('sch_PrimitiveComponent', 'getAll');
    const components = Array.isArray(componentsProbe.value)
      ? componentsProbe.value.map(summarizeComponent)
      : [];

    const wiresProbe = await optionalCall('sch_PrimitiveWire', 'getAll');
    const wires = Array.isArray(wiresProbe.value)
      ? wiresProbe.value.map(summarizeWire)
      : [];

    const netsProbe = await optionalCall('sch_Net', 'getAllNetsName');
    const nets = Array.isArray(netsProbe.value) ? netsProbe.value : [];

    const coverage = {
      document: documentProbe.error ? 'error' : documentProbe.value ? 'ok' : 'unsupported',
      components: componentsProbe.error ? 'error' : Array.isArray(componentsProbe.value) ? 'ok' : 'unsupported',
      wires: wiresProbe.error ? 'error' : Array.isArray(wiresProbe.value) ? 'ok' : 'unsupported',
      nets: netsProbe.error ? 'error' : Array.isArray(netsProbe.value) ? 'ok' : 'unsupported',
    };

    const inspectionFingerprint = hashText(stableStringify({
      documentUuid: document?.uuid,
      componentCount: components.length,
      wireCount: wires.length,
      netCount: nets.length,
      componentIds: components.map((c) => c.primitiveId).sort(),
      wireIds: wires.map((w) => w.primitiveId).sort(),
    }));

    return { document, components, wires, nets, coverage, inspectionFingerprint };
  }

  function publicState(state) {
    return {
      document: state.document,
      inspectionFingerprint: state.inspectionFingerprint,
      coverage: state.coverage,
      componentCount: state.components.length,
      wireCount: state.wires.length,
      netCount: state.nets.length,
      components: state.components,
      wires: state.wires,
      nets: state.nets,
    };
  }

  const mode = request.mode ?? 'inspect';
  if (mode === 'inspect') {
    const state = await captureState();
    return { schemaVersion: 1, status: 'inspected', readOnly: true, state: publicState(state) };
  }
  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
