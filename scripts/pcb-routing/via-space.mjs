// Board coordinates, widths and clearances are mil. Finite sampled via fit
// and the swept source trace; no native EDA calls.
import { conductiveGap, pointSegment, routingLayers, routingViaLayers } from './geometry.mjs';

export const segmentShape = s => ({ kind: 'capsule', a: [s.x1, s.y1], b: [s.x2, s.y2], radius: s.width / 2, layers: [s.layer] });
export const viaShape = (v, layers) => ({ kind: 'circle', center: [v.x, v.y], radius: v.diameter / 2, layers: routingViaLayers(v, layers) });
const bounds = s => {
  const points = s.points ?? [s.a ?? s.center, s.b ?? s.center], r = s.radius ?? 0;
  return { x0: Math.min(...points.map(p => p[0])) - r, x1: Math.max(...points.map(p => p[0])) + r, y0: Math.min(...points.map(p => p[1])) - r, y1: Math.max(...points.map(p => p[1])) + r };
};
function inside(p, poly) {
  let result = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
export function assertRoutingBoard(board) {
  if (!Array.isArray(board?.layers) || !board.layers.length || !Array.isArray(board.pads) || !Array.isArray(board.segments) || !Array.isArray(board.vias)) throw Error('EXPLICIT_ROUTING_BOARD_REQUIRED');
  if (board.layers.some(layer => !Number.isInteger(layer)) || new Set(board.layers).size !== board.layers.length) throw Error('INVALID_BOARD_LAYER_INVENTORY');
  routingLayers(board.layers);
  if (board.segments.some(s => ![s.x1, s.y1, s.x2, s.y2, s.width].every(Number.isFinite) || s.width <= 0 || !board.layers.includes(s.layer))) throw Error('INVALID_TRACE_GEOMETRY');
  if (board.vias.some(v => ![v.x, v.y, v.hole, v.diameter].every(Number.isFinite) || v.hole <= 0 || v.diameter <= v.hole || !Array.isArray(v.layers ?? board.layers) || !(v.layers ?? board.layers).length || (v.layers ?? board.layers).some(layer => !board.layers.includes(layer)))) throw Error('INVALID_EXISTING_VIA_GEOMETRY');
  for(const v of board.vias)routingViaLayers(v,board.layers);
}
export function copperObjects(board) {
  assertRoutingBoard(board);
  return [...board.pads.flatMap(p => p.shapes.map(s => ({ ...s, net: p.net, id: p.id, type: 'pad' }))),
    ...board.segments.map(s => ({ ...segmentShape(s), net: s.net, id: s.id, type: 'line' })),
    ...board.vias.map(v => ({ ...viaShape(v, board.layers), net: v.net, id: v.id, type: 'via' }))];
}
export function copperFits(board, candidate, { copperClearanceMil, drillToPadClearanceMil, drillToDrillClearanceMil, outline, boardEdgeClearanceMil, allowSameNetCopper = true } = {}) {
  assertRoutingBoard(board);
  assertRoutingBoard({ layers: board.layers, pads: [], segments: candidate?.segments, vias: candidate?.vias });
  const poly = outline ?? board.outline;
  if (![copperClearanceMil, drillToPadClearanceMil, drillToDrillClearanceMil, boardEdgeClearanceMil].every(n => Number.isFinite(n) && n >= 0) || !Array.isArray(poly) || poly.length < 3) throw Error('EXPLICIT_GEOMETRY_RULES_REQUIRED');
  const objects = copperObjects(board), issues = [];
  const proposed = [...candidate.segments.map(s => ({ shape: segmentShape(s), net: s.net })), ...candidate.vias.map(v => ({ shape: viaShape(v, board.layers), net: v.net }))];
  for (const item of proposed) {
    for (const old of objects) if ((!allowSameNetCopper || item.net !== old.net) && conductiveGap(item.shape, old) < copperClearanceMil) issues.push({ code: 'COPPER_CLEARANCE', otherId: old.id, otherNet: old.net });
    const endpoints = item.shape.a ? [item.shape.a, item.shape.b] : [item.shape.center];
    for (const p of endpoints) if (!inside(p, poly) || poly.some((a, i) => pointSegment(p, a, poly[(i + 1) % poly.length]) < item.shape.radius + boardEdgeClearanceMil)) issues.push({ code: 'BOARD_EDGE' });
    // A concave board can exclude the middle even if both ends are inside.
    if (item.shape.a && poly.some((a, i) => conductiveGap(item.shape, { kind: 'capsule', a, b: poly[(i + 1) % poly.length], radius: 0, layers: item.shape.layers }) < boardEdgeClearanceMil)) issues.push({ code: 'BOARD_EDGE' });
  }
  for (let i = 0; i < candidate.vias.length; i++) {
    const v = candidate.vias[i], drill = { ...viaShape(v, board.layers), radius: v.hole / 2 };
    for (const pad of board.pads) if (pad.shapes.some(shape => conductiveGap(drill, shape) < drillToPadClearanceMil)) issues.push({ code: 'DRILL_TO_PAD', padId: pad.id });
    for (const old of [...board.vias, ...candidate.vias.slice(i + 1)]) if (Math.hypot(v.x - old.x, v.y - old.y) - (v.hole + old.hole) / 2 < drillToDrillClearanceMil) issues.push({ code: 'DRILL_TO_DRILL', otherId: old.id });
  }
  for (let i = 0; i < proposed.length; i++) for (let j = i + 1; j < proposed.length; j++) if (proposed[i].net !== proposed[j].net && conductiveGap(proposed[i].shape, proposed[j].shape) < copperClearanceMil) issues.push({ code: 'CANDIDATE_COPPER_CLEARANCE' });
  return { passed: !issues.length, issues };
}

export function createViaSpaceScanner(board, { outline = board.outline } = {}) {
  assertRoutingBoard(board);
  if (!Array.isArray(outline) || outline.length < 3 || outline.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) throw Error('EXPLICIT_STRAIGHT_OUTLINE_REQUIRED');
  const metal = copperObjects(board).map(s => ({ ...s, bbox: bounds(s) }));
  return function scanViaPositions(padId, options = {}) {
    const { searchRadiusMil, gridStepMil, viaDiameterMil, holeDiameterMil, copperClearanceMil, drillToPadClearanceMil, drillToDrillClearanceMil, boardEdgeClearanceMil, traceWidthMil, sourceLayer, maxResults, budget, allowSameNetCopper = false, requireStraightTrace = true, viaLayers = board.layers } = options;
    const pad = board.pads.find(p => p.id === padId);
    if (!pad) throw Error('PAD_NOT_FOUND:' + padId);
    if (![searchRadiusMil, gridStepMil, viaDiameterMil, holeDiameterMil, traceWidthMil].every(n => Number.isFinite(n) && n > 0) || holeDiameterMil >= viaDiameterMil || !Number.isInteger(maxResults) || maxResults < 1 || ![copperClearanceMil, drillToPadClearanceMil, drillToDrillClearanceMil, boardEdgeClearanceMil].every(n => Number.isFinite(n) && n >= 0)) throw Error('EXPLICIT_VIA_SCAN_PARAMETERS_REQUIRED');
    if (!board.layers.includes(sourceLayer) || !pad.shapes.some(s => s.layers.includes(sourceLayer)) || !Array.isArray(viaLayers) || !viaLayers.includes(sourceLayer) || viaLayers.some(l => !board.layers.includes(l))) throw Error('VIA_SOURCE_LAYER_MISMATCH');
    if (!budget?.assertRemaining) throw Error('SHARED_TASK_BUDGET_REQUIRED');
    budget.assertRemaining();
    const radius = searchRadiusMil, step = gridStepMil, cells = Math.floor(radius / step), candidates = [], started = Date.now();
    const inflate = viaDiameterMil / 2 + Math.max(copperClearanceMil, drillToPadClearanceMil);
    const relevant = metal.filter(s => s.bbox.x1 >= pad.x - radius - inflate && s.bbox.x0 <= pad.x + radius + inflate && s.bbox.y1 >= pad.y - radius - inflate && s.bbox.y0 <= pad.y + radius + inflate);
    // Index expanded obstacle boxes once, instead of checking every board
    // object for every point in a fine grid. Cell size affects speed only.
    const cell = Math.max(viaDiameterMil, step * 4), index = new Map();
    for (const object of relevant) {
      budget.assertRemaining();
      for (let x = Math.floor((object.bbox.x0 - inflate) / cell); x <= Math.floor((object.bbox.x1 + inflate) / cell); x++) for (let y = Math.floor((object.bbox.y0 - inflate) / cell); y <= Math.floor((object.bbox.y1 + inflate) / cell); y++) {
        const key = x + ',' + y; if (!index.has(key)) index.set(key, []); index.get(key).push(object);
      }
    }
    const traceObstacles = relevant.filter(s => s.net !== pad.net && s.layers.includes(sourceLayer));
    let sampled = 0, rejectedMetal = 0, rejectedBoundary = 0, rejectedTrace = 0, rejectedDrill = 0;
    for (let iy = -cells; iy <= cells; iy++) for (let ix = -cells; ix <= cells; ix++) {
      const dx = ix * step, dy = iy * step, distanceMil = Math.hypot(dx, dy);
      if (distanceMil > radius) continue;
      sampled++; if ((sampled & 255) === 0) budget.assertRemaining();
      const p = [pad.x + dx, pad.y + dy], v = { kind: 'circle', center: p, radius: viaDiameterMil / 2, layers: viaLayers }, drill = { ...v, radius: holeDiameterMil / 2 };
      if (!inside(p, outline) || outline.some((a, i) => pointSegment(p, a, outline[(i + 1) % outline.length]) < v.radius + boardEdgeClearanceMil)) { rejectedBoundary++; continue; }
      const nearby = index.get(Math.floor(p[0] / cell) + ',' + Math.floor(p[1] / cell)) ?? [];
      if (nearby.some(s => (!allowSameNetCopper || s.net !== pad.net) && conductiveGap(v, s) < copperClearanceMil)) { rejectedMetal++; continue; }
      if (nearby.some(s => s.type === 'pad' && conductiveGap(drill, s) < drillToPadClearanceMil) || board.vias.some(old => Math.hypot(p[0] - old.x, p[1] - old.y) - (holeDiameterMil + old.hole) / 2 < drillToDrillClearanceMil)) { rejectedDrill++; continue; }
      const trace = { net: pad.net, layer: sourceLayer, width: traceWidthMil, x1: pad.x, y1: pad.y, x2: p[0], y2: p[1] }, swept = segmentShape(trace);
      const straightTraceClear = !traceObstacles.some(s => conductiveGap(swept, s) < copperClearanceMil) && !outline.some((a, i) => conductiveGap(swept, { kind: 'capsule', a, b: outline[(i + 1) % outline.length], radius: 0, layers: [sourceLayer] }) < boardEdgeClearanceMil);
      if (requireStraightTrace && !straightTraceClear) { rejectedTrace++; continue; }
      candidates.push({ xMil: p[0], yMil: p[1], distanceMil, distanceMm: distanceMil * .0254, trace, straightTraceClear, via: { net: pad.net, x: p[0], y: p[1], diameter: viaDiameterMil, hole: holeDiameterMil, layers: [...viaLayers] } });
    }
    budget.assertRemaining();
    candidates.sort((a, b) => a.distanceMil - b.distanceMil || a.xMil - b.xMil || a.yMil - b.yMil);
    return { padId, net: pad.net, sourceLayer, viaLayers: [...viaLayers], sampled, legalCount: candidates.length, rejectedMetal, rejectedBoundary, rejectedTrace, rejectedDrill, candidates: candidates.slice(0, maxResults), elapsedMs: Date.now() - started, scope: 'Finite sampled copper and drill fit plus swept source trace; target-layer routing and native DRC remain separate.' };
  };
}

export function runViaSpaceScan({ board, requests, options, budget }) {
  const scan = createViaSpaceScanner(board, { outline: options?.outline ?? board.outline });
  return { readOnly: true, reports: requests.map(request => scan(request.padId, { ...options, ...request.options, budget })) };
}
