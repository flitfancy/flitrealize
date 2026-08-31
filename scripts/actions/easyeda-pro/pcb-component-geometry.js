return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { designators: [] } : flitrealizeInput;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function getter(object, name, fallback = null) {
    try {
      return typeof object?.[name] === 'function' ? object[name]() : fallback;
    } catch {
      return fallback;
    }
  }

  function clone(value) {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }

  function parseSourceRecords(source) {
    if (typeof source !== 'string' || !source) return [];
    const records = [];
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.endsWith('|') ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      const separator = line.indexOf('||');
      const headText = separator >= 0 ? line.slice(0, separator) : line;
      const dataText = separator >= 0 ? line.slice(separator + 2) : '';
      try {
        const head = JSON.parse(headText);
        const data = dataText ? JSON.parse(dataText) : null;
        records.push({ type: String(head?.type ?? ''), id: head?.id ?? null, data });
      } catch {
        // Raw source is secondary evidence; malformed records are reported by count below.
      }
    }
    return records;
  }

  async function bboxWithTimeout(primitiveId) {
    if (typeof eda?.pcb_Primitive?.getPrimitivesBBox !== 'function') return { status: 'unsupported', value: null };
    let timeoutId;
    try {
      const value = await Promise.race([
        eda.pcb_Primitive.getPrimitivesBBox([primitiveId]),
        new Promise((resolve) => { timeoutId = setTimeout(() => resolve('__timeout__'), 2000); }),
      ]);
      if (value === '__timeout__') return { status: 'timeout', value: null };
      return { status: value ? 'ok' : 'empty', value: clone(value) };
    } catch (error) {
      return { status: 'error', value: null, error: error.message };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (!document || Number(document.documentType) !== 3) fail('PCB_DOCUMENT_REQUIRED', 'The active EasyEDA document is not a PCB.');
  if (request.expectedDocumentUuid && document.uuid !== request.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', `Expected ${request.expectedDocumentUuid}, got ${document.uuid}.`);
  const requested = [...new Set((Array.isArray(request.designators) ? request.designators : []).map(String).filter(Boolean))];
  if (requested.length === 0) fail('DESIGNATORS_REQUIRED', 'At least one component designator is required.');

  const [allComponents, allPads, footprintSources, documentSource] = await Promise.all([
    eda.pcb_PrimitiveComponent.getAll(),
    eda.pcb_PrimitivePad.getAll(),
    eda.sys_FileManager.getDocumentFootprintSources(),
    eda.sys_FileManager.getDocumentSource(),
  ]);
  const documentRecords = parseSourceRecords(documentSource);
  const components = (Array.isArray(allComponents) ? allComponents : [])
    .filter((item) => requested.includes(String(getter(item, 'getState_Designator', ''))));
  const found = new Set(components.map((item) => String(getter(item, 'getState_Designator', ''))));
  const missing = requested.filter((item) => !found.has(item));
  if (missing.length > 0) fail('COMPONENT_NOT_FOUND', `Missing component(s): ${missing.join(', ')}`);

  const sourceByUuid = new Map((Array.isArray(footprintSources) ? footprintSources : []).map((item) => [item.footprintUuid, item.documentSource]));
  const results = [];
  for (const component of components) {
    const footprint = clone(getter(component, 'getState_Footprint'));
    const source = sourceByUuid.get(footprint?.uuid) ?? null;
    const records = parseSourceRecords(source);
    const typeCounts = {};
    for (const record of records) typeCounts[record.type] = (typeCounts[record.type] ?? 0) + 1;
    const geometryRecords = records.filter((record) => (
      /PAD|HOLE|SLOT|REGION|LINE|ARC|POLY|FILL|CIRCLE|KEEPOUT|PROHIBITED/i.test(record.type)
      && record.type !== 'PRIMITIVE'
    ));
    const primitiveId = getter(component, 'getState_PrimitiveId');
    const componentRecords = documentRecords.filter((record) => String(record.id ?? '').startsWith(String(primitiveId)));
    const bbox = await bboxWithTimeout(primitiveId);
    const bounds = bbox.value;
    const nearbyPads = (Array.isArray(allPads) ? allPads : [])
      .map((pad) => ({
        primitiveId: getter(pad, 'getState_PrimitiveId'),
        padNumber: getter(pad, 'getState_PadNumber'),
        net: getter(pad, 'getState_Net', ''),
        layer: getter(pad, 'getState_Layer'),
        x: Number(getter(pad, 'getState_X')),
        y: Number(getter(pad, 'getState_Y')),
        rotation: Number(getter(pad, 'getState_Rotation', 0)),
        pad: clone(getter(pad, 'getState_Pad')),
        hole: clone(getter(pad, 'getState_Hole')),
        holeOffsetX: Number(getter(pad, 'getState_HoleOffsetX', 0)),
        holeOffsetY: Number(getter(pad, 'getState_HoleOffsetY', 0)),
        holeRotation: Number(getter(pad, 'getState_HoleRotation', 0)),
        metallization: Boolean(getter(pad, 'getState_Metallization', false)),
      }))
      .filter((pad) => bounds
        && pad.x >= bounds.minX - 1 && pad.x <= bounds.maxX + 1
        && pad.y >= bounds.minY - 1 && pad.y <= bounds.maxY + 1);
    results.push({
      primitiveId,
      designator: getter(component, 'getState_Designator'),
      footprint,
      layer: getter(component, 'getState_Layer'),
      x: getter(component, 'getState_X'),
      y: getter(component, 'getState_Y'),
      rotation: getter(component, 'getState_Rotation'),
      pads: clone(getter(component, 'getState_Pads', [])),
      bbox,
      nearbyPads,
      documentRecords: componentRecords,
      footprintSource: {
        available: typeof source === 'string',
        length: typeof source === 'string' ? source.length : 0,
        parsedRecordCount: records.length,
        typeCounts,
        geometryRecords,
        ...(request.includeRawSource === true ? { raw: source } : {}),
      },
    });
  }

  return {
    schemaVersion: 1,
    status: 'inspected',
    readOnly: true,
    capturedAt: new Date().toISOString(),
    document: {
      uuid: document.uuid,
      tabId: document.tabId,
      documentType: document.documentType,
      parentProjectUuid: document.parentProjectUuid ?? null,
    },
    footprintSourceCatalog: (Array.isArray(footprintSources) ? footprintSources : []).map((item) => ({
      keys: Object.keys(item ?? {}),
      footprintUuid: item?.footprintUuid ?? null,
      sourceLength: typeof item?.documentSource === 'string' ? item.documentSource.length : 0,
    })),
    components: results.sort((left, right) => String(left.designator).localeCompare(String(right.designator))),
  };
})();
