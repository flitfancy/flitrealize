// Explicit geometry rules only. Sides refer to EDA coordinates, with top=minY.
import { angle, rotateOffset, transformBox } from './pcb-layout-geometry.mjs';
export const edgeSides = ['left', 'right', 'top', 'bottom'];
const edges = { left: ['minX', 'x', -1, [-1, 0]], right: ['maxX', 'x', 1, [1, 0]], top: ['minY', 'y', -1, [0, -1]], bottom: ['maxY', 'y', 1, [0, 1]] };

function quarterRotation(rotation, ref) {
  if (!Number.isFinite(rotation)) throw Error('EDGE_ALIGNMENT_INVALID_ROTATION ' + ref);
  const normalized = angle(rotation), quarter = Math.round(normalized / 90) * 90;
  if (Math.abs(normalized - quarter) > 1e-7) throw Error('EDGE_ALIGNMENT_INVALID_ROTATION ' + ref);
  return angle(quarter);
}

function localLongAxis(component, ref) {
  // Native snapshot bboxes are already rotated. Undo that orientation before
  // classifying the footprint, so a re-read cannot redefine its long side.
  const bbox = component.bbox;
  if (!bbox || !['minX', 'maxX', 'minY', 'maxY'].every(key => Number.isFinite(bbox[key]))) throw Error('EDGE_ALIGNMENT_MISSING_GEOMETRY ' + ref);
  let width = bbox.maxX - bbox.minX, height = bbox.maxY - bbox.minY;
  if (width <= 0 || height <= 0) throw Error('EDGE_ALIGNMENT_INVALID_GEOMETRY ' + ref);
  if (quarterRotation(component.rotation, ref) % 180) [width, height] = [height, width];
  if (Math.abs(width - height) <= 1e-6) throw Error('EDGE_ALIGNMENT_AMBIGUOUS_SHAPE ' + ref);
  return width > height ? 'x' : 'y';
}

export function compileEdgeRules(rules = [], components) {
  if (!Array.isArray(rules)) throw Error('INVALID_EDGE_RULES');
  const seen = new Set();
  return rules.filter(r => r.onEdge !== false).map(rule => {
    const known = ['ref', 'onEdge', 'sides', 'maxInsetMil', 'outwardAtRotation0', 'alignment', 'basis'];
    if (!components.has(rule.ref) || seen.has(rule.ref) || Object.keys(rule).some(k => !known.includes(k)) || (rule.onEdge !== undefined && rule.onEdge !== true)) throw Error('INVALID_EDGE_RULE ' + rule.ref);
    const sides = rule.sides ?? edgeSides, maxInsetMil = rule.maxInsetMil ?? 0;
    if (!Array.isArray(sides) || !sides.length || sides.some(s => !edgeSides.includes(s)) || new Set(sides).size !== sides.length || !Number.isFinite(maxInsetMil) || maxInsetMil < 0 || (rule.outwardAtRotation0 !== undefined && !edgeSides.includes(rule.outwardAtRotation0)) || (rule.alignment !== undefined && !['long-side', 'short-side'].includes(rule.alignment))) throw Error('INVALID_EDGE_RULE ' + rule.ref);
    seen.add(rule.ref);
    const compiled = { ...rule, sides, maxInsetMil, ...(rule.alignment ? { longAxisAtRotation0: localLongAxis(components.get(rule.ref), rule.ref) } : {}) };
    if (rule.alignment && ![0, 90, 180, 270].some(rotation => availableEdges(compiled, rotation).length)) throw Error('EDGE_ORIENTATION_CONFLICT ' + rule.ref);
    return compiled;
  });
}

export function availableEdges(rule, rotation) {
  let sides = rule.sides;
  if (rule.alignment) {
    if (!['x', 'y'].includes(rule.longAxisAtRotation0)) throw Error('EDGE_ALIGNMENT_NOT_COMPILED ' + rule.ref);
    rotation = quarterRotation(rotation, rule.ref);
    const longAxis = rotation % 180 ? (rule.longAxisAtRotation0 === 'x' ? 'y' : 'x') : rule.longAxisAtRotation0;
    // Long-side contact puts the long axis along the boundary, perpendicular
    // to its normal. Short-side contact puts that axis along the normal.
    sides = sides.filter(side => (edges[side][1] !== longAxis) === (rule.alignment === 'long-side'));
  }
  if (!rule.outwardAtRotation0) return sides;
  const [x, y] = edges[rule.outwardAtRotation0][3], v = rotateOffset(x, y, rotation);
  return sides.filter(side => { const p = edges[side][3]; return v.x === p[0] && v.y === p[1]; });
}

export function checkEdges(rules, components) {
  if (!rules.length) return { issues: [], details: [] };
  const envelope = { minX: Math.min(...components.map(c => c.body.minX)), maxX: Math.max(...components.map(c => c.body.maxX)), minY: Math.min(...components.map(c => c.body.minY)), maxY: Math.max(...components.map(c => c.body.maxY)) };
  const details = rules.map(rule => {
    const c = components.find(c => c.ref === rule.ref);
    const options = availableEdges(rule, c.rotation).map(side => {
      const [key, , sign] = edges[side];
      return { side, coordinate: c.body[key], boundary: envelope[key], insetMil: Math.max(0, sign * (envelope[key] - c.body[key])) };
    }).sort((a, b) => a.insetMil - b.insetMil);
    const chosen = options[0];
    return { ref: rule.ref, maxInsetMil: rule.maxInsetMil, ...chosen, outwardLimited: !!rule.outwardAtRotation0, ...(rule.alignment ? { alignment: rule.alignment } : {}), satisfied: !!chosen && chosen.insetMil <= rule.maxInsetMil + .001 };
  });
  return { envelope, details, issues: details.filter(d => !d.satisfied).map(d => ({ code: 'EDGE_CONSTRAINT_UNSATISFIED', ...d })) };
}

export function projectEdges(model, positions, preferredSides = {}) {
  const out = positions.map(c => ({ ...c }));
  if (!model.edgeRules.length) return out;
  // All placements use the same envelope, preventing order-driven expansion.
  const bodies = out.map(c => ({ ...c, body: transformBox(model.components.get(c.ref).bbox, model.components.get(c.ref), c) }));
  const envelope = checkEdges(model.edgeRules, bodies).envelope;
  for (const rule of model.edgeRules) {
    const c = out.find(c => c.ref === rule.ref);
    if (model.fixed.has(c.ref)) continue;
    const old = model.components.get(c.ref), preferred = preferredSides[c.ref];
    const block = model.blockRules?.find(r => r.ref === c.ref);
    const center = block && { x: block.anchors.reduce((n, ref) => n + out.find(p => p.ref === ref).x, 0) / block.anchors.length, y: block.anchors.reduce((n, ref) => n + out.find(p => p.ref === ref).y, 0) / block.anchors.length };
    if (preferred !== undefined && !rule.sides.includes(preferred)) throw Error('INVALID_EDGE_PREFERENCE ' + c.ref);
    // Normal proposals retain the proposed angle; an explicit side proposal may
    // select an allowed angle for both opening direction and side alignment.
    const rotations = preferred && (rule.outwardAtRotation0 || rule.alignment) ? model.allowedRotations.get(c.ref) : [c.rotation];
    const options = [];
    for (const rotation of rotations) {
      const body = transformBox(old.bbox, old, { ...c, rotation });
      for (const side of availableEdges(rule, rotation)) {
        if (preferred && side !== preferred) continue;
        const [key, axis, sign] = edges[side], delta = sign * Math.max(0, sign * (envelope[key] - body[key]) - rule.maxInsetMil);
        const tangent = axis === 'x' ? 'y' : 'x', normal = c[axis] + delta;
        const remaining = block ? Math.max(0, block.maxDistanceMil - Math.abs(normal - center[axis])) : Infinity;
        const tangential = block ? Math.min(center[tangent] + remaining, Math.max(center[tangent] - remaining, c[tangent])) : c[tangent];
        const violation = block ? Math.max(0, Math.abs(normal - center[axis]) + Math.abs(tangential - center[tangent]) - block.maxDistanceMil) : 0;
        options.push({ side, axis, delta, tangent, tangential, violation, rotation, rotationCost: angle(rotation - c.rotation) ? 1 : 0 });
      }
    }
    options.sort((a, b) => a.violation - b.violation || a.rotationCost - b.rotationCost || Math.abs(a.delta) - Math.abs(b.delta));
    const chosen = options[0];
    if (chosen) { c.rotation = chosen.rotation; c[chosen.axis] += chosen.delta; c[chosen.tangent] = chosen.tangential; }
  }
  return out;
}
