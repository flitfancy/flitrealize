return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;
  const KEEP_OUT_RULES = new Set([5, 6, 7, 8]);
  const MAX_VIAS_PER_APPLY = 200;

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

  async function query(label, target, method = 'getAll') {
    if (typeof target?.[method] !== 'function') {
      return { label, status: 'unsupported', items: [], error: `${method} is unavailable` };
    }
    try {
      const result = await target[method]();
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
    };
  }

  function summarizeRegion(region) {
    const rules = callGetter(region, 'getState_RuleType', []);
    const ruleTypes = Array.isArray(rules)
      ? rules.map(Number).filter(Number.isFinite).sort((left, right) => left - right)
      : [];
    return {
      primitiveId: callGetter(region, 'getState_PrimitiveId'),
      layer: callGetter(region, 'getState_Layer'),
      ruleTypes,
      blocksViaPlanning: ruleTypes.some((rule) => KEEP_OUT_RULES.has(rule)),
      polygonSource: polygonSource(region),
      primitive: region,
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
    };
  }

  function summarizeComponent(component) {
    const pads = callGetter(component, 'getState_Pads', []);
    return {
      primitiveId: callGetter(component, 'getState_PrimitiveId'),
      designator: callGetter(component, 'getState_Designator'),
      footprint: clone(callGetter(component, 'getState_Footprint')),
      layer: callGetter(component, 'getState_Layer'),
      x: finiteOrNull(callGetter(component, 'getState_X')),
      y: finiteOrNull(callGetter(component, 'getState_Y')),
      rotation: finiteOrNull(callGetter(component, 'getState_Rotation')),
      pads: Array.isArray(pads)
        ? pads.map((pad) => ({ primitiveId: pad.primitiveId ?? null, padNumber: pad.padNumber ?? null, net: pad.net ?? '' }))
        : [],
      primitive: component,
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
        // Secondary source scope is reported as coverage, never silently used as proof.
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

  function summarizeSource(source) {
    const records = parseSourceRecords(source);
    const ignoredFingerprintTypes = new Set(['DOCHEAD', 'CANVAS', 'ACTIVE_LAYER', 'PRIMITIVE', 'SILK_OPTS', 'PREFERENCE', 'PANELIZE']);
    const relevantRecords = records
      .filter((record) => !ignoredFingerprintTypes.has(record.type))
      .map((record) => ({ type: record.type, id: record.id, data: record.data }));
    const actualKeepoutRecords = records.filter(isActualKeepoutRecord).map((record) => ({
      type: record.type,
      id: record.id,
      ruleTypes: sourceRuleTypes(record.data),
      dataFingerprint: hashText(stableStringify(record.data)),
    }));
    return {
      relevantFingerprint: hashText(stableStringify(relevantRecords)),
      actualKeepoutRecords,
    };
  }

  function publicRegion(region) {
    const { primitive, ...summary } = region;
    return summary;
  }

  async function captureState() {
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if (!document || document.documentType !== 3) fail('PCB_DOCUMENT_REQUIRED', 'The active EasyEDA document is not a PCB.');
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
    const documentSource = summarizeSource(documentSourceQuery.value);
    const documentKeepouts = documentSource.actualKeepoutRecords;
    const rawFootprintSources = Array.isArray(footprintSourceQuery.value) ? footprintSourceQuery.value : [];
    const footprintKeepouts = rawFootprintSources.map((item) => {
      const source = summarizeSource(item.documentSource);
      return {
        footprintUuid: item.footprintUuid ?? null,
        relevantFingerprint: source.relevantFingerprint,
        actualKeepoutRecords: source.actualKeepoutRecords,
      };
    });
    const coverageEntries = [pourQuery, regionQuery, viaQuery, componentQuery, documentSourceQuery, footprintSourceQuery]
      .map(({ label, status, error }) => ({ label, status, error }));
    const coverageComplete = coverageEntries.every((entry) => entry.status === 'ok');
    const fingerprintPayload = {
      documentUuid: document.uuid,
      pours,
      regions: regions.map(({ primitiveId, layer, ruleTypes, polygonSource }) => ({ primitiveId, layer, ruleTypes, polygonSource })),
      vias,
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
          actualKeepoutRecords: documentKeepouts,
        },
        footprints: footprintKeepouts,
      },
    };
    return {
      document: {
        uuid: document.uuid,
        tabId: document.tabId,
        documentType: document.documentType,
        parentProjectUuid: document.parentProjectUuid ?? null,
      },
      pours,
      regions,
      vias,
      components,
      documentKeepouts,
      footprintKeepouts,
      coverage: { complete: coverageComplete, entries: coverageEntries },
      inspectionFingerprint: hashText(stableStringify(fingerprintPayload)),
    };
  }

  function positiveNumber(value, path) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) fail('INVALID_GROUND_VIA_PLAN', `${path} must be a positive number.`);
    return number;
  }

  function nonNegativeNumber(value, path, fallback = 0) {
    if (value === undefined) return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) fail('INVALID_GROUND_VIA_PLAN', `${path} must be a non-negative number.`);
    return number;
  }

  function normalizePlan(rawPlan) {
    if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) fail('INVALID_GROUND_VIA_PLAN', 'plan must be an object.');
    if (rawPlan.schemaVersion !== 1) fail('INVALID_GROUND_VIA_PLAN', 'plan.schemaVersion must be 1.');
    if (typeof rawPlan.expectedDocumentUuid !== 'string' || !rawPlan.expectedDocumentUuid) {
      fail('INVALID_GROUND_VIA_PLAN', 'plan.expectedDocumentUuid is required.');
    }
    if (typeof rawPlan.expectedInspectionFingerprint !== 'string' || !rawPlan.expectedInspectionFingerprint) {
      fail('INVALID_GROUND_VIA_PLAN', 'plan.expectedInspectionFingerprint is required from the inspection action.');
    }
    if (typeof rawPlan.net !== 'string' || !rawPlan.net.trim()) fail('INVALID_GROUND_VIA_PLAN', 'plan.net is required.');
    if (!Array.isArray(rawPlan.vias) || rawPlan.vias.length === 0) fail('INVALID_GROUND_VIA_PLAN', 'plan.vias must contain at least one candidate.');
    if (rawPlan.vias.length > MAX_VIAS_PER_APPLY) {
      fail('GROUND_VIA_BOUND_EXCEEDED', `A single apply is limited to ${MAX_VIAS_PER_APPLY} vias.`);
    }
    const keys = new Set();
    const vias = rawPlan.vias.map((rawVia, index) => {
      const key = typeof rawVia?.key === 'string' && rawVia.key.trim() ? rawVia.key.trim() : `via-${index + 1}`;
      if (keys.has(key)) fail('INVALID_GROUND_VIA_PLAN', `Duplicate via key: ${key}`);
      keys.add(key);
      const x = Number(rawVia?.x);
      const y = Number(rawVia?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) fail('INVALID_GROUND_VIA_PLAN', `Via ${key} requires finite x and y.`);
      const holeDiameter = positiveNumber(rawVia?.holeDiameter, `vias[${index}].holeDiameter`);
      const diameter = positiveNumber(rawVia?.diameter, `vias[${index}].diameter`);
      if (diameter <= holeDiameter) fail('INVALID_GROUND_VIA_PLAN', `Via ${key} diameter must exceed holeDiameter.`);
      return {
        key,
        x,
        y,
        holeDiameter,
        diameter,
        viaType: rawVia.viaType ?? null,
        designRuleBlindViaName: rawVia.designRuleBlindViaName ?? null,
        solderMaskExpansion: clone(rawVia.solderMaskExpansion),
        primitiveLock: Boolean(rawVia.primitiveLock),
        strategy: typeof rawVia.strategy === 'string' && rawVia.strategy.trim() ? rawVia.strategy.trim() : null,
        score: rawVia.score !== null && rawVia.score !== undefined && Number.isFinite(Number(rawVia.score))
          ? Number(rawVia.score)
          : null,
        anchor: rawVia.anchor === undefined ? null : clone(rawVia.anchor),
        rationale: typeof rawVia.rationale === 'string' ? rawVia.rationale : null,
      };
    });
    return {
      schemaVersion: 1,
      expectedDocumentUuid: rawPlan.expectedDocumentUuid,
      expectedInspectionFingerprint: rawPlan.expectedInspectionFingerprint,
      net: rawPlan.net.trim(),
      clearance: nonNegativeNumber(rawPlan.clearance, 'plan.clearance'),
      minimumCenterSpacing: nonNegativeNumber(rawPlan.minimumCenterSpacing, 'plan.minimumCenterSpacing'),
      boardContainmentConfirmed: rawPlan.boardContainmentConfirmed === true,
      boardContainmentEvidence: typeof rawPlan.boardContainmentEvidence === 'string' ? rawPlan.boardContainmentEvidence : null,
      localClearanceConfirmed: rawPlan.localClearanceConfirmed === true,
      localClearanceEvidence: typeof rawPlan.localClearanceEvidence === 'string' ? rawPlan.localClearanceEvidence : null,
      vias,
    };
  }

  function normalizeGenerationRequest(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_GROUND_VIA_GENERATION', 'generation must be an object.');
    if (raw.schemaVersion !== 1) fail('INVALID_GROUND_VIA_GENERATION', 'generation.schemaVersion must be 1.');
    if (typeof raw.expectedDocumentUuid !== 'string' || !raw.expectedDocumentUuid) {
      fail('INVALID_GROUND_VIA_GENERATION', 'generation.expectedDocumentUuid is required.');
    }
    if (typeof raw.expectedInspectionFingerprint !== 'string' || !raw.expectedInspectionFingerprint) {
      fail('INVALID_GROUND_VIA_GENERATION', 'generation.expectedInspectionFingerprint is required.');
    }
    if (typeof raw.net !== 'string' || !raw.net.trim()) fail('INVALID_GROUND_VIA_GENERATION', 'generation.net is required.');
    if (!Array.isArray(raw.targets) || raw.targets.length === 0) fail('INVALID_GROUND_VIA_GENERATION', 'generation.targets is required.');
    const allowedDirections = new Set(['left', 'right', 'up', 'down']);
    const normalizeDirections = (value, path) => {
      const directions = Array.isArray(value) && value.length > 0 ? value.map(String) : ['right', 'left', 'down', 'up'];
      if (directions.some((direction) => !allowedDirections.has(direction))) {
        fail('INVALID_GROUND_VIA_GENERATION', `${path} contains an unsupported direction.`);
      }
      return [...new Set(directions)];
    };
    const defaultDirections = normalizeDirections(raw.directions, 'generation.directions');
    const targets = raw.targets.map((target, index) => {
      if (typeof target?.designator !== 'string' || !target.designator.trim()) {
        fail('INVALID_GROUND_VIA_GENERATION', `targets[${index}].designator is required.`);
      }
      const countPerPad = target.countPerPad === undefined ? 1 : Number(target.countPerPad);
      if (!Number.isInteger(countPerPad) || countPerPad < 1 || countPerPad > 4) {
        fail('INVALID_GROUND_VIA_GENERATION', `targets[${index}].countPerPad must be an integer from 1 through 4.`);
      }
      return {
        designator: target.designator.trim(),
        padNumbers: Array.isArray(target.padNumbers) ? [...new Set(target.padNumbers.map(String))] : [],
        countPerPad,
        directions: target.directions ? normalizeDirections(target.directions, `targets[${index}].directions`) : defaultDirections,
      };
    });
    const fallbackPadRadius = raw.fallbackPadRadius === undefined
      ? null
      : positiveNumber(raw.fallbackPadRadius, 'generation.fallbackPadRadius');
    return {
      schemaVersion: 1,
      expectedDocumentUuid: raw.expectedDocumentUuid,
      expectedInspectionFingerprint: raw.expectedInspectionFingerprint,
      net: raw.net.trim(),
      via: {
        holeDiameter: positiveNumber(raw.via?.holeDiameter, 'generation.via.holeDiameter'),
        diameter: positiveNumber(raw.via?.diameter, 'generation.via.diameter'),
        viaType: raw.via?.viaType ?? null,
        designRuleBlindViaName: raw.via?.designRuleBlindViaName ?? null,
        solderMaskExpansion: clone(raw.via?.solderMaskExpansion),
        primitiveLock: Boolean(raw.via?.primitiveLock),
      },
      targets,
      padGap: nonNegativeNumber(raw.padGap, 'generation.padGap', 10),
      fallbackPadRadius,
      clearance: nonNegativeNumber(raw.clearance, 'generation.clearance'),
      minimumCenterSpacing: nonNegativeNumber(raw.minimumCenterSpacing, 'generation.minimumCenterSpacing'),
      boardContainmentConfirmed: raw.boardContainmentConfirmed === true,
      boardContainmentEvidence: typeof raw.boardContainmentEvidence === 'string' ? raw.boardContainmentEvidence : null,
      localClearanceConfirmed: raw.localClearanceConfirmed === true,
      localClearanceEvidence: typeof raw.localClearanceEvidence === 'string' ? raw.localClearanceEvidence : null,
      detailLevel: raw.detailLevel === 'full' ? 'full' : 'summary',
    };
  }

  function padHalfExtent(pad, fallback) {
    const shape = callGetter(pad, 'getState_Pad');
    if (!Array.isArray(shape) || shape.length < 2) return fallback;
    const type = String(shape[0]).toUpperCase();
    if (['ELLIPSE', 'OBLONG', 'RECT', 'RECTANGLE'].includes(type)) {
      const width = Number(shape[1]);
      const height = Number(shape[2]);
      if (Number.isFinite(width) && Number.isFinite(height)) return Math.max(width, height) / 2;
    }
    if (type === 'REGULAR_POLYGON') {
      const diameter = Number(shape[1]);
      if (Number.isFinite(diameter)) return diameter / 2;
    }
    return fallback;
  }

  async function componentPins(component) {
    if (typeof component.primitive?.getAllPins === 'function') return component.primitive.getAllPins();
    if (typeof eda?.pcb_PrimitiveComponent?.getAllPinsByPrimitiveId === 'function') {
      return eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(component.primitiveId);
    }
    return undefined;
  }

  function directionOffset(direction, distance) {
    if (direction === 'left') return { x: -distance, y: 0 };
    if (direction === 'right') return { x: distance, y: 0 };
    if (direction === 'up') return { x: 0, y: -distance };
    return { x: 0, y: distance };
  }

  function safeKeyPart(value) {
    return String(value).replace(/[^A-Za-z0-9_.-]+/g, '_');
  }

  async function generatePlan(state, generation) {
    const issues = [];
    if (state.document.uuid !== generation.expectedDocumentUuid) {
      issues.push({ code: 'DOCUMENT_MISMATCH', expected: generation.expectedDocumentUuid, actual: state.document.uuid });
    }
    if (state.inspectionFingerprint !== generation.expectedInspectionFingerprint) {
      issues.push({ code: 'STALE_INSPECTION', expected: generation.expectedInspectionFingerprint, actual: state.inspectionFingerprint });
    }
    if (generation.via.diameter <= generation.via.holeDiameter) {
      issues.push({ code: 'INVALID_VIA_GEOMETRY', message: 'Via diameter must exceed hole diameter.' });
    }

    const proposals = [];
    const groups = [];
    for (const target of generation.targets) {
      const matches = state.components.filter((component) => component.designator === target.designator);
      if (matches.length !== 1) {
        issues.push({ code: matches.length === 0 ? 'TARGET_COMPONENT_NOT_FOUND' : 'TARGET_COMPONENT_NOT_UNIQUE', designator: target.designator, count: matches.length });
        continue;
      }
      const component = matches[0];
      let pins;
      try {
        pins = await componentPins(component);
      } catch (error) {
        issues.push({ code: 'TARGET_PINS_QUERY_FAILED', designator: target.designator, message: error.message });
        continue;
      }
      if (!Array.isArray(pins)) {
        issues.push({ code: 'TARGET_PINS_UNAVAILABLE', designator: target.designator });
        continue;
      }
      const padNumberSet = new Set(target.padNumbers);
      const groundPads = pins.filter((pad) => {
        const net = callGetter(pad, 'getState_Net', '');
        const padNumber = String(callGetter(pad, 'getState_PadNumber', ''));
        return net === generation.net && (padNumberSet.size === 0 || padNumberSet.has(padNumber));
      });
      if (groundPads.length === 0) {
        issues.push({ code: 'TARGET_GROUND_PAD_NOT_FOUND', designator: target.designator, net: generation.net, padNumbers: target.padNumbers });
        continue;
      }

      const padNumberCounts = new Map();
      for (const pad of groundPads) {
        const padNumber = String(callGetter(pad, 'getState_PadNumber', 'unknown'));
        padNumberCounts.set(padNumber, (padNumberCounts.get(padNumber) ?? 0) + 1);
      }

      for (const pad of groundPads) {
        const padNumber = String(callGetter(pad, 'getState_PadNumber', 'unknown'));
        const padId = callGetter(pad, 'getState_PrimitiveId');
        const x = finiteOrNull(callGetter(pad, 'getState_X'));
        const y = finiteOrNull(callGetter(pad, 'getState_Y'));
        const halfExtent = padHalfExtent(pad, generation.fallbackPadRadius);
        if (x === null || y === null || halfExtent === null) {
          issues.push({
            code: 'PAD_GEOMETRY_UNRESOLVED',
            designator: target.designator,
            padNumber,
            primitiveId: padId,
            x,
            y,
            padShape: clone(callGetter(pad, 'getState_Pad')),
          });
          continue;
        }
        const group = { designator: target.designator, padNumber, primitiveId: padId, countPerPad: target.countPerPad, candidateKeys: [] };
        const distance = halfExtent + generation.via.diameter / 2 + generation.padGap;
        const padIdentity = padNumberCounts.get(padNumber) > 1
          ? `${safeKeyPart(padNumber)}-${safeKeyPart(padId).slice(-6)}`
          : safeKeyPart(padNumber);
        for (const direction of target.directions) {
          const offset = directionOffset(direction, distance);
          const key = `${safeKeyPart(target.designator)}-pad${padIdentity}-${direction}`;
          group.candidateKeys.push(key);
          proposals.push({
            key,
            x: x + offset.x,
            y: y + offset.y,
            ...generation.via,
            rationale: `${target.designator} pad ${padNumber} ${generation.net} ${direction}`,
          });
        }
        groups.push(group);
      }
    }

    if (proposals.length === 0) {
      return { status: 'generation-blocked', issues, proposalCount: 0, selectedCount: 0, plan: null, analysis: null, applyRequest: null };
    }
    if (proposals.length > MAX_VIAS_PER_APPLY) {
      issues.push({ code: 'GROUND_VIA_BOUND_EXCEEDED', count: proposals.length, maximum: MAX_VIAS_PER_APPLY });
      return { status: 'generation-blocked', issues, proposalCount: proposals.length, selectedCount: 0, plan: null, analysis: null, applyRequest: null };
    }

    const basePlan = {
      schemaVersion: 1,
      expectedDocumentUuid: generation.expectedDocumentUuid,
      expectedInspectionFingerprint: generation.expectedInspectionFingerprint,
      net: generation.net,
      clearance: generation.clearance,
      minimumCenterSpacing: generation.minimumCenterSpacing,
      boardContainmentConfirmed: generation.boardContainmentConfirmed,
      boardContainmentEvidence: generation.boardContainmentEvidence,
      localClearanceConfirmed: generation.localClearanceConfirmed,
      localClearanceEvidence: generation.localClearanceEvidence,
      vias: proposals,
    };
    const proposalPlan = normalizePlan(basePlan);
    const proposalAnalysis = await analyzePlan(state, proposalPlan, { ignorePlannedViaCollisions: true });
    const rejectedKeys = new Set(proposalAnalysis.rejected.map((item) => item.candidate.key));
    const proposalByKey = new Map(proposals.map((candidate) => [candidate.key, candidate]));
    const selected = [];
    for (const group of groups) {
      const available = group.candidateKeys.filter((key) => !rejectedKeys.has(key)).slice(0, group.countPerPad);
      if (available.length < group.countPerPad) {
        issues.push({
          code: 'INSUFFICIENT_CLEAR_CANDIDATES',
          designator: group.designator,
          padNumber: group.padNumber,
          requested: group.countPerPad,
          available: available.length,
        });
      }
      selected.push(...available.map((key) => proposalByKey.get(key)));
    }
    if (selected.length === 0) {
      return {
        status: 'generation-blocked',
        issues,
        proposalCount: proposals.length,
        selectedCount: 0,
        proposalAnalysis,
        plan: null,
        analysis: null,
        applyRequest: null,
      };
    }

    const plan = normalizePlan({ ...basePlan, vias: selected });
    const analysis = await analyzePlan(state, plan);
    const applyReady = issues.length === 0 && analysis.applyReady;
    return {
      status: applyReady ? 'generated' : 'generated-with-blockers',
      issues,
      proposalCount: proposals.length,
      selectedCount: selected.length,
      proposalAnalysis,
      plan,
      analysis,
      applyRequest: applyReady ? { mode: 'apply', plan, expectedPlanFingerprint: analysis.planFingerprint } : null,
    };
  }

  function pointInPolygon(point, polygon) {
    let inside = false;
    for (let left = 0, right = polygon.length - 1; left < polygon.length; right = left, left += 1) {
      const a = polygon[left];
      const b = polygon[right];
      const crosses = (a.y > point.y) !== (b.y > point.y)
        && point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x;
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function distanceToSegment(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
    const position = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
    return Math.hypot(point.x - (start.x + position * dx), point.y - (start.y + position * dy));
  }

  function circleTouchesPolygon(candidate, points, clearance) {
    if (points.length < 3) return true;
    const center = { x: candidate.x, y: candidate.y };
    if (pointInPolygon(center, points)) return true;
    const radius = candidate.diameter / 2 + clearance;
    for (let index = 0; index < points.length; index += 1) {
      if (distanceToSegment(center, points[index], points[(index + 1) % points.length]) <= radius) return true;
    }
    return false;
  }

  function analyticCircle(source) {
    if (!Array.isArray(source) || String(source[0]).toUpperCase() !== 'CIRCLE' || source.length < 4) return null;
    const x = Number(source[1]);
    const y = Number(source[2]);
    const radius = Math.abs(Number(source[3]));
    if (![x, y, radius].every(Number.isFinite) || radius <= 0) return null;
    return { x, y, radius };
  }

  function candidateTouchesRegion(candidate, region, clearance) {
    if (region.circle) {
      return Math.hypot(candidate.x - region.circle.x, candidate.y - region.circle.y)
        <= candidate.diameter / 2 + clearance + region.circle.radius;
    }
    return circleTouchesPolygon(candidate, region.points, clearance);
  }

  async function blockingRegionGeometry(state) {
    const geometry = [];
    const unresolved = [];
    for (const region of state.regions.filter((item) => item.blocksViaPlanning)) {
      const circle = analyticCircle(region.polygonSource);
      if (circle) {
        geometry.push({
          primitiveId: region.primitiveId,
          layer: region.layer,
          ruleTypes: region.ruleTypes,
          circle,
          sourceKind: 'analytic-circle',
        });
        continue;
      }
      const polygon = callGetter(region.primitive, 'getState_ComplexPolygon');
      if (typeof polygon?.discretize !== 'function') {
        unresolved.push({ primitiveId: region.primitiveId, code: 'REGION_DISCRETIZE_UNAVAILABLE' });
        continue;
      }
      try {
        const rawPoints = await polygon.discretize();
        const points = Array.isArray(rawPoints)
          ? rawPoints.map((point) => ({ x: Number(point.x), y: Number(point.y) })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
          : [];
        if (points.length < 3) unresolved.push({ primitiveId: region.primitiveId, code: 'REGION_GEOMETRY_INCOMPLETE' });
        else geometry.push({ primitiveId: region.primitiveId, layer: region.layer, ruleTypes: region.ruleTypes, points });
      } catch (error) {
        unresolved.push({ primitiveId: region.primitiveId, code: 'REGION_DISCRETIZE_FAILED', message: error.message });
      }
    }
    return { geometry, unresolved };
  }

  async function analyzePlan(state, plan, { ignorePlannedViaCollisions = false } = {}) {
    const globalIssues = [];
    if (state.document.uuid !== plan.expectedDocumentUuid) {
      globalIssues.push({ code: 'DOCUMENT_MISMATCH', expected: plan.expectedDocumentUuid, actual: state.document.uuid });
    }
    if (state.inspectionFingerprint !== plan.expectedInspectionFingerprint) {
      globalIssues.push({ code: 'STALE_INSPECTION', expected: plan.expectedInspectionFingerprint, actual: state.inspectionFingerprint });
    }
    if (!state.coverage.complete) globalIssues.push({ code: 'INCOMPLETE_INSPECTION_COVERAGE', coverage: state.coverage });
    if (!plan.boardContainmentConfirmed) globalIssues.push({ code: 'BOARD_CONTAINMENT_NOT_CONFIRMED' });
    if (!plan.localClearanceConfirmed) globalIssues.push({ code: 'LOCAL_COPPER_CLEARANCE_NOT_CONFIRMED' });

    const blockingGeometry = await blockingRegionGeometry(state);
    globalIssues.push(...blockingGeometry.unresolved);
    const apiBlockingRegionIds = new Set(
      state.regions.filter((region) => region.blocksViaPlanning).map((region) => String(region.primitiveId)),
    );
    const unresolvedDocumentKeepouts = state.documentKeepouts.filter(
      (record) => record.id === null || !apiBlockingRegionIds.has(String(record.id)),
    );
    if (unresolvedDocumentKeepouts.length > 0) {
      globalIssues.push({
        code: 'DOCUMENT_SOURCE_KEEPOUT_NOT_RESOLVED_BY_API',
        records: unresolvedDocumentKeepouts,
      });
    }
    const footprintKeepoutCount = state.footprintKeepouts.reduce((sum, item) => sum + item.actualKeepoutRecords.length, 0);
    if (footprintKeepoutCount > 0) {
      globalIssues.push({ code: 'FOOTPRINT_KEEPOUT_GEOMETRY_UNRESOLVED', count: footprintKeepoutCount });
    }

    const accepted = [];
    const rejected = [];
    for (const candidate of plan.vias) {
      const issues = [];
      for (const region of blockingGeometry.geometry) {
        if (candidateTouchesRegion(candidate, region, plan.clearance)) {
          issues.push({ code: 'KEEPOUT_COLLISION', primitiveId: region.primitiveId, layer: region.layer, ruleTypes: region.ruleTypes });
        }
      }
      for (const existing of state.vias) {
        if (existing.x === null || existing.y === null || existing.diameter === null) continue;
        const minimum = candidate.diameter / 2 + existing.diameter / 2 + plan.minimumCenterSpacing;
        if (Math.hypot(candidate.x - existing.x, candidate.y - existing.y) < minimum) {
          issues.push({ code: 'EXISTING_VIA_COLLISION', primitiveId: existing.primitiveId, net: existing.net });
        }
      }
      if (!ignorePlannedViaCollisions) {
        for (const previous of plan.vias) {
          if (previous.key === candidate.key) break;
          const minimum = candidate.diameter / 2 + previous.diameter / 2 + plan.minimumCenterSpacing;
          if (Math.hypot(candidate.x - previous.x, candidate.y - previous.y) < minimum) {
            issues.push({ code: 'PLANNED_VIA_COLLISION', otherKey: previous.key });
          }
        }
      }
      if (issues.length === 0) accepted.push(candidate);
      else rejected.push({ candidate, issues });
    }

    const planFingerprint = hashText(stableStringify({
      inspectionFingerprint: state.inspectionFingerprint,
      plan,
      acceptedKeys: accepted.map((item) => item.key),
      rejected: rejected.map((item) => ({ key: item.candidate.key, codes: item.issues.map((issue) => issue.code) })),
      globalIssueCodes: globalIssues.map((issue) => issue.code),
    }));
    return {
      applyReady: globalIssues.length === 0 && rejected.length === 0 && accepted.length === plan.vias.length,
      planFingerprint,
      globalIssues,
      accepted,
      rejected,
      keepoutGeometry: {
        resolvedRegionCount: blockingGeometry.geometry.length,
        unresolvedRegionCount: blockingGeometry.unresolved.length,
        footprintKeepoutCount,
      },
    };
  }

  function viaMatches(actual, expected) {
    const coordinateMatches = (left, right) => Number.isFinite(left)
      && Number.isFinite(right)
      && Math.abs(left - right) <= 1e-6;
    return actual
      && actual.net === expected.net
      && coordinateMatches(actual.x, expected.x)
      && coordinateMatches(actual.y, expected.y)
      && actual.holeDiameter === expected.holeDiameter
      && actual.diameter === expected.diameter;
  }

  async function rollbackCreated(created) {
    const ids = created.map((item) => item.primitiveId).filter(Boolean);
    if (ids.length === 0) return { deleted: true, remaining: [] };
    let deleted = false;
    try {
      deleted = await eda.pcb_PrimitiveVia.delete(ids);
    } catch {
      deleted = false;
    }
    const all = await eda.pcb_PrimitiveVia.getAll();
    const remaining = all.map(summarizeVia).filter((via) => ids.includes(via.primitiveId));
    return { deleted: Boolean(deleted), remaining };
  }

  async function applyPlan(plan, expectedPlanFingerprint) {
    const before = await captureState();
    const analysis = await analyzePlan(before, plan);
    if (!analysis.applyReady || analysis.planFingerprint !== expectedPlanFingerprint) {
      return {
        status: 'blocked',
        readOnly: true,
        reason: analysis.planFingerprint !== expectedPlanFingerprint ? 'PLAN_FINGERPRINT_MISMATCH' : 'PLAN_NOT_APPLY_READY',
        state: publicState(before),
        analysis,
      };
    }

    const created = [];
    try {
      for (const candidate of analysis.accepted) {
        const primitive = await eda.pcb_PrimitiveVia.create(
          plan.net,
          candidate.x,
          candidate.y,
          candidate.holeDiameter,
          candidate.diameter,
          candidate.viaType ?? undefined,
          candidate.designRuleBlindViaName,
          candidate.solderMaskExpansion,
          candidate.primitiveLock,
        );
        if (!primitive) fail('CREATE_VIA_FAILED', `EasyEDA rejected via ${candidate.key}.`);
        const primitiveId = callGetter(primitive, 'getState_PrimitiveId');
        if (!primitiveId) fail('CREATE_VIA_WITHOUT_ID', `Via ${candidate.key} has no primitive ID.`);
        created.push({ key: candidate.key, primitiveId, net: plan.net, ...candidate });
        const readbackPrimitive = await eda.pcb_PrimitiveVia.get(primitiveId);
        const actual = summarizeVia(readbackPrimitive);
        const expected = { ...candidate, net: plan.net };
        if (!viaMatches(actual, expected)) {
          fail('VIA_READBACK_MISMATCH', `Readback mismatch for via ${candidate.key}: ${stableStringify({ actual, expected })}`);
        }
        created[created.length - 1] = { key: candidate.key, ...actual };
      }

      const after = await captureState();
      const afterById = new Map(after.vias.map((via) => [via.primitiveId, via]));
      const missing = created.filter((via) => !viaMatches(afterById.get(via.primitiveId), via));
      const beforeIds = new Set(before.vias.map((via) => via.primitiveId));
      const collateralMissing = [...beforeIds].filter((id) => !afterById.has(id));
      if (missing.length > 0 || collateralMissing.length > 0) {
        fail('POST_APPLY_INVARIANT_FAILED', JSON.stringify({ missing, collateralMissing }));
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
        status: rollback.remaining.length === 0 && restored.inspectionFingerprint === before.inspectionFingerprint
          ? 'rolled-back'
          : 'rollback-incomplete',
        error: { code: error.code ?? 'APPLY_FAILED', message: error.message },
        createdBeforeFailure: created,
        rollback,
        restoredInspectionFingerprint: restored.inspectionFingerprint,
        expectedRestoredFingerprint: before.inspectionFingerprint,
        saved: false,
      };
    }
  }

  function publicState(state) {
    return {
      document: state.document,
      inspectionFingerprint: state.inspectionFingerprint,
      coverage: state.coverage,
      pourCount: state.pours.length,
      regionCount: state.regions.length,
      viaCount: state.vias.length,
      componentCount: state.components.length,
      documentKeepoutCount: state.documentKeepouts.length,
      footprintKeepoutCount: state.footprintKeepouts.reduce((sum, item) => sum + item.actualKeepoutRecords.length, 0),
    };
  }

  function compactAnalysis(analysis) {
    if (!analysis) return null;
    const rejectionCounts = new Map();
    for (const item of analysis.rejected) {
      for (const issue of item.issues) rejectionCounts.set(issue.code, (rejectionCounts.get(issue.code) ?? 0) + 1);
    }
    return {
      applyReady: analysis.applyReady,
      planFingerprint: analysis.planFingerprint,
      globalIssues: analysis.globalIssues,
      acceptedCount: analysis.accepted.length,
      rejectedCount: analysis.rejected.length,
      rejectionSummary: [...rejectionCounts.entries()].map(([code, count]) => ({ code, count })),
      keepoutGeometry: analysis.keepoutGeometry,
    };
  }

  const mode = request.mode ?? 'inspect';
  if (mode === 'inspect') {
    const state = await captureState();
    return { schemaVersion: 1, status: 'inspected', readOnly: true, state: publicState(state) };
  }
  if (mode === 'plan') {
    const plan = normalizePlan(request.plan);
    const state = await captureState();
    const analysis = await analyzePlan(state, plan);
    return {
      schemaVersion: 1,
      status: analysis.applyReady ? 'planned' : 'planned-with-blockers',
      readOnly: true,
      state: publicState(state),
      plan,
      analysis,
      applyRequest: analysis.applyReady
        ? { mode: 'apply', plan, expectedPlanFingerprint: analysis.planFingerprint }
        : null,
    };
  }
  if (mode === 'generate') {
    const generation = normalizeGenerationRequest(request.generation);
    const state = await captureState();
    const generated = await generatePlan(state, generation);
    const reported = generation.detailLevel === 'full'
      ? generated
      : {
        ...generated,
        proposalAnalysis: compactAnalysis(generated.proposalAnalysis),
        analysis: compactAnalysis(generated.analysis),
      };
    return {
      schemaVersion: 1,
      readOnly: true,
      state: publicState(state),
      generation,
      ...reported,
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
    if (state.document.uuid !== request.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'Verify request belongs to another PCB.');
    const byId = new Map(state.vias.map((via) => [via.primitiveId, via]));
    const issues = request.created
      .filter((expected) => !viaMatches(byId.get(expected.primitiveId), expected))
      .map((expected) => ({ code: 'VIA_MISSING_OR_CHANGED', primitiveId: expected.primitiveId, key: expected.key ?? null }));
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
    if (current.document.uuid !== request.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'Rollback request belongs to another PCB.');
    if (current.inspectionFingerprint !== request.expectedCurrentFingerprint) fail('STALE_ROLLBACK', 'Current PCB differs from the expected applied state.');
    const byId = new Map(current.vias.map((via) => [via.primitiveId, via]));
    const changed = request.created.filter((expected) => !viaMatches(byId.get(expected.primitiveId), expected));
    if (changed.length > 0) fail('STALE_ROLLBACK', 'One or more created vias changed after apply.');
    const rollback = await rollbackCreated(request.created);
    const restored = await captureState();
    return {
      schemaVersion: 1,
      status: rollback.remaining.length === 0 && restored.inspectionFingerprint === request.expectedRestoredFingerprint
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
