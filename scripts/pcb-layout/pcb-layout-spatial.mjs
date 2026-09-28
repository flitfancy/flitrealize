// Explicit geometric preferences. No inference from designator names or board area.
import { transformBox } from './pcb-layout-geometry.mjs';
import { compileUniformity, evaluateUniformity } from './pcb-layout-uniformity.mjs';

export const spatialKeys = ['proximity', 'spacing', 'whitespace', 'compactness', 'uniformity'];
const finite = n => Number.isFinite(n) && n >= 0;
const boxOK = b => b && ['minX', 'minY', 'maxX', 'maxY'].every(k => Number.isFinite(b[k])) && b.maxX > b.minX && b.maxY > b.minY;
const union = bs => ({ minX: Math.min(...bs.map(b => b.minX)), maxX: Math.max(...bs.map(b => b.maxX)), minY: Math.min(...bs.map(b => b.minY)), maxY: Math.max(...bs.map(b => b.maxY)) });
const gap = (a, b) => Math.max(a.minX - b.maxX, b.minX - a.maxX, a.minY - b.maxY, b.minY - a.maxY);
const geometryKinds = ['body', 'bundle', 'footprint', 'pads', 'silkscreen', 'placement', 'assembly', 'operation'];
const viewKey = kind => ({ body: 'footprint', bundle: 'placement' }[kind] ?? kind);

export function bandPenalty(distance, band) {
  const error = distance < (band.idealMinMil ?? -Infinity) ? band.idealMinMil - distance : distance > (band.idealMaxMil ?? Infinity) ? distance - band.idealMaxMil : 0;
  return (error / band.scaleMil) ** 2;
}

export function compileSpatial(input = {}, components, geometryInput = {}) {
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) throw Error('INVALID_SPATIAL_SCHEMA');
  const ids = new Set();
  function identify(value) {
    if (!value.id || ids.has(value.id)) throw Error('DUPLICATE_OR_MISSING_SPATIAL_ID');
    ids.add(value.id);
  }
  function refsOK(refs) { return Array.isArray(refs) && refs.length && new Set(refs).size === refs.length && refs.every(r => components.has(r)); }
  const localGroups = (input.localGroups ?? []).map(g => {
    identify(g);
    if (!refsOK(g.refs) || g.refs.length < 2 || (g.anchor && !g.refs.includes(g.anchor)) || (g.maxSpanMil !== undefined && (!finite(g.maxSpanMil) || g.maxSpanMil === 0))) throw Error('INVALID_LOCAL_GROUP ' + g.id);
    return { ...g };
  });
  const relations = (input.relations ?? []).map(r => {
    identify(r);
    const anchors = r.anchors ?? (r.b ? [r.b] : []), band = { ...r.band }, weight = r.weight ?? 1;
    if (!components.has(r.a) || !refsOK(anchors) || anchors.includes(r.a) || !['origin-manhattan', 'body-gap', 'bundle-gap', 'geometry-gap'].includes(r.metric) || (r.metric !== 'origin-manhattan' && anchors.length !== 1) || !['proximity', 'spacing'].includes(r.category) || !finite(weight)) throw Error('INVALID_SPATIAL_RELATION ' + r.id);
    if (r.metric === 'geometry-gap' && (!geometryKinds.includes(r.geometryA) || !geometryKinds.includes(r.geometryB))) throw Error('INVALID_RELATION_GEOMETRY ' + r.id);
    if (r.metric !== 'geometry-gap' && (r.geometryA !== undefined || r.geometryB !== undefined)) throw Error('UNUSED_RELATION_GEOMETRY ' + r.id);
    if (!Number.isFinite(band.scaleMil) || band.scaleMil <= 0 || Object.entries(band).some(([k, v]) => !['hardMinMil', 'idealMinMil', 'idealMaxMil', 'hardMaxMil', 'scaleMil'].includes(k) || !finite(v))) throw Error('INVALID_DISTANCE_BAND ' + r.id);
    const bounds = ['hardMinMil', 'idealMinMil', 'idealMaxMil', 'hardMaxMil'].flatMap(k => band[k] === undefined ? [] : [band[k]]);
    if (bounds.some((v, i) => i && v < bounds[i - 1])) throw Error('REVERSED_DISTANCE_BAND ' + r.id);
    return { ...r, anchors, band, weight };
  });
  const zones = (input.zones ?? []).map(z => {
    identify(z);
    const envelope = z.envelopeId === undefined ? undefined : geometryInput.envelopes?.find(e => e.id === z.envelopeId);
    if ((z.envelopeId === undefined ? !boxOK(z.box) : !envelope || z.box !== undefined || (z.owner !== undefined && z.owner !== envelope.ref)) || !['keepout', 'preferEmpty', 'preferFilled'].includes(z.mode) || (z.owner && !components.has(z.owner)) || (z.geometry && !geometryKinds.includes(z.geometry)) || !finite(z.weight ?? 1) || (z.excludeRefs && (!Array.isArray(z.excludeRefs) || (z.excludeRefs.length && !refsOK(z.excludeRefs)))) || (z.targetRefs !== undefined && !refsOK(z.targetRefs))) throw Error('INVALID_SPATIAL_ZONE ' + z.id);
    const owner = envelope?.ref ?? z.owner;
    return { ...z, owner, geometry: z.geometry ?? 'bundle', weight: z.weight ?? 1, excludeRefs: [...new Set([...(z.excludeRefs ?? []), ...(owner ? [owner] : [])])] };
  });
  return { localGroups, relations, zones, uniformity: compileUniformity(input.uniformity) };
}

// Exact union of axis-aligned intersections, so overlapping shapes never earn
// extra occupancy. The target is capped at 100%; ordinary space stays neutral.
export function occupiedArea(boxes, zone) {
  const clips = boxes.map(b => ({ minX: Math.max(b.minX, zone.minX), maxX: Math.min(b.maxX, zone.maxX), minY: Math.max(b.minY, zone.minY), maxY: Math.min(b.maxY, zone.maxY) })).filter(b => b.maxX > b.minX && b.maxY > b.minY);
  const xs = [...new Set(clips.flatMap(b => [b.minX, b.maxX]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 1; i < xs.length; i++) {
    const intervals = clips.filter(b => b.minX < xs[i] && b.maxX > xs[i - 1]).map(b => [b.minY, b.maxY]).sort((a, b) => a[0] - b[0]);
    let length = 0, end = -Infinity;
    for (const [lo, hi] of intervals) { length += Math.max(0, hi - Math.max(lo, end)); end = Math.max(end, hi); }
    area += length * (xs[i] - xs[i - 1]);
  }
  return area;
}

export function evaluateSpatial(rules, components, bundles = [], geometryViews) {
  const positions = new Map(components.map(c => [c.ref, c]));
  const bodies = new Map(components.map(c => [c.ref, c.body ?? c.bbox]));
  const occupied = new Map(bundles.map(b => [b.ref, b.bbox]));
  // Independent test pads are physical obstacles even for body-only zones.
  for (const [ref, box] of occupied) if (!positions.has(ref)) bodies.set(ref, box);
  for (const [ref, box] of bodies) if (!occupied.has(ref)) occupied.set(ref, box);
  const issues = [], sums = Object.fromEntries(spatialKeys.map(k => [k, 0])), divisors = { ...sums };
  function add(key, value, weight) { sums[key] += value * weight; divisors[key] += weight; }
  function shapes(kind) {
    // Preserve body/bundle semantics for existing rules, including test pads.
    if (kind === 'body') return [...bodies].map(([ref, bbox]) => ({ ref, bbox }));
    if (kind === 'bundle') return [...occupied].map(([ref, bbox]) => ({ ref, bbox }));
    return geometryViews?.[viewKey(kind)] ?? [];
  }
  const relations = rules.relations.map(r => {
    const a = positions.get(r.a), center = { x: 0, y: 0 };
    for (const ref of r.anchors) { center.x += positions.get(ref).x / r.anchors.length; center.y += positions.get(ref).y / r.anchors.length; }
    const boxes = r.metric === 'body-gap' ? bodies : occupied;
    let distanceMil;
    if (r.metric === 'geometry-gap') {
      const left = shapes(r.geometryA).filter(s => s.ref === r.a), right = shapes(r.geometryB).filter(s => s.ref === r.anchors[0]);
      if (!left.length || !right.length) {
        issues.push({ code: 'GEOMETRY_MODEL_UNAVAILABLE', id: r.id, refs: [r.a, ...r.anchors], geometryA: r.geometryA, geometryB: r.geometryB });
        return { ...r, distanceMil: null, penalty: 0, satisfied: false };
      }
      distanceMil = Math.min(...left.flatMap(a => right.map(b => gap(a.bbox, b.bbox))));
    } else distanceMil = r.metric === 'origin-manhattan' ? Math.abs(a.x - center.x) + Math.abs(a.y - center.y) : gap(boxes.get(r.a), boxes.get(r.anchors[0]));
    const penalty = bandPenalty(distanceMil, r.band), satisfied = distanceMil >= (r.band.hardMinMil ?? -Infinity) - .001 && distanceMil <= (r.band.hardMaxMil ?? Infinity) + .001;
    if (!satisfied) issues.push({ code: 'SPATIAL_DISTANCE_LIMIT', id: r.id, ref: r.a, distanceMil, band: r.band });
    add(r.category, penalty, r.weight);
    return { id: r.id, a: r.a, anchors: r.anchors, category: r.category, metric: r.metric, geometryA: r.geometryA, geometryB: r.geometryB, band: r.band, distanceMil, penalty, satisfied };
  });
  const groups = rules.localGroups.map(g => {
    const box = union(g.refs.map(ref => bodies.get(ref))), spanMil = box.maxX - box.minX + box.maxY - box.minY;
    const penalty = g.maxSpanMil ? (Math.max(0, spanMil - g.maxSpanMil) / g.maxSpanMil) ** 2 : 0;
    if (g.maxSpanMil) add('compactness', penalty, 1);
    return { id: g.id, label: g.label ?? g.id, refs: g.refs, box, spanMil, penalty };
  });
  const zones = rules.zones.map(z => {
    // Owner-local coordinates at native rotation zero; fixed zones use EDA coordinates.
    const envelope = z.envelopeId && [...(geometryViews?.assembly ?? []), ...(geometryViews?.operation ?? [])].find(e => e.id === z.envelopeId);
    const box = z.envelopeId ? envelope?.bbox : z.owner ? transformBox(z.box, { x: 0, y: 0, rotation: 0 }, positions.get(z.owner)) : z.box;
    const all = shapes(z.geometry), requestedRefs = (z.targetRefs ?? [...positions.keys()]).filter(ref => !z.excludeRefs.includes(ref));
    const modeledRefs = [...new Set(all.map(s => s.ref))], missingRefs = requestedRefs.filter(ref => !modeledRefs.includes(ref));
    const coverage = { requestedRefs, modeledRefs: requestedRefs.filter(ref => modeledRefs.includes(ref)), missingRefs };
    const objects = all.filter(s => !z.excludeRefs.includes(s.ref) && (z.targetRefs === undefined || z.targetRefs.includes(s.ref)));
    if (!box || (!['body', 'bundle'].includes(z.geometry) && (!geometryViews || missingRefs.length))) {
      issues.push({ code: 'GEOMETRY_MODEL_UNAVAILABLE', id: z.id, geometry: z.geometry, envelopeId: z.envelopeId, missingRefs });
      return { ...z, box: box ?? null, occupiedFraction: null, penalty: 0, conflicts: [], coverage };
    }
    const area = occupiedArea(objects.map(s => s.bbox), box), fraction = Math.min(1, area / ((box.maxX - box.minX) * (box.maxY - box.minY)));
    const penalty = z.mode === 'preferFilled' ? 1 - fraction : fraction;
    const conflicts = z.mode === 'keepout' ? [...new Set(objects.filter(s => occupiedArea([s.bbox], box) > .000001).map(s => s.ref))] : [];
    if (conflicts.length) issues.push({ code: 'SPATIAL_KEEPOUT', id: z.id, refs: conflicts });
    if (z.mode !== 'keepout') add('whitespace', penalty, z.weight);
    return { id: z.id, mode: z.mode, owner: z.owner, box, geometry: z.geometry, occupiedFraction: fraction, penalty, conflicts, coverage };
  });
  const uniformity = evaluateUniformity(rules.uniformity, components, occupied);
  if (uniformity) add('uniformity', uniformity.penalty, 1);
  return { penalties: Object.fromEntries(spatialKeys.map(k => [k, divisors[k] ? sums[k] / divisors[k] : 0])), relations, groups, zones, uniformity, issues };
}
