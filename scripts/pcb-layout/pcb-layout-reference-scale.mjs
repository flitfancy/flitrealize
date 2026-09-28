// Coordinate-independent search scales. These normalize existing objectives;
// they are neither new objectives nor electrical/manufacturing limits.
const boxKeys = ['minX', 'minY', 'maxX', 'maxY'];
const round = n => Math.round(n * 1e6) / 1e6;
function dimensions(b, rotation = 0, name = '') {
  if (!b || boxKeys.some(k => !Number.isFinite(b[k])) || b.maxX < b.minX || b.maxY < b.minY) throw Error('INVALID_REFERENCE_GEOMETRY ' + name);
  const quarter = Math.round(rotation / 90);
  if (!Number.isFinite(rotation) || Math.abs(rotation - quarter * 90) > 1e-7) throw Error('REFERENCE_QUARTER_ROTATION_REQUIRED ' + name);
  const world = [b.maxX - b.minX, b.maxY - b.minY];
  return Math.abs(quarter % 2) === 1 ? world.reverse() : world;
}
function record(width, height, source, ref) {
  const widthMil = round(width), heightMil = round(height);
  if (!(widthMil > 0) || !(heightMil > 0)) throw Error('EMPTY_REFERENCE_GEOMETRY ' + ref);
  return { widthMil, heightMil, areaMil2: widthMil * heightMil, longMil: Math.max(widthMil, heightMil), shortMil: Math.min(widthMil, heightMil), source };
}
function union(boxes) {
  for (const b of boxes) dimensions(b);
  return { minX: Math.min(...boxes.map(b => b.minX)), maxX: Math.max(...boxes.map(b => b.maxX)), minY: Math.min(...boxes.map(b => b.minY)), maxY: Math.max(...boxes.map(b => b.maxY)) };
}

// Dimensions use component-local zero axes so asymmetric per-side margins are
// handled consistently after arbitrary translation or relative quarter-turns.
// Only dimensions are retained: neither current position nor refdes is input.
export function compileReferenceGeometry(snapshot, assemblyPolicy) {
  if (!Array.isArray(snapshot?.components) || !Array.isArray(snapshot?.pads)) throw Error('INVALID_REFERENCE_SNAPSHOT');
  const result = new Map();
  const add = (ref, size) => {
    if (typeof ref !== 'string' || !ref || result.has(ref)) throw Error('DUPLICATE_OR_INVALID_REFERENCE_OBJECT ' + ref);
    result.set(ref, size);
  };
  if (assemblyPolicy) {
    for (const r of assemblyPolicy.records) {
      let wh;
      if (r.courtyardLocal) wh = dimensions(r.courtyardLocal, 0, r.ref);
      else {
        wh = dimensions(r.physicalBox, r.original.rotation, r.ref);
        const m = r.marginMil;
        if (!m || ['xMinus', 'xPlus', 'yMinus', 'yPlus'].some(k => !Number.isFinite(m[k]) || m[k] < 0)) throw Error('INVALID_REFERENCE_MARGIN ' + r.ref);
        wh = [wh[0] + m.xMinus + m.xPlus, wh[1] + m.yMinus + m.yPlus];
      }
      add(r.ref, record(...wh, r.source, r.ref));
    }
    for (const p of assemblyPolicy.pads.filter(p => p.owner === null)) add(p.ref, record(...dimensions(p.bbox), 'independent-pad', p.ref));
    return result;
  }
  const owners = snapshot.components;
  const pads = snapshot.pads.map(p => ({ ...p, owner: p.owner === undefined ? padOwner(p, owners)?.ref ?? null : p.owner }));
  for (const c of snapshot.components) {
    const b = union([c.bbox ?? c.body, ...pads.filter(p => p.owner === c.ref).map(p => p.bbox)]);
    add(c.ref, record(...dimensions(b, c.rotation, c.ref), 'footprint-and-pad-bbox-proxy', c.ref));
  }
  for (const p of pads.filter(p => p.owner === null)) {
    const ref = String(p.number);
    add(ref, record(...dimensions(p.bbox), 'independent-pad', ref));
  }
  return result;
}

function config(model) {
  const input = model.config?.scoringReference === undefined ? {} : model.config.scoringReference;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['mode', 'distanceFloorMil'].includes(k)) || input.mode !== undefined && input.mode !== 'geometry') throw Error('INVALID_SCORING_REFERENCE: only geometry is supported; migrate explicit historical references before solving');
  const distanceFloorMil = input.distanceFloorMil ?? 1;
  if (!Number.isFinite(distanceFloorMil) || distanceFloorMil <= 0) throw Error('INVALID_SCORING_REFERENCE_FLOOR');
  return { mode: 'geometry', distanceFloorMil };
}

export function compileReferenceScales(model) {
  const cfg = config(model);
  const geometry = model.referenceGeometry ?? compileReferenceGeometry(model.snapshot, model.assemblyPolicy);
  const size = ref => {
    const d = geometry.get(ref);
    if (!d || !Number.isFinite(d.areaMil2) || d.areaMil2 <= 0) throw Error('MISSING_REFERENCE_GEOMETRY ' + ref);
    return Math.sqrt(d.areaMil2);
  };
  const groups = Object.fromEntries(model.config.groups.map(g => [g.id, { mil: 0, count: 0, basis: 'sum-of-link-endpoint-mean-courtyard-square-root-area' }]));
  for (const link of model.links) {
    const group = groups[link.group];
    if (!group) throw Error('UNKNOWN_REFERENCE_GROUP ' + link.group);
    group.mil += Math.max(cfg.distanceFloorMil, (size(link.a) + size(link.b)) / 2);
    group.count++;
  }
  const nets = [];
  for (const net of model.connectivity) {
    const refs = [...new Set(net.pads.map(p => p.ref ?? p.owner ?? String(p.number)))].sort();
    // An internal/single-object net contributes no board span. Multiple pads on
    // one owner never increase this topology-based scale.
    if (refs.length < 2) continue;
    const mil = Math.max(cfg.distanceFloorMil, 2 * Math.sqrt(refs.reduce((s, ref) => s + size(ref) ** 2, 0)));
    nets.push({ net: net.name, refs, mil });
  }
  groups.connectivity = { mil: nets.reduce((s, n) => s + n.mil, 0), count: nets.length, basis: 'sum-per-net-two-times-square-root-of-unique-object-courtyard-area' };
  for (const g of Object.values(groups)) g.mil = Math.max(cfg.distanceFloorMil, g.mil);
  return { mode: cfg.mode, distanceFloorMil: cfg.distanceFloorMil, groups, nets, limitation: 'Geometry scales normalize existing distance objectives; they do not specify optimal distances or electrical/assembly approval.' };
}

export function scoreReferenceMil(model, key) {
  config(model);
  const configured = model.scoreReferences?.groups?.[key]?.mil;
  if (Number.isFinite(configured) && configured > 0) return configured;
  throw Error('MISSING_COMPILED_SCORE_REFERENCE ' + key);
}
import { padOwner } from './pcb-layout-geometry.mjs';
