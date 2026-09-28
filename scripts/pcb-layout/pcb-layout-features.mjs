// Common components + explicit optional features. No designator-based guessing.
import { compileEdgeRules } from './pcb-layout-edge.mjs';

const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const center = (refs, positions) => ({ x: refs.reduce((s, ref) => s + positions.get(ref).x, 0) / refs.length, y: refs.reduce((s, ref) => s + positions.get(ref).y, 0) / refs.length });

export function compileFeatures(features = [], components, contract, referenceGeometry) {
  if (!Array.isArray(features)) throw Error('INVALID_COMPONENT_FEATURES');
  const seen = new Set(), edges = [], blockRules = [], rotations = new Map();
  for (const f of features) {
    if (!components.has(f.ref) || seen.has(f.ref) || Object.keys(f).some(k => !['ref', 'edge', 'block', 'allowedRotationDeltas', 'basis'].includes(k))) throw Error('INVALID_COMPONENT_FEATURE ' + f.ref);
    seen.add(f.ref);
    if (f.edge) edges.push({ ref: f.ref, ...(f.edge === true ? {} : f.edge) });
    if (f.allowedRotationDeltas) {
      if (!Array.isArray(f.allowedRotationDeltas) || !f.allowedRotationDeltas.length || f.allowedRotationDeltas.some(r => ![0, 90, 180, 270].includes(r)) || !f.allowedRotationDeltas.includes(0)) throw Error('INVALID_FEATURE_ROTATION ' + f.ref);
      rotations.set(f.ref, f.allowedRotationDeltas);
    }
    if (f.block) {
      const blocks = (contract.blocks ?? []).filter(b => b.components.includes(f.ref));
      if (blocks.length !== 1) throw Error('AMBIGUOUS_OR_MISSING_BLOCK ' + f.ref);
      const anchors = f.block.anchors ?? blocks[0].components.filter(ref => ref !== f.ref && components.has(ref));
      if (!Array.isArray(anchors) || !anchors.length || new Set(anchors).size !== anchors.length || anchors.some(ref => ref === f.ref || !components.has(ref))) throw Error('EMPTY_OR_INVALID_BLOCK_ANCHORS ' + f.ref);
      const specified = f.block.maxDistanceMil, geometry = f.block.maxDistanceByGeometry;
      if (typeof f.block !== 'object' || Array.isArray(f.block) || Object.keys(f.block).some(k => !['maxDistanceMil', 'maxDistanceByGeometry', 'anchors'].includes(k)) ||
        (specified === undefined && geometry === undefined) ||
        specified !== undefined && (!Number.isFinite(specified) || specified < 0)) throw Error('INVALID_BLOCK_DISTANCE ' + f.ref + ': use maxDistanceMil or maxDistanceByGeometry');
      let geometryDistance;
      if (geometry !== undefined) {
        if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry) || Object.keys(geometry).some(k => !['factor', 'minMil'].includes(k)) || !Number.isFinite(geometry.factor) || geometry.factor <= 0 || !Number.isFinite(geometry.minMil) || geometry.minMil < 0) throw Error('INVALID_BLOCK_GEOMETRY_DISTANCE ' + f.ref);
        const refs = [...new Set([...blocks[0].components.filter(ref => components.has(ref)), ...anchors])].sort();
        const sizes = refs.map(ref => {
          const d = referenceGeometry?.get(ref);
          if (!d || !Number.isFinite(d.areaMil2) || d.areaMil2 <= 0 || !Number.isFinite(d.longMil) || d.longMil <= 0) throw Error('MISSING_BLOCK_REFERENCE_GEOMETRY ' + ref);
          return d;
        });
        const areaMil2 = sizes.reduce((s, d) => s + d.areaMil2, 0), longestMil = Math.max(...sizes.map(d => d.longMil));
        const spanMil = Math.max(Math.sqrt(areaMil2), longestMil);
        geometryDistance = { refs, areaMil2, longestMil, spanMil, ...geometry, maxDistanceMil: Math.max(geometry.minMil, geometry.factor * spanMil), basis: 'geometry-derived-search-range-not-electrical-specification' };
      }
      // An explicit absolute maximum overrides the geometry search range.
      blockRules.push({ ref: f.ref, blockId: blocks[0].id, anchors,
        maxDistanceMil: specified ?? geometryDistance.maxDistanceMil,
        distanceSource: specified !== undefined ? 'explicit-absolute' : 'geometry-derived',
        ...(geometryDistance ? { geometryDistance } : {}) });
    }
  }
  return { edgeRules: compileEdgeRules(edges, components), blockRules, rotations };
}

export function checkBlocks(rules, components) {
  const positions = new Map(components.map(c => [c.ref, c]));
  const details = rules.map(rule => {
    const blockCenter = center(rule.anchors, positions), mil = distance(positions.get(rule.ref), blockCenter);
    return { ref: rule.ref, blockId: rule.blockId, anchors: rule.anchors, blockCenter, distanceMil: mil, maxDistanceMil: rule.maxDistanceMil, satisfied: mil <= rule.maxDistanceMil + .001 };
  });
  return { details, issues: details.filter(d => !d.satisfied).map(d => ({ code: 'BLOCK_DISTANCE_EXCEEDED', ...d })) };
}
