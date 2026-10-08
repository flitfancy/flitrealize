// Role/net rip-up and finite replay. Every net replay compiles all its roles.
import { compileTasks } from './model.mjs';
import { conductiveGap } from './geometry.mjs';
import { segmentShape, viaShape } from './via-space.mjs';

export const taskKey = task => task.net + ':' + task.role;
export const segmentKey = s => JSON.stringify([s.net, s.layer, s.width, ...[[s.x1, s.y1], [s.x2, s.y2]].sort((a, b) => a[0] - b[0] || a[1] - b[1]).flat()]);
export const viaKey = v => JSON.stringify([v.net, v.x, v.y, v.diameter, v.hole, [...(v.layers ?? [])].sort((a, b) => a - b)]);
const selectedTask = (task, keys) => keys.has(task.id) || keys.has(taskKey(task));
const dropAuthorizations = (board, shouldDrop) => {
  board.approvedEscapeSegments = (board.approvedEscapeSegments ?? []).filter(s => !shouldDrop(s));
  for (const [net, seeds] of Object.entries(board.mainEscapeSegments ?? {})) {
    board.mainEscapeSegments[net] = seeds.filter(s => !shouldDrop(s));
    if (!board.mainEscapeSegments[net].length) delete board.mainEscapeSegments[net];
  }
};
function assertUnlocked(board, segments, vias) {
  if (board.segments.some(s => segments.has(segmentKey(s)) && s.locked) || board.vias.some(v => vias.has(viaKey(v)) && v.locked)) throw Error('LOCKED_REPAIR_COPPER');
}
export function stripNetworks(state, nets) {
  const out = structuredClone(state), removed = new Set(nets);
  if (!Array.isArray(state.accepted)) throw Error('ACCEPTED_ROLE_PROVENANCE_REQUIRED');
  if (out.board.segments.some(s => removed.has(s.net) && s.locked) || out.board.vias.some(v => removed.has(v.net) && v.locked)) throw Error('LOCKED_REPAIR_COPPER');
  out.board.segments = out.board.segments.filter(s => !removed.has(s.net));
  out.board.vias = out.board.vias.filter(v => !removed.has(v.net));
  dropAuthorizations(out.board, s => removed.has(s.net));
  out.accepted = out.accepted.filter(a => !removed.has(a.task.net));
  return out;
}
export function stripRoles(state, keys) {
  if (!Array.isArray(state.accepted)) throw Error('ACCEPTED_ROLE_PROVENANCE_REQUIRED');
  const out = structuredClone(state), removed = new Set(keys), drop = out.accepted.filter(a => selectedTask(a.task, removed)), keep = out.accepted.filter(a => !selectedTask(a.task, removed));
  if (!drop.length) throw Error('REPAIR_ROLE_NOT_FOUND');
  const sharedSegments = new Set(keep.flatMap(a => a.candidate.segments.map(segmentKey))), sharedVias = new Set(keep.flatMap(a => a.candidate.vias.map(viaKey)));
  const withdrawnSegments = new Set(drop.flatMap(a => a.candidate.segments.map(segmentKey)));
  const segments = new Set([...withdrawnSegments].filter(key => !sharedSegments.has(key))), vias = new Set(drop.flatMap(a => a.candidate.vias.map(viaKey)).filter(key => !sharedVias.has(key)));
  assertUnlocked(out.board, segments, vias);
  out.board.segments = out.board.segments.filter(s => !segments.has(segmentKey(s)));
  out.board.vias = out.board.vias.filter(v => !vias.has(viaKey(v)));
  // Copper ownership and permission to use a thin escape as a main path are
  // different. Shared geometry survives; a withdrawn role's approval expires.
  // Untagged legacy approvals cannot prove another role owns that permission.
  dropAuthorizations(out.board, s => {
    if (segments.has(segmentKey(s))) return true;
    if (s.taskId) return drop.some(a => a.task.id === s.taskId);
    if (s.taskKey) return drop.some(a => taskKey(a.task) === s.taskKey);
    if (s.role) return drop.some(a => a.task.net === s.net && a.task.role === s.role);
    return withdrawnSegments.has(segmentKey(s));
  });
  out.accepted = keep;
  return out;
}
export function unaffectedFingerprint(board, affected) {
  const changed = new Set(affected), canonical = items => items.map(x => JSON.stringify(x)).sort();
  return JSON.stringify({ pads: board.pads, segments: canonical(board.segments.filter(s => !changed.has(s.net))), vias: canonical(board.vias.filter(v => !changed.has(v.net))), approvedEscapeSegments: canonical((board.approvedEscapeSegments ?? []).filter(s => !changed.has(s.net))), mainEscapeSegments: Object.fromEntries(Object.entries(board.mainEscapeSegments ?? {}).filter(([net]) => !changed.has(net)).sort(([a], [b]) => a.localeCompare(b))) });
}

export function rankBlockers(board, policy, failed, { proximityMil, directWeight, endpointWeights = {} } = {}) {
  if (!Number.isFinite(proximityMil) || proximityMil <= 0 || !Number.isFinite(directWeight) || directWeight < 0) throw Error('EXPLICIT_BLOCKER_RANKING_REQUIRED');
  const task = compileTasks(board, policy, { nets: [failed.net], roles: [failed.role] }).find(t => failed.id ? t.id === failed.id : taskKey(t) === taskKey(failed));
  if (!task) return [];
  if (task.status === 'delegated') throw Error('GROUND_PLANE_REQUIRES_POUR_WORKFLOW');
  const pads = board.pads.filter(p => task.requiredPadIds.includes(p.id)), corridors = [];
  for (let i = 0; i < pads.length; i++) for (let j = i + 1; j < pads.length; j++) corridors.push({ kind: 'capsule', a: [pads[i].x, pads[i].y], b: [pads[j].x, pads[j].y], radius: task.width / 2, layers: task.layers });
  const scores = new Map(), allowed = new Set(policy.nets.map(n => n.net));
  for (const item of [...board.segments.map(s => ({ net: s.net, shape: segmentShape(s) })), ...board.vias.map(v => ({ net: v.net, shape: viaShape(v, board.layers) }))]) {
    if (item.net === task.net || !allowed.has(item.net)) continue;
    let nearEndpoint = 0, directHits = 0;
    for (const p of pads) {
      const gap = Math.min(...p.shapes.map(s => conductiveGap(s, item.shape))), weight = endpointWeights[p.id] ?? 1;
      if (!Number.isFinite(weight) || weight < 0) throw Error('INVALID_ENDPOINT_WEIGHT');
      if (gap < proximityMil) nearEndpoint += weight * (1 - Math.max(0, gap) / proximityMil);
    }
    for (const corridor of corridors) if (conductiveGap(corridor, item.shape) < task.clearance) directHits++;
    if (!nearEndpoint && !directHits) continue;
    const score = scores.get(item.net) ?? { net: item.net, nearEndpoint: 0, directHits: 0, score: 0 };
    score.nearEndpoint += nearEndpoint; score.directHits += directHits; score.score += nearEndpoint + directHits * directWeight; scores.set(item.net, score);
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.net.localeCompare(b.net));
}
export function repairNeighborhoods(ranked, { maxBlockers, maxCombinationSize } = {}) {
  if (!Number.isInteger(maxBlockers) || maxBlockers < 0 || !Number.isInteger(maxCombinationSize) || maxCombinationSize < 0) throw Error('EXPLICIT_REPAIR_SEARCH_LIMITS_REQUIRED');
  const nets = ranked.slice(0, maxBlockers).map(x => x.net), sets = [[]];
  const visit = (start, selected) => {
    if (selected.length) sets.push([...selected]);
    if (selected.length >= maxCombinationSize) return;
    for (let i = start; i < nets.length; i++) visit(i + 1, [...selected, nets[i]]);
  };
  visit(0, []);
  return sets.sort((a, b) => a.length - b.length);
}

function commonGate(before, after, beforeBoard, afterBoard, affected, protectedState) {
  const issues = [], afterTasks = new Map(after.tasks.map(t => [t.id ?? taskKey(t), t.connected]));
  if (!after.audit?.passed) issues.push('AUDIT_FAILED');
  for (const task of before.tasks) if (task.connected && !afterTasks.get(task.id ?? taskKey(task))) issues.push('LOST_CONNECTION:' + (task.id ?? taskKey(task)));
  if (unaffectedFingerprint(beforeBoard, affected) !== unaffectedFingerprint(afterBoard, affected)) issues.push('CHANGED_OUTSIDE_REPAIR_SCOPE');
  // For role rip-up, same-net copper outside the role remains protected too.
  if (protectedState) {
    const traces = new Set(afterBoard.segments.map(segmentKey)), vias = new Set(afterBoard.vias.map(viaKey));
    if (protectedState.board.segments.some(s => !traces.has(segmentKey(s))) || protectedState.board.vias.some(v => !vias.has(viaKey(v)))) issues.push('REMOVED_PROTECTED_SHARED_COPPER');
    const approved = new Set((afterBoard.approvedEscapeSegments ?? []).map(segmentKey));
    if ((protectedState.board.approvedEscapeSegments ?? []).some(s => !approved.has(segmentKey(s)))) issues.push('REMOVED_PROTECTED_ESCAPE_AUTHORIZATION');
    for (const [net, seeds] of Object.entries(protectedState.board.mainEscapeSegments ?? {})) {
      const next = new Set((afterBoard.mainEscapeSegments?.[net] ?? []).map(segmentKey));
      if (seeds.some(s => !next.has(segmentKey(s)))) issues.push('REMOVED_PROTECTED_MAIN_ESCAPE_AUTHORIZATION:' + net);
    }
  }
  return issues;
}
export function repairGate(before, after, beforeBoard, afterBoard, affected, { protectedState, requireScoreImprovement = false } = {}) {
  const issues = commonGate(before, after, beforeBoard, afterBoard, affected, protectedState);
  if (after.connectedTasks <= before.connectedTasks) issues.push('NO_ADDITIONAL_CONNECTION');
  if (requireScoreImprovement && !(Number.isFinite(after.score) && after.score < before.score)) issues.push('SCORE_NOT_IMPROVED');
  return { passed: !issues.length, issues };
}
export function optimizationGate(before, after, beforeBoard, afterBoard, affected, targetId, { maxPathRegressionMm, minTargetImprovementMm, protectedState, requireScoreImprovement = false } = {}) {
  if (![maxPathRegressionMm, minTargetImprovementMm].every(n => Number.isFinite(n) && n >= 0)) throw Error('EXPLICIT_PATH_ACCEPTANCE_REQUIRED');
  const issues = commonGate(before, after, beforeBoard, afterBoard, affected, protectedState);
  for (const path of before.routeMetrics.pairs) {
    const next = after.routeMetrics.pairs.find(q => q.id === path.id);
    if (path.connected && (!next?.connected || !Number.isFinite(path.scoredPathMm) || !Number.isFinite(next.scoredPathMm) || next.scoredPathMm > path.scoredPathMm + maxPathRegressionMm)) issues.push('CRITICAL_PATH_REGRESSION:' + path.id);
  }
  const old = before.routeMetrics.pairs.find(p => p.id === targetId), next = after.routeMetrics.pairs.find(p => p.id === targetId);
  if (!old?.connected || !next?.connected || !Number.isFinite(old.scoredPathMm) || !Number.isFinite(next.scoredPathMm) || next.scoredPathMm >= old.scoredPathMm - minTargetImprovementMm) issues.push('TARGET_PATH_NOT_SHORTER');
  if (requireScoreImprovement && !(Number.isFinite(after.score) && after.score < before.score)) issues.push('SCORE_NOT_IMPROVED');
  return { passed: !issues.length, issues };
}

export function planLocalRepair({ state, failed, options }) {
  const ranked = rankBlockers(state.board, state.policy, failed, options.ranking);
  const neighborhoods = repairNeighborhoods(ranked, options.search).map(blockers => ({ kind: 'net', blockers }));
  if (state.accepted.some(a => a.task.net === failed.net && a.task.role === failed.role)) neighborhoods.unshift({ kind: 'role', blockers: [] });
  return { readOnly: true, ranked, neighborhoods, scope: 'Finite role/net replay neighborhoods; no completed route or native write is implied.' };
}
export async function runLocalRepair({ state, failed, options, budget, reroute, evaluate, gate }) {
  if (!budget?.assertRemaining || typeof reroute !== 'function' || typeof evaluate !== 'function' || typeof gate !== 'function') throw Error('REPAIR_EXECUTION_CALLBACKS_REQUIRED');
  const plan = planLocalRepair({ state, failed, options }), before = await evaluate(state), attempts = [];
  for (const neighborhood of plan.neighborhoods) {
    budget.assertRemaining();
    const affected = [failed.net, ...neighborhood.blockers], initialState = neighborhood.kind === 'role' ? stripRoles(state, [failed.id ?? taskKey(failed)]) : stripNetworks(state, affected);
    const tasks = compileTasks(initialState.board, initialState.policy, { nets: affected, ...(neighborhood.kind === 'role' ? { roles: [failed.role] } : {}) });
    try {
      const next = await reroute({ state: initialState, tasks, affected, neighborhood, budget }); budget.assertRemaining();
      const after = await evaluate(next), validation = gate(before, after, state.board, next.board, affected, { protectedState: initialState });
      attempts.push({ neighborhood, affected, validation });
      if (validation.passed) return { readOnly: true, state: next, report: after, attempts, accepted: true, budget: budget.snapshot() };
    } catch (error) { attempts.push({ neighborhood, affected, error: error.message }); if (error.message === 'TASK_BUDGET_EXHAUSTED') break; }
  }
  return { readOnly: true, state, report: before, attempts, accepted: false, budget: budget.snapshot() };
}
