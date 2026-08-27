return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;
  const BOARD_OUTLINE = 11;
  const MAX_LAYERS_PER_APPLY = 4;
  const CONNECT_TOLERANCE_MIL = 0.2;

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

  function point(x, y) {
    return { x: Number(x), y: Number(y) };
  }

  function samePoint(left, right, tolerance = CONNECT_TOLERANCE_MIL) {
    return Math.hypot(left.x - right.x, left.y - right.y) <= tolerance;
  }

  async function getAll(api) {
    if (typeof api?.getAll !== 'function') return [];
    const result = await api.getAll();
    return Array.isArray(result) ? result : [];
  }

  function primitiveId(primitive) {
    return getter(primitive, 'getState_PrimitiveId');
  }

  function sourceOf(polygon) {
    return clone(getter(polygon, 'getSource', []));
  }

  async function discretizeSource(source) {
    if (!Array.isArray(source) || source.length === 0) return [];
    const polygon = eda.pcb_MathPolygon.createPolygon(source);
    if (!polygon) return [];
    try {
      const points = typeof polygon.discretize === 'function'
        ? await polygon.discretize({ tolerance: 1 })
        : await eda.pcb_MathPolygon.discretize(polygon, { tolerance: 1 });
      return Array.isArray(points)
        ? points.map((item) => point(item.x, item.y)).filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y))
        : [];
    } catch {
      return [];
    }
  }

  function polygonArea(points) {
    if (points.length < 3) return 0;
    let twiceArea = 0;
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      twiceArea += current.x * next.y - next.x * current.y;
    }
    return Math.abs(twiceArea) / 2;
  }

  function bbox(points) {
    if (points.length === 0) return null;
    const xs = points.map((item) => item.x);
    const ys = points.map((item) => item.y);
    return {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  }

  function sourceMetrics(source) {
    if (source?.[0] === 'R' && source.length >= 7) {
      const width = Math.abs(Number(source[3]));
      const height = Math.abs(Number(source[4]));
      const radius = Math.max(0, Math.min(Math.abs(Number(source[6])), width / 2, height / 2));
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return {
          pointCount: 4,
          areaMil2: width * height - (4 - Math.PI) * radius * radius,
          bbox: { anchorX: Number(source[1]), anchorY: Number(source[2]), width, height, rotation: Number(source[5]) },
          metricSource: 'analytic-rounded-rectangle',
        };
      }
    }
    if (source?.[0] === 'CIRCLE' && source.length >= 4) {
      const radius = Math.abs(Number(source[3]));
      if (Number.isFinite(radius) && radius > 0) {
        return {
          pointCount: 4,
          areaMil2: Math.PI * radius * radius,
          bbox: { centerX: Number(source[1]), centerY: Number(source[2]), width: radius * 2, height: radius * 2 },
          metricSource: 'analytic-circle',
        };
      }
    }
    return null;
  }

  function lineSegment(primitive) {
    return {
      primitiveId: primitiveId(primitive),
      kind: 'line',
      start: point(getter(primitive, 'getState_StartX'), getter(primitive, 'getState_StartY')),
      end: point(getter(primitive, 'getState_EndX'), getter(primitive, 'getState_EndY')),
      lineWidth: Number(getter(primitive, 'getState_LineWidth', 0)),
    };
  }

  function arcSegment(primitive) {
    return {
      primitiveId: primitiveId(primitive),
      kind: 'arc',
      start: point(getter(primitive, 'getState_StartX'), getter(primitive, 'getState_StartY')),
      end: point(getter(primitive, 'getState_EndX'), getter(primitive, 'getState_EndY')),
      arcAngle: Number(getter(primitive, 'getState_ArcAngle', 0)),
      lineWidth: Number(getter(primitive, 'getState_LineWidth', 0)),
    };
  }

  function oriented(segment, reverse) {
    return {
      ...segment,
      start: reverse ? segment.end : segment.start,
      end: reverse ? segment.start : segment.end,
      arcAngle: segment.kind === 'arc' ? (reverse ? -segment.arcAngle : segment.arcAngle) : null,
      reversed: reverse,
    };
  }

  function sourceFromChain(chain) {
    if (chain.length === 0) return [];
    const source = [chain[0].start.x, chain[0].start.y];
    for (const segment of chain) {
      if (segment.kind === 'arc') source.push('ARC', segment.arcAngle, segment.end.x, segment.end.y);
      else source.push('L', segment.end.x, segment.end.y);
    }
    return source;
  }

  function stitchSegments(segments) {
    const remaining = [...segments];
    const chains = [];
    while (remaining.length > 0) {
      const first = remaining.shift();
      const chain = [oriented(first, false)];
      while (remaining.length > 0) {
        const tail = chain.at(-1).end;
        let matchIndex = -1;
        let reverse = false;
        for (let index = 0; index < remaining.length; index += 1) {
          if (samePoint(remaining[index].start, tail)) {
            matchIndex = index;
            break;
          }
          if (samePoint(remaining[index].end, tail)) {
            matchIndex = index;
            reverse = true;
            break;
          }
        }
        if (matchIndex < 0) break;
        chain.push(oriented(remaining.splice(matchIndex, 1)[0], reverse));
        if (samePoint(chain.at(-1).end, chain[0].start)) break;
      }
      chains.push({
        source: sourceFromChain(chain),
        closed: samePoint(chain.at(-1).end, chain[0].start),
        primitiveIds: chain.map((item) => item.primitiveId),
        segmentCount: chain.length,
      });
    }
    return chains;
  }

  async function captureOutline() {
    const [allLines, allArcs, allPolylines] = await Promise.all([
      getAll(eda.pcb_PrimitiveLine),
      getAll(eda.pcb_PrimitiveArc),
      getAll(eda.pcb_PrimitivePolyline),
    ]);
    const lines = allLines.filter((item) => Number(getter(item, 'getState_Layer')) === BOARD_OUTLINE).map(lineSegment);
    const arcs = allArcs.filter((item) => Number(getter(item, 'getState_Layer')) === BOARD_OUTLINE).map(arcSegment);
    const polylines = allPolylines
      .filter((item) => Number(getter(item, 'getState_Layer')) === BOARD_OUTLINE)
      .map((item) => ({
        primitiveId: primitiveId(item),
        source: sourceOf(getter(item, 'getState_Polygon')),
        lineWidth: Number(getter(item, 'getState_LineWidth', 0)),
      }));

    const rawCandidates = [
      ...polylines.map((item) => ({
        kind: 'polyline',
        source: item.source,
        closed: true,
        primitiveIds: [item.primitiveId],
        segmentCount: 1,
      })),
      ...stitchSegments([...lines, ...arcs]).map((item) => ({ kind: 'stitched', ...item })),
    ];
    const candidates = [];
    for (const candidate of rawCandidates) {
      const points = await discretizeSource(candidate.source);
      const fallbackMetrics = points.length >= 3 ? null : sourceMetrics(candidate.source);
      candidates.push({
        ...candidate,
        pointCount: fallbackMetrics?.pointCount ?? points.length,
        areaMil2: fallbackMetrics?.areaMil2 ?? polygonArea(points),
        bbox: fallbackMetrics?.bbox ?? bbox(points),
        metricSource: fallbackMetrics?.metricSource ?? 'discretized',
        sourceFingerprint: hashText(stableStringify(candidate.source)),
      });
    }
    const selected = candidates
      .filter((item) => item.closed && item.pointCount >= 3 && item.areaMil2 > 0)
      .sort((left, right) => right.areaMil2 - left.areaMil2)[0] ?? null;
    const state = {
      layerId: BOARD_OUTLINE,
      lines,
      arcs,
      polylines,
      candidates,
      selected,
    };
    state.fingerprint = hashText(stableStringify({
      lines,
      arcs,
      polylines,
      selectedSource: selected?.source ?? null,
    }));
    return state;
  }

  function summarizePour(pour) {
    const polygon = getter(pour, 'getState_ComplexPolygon');
    return {
      primitiveId: primitiveId(pour),
      net: getter(pour, 'getState_Net', ''),
      layer: Number(getter(pour, 'getState_Layer')),
      fillMethod: clone(getter(pour, 'getState_PourFillMethod')),
      preserveSilos: Boolean(getter(pour, 'getState_PreserveSilos', false)),
      pourName: getter(pour, 'getState_PourName', ''),
      priority: Number(getter(pour, 'getState_PourPriority', 0)),
      lineWidth: Number(getter(pour, 'getState_LineWidth', 0)),
      primitiveLock: Boolean(getter(pour, 'getState_PrimitiveLock', false)),
      polygonSource: sourceOf(polygon),
    };
  }

  async function summarizePoured(poured, probes = []) {
    const fills = getter(poured, 'getState_PourFills', []);
    const fillItems = Array.isArray(fills) ? fills : [];
    const keepoutProbeResults = [];
    for (const probe of probes) {
      if (typeof eda?.sys_Math?.containsPoint !== 'function') {
        keepoutProbeResults.push({ ...probe, status: 'unsupported', insideRealizedCopper: null });
        continue;
      }
      let inside = false;
      let checked = false;
      let selectedScale = null;
      let clearanceContourCount = 0;
      let error = null;
      try {
        for (const fill of fillItems) {
          const strictSources = clone(getter(fill?.path, 'getSourceStrictComplex', []));
          if (!Array.isArray(strictSources) || strictSources.length === 0) continue;
          const scaleCandidates = [1, 0.1, 10, 0.0254];
          const candidates = scaleCandidates.map((scale) => {
            const testPoint = { x: probe.x * scale, y: probe.y * scale };
            const outerContains = Boolean(eda.sys_Math.containsPoint(strictSources[0], testPoint));
            const containingClearanceContours = strictSources.slice(1)
              .map((source, index) => ({ index: index + 1, contains: Boolean(eda.sys_Math.containsPoint(source, testPoint)) }))
              .filter((item) => item.contains);
            return { scale, outerContains, containingClearanceContours };
          });
          const matched = candidates
            .filter((item) => item.outerContains)
            .sort((left, right) => right.containingClearanceContours.length - left.containingClearanceContours.length)[0];
          if (!matched) continue;
          checked = true;
          selectedScale = matched.scale;
          clearanceContourCount = matched.containingClearanceContours.length;
          if (matched.containingClearanceContours.length === 0) inside = true;
          else inside = false;
          if (inside) break;
        }
        if (!checked) {
          error = 'No coordinate scale mapped the probe into the realized outer copper contour.';
        }
      } catch (caught) {
        error = caught.message;
      }
      keepoutProbeResults.push({
        ...probe,
        status: error ? 'error' : 'checked',
        insideRealizedCopper: error ? null : inside,
        selectedScale,
        clearanceContourCount,
        ...(error ? { error } : {}),
      });
    }
    return {
      primitiveId: primitiveId(poured),
      pourPrimitiveId: getter(poured, 'getState_PourPrimitiveId'),
      fillCount: fillItems.length,
      fills: fillItems.map((fill) => ({
        id: fill?.id ?? null,
        fill: fill?.fill ?? null,
        lineWidth: fill?.lineWidth ?? null,
        pathSource: clone(
          getter(fill?.path, 'getSourceStrictComplex', getter(fill?.path, 'getSource', null)),
        ),
      })),
      keepoutProbeResults,
    };
  }

  function summarizeLine(item) {
    return {
      id: primitiveId(item),
      net: getter(item, 'getState_Net', ''),
      layer: Number(getter(item, 'getState_Layer')),
      startX: Number(getter(item, 'getState_StartX')),
      startY: Number(getter(item, 'getState_StartY')),
      endX: Number(getter(item, 'getState_EndX')),
      endY: Number(getter(item, 'getState_EndY')),
      width: Number(getter(item, 'getState_LineWidth', 0)),
    };
  }

  function summarizeArc(item) {
    return { ...summarizeLine(item), angle: Number(getter(item, 'getState_ArcAngle', 0)) };
  }

  function summarizeVia(item) {
    return {
      id: primitiveId(item),
      net: getter(item, 'getState_Net', ''),
      x: Number(getter(item, 'getState_X')),
      y: Number(getter(item, 'getState_Y')),
      diameter: Number(getter(item, 'getState_Diameter', 0)),
      holeDiameter: Number(getter(item, 'getState_HoleDiameter', 0)),
    };
  }

  function summarizeComponent(item) {
    return {
      id: primitiveId(item),
      designator: getter(item, 'getState_Designator', ''),
      layer: Number(getter(item, 'getState_Layer')),
      x: Number(getter(item, 'getState_X')),
      y: Number(getter(item, 'getState_Y')),
      rotation: Number(getter(item, 'getState_Rotation', 0)),
    };
  }

  async function captureInvariants() {
    const [lines, arcs, polylines, vias, components, regions] = await Promise.all([
      getAll(eda.pcb_PrimitiveLine),
      getAll(eda.pcb_PrimitiveArc),
      getAll(eda.pcb_PrimitivePolyline),
      getAll(eda.pcb_PrimitiveVia),
      getAll(eda.pcb_PrimitiveComponent),
      getAll(eda.pcb_PrimitiveRegion),
    ]);
    const state = {
      lines: lines.map(summarizeLine).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      arcs: arcs.map(summarizeArc).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      polylines: polylines.map((item) => ({
        id: primitiveId(item),
        net: getter(item, 'getState_Net', ''),
        layer: Number(getter(item, 'getState_Layer')),
        width: Number(getter(item, 'getState_LineWidth', 0)),
        source: sourceOf(getter(item, 'getState_Polygon')),
      })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      vias: vias.map(summarizeVia).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      components: components.map(summarizeComponent).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      regions: regions.map((item) => ({
        id: primitiveId(item),
        layer: Number(getter(item, 'getState_Layer')),
        ruleType: clone(getter(item, 'getState_RuleType', [])),
        source: sourceOf(getter(item, 'getState_ComplexPolygon')),
      })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    };
    return {
      counts: Object.fromEntries(Object.entries(state).map(([key, value]) => [key, value.length])),
      fingerprint: hashText(stableStringify(state)),
    };
  }

  async function captureState() {
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if (!document || Number(document.documentType) !== 3) fail('PCB_DOCUMENT_REQUIRED', 'The active EasyEDA document is not a PCB.');
    const project = await eda.dmt_Project.getCurrentProjectInfo();
    const [layers, outline, pours, poured, regions, invariants] = await Promise.all([
      eda.pcb_Layer.getAllLayers(),
      captureOutline(),
      getAll(eda.pcb_PrimitivePour),
      getAll(eda.pcb_PrimitivePoured),
      getAll(eda.pcb_PrimitiveRegion),
      captureInvariants(),
    ]);
    const keepoutProbes = regions
      .map((item) => ({
        primitiveId: primitiveId(item),
        ruleTypes: Array.isArray(getter(item, 'getState_RuleType', []))
          ? getter(item, 'getState_RuleType', []).map(Number)
          : [],
        source: sourceOf(getter(item, 'getState_ComplexPolygon')),
      }))
      .filter((item) => item.ruleTypes.includes(7) && item.source?.[0] === 'CIRCLE')
      .map((item) => ({ primitiveId: item.primitiveId, x: Number(item.source[1]), y: Number(item.source[2]) }));
    const pouredSummaries = await Promise.all(poured.map((item) => summarizePoured(item, keepoutProbes)));
    const copperLayers = (Array.isArray(layers) ? layers : [])
      .filter((item) => item.layerStatus !== 0)
      .filter((item) => item.id === 1 || item.id === 2 || (item.id >= 15 && item.id <= 44))
      .map((item) => ({ id: Number(item.id), name: item.name ?? null, type: item.type ?? null }))
      .sort((left, right) => {
        const order = (id) => id === 1 ? 0 : id === 2 ? 100 : id - 14;
        return order(left.id) - order(right.id);
      });
    const state = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      project: project ? { uuid: project.uuid, name: project.name, friendlyName: project.friendlyName } : null,
      document: {
        uuid: document.uuid,
        tabId: document.tabId,
        documentType: document.documentType,
        parentProjectUuid: document.parentProjectUuid ?? null,
      },
      copperLayers,
      outline,
      pours: pours.map(summarizePour).sort((a, b) => String(a.primitiveId).localeCompare(String(b.primitiveId))),
      keepoutProbes,
      poured: pouredSummaries.sort((a, b) => String(a.primitiveId).localeCompare(String(b.primitiveId))),
      invariants,
    };
    state.inspectionFingerprint = hashText(stableStringify({
      documentUuid: state.document.uuid,
      copperLayers: state.copperLayers,
      outlineFingerprint: state.outline.fingerprint,
      pours: state.pours,
      invariantsFingerprint: state.invariants.fingerprint,
    }));
    return state;
  }

  function normalizePlan(rawPlan, state) {
    if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) fail('INVALID_POUR_PLAN', 'plan must be an object.');
    if (rawPlan.schemaVersion !== 1) fail('INVALID_POUR_PLAN', 'plan.schemaVersion must be 1.');
    if (typeof rawPlan.expectedDocumentUuid !== 'string' || !rawPlan.expectedDocumentUuid) fail('INVALID_POUR_PLAN', 'expectedDocumentUuid is required.');
    if (typeof rawPlan.expectedInspectionFingerprint !== 'string' || !rawPlan.expectedInspectionFingerprint) fail('INVALID_POUR_PLAN', 'expectedInspectionFingerprint is required.');
    const net = typeof rawPlan.net === 'string' ? rawPlan.net.trim() : '';
    if (!net) fail('INVALID_POUR_PLAN', 'A non-empty existing net is required.');
    const layerIds = [...new Set((Array.isArray(rawPlan.layerIds) ? rawPlan.layerIds : []).map(Number))];
    if (layerIds.length === 0 || layerIds.length > MAX_LAYERS_PER_APPLY) fail('INVALID_POUR_PLAN', `layerIds must contain 1-${MAX_LAYERS_PER_APPLY} layers.`);
    const activeLayers = new Set(state.copperLayers.map((item) => item.id));
    for (const layerId of layerIds) {
      if (!activeLayers.has(layerId)) fail('INVALID_POUR_PLAN', `Layer ${layerId} is not an active copper layer.`);
      if (state.pours.some((item) => item.layer === layerId && item.net === net)) fail('POUR_ALREADY_EXISTS', `${net} already has a pour on layer ${layerId}.`);
    }
    const polygonSource = Array.isArray(rawPlan.polygonSource)
      ? clone(rawPlan.polygonSource)
      : clone(state.outline.selected?.source);
    if (!Array.isArray(polygonSource) || polygonSource.length < 3) fail('BOARD_OUTLINE_UNRESOLVED', 'No closed board outline polygon is available.');
    const fillMethod = rawPlan.fillMethod ?? 'solid';
    if (fillMethod !== 'solid' && fillMethod !== 'grid') fail('INVALID_POUR_PLAN', 'fillMethod must be solid or grid.');
    const priority = Number(rawPlan.priority ?? 1);
    const lineWidth = Number(rawPlan.lineWidth ?? 10);
    if (!Number.isFinite(priority) || !Number.isFinite(lineWidth) || lineWidth <= 0) fail('INVALID_POUR_PLAN', 'priority and positive lineWidth are required.');
    return {
      schemaVersion: 1,
      expectedDocumentUuid: rawPlan.expectedDocumentUuid,
      expectedInspectionFingerprint: rawPlan.expectedInspectionFingerprint,
      expectedOutlineFingerprint: rawPlan.expectedOutlineFingerprint ?? state.outline.fingerprint,
      net,
      layerIds,
      polygonSource,
      polygonSourceFingerprint: hashText(stableStringify(polygonSource)),
      fillMethod,
      preserveSilos: Boolean(rawPlan.preserveSilos ?? false),
      pourNamePrefix: typeof rawPlan.pourNamePrefix === 'string' && rawPlan.pourNamePrefix.trim()
        ? rawPlan.pourNamePrefix.trim()
        : 'FLITREALIZE_GND',
      priority,
      lineWidth,
      primitiveLock: Boolean(rawPlan.primitiveLock ?? false),
    };
  }

  async function copperForPour(pour) {
    let rebuildError = null;
    let region = null;
    if (typeof pour?.rebuildCopperRegion === 'function') {
      try {
        region = await pour.rebuildCopperRegion();
      } catch (error) {
        rebuildError = error.message;
      }
    }
    for (let attempt = 0; !region && attempt < 12; attempt += 1) {
      if (typeof pour?.getCopperRegion === 'function') {
        try {
          region = await pour.getCopperRegion();
        } catch {
          // The BETA API can be temporarily unavailable while calculation is running.
        }
      }
      if (!region) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { region, rebuildError };
  }

  async function deleteCreated(createdIds) {
    const uniqueIds = [...new Set(createdIds.filter(Boolean))];
    if (uniqueIds.length === 0) return { deleted: true, remainingIds: [] };
    const deleted = await eda.pcb_PrimitivePour.delete(uniqueIds);
    const remaining = await getAll(eda.pcb_PrimitivePour);
    const remainingIds = remaining.map(primitiveId).filter((id) => uniqueIds.includes(id));
    return { deleted: Boolean(deleted) && remainingIds.length === 0, remainingIds };
  }

  async function applyPlan(plan) {
    const before = await captureState();
    if (before.document.uuid !== plan.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', `Expected ${plan.expectedDocumentUuid}, got ${before.document.uuid}.`);
    if (before.inspectionFingerprint !== plan.expectedInspectionFingerprint) fail('STALE_POUR_PLAN', 'PCB geometry, layers, outline, or existing pours changed after planning.');
    if (before.outline.fingerprint !== plan.expectedOutlineFingerprint) fail('OUTLINE_MISMATCH', 'The board outline changed after planning.');
    const created = [];
    try {
      for (const layerId of plan.layerIds) {
        const polygon = eda.pcb_MathPolygon.createPolygon(plan.polygonSource);
        if (!polygon) fail('POLYGON_CREATE_FAILED', 'EasyEDA rejected the planned board polygon.');
        const name = `${plan.pourNamePrefix}_L${layerId}`;
        const pour = await eda.pcb_PrimitivePour.create(
          plan.net,
          layerId,
          polygon,
          plan.fillMethod,
          plan.preserveSilos,
          name,
          plan.priority,
          plan.lineWidth,
          plan.primitiveLock,
        );
        if (!pour) fail('POUR_CREATE_FAILED', `EasyEDA rejected the pour on layer ${layerId}.`);
        const id = primitiveId(pour);
        created.push(id);
        const { region, rebuildError } = await copperForPour(pour);
        if (!region) fail('POUR_REBUILD_FAILED', `Layer ${layerId} has no realized copper region${rebuildError ? `: ${rebuildError}` : '.'}`);
        const readback = await eda.pcb_PrimitivePour.get(id);
        const summary = summarizePour(readback);
        if (summary.net !== plan.net || summary.layer !== layerId || summary.pourName !== name) {
          fail('POUR_READBACK_MISMATCH', `Layer ${layerId} pour properties did not read back exactly.`);
        }
      }
      const after = await captureState();
      if (after.invariants.fingerprint !== before.invariants.fingerprint) fail('PROTECTED_GEOMETRY_CHANGED', 'Tracks, arcs, polylines, vias, components, or regions changed during pour creation.');
      const createdPours = after.pours.filter((item) => created.includes(item.primitiveId));
      const createdPoured = after.poured.filter((item) => created.includes(item.pourPrimitiveId));
      if (createdPours.length !== created.length || createdPoured.length !== created.length) fail('POUR_EVIDENCE_INCOMPLETE', 'Not every created pour has a border and realized filled-region record.');
      const failedKeepoutProbes = createdPoured.flatMap((item) => item.keepoutProbeResults
        .filter((probe) => probe.status === 'checked' && probe.insideRealizedCopper)
        .map((probe) => ({ pourPrimitiveId: item.pourPrimitiveId, ...probe })));
      if (failedKeepoutProbes.length > 0) fail('KEEPOUT_NOT_REALIZED', `Realized copper covers protected probe points: ${stableStringify(failedKeepoutProbes)}`);
      return {
        status: 'applied',
        saved: false,
        plan,
        before: {
          inspectionFingerprint: before.inspectionFingerprint,
          pourCount: before.pours.length,
          pouredCount: before.poured.length,
          invariantFingerprint: before.invariants.fingerprint,
        },
        createdPourIds: created,
        createdPours,
        createdPoured,
        after: {
          inspectionFingerprint: after.inspectionFingerprint,
          pourCount: after.pours.length,
          pouredCount: after.poured.length,
          invariantFingerprint: after.invariants.fingerprint,
        },
        rollbackRequest: {
          mode: 'rollback',
          expectedDocumentUuid: after.document.uuid,
          expectedCurrentInspectionFingerprint: after.inspectionFingerprint,
          createdPourIds: created,
        },
      };
    } catch (error) {
      const rollback = await deleteCreated(created);
      return {
        status: rollback.deleted ? 'rolled-back' : 'rollback-incomplete',
        saved: false,
        error: { code: error.code ?? 'APPLY_FAILED', message: error.message },
        createdPourIds: created,
        rollback,
      };
    }
  }

  async function verifyPlan(plan, expectedPourIds = []) {
    const state = await captureState();
    const issues = [];
    if (state.document.uuid !== plan.expectedDocumentUuid) issues.push({ code: 'DOCUMENT_MISMATCH' });
    if (state.outline.fingerprint !== plan.expectedOutlineFingerprint) issues.push({ code: 'OUTLINE_MISMATCH' });
    const ids = new Set(expectedPourIds);
    for (const layerId of plan.layerIds) {
      const matches = state.pours.filter((item) => item.net === plan.net && item.layer === layerId && (!ids.size || ids.has(item.primitiveId)));
      if (matches.length !== 1) issues.push({ code: 'POUR_BORDER_COUNT', layerId, count: matches.length });
      else {
        const realized = state.poured.find((item) => item.pourPrimitiveId === matches[0].primitiveId);
        if (!realized) issues.push({ code: 'REALIZED_COPPER_MISSING', layerId });
        else {
          for (const probe of realized.keepoutProbeResults) {
            if (probe.status !== 'checked') issues.push({ code: 'KEEPOUT_PROBE_UNRESOLVED', layerId, primitiveId: probe.primitiveId, status: probe.status });
            else if (probe.insideRealizedCopper) issues.push({ code: 'KEEPOUT_COVERED_BY_COPPER', layerId, primitiveId: probe.primitiveId });
          }
        }
      }
    }
    return { status: issues.length === 0 ? 'verified' : 'mismatch', readOnly: true, saved: false, issues, state };
  }

  const mode = request?.mode ?? 'inspect';
  if (mode === 'inspect') return { status: 'inspected', readOnly: true, state: await captureState() };
  if (mode === 'plan') {
    const state = await captureState();
    const plan = normalizePlan(request.plan, state);
    if (state.document.uuid !== plan.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'The plan targets another PCB document.');
    if (state.inspectionFingerprint !== plan.expectedInspectionFingerprint) fail('STALE_POUR_PLAN', 'The inspection fingerprint is stale.');
    return { status: 'planned', readOnly: true, plan, outline: state.outline.selected, existingPourCount: state.pours.length };
  }
  if (mode === 'apply') {
    const state = await captureState();
    return applyPlan(normalizePlan(request.plan, state));
  }
  if (mode === 'verify') {
    const state = await captureState();
    return verifyPlan(normalizePlan(request.plan, { ...state, pours: state.pours.filter((item) => !request.expectedPourIds?.includes(item.primitiveId)) }), request.expectedPourIds ?? []);
  }
  if (mode === 'rollback') {
    const state = await captureState();
    if (state.document.uuid !== request.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'Rollback targets another PCB document.');
    if (typeof request.expectedCurrentInspectionFingerprint === 'string' && state.inspectionFingerprint !== request.expectedCurrentInspectionFingerprint) fail('STALE_ROLLBACK', 'The PCB changed after the pour transaction.');
    const rollback = await deleteCreated(Array.isArray(request.createdPourIds) ? request.createdPourIds : []);
    const after = await captureState();
    return { status: rollback.deleted ? 'rolled-back' : 'rollback-incomplete', saved: false, rollback, after };
  }
  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
