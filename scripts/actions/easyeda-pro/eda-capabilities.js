return await (async () => {
  const checks = {
    'document.current': ['dmt_SelectControl', 'getCurrentDocumentInfo'],
    'project.current': ['dmt_Project', 'getCurrentProjectInfo'],
    'file.documentSource': ['sys_FileManager', 'getDocumentSource'],
    'file.footprintSources': ['sys_FileManager', 'getDocumentFootprintSources'],
    'layer.list': ['pcb_Layer', 'getAllLayers'],
    'layer.setCopperCount': ['pcb_Layer', 'setTheNumberOfCopperLayers'],
    'layer.modify': ['pcb_Layer', 'modifyLayer'],
    'layer.physicalStack': ['pcb_Layer', 'getCurrentPhysicalStackingConfiguration'],
    'primitive.bbox': ['pcb_Primitive', 'getPrimitivesBBox'],
    'component.list': ['pcb_PrimitiveComponent', 'getAll'],
    'pad.list': ['pcb_PrimitivePad', 'getAll'],
    'line.list': ['pcb_PrimitiveLine', 'getAll'],
    'arc.list': ['pcb_PrimitiveArc', 'getAll'],
    'polyline.list': ['pcb_PrimitivePolyline', 'getAll'],
    'pour.list': ['pcb_PrimitivePour', 'getAll'],
    'pour.create': ['pcb_PrimitivePour', 'create'],
    'pour.delete': ['pcb_PrimitivePour', 'delete'],
    'poured.list': ['pcb_PrimitivePoured', 'getAll'],
    'region.list': ['pcb_PrimitiveRegion', 'getAll'],
    'region.create': ['pcb_PrimitiveRegion', 'create'],
    'region.delete': ['pcb_PrimitiveRegion', 'delete'],
    'via.list': ['pcb_PrimitiveVia', 'getAll'],
    'via.create': ['pcb_PrimitiveVia', 'create'],
    'via.delete': ['pcb_PrimitiveVia', 'delete'],
    'math.polygon.create': ['pcb_MathPolygon', 'createPolygon'],
    'drc.check': ['pcb_Drc', 'check'],
    'drc.netClass.list': ['pcb_Drc', 'getAllNetClasses'],
    'drc.netClass.create': ['pcb_Drc', 'createNetClass'],
    'drc.netClass.addNet': ['pcb_Drc', 'addNetToNetClass'],
    'drc.differentialPair.list': ['pcb_Drc', 'getAllDifferentialPairs'],
    'lib.device.search': ['lib_Device', 'search'],
    'sch.component.list': ['sch_PrimitiveComponent', 'getAll'],
    'sch.component.get': ['sch_PrimitiveComponent', 'get'],
    'sch.component.create': ['sch_PrimitiveComponent', 'create'],
    'sch.component.delete': ['sch_PrimitiveComponent', 'delete'],
    'sch.component.modify': ['sch_PrimitiveComponent', 'modify'],
    'sch.component.createNetFlag': ['sch_PrimitiveComponent', 'createNetFlag'],
    'sch.component.createNetPort': ['sch_PrimitiveComponent', 'createNetPort'],
    'sch.component.getAllPins': ['sch_PrimitiveComponent', 'getAllPinsByPrimitiveId'],
    'sch.wire.list': ['sch_PrimitiveWire', 'getAll'],
    'sch.wire.get': ['sch_PrimitiveWire', 'get'],
    'sch.wire.create': ['sch_PrimitiveWire', 'create'],
    'sch.wire.delete': ['sch_PrimitiveWire', 'delete'],
    'sch.net.list': ['sch_Net', 'getAllNets'],
    'sch.net.listNames': ['sch_Net', 'getAllNetsName'],
    'sch.document.save': ['sch_Document', 'save'],
    'sch.drc.check': ['sch_Drc', 'check'],
  };

  function available(path) {
    let value = eda;
    for (const part of path) value = value?.[part];
    return typeof value === 'function';
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  function hashText(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return 'fnv1a32-' + hash.toString(16).padStart(8, '0');
  }

  async function optionalCall(path) {
    if (!available(path)) return { value: null, error: null };
    let target = eda;
    for (const part of path.slice(0, -1)) target = target[part];
    try {
      return { value: await target[path.at(-1)](), error: null };
    } catch (error) {
      return { value: null, error: error.message };
    }
  }

  const capabilities = {};
  for (const [name, path] of Object.entries(checks)) capabilities[name] = available(path);

  const documentRead = await optionalCall(checks['document.current']);
  const projectRead = await optionalCall(checks['project.current']);
  const document = documentRead.value
    ? {
      uuid: documentRead.value.uuid ?? null,
      tabId: documentRead.value.tabId ?? null,
      documentType: documentRead.value.documentType ?? null,
      parentProjectUuid: documentRead.value.parentProjectUuid ?? null,
    }
    : null;
  const project = projectRead.value
    ? {
      uuid: projectRead.value.uuid ?? null,
      name: projectRead.value.name ?? null,
      friendlyName: projectRead.value.friendlyName ?? null,
    }
    : null;
  const capabilityFingerprint = hashText(stableStringify(capabilities));

  return {
    schemaVersion: 1,
    status: documentRead.error || !capabilities['document.current'] ? 'inspected-with-gaps' : 'inspected',
    readOnly: true,
    document,
    project,
    capabilityFingerprint,
    capabilities,
    availableCount: Object.values(capabilities).filter(Boolean).length,
    missing: Object.entries(capabilities).filter(([, present]) => !present).map(([name]) => name),
    errors: [
      ...(documentRead.error ? [{ code: 'DOCUMENT_PROBE_FAILED', message: documentRead.error }] : []),
      ...(projectRead.error ? [{ code: 'PROJECT_PROBE_FAILED', message: projectRead.error }] : []),
    ],
    note: 'Feature presence is preflight evidence only; each mutating action still requires live readback verification.',
  };
})();
