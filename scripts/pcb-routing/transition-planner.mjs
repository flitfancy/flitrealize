// Width-change / through-via seed candidates and complete-route comparison.
// The caller supplies the existing compiler/backend/validator; this module
// neither invents another DSN model nor writes to an EDA document.
import { outsidePadSegments, terminalIntervals, traceCovered } from './geometry.mjs';
import { createViaSpaceScanner, copperFits, assertRoutingBoard } from './via-space.mjs';
import { chooseJointEscapes } from './source-escapes.mjs';
import { criticalRouteMetrics } from './copper-path.mjs';

const length = s => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
const segment = (net, layer, width, a, b) => ({ net, layer, width, x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
const point = (a, n, distance) => [a[0] + n[0] * distance, a[1] + n[1] * distance];
const positive = values => values.every(value => Number.isFinite(value) && value > 0);

export function protectRoleCopper(board, task, { protectNarrowExistingCopper = task.role === 'load_current_main' } = {}) {
  if (!protectNarrowExistingCopper) return board;
  const pads = board.pads.filter(p => task.requiredPadIds.includes(p.id)), fake = '__protected_role__' + task.id;
  if ([...board.pads, ...board.segments, ...board.vias].some(item => item.net === fake)) throw Error('PROTECTED_ROLE_NET_COLLISION');
  const segments = board.segments.flatMap(s => {
    if (s.net !== task.net || s.width >= task.width || (board.approvedEscapeSegments ?? []).some(a => traceCovered(s, [a]))) return [s];
    let pieces = [s]; for (const pad of pads) pieces = pieces.flatMap(piece => outsidePadSegments(piece, pad, s.width / 2 + task.clearance));
    return pieces.map(piece => ({ ...piece, net: fake }));
  });
  const vias = board.vias.map(v => v.net === task.net && (v.diameter < task.via.diameterMil || v.hole < task.via.holeMil) ? { ...v, net: fake } : v);
  return { ...board, segments, vias };
}

function sourceSegments(pad, end, sourceLayer, fine, local, neckExtra) {
  const start = [pad.x, pad.y], direct = segment(pad.net, sourceLayer, fine, start, end), distance = length(direct);
  if (!distance) return [];
  if (fine === local) return [direct];
  const coveredEnd = Math.max(0, ...pad.shapes.filter(shape => shape.layers.includes(sourceLayer)).flatMap(shape => terminalIntervals(direct, shape).filter(([lo]) => lo < 1e-8).map(([,hi]) => hi)));
  const t = Math.min(1, coveredEnd + neckExtra / distance), neck = [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
  return [segment(pad.net, sourceLayer, fine, start, neck), segment(pad.net, sourceLayer, local, neck, end)].filter(s => length(s) > 1e-8);
}
function exposedLength(candidate, pad, task) {
  return candidate.segments.filter(s => s.width < task.width).reduce((sum, s) => sum + outsidePadSegments(s, pad).reduce((n, piece) => n + length(piece), 0), 0);
}
function directions(options, padId) {
  const configured = options.directionsByPad?.[padId] ?? options.directions;
  if (!Array.isArray(configured) || !configured.length || configured.some(n => !Array.isArray(n) || n.length !== 2 || !n.every(Number.isFinite) || Math.hypot(...n) === 0)) throw Error('EXPLICIT_TRANSITION_DIRECTIONS_REQUIRED');
  return configured.map(n => { const size = Math.hypot(...n); return n.map(x => x / size); });
}

export function planTransitionSeeds({ board, task, method, options, budget, variant = 0 }) {
  assertRoutingBoard(board);
  if (!['same-layer', 'through-via'].includes(method) || !budget?.assertRemaining || !options || !positive([task.width, task.localWidth, options.anchorLengthMil, options.maxExposedNarrowLengthMil]) || !Number.isInteger(options.maxCandidatesPerSource) || options.maxCandidatesPerSource < 1 || !Array.isArray(options.neckExtensionsMil) || !options.neckExtensionsMil.length || options.neckExtensionsMil.some(n => !Number.isFinite(n) || n < 0) || !Array.isArray(options.targetExtensionsMil) || !positive(options.targetExtensionsMil)) throw Error('EXPLICIT_TRANSITION_PARAMETERS_REQUIRED');
  if (!Number.isInteger(variant) || variant < 0) throw Error('INVALID_TRANSITION_VARIANT');
  if (method === 'through-via' && (!task.layers.includes(options.transitLayer) || !Number.isInteger(options.viaCount) || options.viaCount < 1 || !positive([task.via?.diameterMil, task.via?.holeMil]) || task.via.holeMil >= task.via.diameterMil)) throw Error('EXPLICIT_ALLOWED_TRANSIT_REQUIRED');
  const selected = new Set(task.requiredPadIds), solverBoard = protectRoleCopper(board, task, options);
  const geometryBoard = { ...solverBoard, pads: solverBoard.pads.map(p => p.net === task.net && !selected.has(p.id) ? { ...p, net: '__other_role_pad__' + p.id } : p) };
  const fits = candidate => copperFits(geometryBoard, candidate, options.geometry).passed;
  const pads = board.pads.filter(p => selected.has(p.id) && !(options.skipPadIds ?? []).includes(p.id)), domains = [], reports = [];
  if (!pads.length) return { segments: [], vias: [], anchors: [], metadata: [], solverBoard };
  for (const pad of pads) {
    budget.assertRemaining();
    const sourceLayer = options.sourceLayers?.[pad.id], fine = options.fineWidthsMil?.[pad.id], local = task.localWidth, candidates = [];
    if (!task.layers.includes(sourceLayer) || !pad.shapes.some(shape => shape.layers.includes(sourceLayer)) || !positive([fine]) || fine > local || local > task.width || method === 'through-via' && sourceLayer === options.transitLayer) throw Error('SOURCE_TRANSITION_RULE_MISMATCH:' + pad.id);
    const normals = directions(options, pad.id), start = [pad.x, pad.y];
    const add = (segments, vias, anchor, metadata) => {
      const candidate = { net: task.net, taskId: task.id, padId: pad.id, segments, vias, anchor, metadata, cost: segments.reduce((sum, s) => sum + length(s), 0) };
      if (exposedLength(candidate, pad, task) <= options.maxExposedNarrowLengthMil && fits(candidate)) candidates.push(candidate);
    };
    if (method === 'same-layer') {
      for (const normal of normals) for (const extension of options.targetExtensionsMil) for (const neck of options.neckExtensionsMil) {
        budget.assertRemaining();
        const end = point(start, normal, extension), tail = point(end, normal, options.anchorLengthMil);
        add([...sourceSegments(pad, end, sourceLayer, fine, local, neck), segment(task.net, sourceLayer, task.width, end, tail)], [], { x: tail[0], y: tail[1], layer: sourceLayer, width: task.width }, { method, normal, extensionMil: extension, neckMil: neck });
      }
    } else {
      const report = createViaSpaceScanner(geometryBoard, { outline: options.geometry?.outline ?? geometryBoard.outline })(pad.id, { ...options.scan, ...options.geometry, viaDiameterMil: task.via.diameterMil, holeDiameterMil: task.via.holeMil, traceWidthMil: fine, sourceLayer, viaLayers: board.layers, budget });
      reports.push(report);
      for (const first of report.candidates) {
        budget.assertRemaining();
        const chosen = [first];
        for (const other of report.candidates) {
          if (chosen.length >= options.viaCount) break;
          if (chosen.every(c => Math.hypot(c.xMil - other.xMil, c.yMil - other.yMil) >= task.via.diameterMil + options.geometry.copperClearanceMil && Math.hypot(c.xMil - other.xMil, c.yMil - other.yMil) - task.via.holeMil >= options.geometry.drillToDrillClearanceMil)) chosen.push(other);
        }
        if (chosen.length < options.viaCount) continue;
        const center = chosen.reduce((sum, c) => [sum[0] + c.xMil / chosen.length, sum[1] + c.yMil / chosen.length], [0, 0]);
        for (const normal of normals) for (const extension of options.targetExtensionsMil) for (const neck of options.neckExtensionsMil) {
          budget.assertRemaining();
          const end = point(center, normal, extension), tail = point(end, normal, options.anchorLengthMil);
          const segments = chosen.flatMap(c => sourceSegments(pad, [c.xMil, c.yMil], sourceLayer, fine, local, neck));
          for (const c of chosen) segments.push(segment(task.net, options.transitLayer, local, [c.xMil, c.yMil], end));
          segments.push(segment(task.net, options.transitLayer, task.width, end, tail));
          add(segments, chosen.map(c => c.via), { x: tail[0], y: tail[1], layer: options.transitLayer, width: task.width }, { method, normal, extensionMil: extension, neckMil: neck, scanSampled: report.sampled });
        }
      }
    }
    candidates.sort((a, b) => a.cost - b.cost);
    // Spatial/cost alternatives consume the same shared task budget.
    domains.push({ id: pad.id, candidates: candidates.slice(variant, variant + options.maxCandidatesPerSource) });
  }
  const assignment = chooseJointEscapes(domains, board.layers, { clearanceMil: options.geometry.copperClearanceMil, drillToDrillClearanceMil: options.geometry.drillToDrillClearanceMil, budget });
  if (!assignment.chosen) throw Error('NO_LEGAL_TRANSITION_SEED_SET:' + assignment.reason);
  return { segments: assignment.chosen.flatMap(c => c.segments), vias: assignment.chosen.flatMap(c => c.vias), anchors: assignment.chosen.map(c => c.anchor), metadata: assignment.chosen.map(c => ({ padId: c.padId, ...c.metadata })), reports, assignment, solverBoard };
}

export async function compareTransitions({ board, policy, task, options, budget, solve, validate, evaluate }) {
  if (!budget?.assertRemaining || typeof solve !== 'function' || typeof validate !== 'function' || typeof evaluate !== 'function' || !Array.isArray(options?.methods) || !options.methods.length) throw Error('TRANSITION_COMPARISON_CALLBACKS_REQUIRED');
  const attempts = []; let selected = null;
  for (const configuration of options.methods) {
    if (!['same-layer', 'through-via'].includes(configuration.method) || !Number.isInteger(configuration.variants) || configuration.variants < 1) throw Error('INVALID_TRANSITION_METHOD');
    for (let variant = 0; variant < configuration.variants; variant++) {
      try {
        budget.assertRemaining();
        const seedOptions = { ...options.seedOptions, ...configuration.seedOptions }, seeds = planTransitionSeeds({ board, task, method: configuration.method, options: seedOptions, budget, variant });
        // A via candidate may route on every allowed task layer after transition.
        const variantTask = { ...task, layers: configuration.method === 'same-layer' ? [...new Set(seeds.anchors.map(anchor => anchor.layer))] : [...task.layers] };
        const candidate = await solve({ board: seeds.solverBoard, policy, task: variantTask, seeds, method: configuration.method, variant, budget }); budget.assertRemaining();
        const validation = await validate({ board, policy, task: variantTask, candidate, seeds, budget });
        if (configuration.method === 'same-layer' && candidate.vias.length) { validation.issues = [...(validation.issues ?? []), { code: 'SAME_LAYER_METHOD_CREATED_VIAS' }]; validation.passed = false; }
        const combined = { ...board, segments: [...board.segments, ...candidate.segments], vias: [...board.vias, ...candidate.vias] };
        const evaluation = validation.passed ? await evaluate({ board: combined, policy, task, candidate, method: configuration.method, budget }) : null;
        budget.assertRemaining();
        if (evaluation && (!Number.isFinite(evaluation.cost) || evaluation.cost < 0)) throw Error('FINITE_TRANSITION_SCORE_REQUIRED');
        const attempt = { method: configuration.method, variant, validation, evaluation, seedMetadata: seeds.metadata };
        attempts.push(attempt);
        if (validation.passed && (!selected || evaluation.cost < selected.evaluation.cost)) selected = { ...attempt, candidate, task: variantTask, seeds };
      } catch (error) { attempts.push({ method: configuration.method, variant, error: error.message }); if (error.message === 'TASK_BUDGET_EXHAUSTED') return { readOnly: true, selected, attempts, timedOut: true, budget: budget.snapshot() }; }
    }
  }
  return { readOnly: true, selected, attempts, timedOut: false, budget: budget.snapshot(), scope: 'Finite legal full-route candidates compared using caller-configured metrics; no ground/thermal/EMI completion is implied.' };
}

export function evaluateTransitionPaths({ board, metrics, weights, budget }) {
  budget?.assertRemaining();
  const report = criticalRouteMetrics(board, { ...metrics, budget });
  if (!weights || report.pairs.some(pair => !Number.isFinite(weights[pair.id]) || weights[pair.id] < 0)) throw Error('EXPLICIT_TRANSITION_PATH_WEIGHTS_REQUIRED');
  if (report.pairs.some(pair => !pair.connected)) throw Error('TRANSITION_CRITICAL_PATH_DISCONNECTED');
  budget?.assertRemaining();
  return { cost: report.pairs.reduce((sum, pair) => sum + pair.scoredPathMm * weights[pair.id], 0), metrics: report };
}
