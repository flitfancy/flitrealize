// A bounded archive of sampled nondominated points, not a global Pareto proof.
export const dominates = (a, b) => a.every((v, i) => v <= b[i] + 1e-10) && a.some((v, i) => v < b[i] - 1e-10);
export function planKey(candidate) {
  return JSON.stringify([candidate.plan.components.map(c => [c.ref, c.x, c.y, c.rotation]), candidate.plan.labels.map(l => [l.id, l.x, l.y, l.rotation, l.alignMode]), candidate.plan.testPads.map(p => [p.id, p.x, p.y])]);
}
export function addToArchive(archive, candidate, vector, limit = 10) {
  if (!candidate.validation.valid || !vector.length || vector.some(v => !Number.isFinite(v))) return archive;
  if (archive.some(e => dominates(e.vector, vector) || e.vector.every((v, i) => Math.abs(v - vector[i]) < 1e-10))) return archive;
  const key = planKey(candidate);
  if (archive.some(e => e.key === key)) return archive;
  const next = archive.filter(e => !dominates(vector, e.vector));
  next.push({ candidate, vector, key });
  if (next.length <= limit) return next;
  // Crowding distance keeps extremes and dispersed alternatives deterministically.
  const crowding = next.map(() => 0);
  for (let d = 0; d < vector.length; d++) {
    const order = next.map((e, i) => ({ i, value: e.vector[d] })).sort((a, b) => a.value - b.value || a.i - b.i);
    const range = order.at(-1).value - order[0].value;
    if (range < 1e-10) continue;
    crowding[order[0].i] = crowding[order.at(-1).i] = Infinity;
    for (let j = 1; j < order.length - 1; j++) crowding[order[j].i] += (order[j + 1].value - order[j - 1].value) / range;
  }
  let remove = 0;
  for (let i = 1; i < next.length; i++) if (crowding[i] <= crowding[remove]) remove = i;
  next.splice(remove, 1);
  return next;
}
