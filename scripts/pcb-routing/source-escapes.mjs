import { conductiveGap } from './geometry.mjs';
import { segmentShape, viaShape, assertRoutingBoard, createViaSpaceScanner } from './via-space.mjs';

export const escapeShapes = (candidate, layers) => [...candidate.segments.map(segmentShape), ...candidate.vias.map(v => viaShape(v, layers))];
export function chooseJointEscapes(domains, layers, { clearanceMil, drillToDrillClearanceMil, budget } = {}) {
  if (!Array.isArray(layers) || !layers.length || ![clearanceMil, drillToDrillClearanceMil].every(n => Number.isFinite(n) && n >= 0) || !budget?.assertRemaining) throw Error('EXPLICIT_JOINT_ESCAPE_RULES_REQUIRED');
  const ids = new Set();
  const ordered = domains.map(domain => {
    if (!domain.id || ids.has(domain.id)) throw Error('UNIQUE_SOURCE_DOMAIN_REQUIRED'); ids.add(domain.id);
    return { ...domain, candidates: domain.candidates.map((c, i) => {
      if (!Number.isFinite(c.cost) || c.cost < 0 || !c.segments || !c.vias) throw Error('INVALID_ESCAPE_CANDIDATE');
      assertRoutingBoard({ layers, pads: [], segments: c.segments, vias: c.vias });
      return { ...c, domainId: domain.id, candidateIndex: i, shapes: escapeShapes(c, layers) };
    }).sort((a, b) => a.cost - b.cost) };
  }).sort((a, b) => a.candidates.length - b.candidates.length || a.id.localeCompare(b.id));
  if (ordered.some(d => !d.candidates.length)) return { chosen: null, reason: 'EMPTY_SOURCE_DOMAIN', nodes: 0, timedOut: false };
  const remaining = Array(ordered.length + 1).fill(0);
  for (let i = ordered.length - 1; i >= 0; i--) remaining[i] = remaining[i + 1] + ordered[i].candidates[0].cost;
  let best = null, bestCost = Infinity, nodes = 0, timedOut = false;
  const compatible = (a, b) => !a.shapes.some(x => b.shapes.some(y => conductiveGap(x, y) < clearanceMil)) && !a.vias.some(v => b.vias.some(w => Math.hypot(v.x - w.x, v.y - w.y) - (v.hole + w.hole) / 2 < drillToDrillClearanceMil));
  const visit = (i, cost, selected) => {
    try { budget.assertRemaining(); } catch (error) { if (error.message !== 'TASK_BUDGET_EXHAUSTED') throw error; timedOut = true; return; }
    if (cost + remaining[i] >= bestCost) return;
    if (i === ordered.length) { best = selected.map(({ shapes, ...c }) => c); bestCost = cost; return; }
    for (const candidate of ordered[i].candidates) {
      nodes++; if (cost + candidate.cost + remaining[i + 1] >= bestCost) break;
      if (selected.some(old => !compatible(candidate, old))) continue;
      visit(i + 1, cost + candidate.cost, [...selected, candidate]); if (timedOut) return;
    }
  };
  visit(0, 0, []);
  return { chosen: best, totalCost: best ? bestCost : null, nodes, timedOut, optimalWithinDomains: !!best && !timedOut, reason: best ? 'COMPATIBLE_ESCAPE_SET' : timedOut ? 'SEARCH_BUDGET' : 'NO_COMPATIBLE_SET', scope: 'Finite candidate domains; sources retain independent role identities.' };
}

export function runSourceEscapes({ board, sources, scanOptions, clearanceMil, drillToDrillClearanceMil, budget }) {
  assertRoutingBoard(board);
  const scan = createViaSpaceScanner(board, { outline: scanOptions?.outline ?? board.outline });
  const reports = sources.map(source => ({ id: source.id, taskKey: source.taskKey, ...scan(source.padId, { ...scanOptions, ...source.scanOptions, budget }) }));
  const domains = reports.map(report => ({ id: report.id, candidates: report.candidates.map(c => ({ net: report.net, taskKey: report.taskKey, padId: report.padId, cost: c.distanceMil, segments: [c.trace], vias: [c.via] })) }));
  return { readOnly: true, reports, assignment: chooseJointEscapes(domains, board.layers, { clearanceMil, drillToDrillClearanceMil, budget }) };
}
