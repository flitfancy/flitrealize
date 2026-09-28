// A score-ranked, bounded pool for human inspection. No Pareto or aesthetic filter.
// Pool entries retain the candidate itself; large plans/metrics are never cloned.
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const validCandidate = candidate => candidate?.validation?.valid === true && Number.isFinite(candidate.comparisonScore);

function assertCount(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative integer`);
}

/** Returns null for malformed component poses. Labels and test pads are not part of the pose key. */
export function getCatalogPoseKey(candidate, gridMil = 0.001) {
  if (!Number.isFinite(gridMil) || gridMil <= 0) throw new RangeError('gridMil must be positive and finite');
  const components = candidate?.plan?.components;
  if (!Array.isArray(components) || !components.length) return null;
  const seen = new Set();
  const poses = [];
  for (const component of components) {
    if (!component || typeof component.ref !== 'string' || !component.ref || seen.has(component.ref)
      || ![component.x, component.y, component.rotation].every(Number.isFinite)) return null;
    seen.add(component.ref);
    const x = Math.round(component.x / gridMil), y = Math.round(component.y / gridMil);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null;
    const rotation = ((component.rotation % 360) + 360) % 360;
    poses.push([component.ref, x, y, rotation]);
  }
  poses.sort((a, b) => compareText(a[0], b[0]));
  return JSON.stringify(poses);
}

const compareEntries = (a, b) => a.candidate.comparisonScore - b.candidate.comparisonScore || compareText(a.key, b.key);

/** Use a consistent gridMil for a pool. Entries are { key, candidate }; callers own the candidates. */
export function addCatalogCandidate(pool, candidate, { limit = 40, gridMil = 20 } = {}) {
  assertCount(limit, 'limit');
  // Validate grid even when a rejected candidate has no pose.
  const key = getCatalogPoseKey(candidate, gridMil);
  if (!validCandidate(candidate) || key === null) return pool;
  const existing = pool.find(entry => entry.key === key);
  if (existing) {
    const scoreDifference = candidate.comparisonScore - existing.candidate.comparisonScore;
    if (scoreDifference > 0 || (scoreDifference === 0
      && compareText(getCatalogPoseKey(candidate), getCatalogPoseKey(existing.candidate)) >= 0)) return pool;
  }
  const next = pool.filter(entry => entry.key !== key);
  next.push({ key, candidate });
  next.sort(compareEntries);
  return next.slice(0, limit);
}

/** Exact-to-0.001mil deduplication for final selection; never pads a short result with repeats. */
export function selectCatalogCandidates(candidates, { count = 100 } = {}) {
  assertCount(count, 'count');
  const byPose = new Map();
  let validCount = 0;
  for (const candidate of candidates) {
    if (!validCandidate(candidate)) continue;
    const key = getCatalogPoseKey(candidate);
    if (key === null) continue;
    validCount++;
    const previous = byPose.get(key);
    if (!previous || candidate.comparisonScore < previous.candidate.comparisonScore) byPose.set(key, { key, candidate });
  }
  const entries = [...byPose.values()].sort(compareEntries);
  return {
    selected: entries.slice(0, count).map(entry => entry.candidate),
    available: entries.length,
    duplicatesRemoved: validCount - entries.length,
  };
}
