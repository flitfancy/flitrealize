return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? {} : flitrealizeInput;
  const KEEP_OUT_RULES = new Set([5, 6, 7, 8]);

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

  function clone(value) {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
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

  async function query(label, target, method = 'getAll', args = []) {
    if (typeof target?.[method] !== 'function') {
      return { label, status: 'unsupported', items: [], error: `${method} is unavailable` };
    }
    try {
      const result = await target[method](...args);
      return {
        label,
        status: Array.isArray(result) ? 'ok' : 'unexpected-result',
        items: Array.isArray(result) ? result : [],
        error: Array.isArray(result) ? null : `${method} did not return an array`,
      };
    } catch (error) {
      return { label, status: 'error', items: [], error: error.message };
    }
  }

  async function readSource(label, method) {
    if (typeof eda?.sys_FileManager?.[method] !== 'function') {
      return { label, status: 'unsupported', value: null, error: `${method} is unavailable` };
    }
    try {
      const value = await eda.sys_FileManager[method]();
      return { label, status: value === undefined ? 'empty' : 'ok', value, error: null };
    } catch (error) {
      return { label, status: 'error', value: null, error: error.message };
    }
  }

  function polygonSource(primitive) {
    const polygon = callGetter(primitive, 'getState_ComplexPolygon');
    return clone(callGetter(polygon, 'getSource'));
  }

  function summarizePour(pour) {
    return {
      primitiveId: callGetter(pour, 'getState_PrimitiveId'),
      net: callGetter(pour, 'getState_Net', ''),
      layer: callGetter(pour, 'getState_Layer'),
      name: callGetter(pour, 'getState_PourName'),
      fillMethod: clone(callGetter(pour, 'getState_PourFillMethod')),
      preserveIslands: callGetter(pour, 'getState_PreserveSilos'),
      priority: finiteOrNull(callGetter(pour, 'getState_PourPriority')),
      lineWidth: finiteOrNull(callGetter(pour, 'getState_LineWidth')),
      polygonSource: polygonSource(pour),
    };
  }

  function summarizeRegion(region) {
    const rules = callGetter(region, 'getState_RuleType', []);
    const normalizedRules = Array.isArray(rules)
      ? rules.map(Number).filter(Number.isFinite).sort((left, right) => left - right)
      : [];
    return {
      primitiveId: callGetter(region, 'getState_PrimitiveId'),
      layer: callGetter(region, 'getState_Layer'),
      name: callGetter(region, 'getState_RegionName'),
      ruleTypes: normalizedRules,
      blocksViaPlanning: normalizedRules.some((rule) => KEEP_OUT_RULES.has(rule)),
      lineWidth: finiteOrNull(callGetter(region, 'getState_LineWidth')),
      polygonSource: polygonSource(region),
    };
  }

  function summarizeVia(via) {
    return {
      primitiveId: callGetter(via, 'getState_PrimitiveId'),
      net: callGetter(via, 'getState_Net', ''),
      x: finiteOrNull(callGetter(via, 'getState_X')),
      y: finiteOrNull(callGetter(via, 'getState_Y')),
      holeDiameter: finiteOrNull(callGetter(via, 'getState_HoleDiameter')),
      diameter: finiteOrNull(callGetter(via, 'getState_Diameter')),
      viaType: clone(callGetter(via, 'getState_ViaType')),
      locked: callGetter(via, 'getState_PrimitiveLock'),
    };
  }

  function summarizeComponent(component) {
    const footprint = clone(callGetter(component, 'getState_Footprint'));
    const pads = callGetter(component, 'getState_Pads', []);
    return {
      primitiveId: callGetter(component, 'getState_PrimitiveId'),
      designator: callGetter(component, 'getState_Designator'),
      name: callGetter(component, 'getState_Name'),
      footprint,
      layer: callGetter(component, 'getState_Layer'),
      x: finiteOrNull(callGetter(component, 'getState_X')),
      y: finiteOrNull(callGetter(component, 'getState_Y')),
      rotation: finiteOrNull(callGetter(component, 'getState_Rotation')),
      pads: Array.isArray(pads)
        ? pads.map((pad) => ({ primitiveId: pad.primitiveId ?? null, padNumber: pad.padNumber ?? null, net: pad.net ?? '' }))
        : [],
    };
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
        // Source is a best-effort secondary scope check. Unparseable lines are counted separately.
      }
    }
    return records;
  }

  function sourceRuleTypes(data) {
    const candidate = data?.ruleTypes ?? data?.ruleType ?? data?.rules ?? [];
    const values = Array.isArray(candidate) ? candidate : [candidate];
    return values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  }

  function isDisplayConfiguration(record) {
    return record.type === 'PRIMITIVE' && /PROHIBITEDREGION|KEEP[_ -]?OUT/i.test(String(record.id));
  }

  function isActualKeepoutRecord(record) {
    if (isDisplayConfiguration(record)) return false;
    const rules = sourceRuleTypes(record.data);
    if (record.type === 'REGION' && rules.some((rule) => KEEP_OUT_RULES.has(rule))) return true;
    return /PROHIBITEDREGION|KEEP[_ -]?OUT/i.test(record.type);
  }

  function summarizeSource(label, source) {
    const records = parseSourceRecords(source);
    const ignoredFingerprintTypes = new Set(['DOCHEAD', 'CANVAS', 'ACTIVE_LAYER', 'PRIMITIVE', 'SILK_OPTS', 'PREFERENCE', 'PANELIZE']);
    const relevantRecords = records
      .filter((record) => !ignoredFingerprintTypes.has(record.type))
      .map((record) => ({ type: record.type, id: record.id, data: record.data }));
    const actual = records.filter(isActualKeepoutRecord).map((record) => ({
      type: record.type,
      id: record.id,
      ruleTypes: sourceRuleTypes(record.data),
      dataFingerprint: hashText(stableStringify(record.data)),
    }));
    const displayConfigurationCount = records.filter(isDisplayConfiguration).length;
    const rawTokenCount = typeof source === 'string'
      ? (source.match(/PROHIBITEDREGION|KEEP[_ -]?OUT/gi) ?? []).length
      : 0;
    return {
      label,
      length: typeof source === 'string' ? source.length : 0,
      parsedRecordCount: records.length,
      relevantFingerprint: hashText(stableStringify(relevantRecords)),
      actualKeepoutRecords: actual,
      displayConfigurationCount,
      rawTokenCount,
      tokenOnlyCount: Math.max(0, rawTokenCount - displayConfigurationCount - actual.length),
    };
  }

  function groupPours(pours) {
    const groups = new Map();
    for (const pour of pours) {
      const key = pour.net || '(unassigned)';
      if (!groups.has(key)) groups.set(key, { net: key, count: 0, layers: new Set() });
      const group = groups.get(key);
      group.count += 1;
      group.layers.add(pour.layer);
    }
    return [...groups.values()]
      .map((group) => ({ net: group.net, count: group.count, layers: [...group.layers].sort((a, b) => Number(a) - Number(b)) }))
      .sort((left, right) => left.net.localeCompare(right.net));
  }

  function nearestVia(component, vias) {
    if (component.x === null || component.y === null || vias.length === 0) return null;
    let nearest = null;
    for (const via of vias) {
      if (via.x === null || via.y === null) continue;
      const distance = Math.hypot(component.x - via.x, component.y - via.y);
      if (!nearest || distance < nearest.distance) nearest = { primitiveId: via.primitiveId, distance };
    }
    return nearest;
  }

  const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (!document || document.documentType !== 3) fail('PCB_DOCUMENT_REQUIRED', 'The active EasyEDA document is not a PCB.');
  if (request.expectedDocumentUuid && document.uuid !== request.expectedDocumentUuid) {
    fail('DOCUMENT_MISMATCH', `Expected PCB ${request.expectedDocumentUuid}, got ${document.uuid}.`);
  }
  const project = typeof eda?.dmt_Project?.getCurrentProjectInfo === 'function'
    ? await eda.dmt_Project.getCurrentProjectInfo()
    : null;

  const [pourQuery, regionQuery, viaQuery, componentQuery, documentSourceQuery, footprintSourceQuery] = await Promise.all([
    query('pours', eda.pcb_PrimitivePour),
    query('regions', eda.pcb_PrimitiveRegion),
    query('vias', eda.pcb_PrimitiveVia),
    query('components', eda.pcb_PrimitiveComponent),
    readSource('documentSource', 'getDocumentSource'),
    readSource('footprintSources', 'getDocumentFootprintSources'),
  ]);

  const pours = pourQuery.items.map(summarizePour).sort((left, right) => String(left.primitiveId).localeCompare(String(right.primitiveId)));
  const regions = regionQuery.items.map(summarizeRegion).sort((left, right) => String(left.primitiveId).localeCompare(String(right.primitiveId)));
  const vias = viaQuery.items.map(summarizeVia).sort((left, right) => String(left.primitiveId).localeCompare(String(right.primitiveId)));
  const components = componentQuery.items.map(summarizeComponent).sort((left, right) => String(left.designator).localeCompare(String(right.designator)));

  const documentSource = summarizeSource('document', documentSourceQuery.value);
  const rawFootprintSources = Array.isArray(footprintSourceQuery.value) ? footprintSourceQuery.value : [];
  const footprintSources = rawFootprintSources.map((item) => ({
    footprintUuid: item.footprintUuid ?? null,
    ...summarizeSource(`footprint:${item.footprintUuid ?? 'unknown'}`, item.documentSource),
  }));
  const footprintKeepoutUuids = new Set(
    footprintSources.filter((item) => item.actualKeepoutRecords.length > 0).map((item) => item.footprintUuid),
  );
  const componentsWithFootprintKeepouts = components
    .filter((component) => footprintKeepoutUuids.has(component.footprint?.uuid))
    .map((component) => ({
      primitiveId: component.primitiveId,
      designator: component.designator,
      footprintUuid: component.footprint?.uuid ?? null,
      x: component.x,
      y: component.y,
      rotation: component.rotation,
      layer: component.layer,
    }));

  const groundNets = Array.isArray(request.groundNets) && request.groundNets.length > 0
    ? [...new Set(request.groundNets.map((net) => String(net).trim()).filter(Boolean))]
    : ['GND'];
  const groundNetSet = new Set(groundNets);
  const groundVias = vias.filter((via) => groundNetSet.has(via.net));
  const criticalDesignators = Array.isArray(request.criticalDesignators)
    ? new Set(request.criticalDesignators.map(String))
    : new Set();
  const componentGrounding = components
    .filter((component) => criticalDesignators.has(component.designator))
    .map((component) => ({
      primitiveId: component.primitiveId,
      designator: component.designator,
      footprint: component.footprint,
      layer: component.layer,
      x: component.x,
      y: component.y,
      rotation: component.rotation,
      pads: component.pads,
      groundPadCount: component.pads.filter((pad) => groundNetSet.has(pad.net)).length,
      nearestGroundVia: nearestVia(component, groundVias),
    }));

  const fingerprintPayload = {
    documentUuid: document.uuid,
    pours: pours.map(({ primitiveId, net, layer }) => ({ primitiveId, net, layer })),
    regions: regions.map(({ primitiveId, layer, ruleTypes, polygonSource }) => ({ primitiveId, layer, ruleTypes, polygonSource })),
    vias: vias.map(({ primitiveId, net, x, y, holeDiameter, diameter, viaType }) => ({ primitiveId, net, x, y, holeDiameter, diameter, viaType })),
    components: components.map(({ primitiveId, designator, footprint, layer, x, y, rotation, pads }) => ({
      primitiveId,
      designator,
      footprint,
      layer,
      x,
      y,
      rotation,
      pads,
    })),
    sourceKeepouts: {
      document: {
        relevantFingerprint: documentSource.relevantFingerprint,
        actualKeepoutRecords: documentSource.actualKeepoutRecords,
      },
      footprints: footprintSources.map((item) => ({
        footprintUuid: item.footprintUuid,
        relevantFingerprint: item.relevantFingerprint,
        actualKeepoutRecords: item.actualKeepoutRecords,
      })),
    },
  };
  const inspectionFingerprint = hashText(stableStringify(fingerprintPayload));
  const coverageEntries = [pourQuery, regionQuery, viaQuery, componentQuery, documentSourceQuery, footprintSourceQuery]
    .map(({ label, status, error }) => ({ label, status, error }));
  const completeCoverage = coverageEntries.every((entry) => entry.status === 'ok');
  const apiBlockingRegionIds = new Set(
    regions.filter((region) => region.blocksViaPlanning).map((region) => String(region.primitiveId)),
  );
  const unresolvedDocumentKeepouts = documentSource.actualKeepoutRecords.filter(
    (record) => record.id === null || !apiBlockingRegionIds.has(String(record.id)),
  );
  const unresolvedKeepoutGeometry = unresolvedDocumentKeepouts.length > 0 || componentsWithFootprintKeepouts.length > 0;
  const detailLevel = request.detailLevel === 'full' ? 'full' : 'summary';
  const reportedFootprintSources = detailLevel === 'full'
    ? footprintSources
    : footprintSources.filter((item) => item.actualKeepoutRecords.length > 0 || item.rawTokenCount > 0);

  return {
    schemaVersion: 1,
    status: completeCoverage ? 'inspected' : 'inspected-with-gaps',
    readOnly: true,
    capturedAt: new Date().toISOString(),
    project: project ? { uuid: project.uuid, name: project.name, friendlyName: project.friendlyName } : null,
    document: {
      uuid: document.uuid,
      tabId: document.tabId,
      documentType: document.documentType,
      parentProjectUuid: document.parentProjectUuid ?? null,
    },
    inspectionFingerprint,
    detailLevel,
    coverage: {
      complete: completeCoverage,
      entries: coverageEntries,
      sourceScopeNote: 'Document and footprint source scans distinguish instantiated keepout records from display configuration tokens.',
    },
    pours: { count: pours.length, byNet: groupPours(pours), ...(detailLevel === 'full' ? { items: pours } : {}) },
    keepouts: {
      apiRegionCount: regions.length,
      viaBlockingApiRegionCount: regions.filter((region) => region.blocksViaPlanning).length,
      regions: detailLevel === 'full' ? regions : regions.filter((region) => region.blocksViaPlanning),
      documentSource,
      unresolvedDocumentKeepouts,
      footprintSources: reportedFootprintSources,
      componentsWithFootprintKeepouts,
      unresolvedGeometry: unresolvedKeepoutGeometry,
    },
    grounding: {
      groundNets,
      viaCount: vias.length,
      groundViaCount: groundVias.length,
      ...(detailLevel === 'full' ? { groundVias } : {}),
      componentGrounding,
    },
  };
})();
