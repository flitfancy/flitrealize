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

  function textOrNull(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
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
      if (Array.isArray(entry) && entry.length >= 2) return { x: finiteOrNull(entry[0]), y: finiteOrNull(entry[1]) };
      if (entry && typeof entry === 'object') return { x: finiteOrNull(entry.x), y: finiteOrNull(entry.y) };
      return null;
    }).filter((entry) => entry && entry.x !== null && entry.y !== null);
  }

  function componentBinding(component) {
    const state = callGetter(component, 'getState_Component', {}) || {};
    const libraryUuid = textOrNull(callGetter(component, 'getState_LibraryUuid'))
      ?? textOrNull(state.libraryUuid)
      ?? textOrNull(state.library_uuid);
    const deviceUuid = textOrNull(callGetter(component, 'getState_Uuid'))
      ?? textOrNull(state.uuid)
      ?? textOrNull(state.deviceUuid);
    return { libraryUuid, deviceUuid };
  }

  async function summarizePin(pin, componentId) {
    const number = textOrNull(callGetter(pin, 'getState_PinNumber'))
      ?? textOrNull(callGetter(pin, 'getState_Number'))
      ?? textOrNull(callGetter(pin, 'getState_Name'));
    const nativeId = textOrNull(callGetter(pin, 'getState_PrimitiveId'))
      ?? textOrNull(callGetter(pin, 'getState_Id'))
      ?? (number ? `${componentId}:${number}` : null);
    if (!number || !nativeId) return null;
    const x = finiteOrNull(callGetter(pin, 'getState_X'));
    const y = finiteOrNull(callGetter(pin, 'getState_Y'));
    const summarized = {
      number,
      name: textOrNull(callGetter(pin, 'getState_PinName')) ?? textOrNull(callGetter(pin, 'getState_Name')) ?? '',
      nativeId,
      net: null,
      noConnect: Boolean(callGetter(pin, 'getState_NoConnect', false)),
      extensions: {
        easyedaPro: {
          rotation: finiteOrNull(callGetter(pin, 'getState_Rotation')),
          pinType: callGetter(pin, 'getState_PinType'),
          pinShape: callGetter(pin, 'getState_PinShape'),
        },
      },
    };
    if (x !== null && y !== null) summarized.position = { x, y };
    return summarized;
  }

  async function summarizeComponent(component, sheetId) {
    const nativeId = textOrNull(callGetter(component, 'getState_PrimitiveId'));
    const designator = textOrNull(callGetter(component, 'getState_Designator'));
    if (!nativeId || !designator) return null;

    const pinsProbe = await optionalCall('sch_PrimitiveComponent', 'getAllPinsByPrimitiveId', nativeId);
    const pinValues = Array.isArray(pinsProbe.value) ? pinsProbe.value : [];
    const pins = (await Promise.all(pinValues.map((pin) => summarizePin(pin, nativeId)))).filter(Boolean);
    const binding = componentBinding(component);
    const x = finiteOrNull(callGetter(component, 'getState_X'));
    const y = finiteOrNull(callGetter(component, 'getState_Y'));
    const summarized = {
      designator,
      nativeId,
      sheetId,
      name: textOrNull(callGetter(component, 'getState_Name')) ?? '',
      value: textOrNull(callGetter(component, 'getState_Value')) ?? '',
      manufacturer: textOrNull(callGetter(component, 'getState_Manufacturer')) ?? '',
      mpn: textOrNull(callGetter(component, 'getState_ManufacturerPart')) ?? '',
      footprint: textOrNull(callGetter(component, 'getState_Footprint')),
      includeInBom: Boolean(callGetter(component, 'getState_AddIntoBom', true)),
      includeInPcb: Boolean(callGetter(component, 'getState_AddIntoPcb', true)),
      rotation: finiteOrNull(callGetter(component, 'getState_Rotation')) ?? 0,
      mirror: Boolean(callGetter(component, 'getState_Mirror', false)),
      pins,
      bindings: {
        easyedaPro: {
          libraryUuid: binding.libraryUuid,
          deviceUuid: binding.deviceUuid,
        },
      },
      extensions: {
        easyedaPro: {
          componentType: callGetter(component, 'getState_ComponentType'),
          pinInspection: pinsProbe.error ? 'error' : pinsProbe.unsupported ? 'unsupported' : 'ok',
          pinInspectionError: pinsProbe.error,
        },
      },
    };
    if (x !== null && y !== null) summarized.position = { x, y };
    return summarized;
  }

  function summarizeWire(wire) {
    const line = callGetter(wire, 'getState_Line', null);
    const fallback = line === null ? callGetter(wire, 'getState_Points', []) : line;
    return {
      primitiveId: textOrNull(callGetter(wire, 'getState_PrimitiveId')),
      net: textOrNull(callGetter(wire, 'getState_Net')) ?? '',
      lineWidth: finiteOrNull(callGetter(wire, 'getState_LineWidth')),
      lineType: callGetter(wire, 'getState_LineType'),
      points: normalizePoints(fallback),
    };
  }

  async function captureState() {
    const documentProbe = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    const nativeDocument = documentProbe.value;
    if (!nativeDocument?.uuid) fail('DOCUMENT_UNAVAILABLE', 'No active EasyEDA Pro document is available.');
    if (nativeDocument.documentType !== 1) fail('WRONG_DOCUMENT_TYPE', 'The active EasyEDA Pro document is not a schematic.');

    const documentUuid = String(nativeDocument.uuid);
    const projectUuid = String(nativeDocument.parentProjectUuid ?? 'unknown-project');
    const componentsProbe = await optionalCall('sch_PrimitiveComponent', 'getAll');
    const componentValues = Array.isArray(componentsProbe.value) ? componentsProbe.value : [];
    const componentSummaries = await Promise.all(componentValues.map((component) => summarizeComponent(component, documentUuid)));
    const components = componentSummaries.filter(Boolean);
    const omittedComponents = componentSummaries.length - components.length;

    const wiresProbe = await optionalCall('sch_PrimitiveWire', 'getAll');
    const wires = Array.isArray(wiresProbe.value) ? wiresProbe.value.map(summarizeWire) : [];
    const netsProbe = await optionalCall('sch_Net', 'getAllNetsName');
    const netNames = Array.isArray(netsProbe.value)
      ? [...new Set(netsProbe.value.map(textOrNull).filter(Boolean))].sort()
      : [];
    const nets = netNames.map((name) => ({ name, nativeId: null, endpoints: [] }));

    const queried = ['document'];
    const unsupported = [];
    const unknown = [];
    for (const [name, probe] of [['components', componentsProbe], ['wires', wiresProbe], ['nets', netsProbe]]) {
      if (probe.unsupported) unsupported.push(name);
      else queried.push(name);
      if (probe.error) unknown.push(name);
    }
    if (netNames.length) unknown.push('net-endpoints');
    if (omittedComponents) unknown.push('components-without-designators');
    if (components.some((component) => component.extensions.easyedaPro.pinInspection !== 'ok')) unknown.push('component-pins');

    const diagnostics = [];
    if (omittedComponents) diagnostics.push({
      severity: 'warning',
      code: 'COMPONENT_IDENTITY_INCOMPLETE',
      message: `${omittedComponents} primitive(s) were omitted because a native id or designator was unavailable.`,
    });
    if (unknown.includes('component-pins')) diagnostics.push({
      severity: 'warning',
      code: 'PIN_INSPECTION_INCOMPLETE',
      message: 'At least one component could not provide a complete pin list.',
    });
    if (netNames.length) diagnostics.push({
      severity: 'info',
      code: 'NET_ENDPOINTS_UNKNOWN',
      message: 'EasyEDA net names were captured, but endpoint membership was not inferred from wire geometry.',
    });

    const componentGeometry = components.map((component) => ({
      designator: component.designator,
      nativeId: component.nativeId,
      position: component.position ?? null,
      rotation: component.rotation,
      mirror: component.mirror,
      pins: component.pins.map((pin) => ({ number: pin.number, nativeId: pin.nativeId, position: pin.position ?? null, noConnect: pin.noConnect })),
    })).sort((a, b) => a.designator.localeCompare(b.designator));
    const wireGeometry = wires.map((wire) => ({
      primitiveId: wire.primitiveId,
      net: wire.net,
      lineWidth: wire.lineWidth,
      lineType: wire.lineType,
      points: wire.points,
    })).sort((a, b) => String(a.primitiveId).localeCompare(String(b.primitiveId)));
    const capabilitiesFingerprint = hashText(stableStringify({ queried, unsupported, unknown }));
    const componentsFingerprint = hashText(stableStringify(componentGeometry));
    const connectivityFingerprint = hashText(stableStringify({ nets, wires: wireGeometry }));
    const documentFingerprint = hashText(stableStringify({
      documentUuid,
      projectUuid,
      componentsFingerprint,
      connectivityFingerprint,
    }));

    const snapshot = {
      kind: 'flitrealize.schematic-snapshot',
      schemaVersion: 1,
      provider: 'easyeda-pro',
      capturedAt: new Date().toISOString(),
      project: { id: projectUuid, nativeId: projectUuid },
      document: {
        id: documentUuid,
        nativeId: documentUuid,
        type: 'schematic',
        extensions: { easyedaPro: { tabId: nativeDocument.tabId ?? null, documentType: nativeDocument.documentType } },
      },
      sheets: [{ id: documentUuid, nativeId: documentUuid, name: textOrNull(nativeDocument.title) ?? 'Active schematic' }],
      components,
      nets,
      diagnostics,
      coverage: { queried, unsupported, unknown },
      fingerprints: {
        document: documentFingerprint,
        connectivity: connectivityFingerprint,
        components: componentsFingerprint,
        capabilities: capabilitiesFingerprint,
      },
      extensions: { easyedaPro: { wires } },
    };

    return {
      snapshot,
      state: {
        document: {
          uuid: documentUuid,
          tabId: nativeDocument.tabId ?? null,
          documentType: nativeDocument.documentType,
          parentProjectUuid: nativeDocument.parentProjectUuid ?? null,
        },
        inspectionFingerprint: documentFingerprint,
        coverage: {
          document: 'ok',
          components: componentsProbe.error ? 'error' : componentsProbe.unsupported ? 'unsupported' : 'ok',
          wires: wiresProbe.error ? 'error' : wiresProbe.unsupported ? 'unsupported' : 'ok',
          nets: netsProbe.error ? 'error' : netsProbe.unsupported ? 'unsupported' : 'ok',
        },
        componentCount: components.length,
        wireCount: wires.length,
        netCount: nets.length,
        components,
        wires,
        nets: netNames,
      },
    };
  }

  const mode = request.mode ?? 'inspect';
  if (mode !== 'inspect') fail('INVALID_MODE', `Unsupported mode: ${mode}`);
  const captured = await captureState();
  return {
    schemaVersion: 2,
    status: captured.snapshot.coverage.unknown.length || captured.snapshot.coverage.unsupported.length ? 'inspected-with-gaps' : 'inspected',
    readOnly: true,
    snapshot: captured.snapshot,
    state: captured.state,
  };
})();
