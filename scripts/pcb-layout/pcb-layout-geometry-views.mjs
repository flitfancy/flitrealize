import { transformBox, transformPoint, padOwner } from './pcb-layout-geometry.mjs';
import { assemblyRuntime } from './pcb-layout-assembly-policy.mjs';

const keys = (value, allowed, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_GEOMETRY_OBJECT ' + name);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error('UNKNOWN_GEOMETRY_FIELD ' + name + '.' + key);
};
const identifier = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw Error('INVALID_GEOMETRY_ID ' + name);
  return value;
};
const finite = (value, name) => {
  if (!Number.isFinite(value)) throw Error('INVALID_GEOMETRY_COORDINATE ' + name);
  return value;
};
function box(value, name, positive = false) {
  keys(value, ['minX', 'minY', 'maxX', 'maxY'], name);
  const result = Object.fromEntries(['minX', 'minY', 'maxX', 'maxY'].map(key => [key, finite(value[key], name + '.' + key)]));
  if (result.minX > result.maxX || result.minY > result.maxY || (positive && (result.minX === result.maxX || result.minY === result.maxY))) throw Error('INVALID_GEOMETRY_BOX ' + name);
  return result;
}
function layer(value, name) {
  if (value === undefined || value === null) return null;
  if ((typeof value === 'string' && value.trim()) || (Number.isInteger(value) && value >= 0)) return value;
  throw Error('INVALID_GEOMETRY_LAYER ' + name);
}
const pose = (value, name) => ({ x: finite(value.x, name + '.x'), y: finite(value.y, name + '.y'), rotation: finite(value.rotation, name + '.rotation') });
const unique = (values, key, name) => {
  const ids = new Set();
  for (const value of values) {
    const id = identifier(value[key], name);
    if (ids.has(id)) throw Error('DUPLICATE_GEOMETRY_ID ' + name + ':' + id);
    ids.add(id);
  }
};
const union = boxes => ({ minX: Math.min(...boxes.map(b => b.minX)), minY: Math.min(...boxes.map(b => b.minY)), maxX: Math.max(...boxes.map(b => b.maxX)), maxY: Math.max(...boxes.map(b => b.maxY)) });
const metadataLayer = (candidate, original, name) => layer(candidate?.layer === undefined ? original.layer : candidate.layer, name);

// Configuration is strict. Native snapshot objects intentionally retain the
// inspector's extensible schema; only consumed fields are validated here.
export function compileGeometryViews(snapshot, input = {}) {
  keys(input, ['schemaVersion', 'description', 'envelopes'], 'config');
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) throw Error('UNSUPPORTED_GEOMETRY_SCHEMA');
  if (input.description !== undefined && typeof input.description !== 'string') throw Error('INVALID_GEOMETRY_DESCRIPTION');
  if (!snapshot || !['components', 'pads', 'items'].every(k => Array.isArray(snapshot[k]))) throw Error('INVALID_GEOMETRY_SNAPSHOT');
  const components = snapshot.components.map(c => ({ id: identifier(c.id, 'component.id'), ref: identifier(c.ref, 'component.ref'), ...pose(c, c.ref), bbox: box(c.bbox ?? c.body, c.ref + '.bbox'), layer: layer(c.layer, c.ref) }));
  unique(components, 'id', 'component.id'); unique(components, 'ref', 'component.ref');
  const byRef = new Map(components.map(c => [c.ref, c]));
  const pads = snapshot.pads.map(p => {
    identifier(p.id, 'pad.id');
    const owner = p.owner === undefined ? padOwner(p, components)?.ref ?? null : p.owner;
    if (owner !== null && !byRef.has(owner)) throw Error('UNKNOWN_GEOMETRY_OWNER ' + p.id);
    if (p.number === undefined || p.number === null || !String(p.number).trim()) throw Error('INVALID_GEOMETRY_PAD_NUMBER ' + p.id);
    if (p.net !== undefined && p.net !== null && typeof p.net !== 'string') throw Error('INVALID_GEOMETRY_NET ' + p.id);
    return { id: p.id, ref: owner ?? String(p.number), owner, number: p.number, net: p.net ?? null, x: finite(p.x, p.id + '.x'), y: finite(p.y, p.id + '.y'), bbox: box(p.bbox, p.id + '.bbox'), layer: layer(p.layer, p.id) };
  });
  unique(pads, 'id', 'pad.id');
  const labels = snapshot.items.map(t => {
    identifier(t.id, 'label.id');
    if (!byRef.has(t.owner)) throw Error('UNKNOWN_GEOMETRY_OWNER ' + t.id);
    if (!t.original) throw Error('MISSING_GEOMETRY_LABEL_ORIGINAL ' + t.id);
    return { id: t.id, ref: t.owner, owner: t.owner, text: t.text ?? null, ...pose(t.original, t.id), bbox: box(t.original.bbox, t.id + '.bbox'), layer: layer(t.layer === undefined ? t.original.layer : t.layer, t.id) };
  });
  unique(labels, 'id', 'label.id');
  if (input.envelopes !== undefined && !Array.isArray(input.envelopes)) throw Error('INVALID_GEOMETRY_ENVELOPES');
  const envelopes = (input.envelopes ?? []).map(e => {
    keys(e, ['id', 'ref', 'kind', 'box', 'coordinateSystem', 'layer', 'basis'], 'envelope');
    identifier(e.id, 'envelope.id');
    if (!byRef.has(e.ref)) throw Error('UNKNOWN_GEOMETRY_REF ' + e.id);
    if (!['assembly', 'operation'].includes(e.kind)) throw Error('INVALID_GEOMETRY_KIND ' + e.id);
    if (e.coordinateSystem !== 'component-local-zero') throw Error('INVALID_GEOMETRY_COORDINATE_SYSTEM ' + e.id);
    if (e.basis !== undefined && typeof e.basis !== 'string') throw Error('INVALID_GEOMETRY_BASIS ' + e.id);
    return { id: e.id, ref: e.ref, kind: e.kind, box: box(e.box, e.id + '.box', true), coordinateSystem: e.coordinateSystem, layer: layer(e.layer, e.id), ...(e.basis === undefined ? {} : { basis: e.basis }) };
  });
  unique(envelopes, 'id', 'envelope.id');
  return { schemaVersion: 1, components, pads, labels, envelopes };
}

// Configured envelopes are drawn at native zero rotation. Unlike native AABBs,
// these original rectangles can be bounded directly at any absolute angle.
function envelopeBounds(b, c) {
  const radians = c.rotation * Math.PI / 180;
  const snap = n => Math.abs(n) < 1e-12 ? 0 : Math.abs(n - 1) < 1e-12 ? 1 : Math.abs(n + 1) < 1e-12 ? -1 : n;
  const cos = snap(Math.cos(radians)), sin = snap(Math.sin(radians));
  const points = [[b.minX, b.minY], [b.minX, b.maxY], [b.maxX, b.minY], [b.maxX, b.maxY]].map(([x, y]) => ({ x: c.x + x * cos - y * sin, y: c.y + x * sin + y * cos }));
  return { minX: Math.min(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxX: Math.max(...points.map(p => p.x)), maxY: Math.max(...points.map(p => p.y)) };
}

function finalItems(values, originals, name, make) {
  if (!Array.isArray(values)) throw Error('INVALID_GEOMETRY_FINAL_ARRAY ' + name);
  unique(values, 'id', name + '.id');
  if (values.length !== originals.length) throw Error('GEOMETRY_OBJECT_COUNT ' + name);
  const byId = new Map(originals.map(o => [o.id, o]));
  return values.map(value => {
    const original = byId.get(value.id);
    if (!original) throw Error('UNKNOWN_GEOMETRY_ID ' + name + ':' + value.id);
    return make(value, original);
  });
}

export function buildGeometryViews(compiled, components, labels = undefined, testPads = undefined, actualPads = undefined) {
  if (compiled?.schemaVersion !== 1 || !Array.isArray(compiled.components)) throw Error('INVALID_COMPILED_GEOMETRY');
  if (!Array.isArray(components)) throw Error('INVALID_GEOMETRY_FINAL_ARRAY components');
  unique(components, 'ref', 'component.ref');
  if (components.length !== compiled.components.length) throw Error('GEOMETRY_OBJECT_COUNT components');
  const original = new Map(compiled.components.map(c => [c.ref, c]));
  const positions = new Map(components.map(c => {
    const old = original.get(c.ref);
    if (!old || (c.id !== undefined && c.id !== old.id)) throw Error('UNKNOWN_GEOMETRY_COMPONENT ' + c.ref);
    return [c.ref, { ...c, ...pose(c, c.ref) }];
  }));
  const footprint = components.map(c => {
    const old = original.get(c.ref), next = positions.get(c.ref);
    return { id: old.id, ref: c.ref, bbox: box(c.body ?? c.bbox ?? transformBox(old.bbox, old, next), c.ref + '.bbox'), source: 'native-footprint-bbox-proxy', layer: metadataLayer(c, old, c.ref) };
  });
  const silkscreen = labels === undefined ? compiled.labels.map(t => {
    const from = original.get(t.owner), to = positions.get(t.owner);
    return { ...t, ...transformPoint(t, from, to), bbox: transformBox(t.bbox, from, to), rotation: ((t.rotation + to.rotation - from.rotation) % 360 + 360) % 360, source: 'transformed-native-label-bbox' };
  }) : finalItems(labels, compiled.labels, 'labels', (t, old) => {
    if (t.owner !== old.owner) throw Error('GEOMETRY_LABEL_OWNER_CHANGED ' + t.id);
    const output = { id: old.id, ref: old.ref, owner: old.owner, text: old.text, bbox: box(t.bbox, t.id + '.bbox'), source: 'final-native-label-bbox', layer: metadataLayer(t, old, t.id) };
    for (const key of ['x', 'y', 'rotation']) if (t[key] !== undefined) output[key] = finite(t[key], t.id + '.' + key);
    return output;
  });
  const standalone = compiled.pads.filter(p => p.owner === null);
  const finalTestPads = testPads === undefined ? standalone.map(p => ({ ...p, bbox: { ...p.bbox } })) : finalItems(testPads, standalone, 'testPads', (p, old) => {
    if ((p.net !== undefined && p.net !== old.net) || (p.number !== undefined && String(p.number) !== String(old.number))) throw Error('GEOMETRY_TEST_PAD_IDENTITY_CHANGED ' + p.id);
    return { ...old, x: finite(p.x, p.id + '.x'), y: finite(p.y, p.id + '.y'), bbox: box(p.bbox, p.id + '.bbox'), layer: metadataLayer(p, old, p.id) };
  });
  const finalTestMap = new Map(finalTestPads.map(p => [p.id, p]));
  const pads = actualPads ?? compiled.pads.map(p => p.owner === null ? { ...finalTestMap.get(p.id), source: 'native-standalone-pad-bbox' } : { ...p, ...transformPoint(p, original.get(p.owner), positions.get(p.owner)), bbox: transformBox(p.bbox, original.get(p.owner), positions.get(p.owner)), source: 'transformed-native-pad-bbox' });
  const placement = footprint.map(f => ({ id: f.id, ref: f.ref, bbox: union([f.bbox, ...silkscreen.filter(t => t.owner === f.ref).map(t => t.bbox)]), source: 'footprint-and-native-label-envelope', layer: f.layer }));
  placement.push(...finalTestPads.map(p => ({ id: p.id, ref: p.ref, bbox: { ...p.bbox }, source: 'native-standalone-pad-bbox', layer: p.layer })));
  const envelopes = compiled.envelopes.map(e => ({ id: e.id, ref: e.ref, kind: e.kind, bbox: envelopeBounds(e.box, positions.get(e.ref)), source: 'configured-component-local-envelope', layer: e.layer, ...(e.basis === undefined ? {} : { basis: e.basis }) }));
  const assemblyPolicy = compiled.assemblyPolicy ? assemblyRuntime(compiled.assemblyPolicy, components.map(c => ({ ...c, body: footprint.find(f => f.ref === c.ref).bbox })), pads) : null;
  return {
    schemaVersion: 1, units: 'mil', coordinateSystem: 'cartesian-y-up', representation: 'axis-aligned-bounds',
    footprint, pads, silkscreen, placement,
    ...(assemblyPolicy ? { physical: assemblyPolicy.physical, assemblyPolicy } : {}),
    assembly: [...envelopes.filter(e => e.kind === 'assembly'), ...(assemblyPolicy?.courtyards ?? [])], operation: envelopes.filter(e => e.kind === 'operation'),
    limitations: [
      { code: 'NATIVE_BBOX_PROXY', message: 'Footprint bounds are native component bounding-box proxies, not exact physical body outlines or courtyards.' },
      { code: 'BOUNDS_ONLY', message: 'All views are axis-aligned bounds; pad outlines, holes, copper clearance, and 3D volumes are not modeled.' },
      { code: 'QUARTER_TURN_NATIVE_TRANSFORMS', message: 'Native snapshot geometry supports relative quarter-turn rotation; configured local envelopes support arbitrary absolute angles.' },
      assemblyPolicy ? { code: 'RULE_DERIVED_ASSEMBLY', message: 'Assembly courtyards are rule-derived from native footprint-and-pad bounds unless explicitly supplied. They are proxies, not verified body outlines. Operation spaces still require explicit dimensions.' } : { code: 'EXPLICIT_ENVELOPES_ONLY', message: 'Assembly and operation envelopes exist only where configured. An empty view does not establish clearance or access.' },
      { code: 'LAYER_METADATA_ONLY', message: 'Missing native layer metadata remains null. These geometry views do not by themselves check layer-aware clearance.' },
      { code: 'NATIVE_LABELS_ONLY', message: 'Silkscreen includes only the native labels supplied by the snapshot, not all silkscreen graphics.' }
    ]
  };
}
