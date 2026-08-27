return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;
  const BOARD_OUTLINE_LAYER = 11;
  const KEEP_OUT_RULES = new Set([5, 6, 7, 8]);
  const MAX_SELECTED = 200;
  const MAX_PROPOSALS = 5000;

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
    if (value === undefined) return undefined;
    try {
      return structuredClone(value);
    } catch {
      return JSON.parse(JSON.stringify(value));
    }
  }

  function finite(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
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

  async function query(label, api, method = 'getAll') {
    if (typeof api?.[method] !== 'function') return { label, status: 'unsupported', items: [], error: null };
    try {
      const value = await api[method]();
      return { label, status: Array.isArray(value) ? 'ok' : 'invalid', items: Array.isArray(value) ? value : [], error: null };
    } catch (error) {
      return { label, status: 'error', items: [], error: error.message };
    }
  }

  function positive(value, path) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) fail('INVALID_STITCHING_REQUEST', `${path} must be a positive number.`);
    return number;
  }

  function nonNegative(value, path, fallback = 0) {
    if (value === undefined) return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) fail('INVALID_STITCHING_REQUEST', `${path} must be a non-negative number.`);
    return number;
  }

  function boundedInteger(value, path, fallback, minimum, maximum) {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
      fail('INVALID_STITCHING_REQUEST', `${path} must be an integer from ${minimum} through ${maximum}.`);
    }
    return number;
  }

  function primitiveId(item) {
    return getter(item, 'getState_PrimitiveId');
  }

  function sourceOf(polygon) {
    return clone(getter(polygon, 'getSource'));
  }

  function activeCopperLayerIds(layers) {
    return (Array.isArray(layers) ? layers : [])
      .filter((item) => item.layerStatus !== 0)
      .map((item) => Number(item.id))
      .filter((id) => id === 1 || id === 2 || (id >= 15 && id <= 44));
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

  function minimumBoundaryDistance(point, points) {
    let distance = Infinity;
    for (let index = 0; index < points.length; index += 1) {
      distance = Math.min(distance, distanceToSegment(point, points[index], points[(index + 1) % points.length]));
    }
    return distance;
  }

  function perimeterModel(points) {
    const segments = [];
    let length = 0;
    let signedAreaTwice = 0;
    for (let index = 0; index < points.length; index += 1) {
      const start = points[index];
      const end = points[(index + 1) % points.length];
      const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
      signedAreaTwice += start.x * end.y - end.x * start.y;
      if (segmentLength <= 1e-9) continue;
      segments.push({ start, end, startDistance: length, length: segmentLength });
      length += segmentLength;
    }
    if (segments.length < 3 || length <= 0 || Math.abs(signedAreaTwice) <= 1e-9) return null;
    return { segments, length, orientation: Math.sign(signedAreaTwice) };
  }

  function samplePerimeter(model, distance) {
    const normalized = ((distance % model.length) + model.length) % model.length;
    let segment = model.segments.at(-1);
    for (const candidate of model.segments) {
      if (normalized < candidate.startDistance + candidate.length - 1e-9) {
        segment = candidate;
        break;
      }
    }
    const position = Math.max(0, Math.min(1, (normalized - segment.startDistance) / segment.length));
    const dx = segment.end.x - segment.start.x;
    const dy = segment.end.y - segment.start.y;
    const inward = model.orientation > 0
      ? { x: -dy / segment.length, y: dx / segment.length }
      : { x: dy / segment.length, y: -dx / segment.length };
    return {
      boundary: { x: segment.start.x + dx * position, y: segment.start.y + dy * position },
      inward,
      perimeterPosition: normalized,
      perimeterFraction: normalized / model.length,
    };
  }

  function projectToPerimeter(model, point) {
    let best = null;
    for (const segment of model.segments) {
      const dx = segment.end.x - segment.start.x;
      const dy = segment.end.y - segment.start.y;
      const lengthSquared = segment.length * segment.length;
      const position = Math.max(0, Math.min(1, ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / lengthSquared));
      const projected = { x: segment.start.x + dx * position, y: segment.start.y + dy * position };
      const distance = Math.hypot(point.x - projected.x, point.y - projected.y);
      if (!best || distance < best.distance) {
        best = {
          distance,
          perimeterPosition: segment.startDistance + segment.length * position,
          perimeterFraction: (segment.startDistance + segment.length * position) / model.length,
        };
      }
    }
    return best;
  }

  function maximumCyclicGap(positions, circumference) {
    if (!Number.isFinite(circumference) || circumference <= 0 || positions.length === 0) return null;
    if (positions.length === 1) return circumference;
    const ordered = [...positions].sort((left, right) => left - right);
    let maximum = 0;
    for (let index = 0; index < ordered.length; index += 1) {
      const next = index + 1 < ordered.length ? ordered[index + 1] : ordered[0] + circumference;
      maximum = Math.max(maximum, next - ordered[index]);
    }
    return maximum;
  }

  function isConvex(points) {
    if (points.length < 3) return false;
    let sign = 0;
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      const c = points[(index + 2) % points.length];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1e-9) continue;
      const current = Math.sign(cross);
      if (sign !== 0 && current !== sign) return false;
      sign = current;
    }
    return sign !== 0;
  }

  function roundedRect(source) {
    if (!Array.isArray(source) || String(source[0]).toUpperCase() !== 'R' || Number(source[5] ?? 0) !== 0) return null;
    const x = Number(source[1]);
    const yTop = Number(source[2]);
    const width = Math.abs(Number(source[3]));
    const height = Math.abs(Number(source[4]));
    const radius = Math.min(Math.abs(Number(source[6] ?? 0)), width / 2, height / 2);
    if (![x, yTop, width, height, radius].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    const rect = { minX: x, maxX: x + width, minY: yTop - height, maxY: yTop, radius };
    const points = [];
    const steps = radius > 0 ? 8 : 1;
    const corners = [
      { x: rect.minX + radius, y: rect.minY + radius, start: Math.PI, end: Math.PI * 1.5 },
      { x: rect.maxX - radius, y: rect.minY + radius, start: Math.PI * 1.5, end: Math.PI * 2 },
      { x: rect.maxX - radius, y: rect.maxY - radius, start: 0, end: Math.PI * 0.5 },
      { x: rect.minX + radius, y: rect.maxY - radius, start: Math.PI * 0.5, end: Math.PI },
    ];
    if (radius === 0) {
      points.push(
        { x: rect.minX, y: rect.minY },
        { x: rect.maxX, y: rect.minY },
        { x: rect.maxX, y: rect.maxY },
        { x: rect.minX, y: rect.maxY },
      );
    } else {
      for (const corner of corners) {
        for (let step = 0; step < steps; step += 1) {
          const angle = corner.start + (corner.end - corner.start) * step / steps;
          points.push({ x: corner.x + radius * Math.cos(angle), y: corner.y + radius * Math.sin(angle) });
        }
      }
    }
    return { ...rect, points };
  }

  function insideRoundedRect(point, rect, margin) {
    const minX = rect.minX + margin;
    const maxX = rect.maxX - margin;
    const minY = rect.minY + margin;
    const maxY = rect.maxY - margin;
    if (minX > maxX || minY > maxY || point.x < minX || point.x > maxX || point.y < minY || point.y > maxY) return false;
    const radius = Math.max(0, rect.radius - margin);
    if (radius === 0) return true;
    if (point.x >= minX + radius && point.x <= maxX - radius) return true;
    if (point.y >= minY + radius && point.y <= maxY - radius) return true;
    const cornerX = point.x < minX + radius ? minX + radius : maxX - radius;
    const cornerY = point.y < minY + radius ? minY + radius : maxY - radius;
    return Math.hypot(point.x - cornerX, point.y - cornerY) <= radius;
  }

  async function resolveOutline(polylines) {
    const candidates = polylines.filter((item) => Number(getter(item, 'getState_Layer')) === BOARD_OUTLINE_LAYER);
    if (candidates.length !== 1) {
      return { status: 'unresolved', issue: { code: 'BOARD_OUTLINE_COUNT', count: candidates.length }, source: null, points: [] };
    }
    const primitive = candidates[0];
    const polygon = getter(primitive, 'getState_Polygon', getter(primitive, 'getState_ComplexPolygon'));
    const source = sourceOf(polygon);
    const analytic = roundedRect(source);
    if (analytic) {
      return {
        status: 'resolved',
        primitiveId: primitiveId(primitive),
        source,
        sourceKind: 'analytic-rounded-rectangle',
        roundedRect: analytic,
        points: analytic.points,
      };
    }
    if (typeof polygon?.discretize !== 'function') {
      return { status: 'unresolved', issue: { code: 'BOARD_OUTLINE_DISCRETIZE_UNAVAILABLE' }, source, points: [] };
    }
    try {
      const raw = await polygon.discretize({ tolerance: 1 });
      const points = (Array.isArray(raw) ? raw : [])
        .map((point) => ({ x: Number(point.x), y: Number(point.y) }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      if (points.length > 1 && points[0].x === points.at(-1).x && points[0].y === points.at(-1).y) points.pop();
      if (points.length < 3) return { status: 'unresolved', issue: { code: 'BOARD_OUTLINE_GEOMETRY_INCOMPLETE' }, source, points };
      return {
        status: 'resolved',
        primitiveId: primitiveId(primitive),
        source,
        sourceKind: 'discretized',
        roundedRect: null,
        points,
      };
    } catch (error) {
      return { status: 'unresolved', issue: { code: 'BOARD_OUTLINE_DISCRETIZE_FAILED', message: error.message }, source, points: [] };
    }
  }

  function outlineBounds(outline) {
    const xs = outline.points.map((point) => point.x);
    const ys = outline.points.map((point) => point.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }

  function outlineContains(outline, point, margin) {
    if (outline.roundedRect) return insideRoundedRect(point, outline.roundedRect, margin);
    return pointInPolygon(point, outline.points) && minimumBoundaryDistance(point, outline.points) >= margin;
  }

  function analyticCircle(source) {
    if (!Array.isArray(source) || String(source[0]).toUpperCase() !== 'CIRCLE' || source.length < 4) return null;
    const x = Number(source[1]);
    const y = Number(source[2]);
    const radius = Math.abs(Number(source[3]));
    if (![x, y, radius].every(Number.isFinite) || radius <= 0) return null;
    return { x, y, radius };
  }

  async function resolveRegions(items) {
    const geometry = [];
    const unresolved = [];
    for (const region of items) {
      const rules = getter(region, 'getState_RuleType', []);
      const ruleTypes = Array.isArray(rules) ? rules.map(Number).filter(Number.isFinite) : [];
      if (!ruleTypes.some((rule) => KEEP_OUT_RULES.has(rule))) continue;
      const polygon = getter(region, 'getState_ComplexPolygon');
      const source = sourceOf(polygon);
      const circle = analyticCircle(source);
      if (circle) {
        geometry.push({ primitiveId: primitiveId(region), layer: Number(getter(region, 'getState_Layer')), ruleTypes, circle, source });
        continue;
      }
      if (typeof polygon?.discretize !== 'function') {
        unresolved.push({ primitiveId: primitiveId(region), code: 'REGION_DISCRETIZE_UNAVAILABLE' });
        continue;
      }
      try {
        const raw = await polygon.discretize({ tolerance: 1 });
        const points = (Array.isArray(raw) ? raw : [])
          .map((point) => ({ x: Number(point.x), y: Number(point.y) }))
          .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
        if (points.length < 3) unresolved.push({ primitiveId: primitiveId(region), code: 'REGION_GEOMETRY_INCOMPLETE' });
        else geometry.push({ primitiveId: primitiveId(region), layer: Number(getter(region, 'getState_Layer')), ruleTypes, points, source });
      } catch (error) {
        unresolved.push({ primitiveId: primitiveId(region), code: 'REGION_DISCRETIZE_FAILED', message: error.message });
      }
    }
    return { geometry, unresolved };
  }

  function padRadius(shape, x, y) {
    if (!Array.isArray(shape) || shape.length < 2) return null;
    const type = String(shape[0]).toUpperCase();
    if (['RECT', 'RECTANGLE', 'ELLIPSE', 'OBLONG', 'REGULAR_POLYGON'].includes(type)) {
      const width = Number(shape[1]);
      const height = Number(shape[2] ?? shape[1]);
      return Number.isFinite(width) && Number.isFinite(height) ? Math.max(Math.abs(width), Math.abs(height)) / 2 : null;
    }
    if (type === 'POLYGON' && Array.isArray(shape[1])) {
      let radius = 0;
      const values = shape[1];
      for (let index = 0; index + 1 < values.length; index += 2) {
        const px = Number(values[index]);
        const py = Number(values[index + 1]);
        if (Number.isFinite(px) && Number.isFinite(py)) radius = Math.max(radius, Math.hypot(px - x, py - y));
      }
      return radius > 0 ? radius : null;
    }
    return null;
  }

  async function collectPads(components, standalonePads) {
    const pads = new Map();
    const add = (pad, componentId = null, designator = null) => {
      const id = primitiveId(pad);
      if (id !== null && pads.has(String(id))) return;
      const x = finite(getter(pad, 'getState_X'));
      const y = finite(getter(pad, 'getState_Y'));
      const shape = getter(pad, 'getState_Pad');
      pads.set(id === null ? `anonymous-${pads.size}` : String(id), {
        primitiveId: id,
        componentId,
        designator,
        padNumber: String(getter(pad, 'getState_PadNumber', '')),
        net: getter(pad, 'getState_Net', ''),
        layer: finite(getter(pad, 'getState_Layer')),
        x,
        y,
        radius: x === null || y === null ? null : padRadius(shape, x, y),
        shapeType: Array.isArray(shape) ? shape[0] : null,
      });
    };
    for (const component of components) {
      const componentId = primitiveId(component);
      const designator = getter(component, 'getState_Designator', '');
      let pins = [];
      if (typeof component.getAllPins === 'function') pins = await component.getAllPins();
      else if (typeof eda.pcb_PrimitiveComponent?.getAllPinsByPrimitiveId === 'function') {
        pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(componentId);
      }
      for (const pin of Array.isArray(pins) ? pins : []) add(pin, componentId, designator);
    }
    for (const pad of standalonePads) add(pad);
    return [...pads.values()];
  }

  function summarizeVia(item) {
    return {
      primitiveId: primitiveId(item),
      net: getter(item, 'getState_Net', ''),
      x: finite(getter(item, 'getState_X')),
      y: finite(getter(item, 'getState_Y')),
      diameter: finite(getter(item, 'getState_Diameter')),
      holeDiameter: finite(getter(item, 'getState_HoleDiameter')),
    };
  }

  function summarizeLine(item) {
    return {
      primitiveId: primitiveId(item),
      net: getter(item, 'getState_Net', ''),
      layer: finite(getter(item, 'getState_Layer')),
      width: finite(getter(item, 'getState_LineWidth'), 0),
      start: { x: finite(getter(item, 'getState_StartX')), y: finite(getter(item, 'getState_StartY')) },
      end: { x: finite(getter(item, 'getState_EndX')), y: finite(getter(item, 'getState_EndY')) },
    };
  }

  function summarizeArc(item) {
    return { ...summarizeLine(item), angle: finite(getter(item, 'getState_ArcAngle')) };
  }

  function arcSegments(arc) {
    const angleDegrees = Number(arc.angle);
    const angle = angleDegrees * Math.PI / 180;
    const dx = arc.end.x - arc.start.x;
    const dy = arc.end.y - arc.start.y;
    const chord = Math.hypot(dx, dy);
    if (!Number.isFinite(angle) || Math.abs(angle) < 1e-9 || chord === 0 || Math.abs(Math.sin(angle / 2)) < 1e-9) return null;
    const middle = { x: (arc.start.x + arc.end.x) / 2, y: (arc.start.y + arc.end.y) / 2 };
    const offset = chord / (2 * Math.tan(angle / 2));
    const center = { x: middle.x - dy / chord * offset, y: middle.y + dx / chord * offset };
    const startAngle = Math.atan2(arc.start.y - center.y, arc.start.x - center.x);
    const radius = Math.hypot(arc.start.x - center.x, arc.start.y - center.y);
    const count = Math.max(2, Math.ceil(Math.abs(angleDegrees) / 5));
    const points = [];
    for (let index = 0; index <= count; index += 1) {
      const theta = startAngle + angle * index / count;
      points.push({ x: center.x + radius * Math.cos(theta), y: center.y + radius * Math.sin(theta) });
    }
    return points;
  }

  async function captureState() {
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if (!document || Number(document.documentType) !== 3) fail('PCB_DOCUMENT_REQUIRED', 'The active EasyEDA document is not a PCB.');
    const results = await Promise.all([
      query('layers', eda.pcb_Layer, 'getAllLayers'),
      query('polylines', eda.pcb_PrimitivePolyline),
      query('regions', eda.pcb_PrimitiveRegion),
      query('vias', eda.pcb_PrimitiveVia),
      query('components', eda.pcb_PrimitiveComponent),
      query('pads', eda.pcb_PrimitivePad),
      query('lines', eda.pcb_PrimitiveLine),
      query('arcs', eda.pcb_PrimitiveArc),
      query('pours', eda.pcb_PrimitivePour),
      query('poured', eda.pcb_PrimitivePoured),
    ]);
    const byLabel = new Map(results.map((result) => [result.label, result]));
    const outline = await resolveOutline(byLabel.get('polylines').items);
    const regions = await resolveRegions(byLabel.get('regions').items);
    const pads = await collectPads(byLabel.get('components').items, byLabel.get('pads').items);
    const copperLayers = activeCopperLayerIds(byLabel.get('layers').items);
    const lines = byLabel.get('lines').items.map(summarizeLine)
      .filter((item) => copperLayers.includes(item.layer) && item.start.x !== null && item.start.y !== null && item.end.x !== null && item.end.y !== null);
    const arcs = byLabel.get('arcs').items.map(summarizeArc)
      .filter((item) => copperLayers.includes(item.layer) && item.start.x !== null && item.start.y !== null && item.end.x !== null && item.end.y !== null);
    const vias = byLabel.get('vias').items.map(summarizeVia);
    const pours = byLabel.get('pours').items.map((item) => ({
      primitiveId: primitiveId(item),
      net: getter(item, 'getState_Net', ''),
      layer: finite(getter(item, 'getState_Layer')),
    }));
    const poured = byLabel.get('poured').items.map((item) => {
      const fills = getter(item, 'getState_PourFills', []);
      return {
        primitiveId: primitiveId(item),
        pourPrimitiveId: getter(item, 'getState_PourPrimitiveId'),
        fillCount: Array.isArray(fills) ? fills.length : 0,
      };
    });
    const coverageEntries = results.map(({ label, status, error }) => ({ label, status, error }));
    const coverageComplete = coverageEntries.every((entry) => entry.status === 'ok')
      && outline.status === 'resolved'
      && regions.unresolved.length === 0;
    const fingerprintPayload = {
      documentUuid: document.uuid,
      copperLayers,
      outline: { source: outline.source, points: outline.points },
      regions: regions.geometry,
      vias,
      pads,
      lines,
      arcs,
      pours,
      poured,
    };
    return {
      document: { uuid: document.uuid, tabId: document.tabId, documentType: document.documentType, parentProjectUuid: document.parentProjectUuid ?? null },
      copperLayers,
      outline,
      regions,
      vias,
      pads,
      lines,
      arcs,
      pours,
      poured,
      coverage: { complete: coverageComplete, entries: coverageEntries },
      plannerFingerprint: hashText(stableStringify(fingerprintPayload)),
    };
  }

  function normalizeRequest(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_STITCHING_REQUEST', 'generation must be an object.');
    if (raw.schemaVersion !== 1) fail('INVALID_STITCHING_REQUEST', 'generation.schemaVersion must be 1.');
    if (typeof raw.expectedDocumentUuid !== 'string' || !raw.expectedDocumentUuid) fail('INVALID_STITCHING_REQUEST', 'expectedDocumentUuid is required.');
    if (typeof raw.expectedInspectionFingerprint !== 'string' || !raw.expectedInspectionFingerprint) {
      fail('INVALID_STITCHING_REQUEST', 'expectedInspectionFingerprint is required from pcb-grounding-inspect.js.');
    }
    if (typeof raw.net !== 'string' || !raw.net.trim()) fail('INVALID_STITCHING_REQUEST', 'net is required.');
    const via = {
      holeDiameter: positive(raw.via?.holeDiameter, 'via.holeDiameter'),
      diameter: positive(raw.via?.diameter, 'via.diameter'),
      viaType: raw.via?.viaType ?? null,
      designRuleBlindViaName: raw.via?.designRuleBlindViaName ?? null,
      solderMaskExpansion: clone(raw.via?.solderMaskExpansion),
      primitiveLock: Boolean(raw.via?.primitiveLock),
    };
    if (via.diameter <= via.holeDiameter) fail('INVALID_STITCHING_REQUEST', 'via.diameter must exceed via.holeDiameter.');
    const clearance = nonNegative(raw.clearance, 'clearance');
    const edgeClearance = nonNegative(raw.edgeClearance, 'edgeClearance', clearance);
    const minimumCenterSpacing = nonNegative(raw.minimumCenterSpacing, 'minimumCenterSpacing');
    const maxSelected = boundedInteger(raw.maxSelected, 'maxSelected', 64, 1, MAX_SELECTED);
    const requiredGroundLayerIds = [...new Set((Array.isArray(raw.requiredGroundLayerIds) ? raw.requiredGroundLayerIds : []).map(Number))];
    if (requiredGroundLayerIds.length === 0) fail('INVALID_STITCHING_REQUEST', 'requiredGroundLayerIds must declare the realized GND layers for this stage.');
    if (!Array.isArray(raw.strategies) || raw.strategies.length === 0) fail('INVALID_STITCHING_REQUEST', 'strategies must contain at least one strategy.');
    const allowedDirections = new Set(['left', 'right', 'up', 'down']);
    const strategies = raw.strategies.map((strategy, index) => {
      const type = String(strategy?.type ?? '');
      const maximum = boundedInteger(strategy?.maxCount, `strategies[${index}].maxCount`, maxSelected, 1, maxSelected);
      if (type === 'plane-grid') {
        return {
          type,
          pitch: positive(strategy.pitch, `strategies[${index}].pitch`),
          inset: nonNegative(strategy.inset, `strategies[${index}].inset`, via.diameter / 2 + edgeClearance),
          minimumGroundViaDistance: nonNegative(strategy.minimumGroundViaDistance, `strategies[${index}].minimumGroundViaDistance`, 0),
          stagger: strategy.stagger === true,
          maxCount: maximum,
        };
      }
      if (type === 'edge-fence') {
        const inset = positive(strategy.inset, `strategies[${index}].inset`);
        if (inset < via.diameter / 2 + edgeClearance) {
          fail('INVALID_STITCHING_REQUEST', `strategies[${index}].inset is smaller than the via edge margin.`);
        }
        return {
          type,
          spacing: positive(strategy.spacing, `strategies[${index}].spacing`),
          inset,
          candidateSamplesPerSpacing: boundedInteger(
            strategy.candidateSamplesPerSpacing,
            `strategies[${index}].candidateSamplesPerSpacing`,
            4,
            1,
            16,
          ),
          minimumGroundViaDistance: nonNegative(strategy.minimumGroundViaDistance, `strategies[${index}].minimumGroundViaDistance`, 0),
          maxCount: maximum,
        };
      }
      if (type === 'signal-transition-return') {
        const directions = Array.isArray(strategy.directions) && strategy.directions.length > 0
          ? [...new Set(strategy.directions.map(String))]
          : ['right', 'left', 'down', 'up'];
        if (directions.some((direction) => !allowedDirections.has(direction))) {
          fail('INVALID_STITCHING_REQUEST', `strategies[${index}].directions contains an unsupported direction.`);
        }
        return {
          type,
          gap: nonNegative(strategy.gap, `strategies[${index}].gap`, 10),
          directions,
          nets: Array.isArray(strategy.nets) ? [...new Set(strategy.nets.map(String))] : [],
          countPerVia: boundedInteger(strategy.countPerVia, `strategies[${index}].countPerVia`, 1, 1, 4),
          skipIfGroundViaWithin: nonNegative(strategy.skipIfGroundViaWithin, `strategies[${index}].skipIfGroundViaWithin`, 0),
          maxCount: maximum,
        };
      }
      fail('INVALID_STITCHING_REQUEST', `Unsupported strategy type: ${type}`);
    });
    return {
      schemaVersion: 1,
      expectedDocumentUuid: raw.expectedDocumentUuid,
      expectedInspectionFingerprint: raw.expectedInspectionFingerprint,
      net: raw.net.trim(),
      via,
      requiredGroundLayerIds,
      clearance,
      edgeClearance,
      minimumCenterSpacing,
      maxSelected,
      allowSameNetTracks: raw.allowSameNetTracks !== false,
      unresolvedPadNeighborhood: nonNegative(raw.unresolvedPadNeighborhood, 'unresolvedPadNeighborhood', 200),
      strategies,
      detailLevel: raw.detailLevel === 'full' ? 'full' : 'summary',
    };
  }

  function addProposal(proposals, proposal) {
    if (proposals.length >= MAX_PROPOSALS) fail('STITCHING_PROPOSAL_BOUND_EXCEEDED', `Proposal generation exceeded ${MAX_PROPOSALS}.`);
    proposals.push(proposal);
  }

  function directionOffset(direction, distance) {
    if (direction === 'left') return { x: -distance, y: 0 };
    if (direction === 'right') return { x: distance, y: 0 };
    if (direction === 'up') return { x: 0, y: distance };
    return { x: 0, y: -distance };
  }

  function generateProposals(state, generation) {
    const proposals = [];
    const bounds = outlineBounds(state.outline);
    const perimeter = perimeterModel(state.outline.points);
    for (let strategyIndex = 0; strategyIndex < generation.strategies.length; strategyIndex += 1) {
      const strategy = generation.strategies[strategyIndex];
      if (strategy.type === 'plane-grid') {
        let row = 0;
        for (let y = bounds.minY + strategy.inset; y <= bounds.maxY - strategy.inset + 1e-9; y += strategy.pitch) {
          const stagger = strategy.stagger && row % 2 === 1 ? strategy.pitch / 2 : 0;
          for (let x = bounds.minX + strategy.inset + stagger; x <= bounds.maxX - strategy.inset + 1e-9; x += strategy.pitch) {
            addProposal(proposals, {
              key: `plane-grid-${row + 1}-${Math.round((x - bounds.minX) * 1000)}`,
              strategy: strategy.type,
              score: 40,
              x,
              y,
              minimumGroundViaDistance: strategy.minimumGroundViaDistance,
              strategyMaxCount: strategy.maxCount,
              strategyIndex,
              rationale: 'Connect sparse open ground-plane areas after routing is stable.',
              anchor: { kind: 'grid', row, strategyIndex },
            });
          }
          row += 1;
        }
      } else if (strategy.type === 'edge-fence') {
        if (!perimeter) fail('BOARD_OUTLINE_PERIMETER_UNRESOLVED', 'Could not parameterize the board perimeter for edge fencing.');
        const sampleCount = Math.max(1, Math.ceil(perimeter.length / strategy.spacing) * strategy.candidateSamplesPerSpacing);
        const actualSpacing = perimeter.length / sampleCount;
        for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
          const sample = samplePerimeter(perimeter, (sampleIndex + 0.5) * actualSpacing);
          addProposal(proposals, {
            key: `edge-fence-${String(sampleIndex + 1).padStart(4, '0')}`,
            strategy: strategy.type,
            score: 70,
            x: sample.boundary.x + sample.inward.x * strategy.inset,
            y: sample.boundary.y + sample.inward.y * strategy.inset,
            minimumGroundViaDistance: strategy.minimumGroundViaDistance,
            strategyMaxCount: strategy.maxCount,
            strategyIndex,
            rationale: 'Stitch the ground structure near a verified convex board edge with perimeter-balanced coverage.',
            anchor: {
              kind: 'board-edge',
              strategyIndex,
              sampleIndex,
              sampleCount,
              perimeterPosition: sample.perimeterPosition,
              perimeterFraction: sample.perimeterFraction,
              perimeterLength: perimeter.length,
            },
          });
        }
      } else if (strategy.type === 'signal-transition-return') {
        let considered = 0;
        for (const signalVia of state.vias.filter((item) => item.net && item.net !== generation.net)) {
          if (strategy.nets.length > 0 && !strategy.nets.includes(signalVia.net)) continue;
          if (![signalVia.x, signalVia.y, signalVia.diameter].every(Number.isFinite)) continue;
          const nearestGround = state.vias
            .filter((item) => item.net === generation.net && Number.isFinite(item.x) && Number.isFinite(item.y))
            .reduce((minimum, item) => Math.min(minimum, Math.hypot(signalVia.x - item.x, signalVia.y - item.y)), Infinity);
          if (strategy.skipIfGroundViaWithin > 0 && nearestGround <= strategy.skipIfGroundViaWithin) continue;
          const distance = signalVia.diameter / 2 + generation.via.diameter / 2 + strategy.gap;
          for (const direction of strategy.directions) {
            const offset = directionOffset(direction, distance);
            addProposal(proposals, {
              key: `signal-return-${signalVia.primitiveId ?? considered + 1}-${direction}`,
              strategy: strategy.type,
              score: 100,
              x: signalVia.x + offset.x,
              y: signalVia.y + offset.y,
              minimumGroundViaDistance: 0,
              strategyMaxCount: strategy.maxCount,
              strategyIndex,
              rationale: `Provide a vertical GND return beside signal via ${signalVia.primitiveId ?? considered + 1} (${signalVia.net}).`,
              anchor: {
                kind: 'signal-via',
                strategyIndex,
                primitiveId: signalVia.primitiveId,
                net: signalVia.net,
                countPerVia: strategy.countPerVia,
              },
            });
          }
          considered += 1;
        }
      }
    }
    return proposals;
  }

  function candidateTouchesRegion(candidate, region, margin) {
    if (region.circle) {
      return Math.hypot(candidate.x - region.circle.x, candidate.y - region.circle.y)
        <= candidate.diameter / 2 + margin + region.circle.radius;
    }
    if (pointInPolygon(candidate, region.points)) return true;
    return minimumBoundaryDistance(candidate, region.points) <= candidate.diameter / 2 + margin;
  }

  function analyzeProposal(state, generation, proposal) {
    const candidate = { ...proposal, diameter: generation.via.diameter, holeDiameter: generation.via.holeDiameter };
    const issues = [];
    if (!outlineContains(state.outline, candidate, generation.via.diameter / 2 + generation.edgeClearance)) {
      issues.push({ code: 'BOARD_EDGE_COLLISION' });
    }
    for (const region of state.regions.geometry) {
      if (candidateTouchesRegion(candidate, region, generation.clearance)) {
        issues.push({ code: 'KEEPOUT_COLLISION', primitiveId: region.primitiveId, ruleTypes: region.ruleTypes });
      }
    }
    for (const pad of state.pads) {
      if (!Number.isFinite(pad.x) || !Number.isFinite(pad.y) || pad.radius === null) {
        if (Number.isFinite(pad.x) && Number.isFinite(pad.y)
          && Math.hypot(candidate.x - pad.x, candidate.y - pad.y) < generation.unresolvedPadNeighborhood) {
          issues.push({ code: 'PAD_GEOMETRY_UNRESOLVED', primitiveId: pad.primitiveId, designator: pad.designator, padNumber: pad.padNumber });
        }
        continue;
      }
      if (Math.hypot(candidate.x - pad.x, candidate.y - pad.y)
        < generation.via.diameter / 2 + generation.clearance + pad.radius) {
        issues.push({ code: 'PAD_CLEARANCE', primitiveId: pad.primitiveId, designator: pad.designator, padNumber: pad.padNumber, net: pad.net });
      }
    }
    for (const line of state.lines) {
      if (generation.allowSameNetTracks && line.net === generation.net) continue;
      if (distanceToSegment(candidate, line.start, line.end)
        < generation.via.diameter / 2 + generation.clearance + line.width / 2) {
        issues.push({ code: 'TRACK_CLEARANCE', primitiveId: line.primitiveId, net: line.net, layer: line.layer });
      }
    }
    for (const arc of state.arcs) {
      if (generation.allowSameNetTracks && arc.net === generation.net) continue;
      const points = arcSegments(arc);
      if (!points) {
        if (Math.min(Math.hypot(candidate.x - arc.start.x, candidate.y - arc.start.y), Math.hypot(candidate.x - arc.end.x, candidate.y - arc.end.y))
          < generation.unresolvedPadNeighborhood) {
          issues.push({ code: 'ARC_GEOMETRY_UNRESOLVED', primitiveId: arc.primitiveId, net: arc.net, layer: arc.layer });
        }
        continue;
      }
      let distance = Infinity;
      for (let index = 0; index + 1 < points.length; index += 1) {
        distance = Math.min(distance, distanceToSegment(candidate, points[index], points[index + 1]));
      }
      if (distance < generation.via.diameter / 2 + generation.clearance + arc.width / 2) {
        issues.push({ code: 'ARC_CLEARANCE', primitiveId: arc.primitiveId, net: arc.net, layer: arc.layer });
      }
    }
    let nearestGroundViaDistance = Infinity;
    for (const existing of state.vias) {
      if (![existing.x, existing.y, existing.diameter].every(Number.isFinite)) continue;
      const centerDistance = Math.hypot(candidate.x - existing.x, candidate.y - existing.y);
      const minimum = generation.via.diameter / 2 + existing.diameter / 2 + generation.minimumCenterSpacing;
      if (centerDistance < minimum) issues.push({ code: 'EXISTING_VIA_COLLISION', primitiveId: existing.primitiveId, net: existing.net });
      if (existing.net === generation.net) nearestGroundViaDistance = Math.min(nearestGroundViaDistance, centerDistance);
    }
    if (proposal.minimumGroundViaDistance > 0 && nearestGroundViaDistance < proposal.minimumGroundViaDistance) {
      issues.push({ code: 'REDUNDANT_GROUND_VIA', nearestGroundViaDistance });
    }
    return { candidate: { ...candidate, nearestGroundViaDistance: Number.isFinite(nearestGroundViaDistance) ? nearestGroundViaDistance : null }, issues };
  }

  function selectCandidates(analyzed, generation, state) {
    const accepted = analyzed.filter((item) => item.issues.length === 0)
      .sort((left, right) => right.candidate.score - left.candidate.score || left.candidate.key.localeCompare(right.candidate.key));
    const selected = [];
    const perStrategy = new Map();
    const perAnchor = new Map();
    const skipped = [];

    function strategyKey(candidate) {
      return `${candidate.strategy}:${candidate.strategyIndex ?? 0}`;
    }

    function recordSkip(candidate, issue) {
      skipped.push({ candidate, issues: [issue] });
    }

    function trySelect(candidate) {
      if (selected.length >= generation.maxSelected) return false;
      const key = strategyKey(candidate);
      const strategyCount = perStrategy.get(key) ?? 0;
      if (strategyCount >= candidate.strategyMaxCount) {
        recordSkip(candidate, { code: 'STRATEGY_LIMIT_REACHED' });
        return false;
      }
      if (candidate.anchor?.kind === 'signal-via') {
        const anchorKey = String(candidate.anchor.primitiveId);
        const anchorCount = perAnchor.get(anchorKey) ?? 0;
        if (anchorCount >= candidate.anchor.countPerVia) {
          recordSkip(candidate, { code: 'ANCHOR_LIMIT_REACHED' });
          return false;
        }
      }
      const collision = selected.find((other) => Math.hypot(candidate.x - other.x, candidate.y - other.y)
        < generation.via.diameter + generation.minimumCenterSpacing);
      if (collision) {
        recordSkip(candidate, { code: 'SELECTED_VIA_COLLISION', otherKey: collision.key });
        return false;
      }
      selected.push(candidate);
      perStrategy.set(key, strategyCount + 1);
      if (candidate.anchor?.kind === 'signal-via') {
        const anchorKey = String(candidate.anchor.primitiveId);
        perAnchor.set(anchorKey, (perAnchor.get(anchorKey) ?? 0) + 1);
      }
      return true;
    }

    function selectOrdinary(items) {
      for (const item of items) {
        if (selected.length >= generation.maxSelected) return;
        trySelect(item.candidate);
      }
    }

    function selectEdge(items) {
      if (items.length === 0 || selected.length >= generation.maxSelected) return;
      const maximum = Math.min(items[0].candidate.strategyMaxCount, generation.maxSelected - selected.length);
      if (maximum <= 0) return;
      const strategyIndex = items[0].candidate.strategyIndex ?? 0;
      const strategy = generation.strategies[strategyIndex];
      const perimeter = perimeterModel(state.outline.points);
      if (!perimeter) return;
      const existingCoverage = state.vias
        .filter((via) => via.net === generation.net && Number.isFinite(via.x) && Number.isFinite(via.y))
        .map((via) => ({ via, projection: projectToPerimeter(perimeter, via) }))
        .filter((item) => item.projection && item.projection.distance <= strategy.inset + strategy.minimumGroundViaDistance);
      const bins = Array.from({ length: maximum }, () => []);
      for (const item of items) {
        const fraction = item.candidate.anchor?.perimeterFraction;
        if (!Number.isFinite(fraction)) {
          recordSkip(item.candidate, { code: 'EDGE_PERIMETER_POSITION_MISSING' });
          continue;
        }
        const binIndex = Math.min(maximum - 1, Math.floor(fraction * maximum));
        bins[binIndex].push(item.candidate);
      }
      const existingBins = new Set(existingCoverage.map((item) => (
        Math.min(maximum - 1, Math.floor(item.projection.perimeterFraction * maximum))
      )));
      const unavailable = new Set();
      for (let binIndex = 0; binIndex < bins.length; binIndex += 1) {
        if (existingBins.has(binIndex)) continue;
        const center = (binIndex + 0.5) / bins.length;
        const ranked = bins[binIndex].sort((left, right) => {
          const leftDistance = Math.abs(left.anchor.perimeterFraction - center);
          const rightDistance = Math.abs(right.anchor.perimeterFraction - center);
          if (Math.abs(leftDistance - rightDistance) > 1e-12) return leftDistance - rightDistance;
          const leftGround = Number.isFinite(left.nearestGroundViaDistance) ? left.nearestGroundViaDistance : Number.MAX_VALUE;
          const rightGround = Number.isFinite(right.nearestGroundViaDistance) ? right.nearestGroundViaDistance : Number.MAX_VALUE;
          return rightGround - leftGround || left.key.localeCompare(right.key);
        });
        for (const candidate of ranked) {
          if (trySelect(candidate)) {
            candidate.anchor.coverageBin = binIndex;
            candidate.anchor.coverageBinCount = bins.length;
            break;
          }
          unavailable.add(candidate.key);
        }
      }

      const key = strategyKey(items[0].candidate);
      while ((perStrategy.get(key) ?? 0) < maximum && selected.length < generation.maxSelected) {
        const edgeSelected = selected.filter((candidate) => strategyKey(candidate) === key);
        const remaining = items.map((item) => item.candidate)
          .filter((candidate) => !edgeSelected.some((chosen) => chosen.key === candidate.key) && !unavailable.has(candidate.key));
        if (remaining.length === 0) break;
        remaining.sort((left, right) => {
          const circumference = left.anchor.perimeterLength;
          const coveragePositions = [
            ...existingCoverage.map((item) => item.projection.perimeterPosition),
            ...edgeSelected.map((chosen) => chosen.anchor.perimeterPosition),
          ];
          const currentGap = maximumCyclicGap(coveragePositions, circumference) ?? circumference;
          const leftGap = maximumCyclicGap([...coveragePositions, left.anchor.perimeterPosition], circumference) ?? circumference;
          const rightGap = maximumCyclicGap([...coveragePositions, right.anchor.perimeterPosition], circumference) ?? circumference;
          const leftDistance = currentGap - leftGap;
          const rightDistance = currentGap - rightGap;
          if (Math.abs(leftDistance - rightDistance) > 1e-9) return rightDistance - leftDistance;
          const leftGround = Number.isFinite(left.nearestGroundViaDistance) ? left.nearestGroundViaDistance : Number.MAX_VALUE;
          const rightGround = Number.isFinite(right.nearestGroundViaDistance) ? right.nearestGroundViaDistance : Number.MAX_VALUE;
          return rightGround - leftGround || left.key.localeCompare(right.key);
        });
        const edgeSelectedBefore = selected.filter((candidate) => strategyKey(candidate) === key);
        const coverageBefore = [
          ...existingCoverage.map((item) => item.projection.perimeterPosition),
          ...edgeSelectedBefore.map((chosen) => chosen.anchor.perimeterPosition),
        ];
        const circumference = remaining[0].anchor.perimeterLength;
        const currentGap = maximumCyclicGap(coverageBefore, circumference) ?? circumference;
        const bestGap = maximumCyclicGap([...coverageBefore, remaining[0].anchor.perimeterPosition], circumference) ?? circumference;
        if (currentGap - bestGap <= 1e-9) break;
        let added = false;
        for (const candidate of remaining) {
          if (trySelect(candidate)) {
            candidate.anchor.coverageBin = Math.min(maximum - 1, Math.floor(candidate.anchor.perimeterFraction * maximum));
            candidate.anchor.coverageBinCount = maximum;
            added = true;
            break;
          }
          unavailable.add(candidate.key);
        }
        if (!added) break;
      }
    }

    const scoreLevels = [...new Set(accepted.map((item) => item.candidate.score))].sort((left, right) => right - left);
    for (const score of scoreLevels) {
      const level = accepted.filter((item) => item.candidate.score === score);
      selectOrdinary(level.filter((item) => item.candidate.strategy !== 'edge-fence'));
      const edgeGroups = new Map();
      for (const item of level.filter((candidate) => candidate.candidate.strategy === 'edge-fence')) {
        const key = strategyKey(item.candidate);
        if (!edgeGroups.has(key)) edgeGroups.set(key, []);
        edgeGroups.get(key).push(item);
      }
      for (const items of edgeGroups.values()) selectEdge(items);
    }
    return { selected, skipped };
  }

  function edgeCoverageQuality(selected, generation, state) {
    const reports = [];
    const perimeter = perimeterModel(state.outline.points);
    for (let strategyIndex = 0; strategyIndex < generation.strategies.length; strategyIndex += 1) {
      const strategy = generation.strategies[strategyIndex];
      if (strategy.type !== 'edge-fence') continue;
      const candidates = selected.filter((candidate) => candidate.strategy === 'edge-fence' && candidate.strategyIndex === strategyIndex);
      const perimeterLength = perimeter?.length ?? candidates[0]?.anchor?.perimeterLength ?? null;
      const binCount = candidates[0]?.anchor?.coverageBinCount ?? Math.min(strategy.maxCount, generation.maxSelected);
      const existingCoverage = perimeter ? state.vias
        .filter((via) => via.net === generation.net && Number.isFinite(via.x) && Number.isFinite(via.y))
        .map((via) => ({ via, projection: projectToPerimeter(perimeter, via) }))
        .filter((item) => item.projection && item.projection.distance <= strategy.inset + strategy.minimumGroundViaDistance) : [];
      const newOccupiedBins = [...new Set(candidates.map((candidate) => candidate.anchor?.coverageBin).filter(Number.isInteger))].sort((a, b) => a - b);
      const existingOccupiedBins = [...new Set(existingCoverage.map((item) => (
        Math.min(binCount - 1, Math.floor(item.projection.perimeterFraction * binCount))
      )))].sort((a, b) => a - b);
      const occupiedBins = [...new Set([...newOccupiedBins, ...existingOccupiedBins])].sort((a, b) => a - b);
      const newPositions = candidates.map((candidate) => candidate.anchor?.perimeterPosition).filter(Number.isFinite);
      const existingPositions = existingCoverage.map((item) => item.projection.perimeterPosition);
      const maximumArcGap = maximumCyclicGap([...existingPositions, ...newPositions], perimeterLength);
      const existingMaximumArcGap = maximumCyclicGap(existingPositions, perimeterLength);
      reports.push({
        strategyIndex,
        method: 'existing-coverage-seeded-perimeter-bins-then-farthest-point',
        requestedMaxCount: strategy.maxCount,
        selectedCount: candidates.length,
        existingEdgeGroundViaCount: existingCoverage.length,
        perimeterLength,
        binCount,
        occupiedBinCount: occupiedBins.length,
        emptyBinCount: Math.max(0, binCount - occupiedBins.length),
        occupiedBins,
        newOccupiedBinCount: newOccupiedBins.length,
        newOccupiedBins,
        existingOccupiedBinCount: existingOccupiedBins.length,
        existingOccupiedBins,
        existingMaximumArcGap,
        existingMaximumArcGapFraction: Number.isFinite(existingMaximumArcGap) && Number.isFinite(perimeterLength)
          ? existingMaximumArcGap / perimeterLength : null,
        maximumArcGap,
        maximumArcGapFraction: Number.isFinite(maximumArcGap) && Number.isFinite(perimeterLength) ? maximumArcGap / perimeterLength : null,
      });
    }
    return { edgeFences: reports };
  }

  function compactRejections(items) {
    const counts = new Map();
    for (const item of items) for (const issue of item.issues) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
    return [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0])).map(([code, count]) => ({ code, count }));
  }

  function publicState(state) {
    return {
      document: state.document,
      plannerFingerprint: state.plannerFingerprint,
      coverage: state.coverage,
      copperLayers: state.copperLayers,
      outline: {
        status: state.outline.status,
        primitiveId: state.outline.primitiveId ?? null,
        sourceKind: state.outline.sourceKind ?? null,
        pointCount: state.outline.points.length,
        convex: state.outline.status === 'resolved' ? isConvex(state.outline.points) : null,
        issue: state.outline.issue ?? null,
      },
      counts: {
        regions: state.regions.geometry.length,
        unresolvedRegions: state.regions.unresolved.length,
        vias: state.vias.length,
        pads: state.pads.length,
        lines: state.lines.length,
        arcs: state.arcs.length,
        pours: state.pours.length,
        poured: state.poured.length,
      },
    };
  }

  function groundLayerIssues(state, generation) {
    const issues = [];
    for (const layerId of generation.requiredGroundLayerIds) {
      if (!state.copperLayers.includes(layerId)) {
        issues.push({ code: 'REQUIRED_GROUND_LAYER_INACTIVE', layerId });
        continue;
      }
      const borders = state.pours.filter((item) => item.net === generation.net && item.layer === layerId);
      if (borders.length !== 1) {
        issues.push({ code: 'GROUND_POUR_BORDER_COUNT', layerId, count: borders.length });
        continue;
      }
      const realized = state.poured.filter((item) => item.pourPrimitiveId === borders[0].primitiveId && item.fillCount > 0);
      if (realized.length !== 1) issues.push({ code: 'REALIZED_GROUND_COPPER_MISSING', layerId });
    }
    return issues;
  }

  const mode = request.mode ?? 'inspect';
  const state = await captureState();
  if (mode === 'inspect') {
    if (request.expectedDocumentUuid && state.document.uuid !== request.expectedDocumentUuid) {
      fail('DOCUMENT_MISMATCH', `Expected ${request.expectedDocumentUuid}, got ${state.document.uuid}.`);
    }
    return { schemaVersion: 1, status: 'inspected', readOnly: true, state: publicState(state) };
  }
  if (mode !== 'generate') fail('UNSUPPORTED_STITCHING_MODE', `Unsupported mode: ${mode}`);

  const generation = normalizeRequest(request.generation);
  const globalIssues = [];
  if (state.document.uuid !== generation.expectedDocumentUuid) {
    globalIssues.push({ code: 'DOCUMENT_MISMATCH', expected: generation.expectedDocumentUuid, actual: state.document.uuid });
  }
  if (!state.coverage.complete) globalIssues.push({ code: 'INCOMPLETE_GEOMETRY_COVERAGE', coverage: state.coverage });
  if (state.outline.status !== 'resolved') globalIssues.push(state.outline.issue ?? { code: 'BOARD_OUTLINE_UNRESOLVED' });
  if (state.regions.unresolved.length > 0) globalIssues.push(...state.regions.unresolved);
  if (generation.strategies.some((strategy) => strategy.type === 'edge-fence')
    && state.outline.status === 'resolved' && !isConvex(state.outline.points)) {
    globalIssues.push({ code: 'EDGE_FENCE_REQUIRES_CONVEX_OUTLINE' });
  }
  globalIssues.push(...groundLayerIssues(state, generation));

  const proposals = globalIssues.length === 0 ? generateProposals(state, generation) : [];
  const analyzed = proposals.map((proposal) => analyzeProposal(state, generation, proposal));
  const rejected = analyzed.filter((item) => item.issues.length > 0);
  const selection = selectCandidates(analyzed, generation, state);
  const selected = selection.selected;
  const selectionQuality = edgeCoverageQuality(selected, generation, state);
  if (globalIssues.length === 0 && selected.length === 0) globalIssues.push({ code: 'NO_USEFUL_STITCHING_CANDIDATES' });
  const plannerEvidenceFingerprint = hashText(stableStringify({
    plannerFingerprint: state.plannerFingerprint,
    generation,
    proposals: proposals.map(({ key, strategy, x, y }) => ({ key, strategy, x, y })),
    selected: selected.map(({ key, strategy, x, y }) => ({ key, strategy, x, y })),
    rejected: rejected.map((item) => ({ key: item.candidate.key, codes: item.issues.map((issue) => issue.code) })),
    selectionQuality,
    globalIssueCodes: globalIssues.map((issue) => issue.code),
  }));
  const plan = globalIssues.length === 0 ? {
    schemaVersion: 1,
    expectedDocumentUuid: generation.expectedDocumentUuid,
    expectedInspectionFingerprint: generation.expectedInspectionFingerprint,
    net: generation.net,
    clearance: generation.clearance,
    minimumCenterSpacing: generation.minimumCenterSpacing,
    boardContainmentConfirmed: true,
    boardContainmentEvidence: `pcb-ground-stitching:${plannerEvidenceFingerprint}:outline-${state.outline.sourceKind}`,
    localClearanceConfirmed: true,
    localClearanceEvidence: `pcb-ground-stitching:${plannerEvidenceFingerprint}:pads-${state.pads.length}:lines-${state.lines.length}:arcs-${state.arcs.length}:regions-${state.regions.geometry.length}`,
    vias: selected.map((candidate) => ({
      key: candidate.key,
      x: candidate.x,
      y: candidate.y,
      holeDiameter: generation.via.holeDiameter,
      diameter: generation.via.diameter,
      viaType: generation.via.viaType,
      designRuleBlindViaName: generation.via.designRuleBlindViaName,
      solderMaskExpansion: clone(generation.via.solderMaskExpansion),
      primitiveLock: generation.via.primitiveLock,
      strategy: candidate.strategy,
      score: candidate.score,
      anchor: clone(candidate.anchor),
      rationale: candidate.rationale,
    })),
  } : null;
  const detail = generation.detailLevel === 'full'
    ? { proposals, rejected, skipped: selection.skipped, selected }
    : {
      proposalCount: proposals.length,
      rejectedCount: rejected.length,
      skippedCount: selection.skipped.length,
      selectedCount: selected.length,
      rejectionSummary: compactRejections(rejected),
      skippedSummary: compactRejections(selection.skipped),
      selected: selected.map(({ key, strategy, score, x, y, rationale, anchor }) => ({ key, strategy, score, x, y, rationale, anchor })),
    };
  return {
    schemaVersion: 1,
    status: globalIssues.length === 0 ? 'generated' : 'generated-with-blockers',
    readOnly: true,
    state: publicState(state),
    generation,
    globalIssues,
    plannerEvidenceFingerprint,
    selectionQuality,
    ...detail,
    plan,
    nextRequest: plan ? { mode: 'plan', plan } : null,
    nextAction: plan ? 'Run pcb-ground-vias.js with nextRequest; do not apply directly from this planner.' : null,
  };
})();
