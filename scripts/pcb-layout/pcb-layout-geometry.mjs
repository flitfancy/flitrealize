import { layoutLabelAlignment } from './pcb-layout-provider.mjs';
export const angle = value => ((value % 360) + 360) % 360;
export function rotateOffset(x, y, degrees) {
  const q = angle(degrees) / 90;
  if (!Number.isInteger(q)) throw Error('Only relative quarter-turn rotations are supported');
  return [{ x, y }, { x: -y, y: x }, { x: -x, y: -y }, { x: y, y: -x }][q];
}
export function transformPoint(p, from, to) {
  const v = rotateOffset(p.x - from.x, p.y - from.y, to.rotation - from.rotation);
  return { x: to.x + v.x, y: to.y + v.y };
}
export function transformBox(b, from, to) {
  const ps = [[b.minX, b.minY], [b.minX, b.maxY], [b.maxX, b.minY], [b.maxX, b.maxY]].map(([x, y]) => transformPoint({ x, y }, from, to));
  return { minX: Math.min(...ps.map(p => p.x)), maxX: Math.max(...ps.map(p => p.x)), minY: Math.min(...ps.map(p => p.y)), maxY: Math.max(...ps.map(p => p.y)) };
}
export function transformLabel(label, from, to, bottomLeftAlignment = layoutLabelAlignment().bottomLeft) {
  if (angle(to.rotation - from.rotation) === 0) return { ...label, x: label.x + to.x - from.x, y: label.y + to.y - from.y, bbox: transformBox(label.bbox, from, to) };
  const bbox = transformBox(label.bbox, from, to), rawRotation = angle(label.rotation + to.rotation - from.rotation);
  // Keep orthogonal text readable; changing 180 to 0 (or 270 to 90) keeps
  // the same occupied rectangle, but requires a different native anchor.
  if ([0, 90, 180, 270].includes(rawRotation)) {
    const rotation = rawRotation % 180;
    return { ...label, rotation, alignMode: bottomLeftAlignment, x: rotation ? bbox.maxX : bbox.minX, y: bbox.minY, bbox };
  }
  return { ...label, ...transformPoint(label, from, to), rotation: rawRotation, bbox };
}
// Ownership is observed data. A missing declaration cannot imply standalone
// copper, and an object-id naming pattern cannot establish a parent.
export function padOwner(pad, components) {
  const values = components instanceof Map ? [...components.values()] : components;
  if (pad.owner === undefined && pad.parentComponentId === undefined) throw Error('PAD_OWNERSHIP_REQUIRED ' + pad.id + ': read a fresh snapshot with explicit owner or parent');
  const owner = pad.owner == null ? undefined : values.find(c => c.ref === pad.owner);
  const parent = pad.parentComponentId == null ? undefined : values.find(c => c.id === pad.parentComponentId);
  if (pad.owner != null && !owner) throw Error('UNKNOWN_PAD_OWNER ' + pad.id);
  if (pad.parentComponentId != null && !parent) throw Error('UNKNOWN_PAD_PARENT ' + pad.id);
  if (pad.owner !== undefined && pad.parentComponentId !== undefined && owner !== parent) throw Error('PAD_PARENT_MISMATCH ' + pad.id);
  return pad.owner === undefined ? parent : owner;
}
