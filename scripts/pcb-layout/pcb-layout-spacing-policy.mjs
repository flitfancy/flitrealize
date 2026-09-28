// Physical spacing is derived from assembly courtyards and explicit pair requirements.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const finiteNonnegative = value => Number.isFinite(value) && value >= 0;
const nameOK = value => typeof value === 'string' && value.length > 0 && value.trim() === value;

function objectWithKeys(value, keys, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error('INVALID_SPACING_POLICY ' + context);
}

function optionalText(value, key, context) {
  if (own(value, key) && typeof value[key] !== 'string') throw Error('INVALID_SPACING_POLICY ' + context + '.' + key);
}

export function compileSpacingPolicy(input, refs, { absoluteFloorMil = 0, assemblyPolicy = null } = {}) {
  if (input === undefined || input === null) return null;
  if (input.schemaVersion !== 2) throw Error('UNSUPPORTED_SPACING_POLICY_VERSION: use schemaVersion 2 with assembly-courtyard physical spacing');
  objectWithKeys(input, ['schemaVersion', 'mode', 'source', 'geometry', 'bandRatios', 'requirements', 'description'], 'assembly-root');
  optionalText(input, 'description', 'assembly-root');
  if (input.mode !== 'active' || input.source !== 'assembly-courtyard' || input.geometry !== 'physical') throw Error('INVALID_ASSEMBLY_SPACING_POLICY');
  if (!assemblyPolicy) throw Error('ASSEMBLY_RULES_REQUIRED_FOR_SPACING');
  if (!Array.isArray(refs) || refs.some(ref => !nameOK(ref)) || new Set(refs).size !== refs.length) throw Error('INVALID_SPACING_REFS');
  if (!Number.isFinite(absoluteFloorMil) || absoluteFloorMil <= 0) throw Error('ASSEMBLY_SPACING_REQUIRES_POSITIVE_ABSOLUTE_FLOOR');
  objectWithKeys(input.bandRatios, ['rejectBelow', 'neutralMin', 'neutralMax'], 'bandRatios');
  const r = input.bandRatios;
  if (!Object.values(r).every(Number.isFinite) || !['rejectBelow', 'neutralMin', 'neutralMax'].every(k => Number.isFinite(r[k])) || r.rejectBelow <= 0 || r.neutralMin < r.rejectBelow || r.neutralMax < r.neutralMin) throw Error('INVALID_SPACING_RATIOS');
  if (!Array.isArray(input.requirements)) throw Error('INVALID_SPACING_REQUIREMENTS');
  const ids = new Set(), allowed = new Set(refs);
  const requirements = input.requirements.map(q => {
    objectWithKeys(q, ['id', 'refs', 'purpose', 'hardMinimumMil', 'basis'], 'assembly-requirement');
    if (!nameOK(q.id) || ids.has(q.id) || !nameOK(q.purpose) || !Array.isArray(q.refs) || q.refs.length !== 2 || q.refs[0] === q.refs[1] || !q.refs.every(ref => allowed.has(ref)) || !finiteNonnegative(q.hardMinimumMil)) throw Error('INVALID_SPACING_REQUIREMENT ' + q.id);
    ids.add(q.id); return { ...q, refs: [...q.refs] };
  });
  return { schemaVersion: 2, mode: 'active', source: input.source, geometry: 'physical', state: 'ready', baselineStatus: 'derived',
    baselineDefinition: 'directional-hard-minimum-divided-by-reject-ratio', bandRatios: { ...r }, refs: [...refs],
    absoluteFloorMil, requirements };
}

export function scorePairSpacing(distanceMil, resolved) {
  if (!Number.isFinite(distanceMil)) throw Error('INVALID_SPACING_DISTANCE');
  if (!resolved || resolved.state !== 'ready' || !Number.isFinite(resolved.baselineMil) || resolved.baselineMil <= 0 || ![resolved.hardMinMil, resolved.neutralMinMil, resolved.neutralMaxMil].every(Number.isFinite)) throw Error('INVALID_RESOLVED_SPACING');
  const ratio = Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, distanceMil / resolved.baselineMil));
  const accepted = distanceMil >= resolved.hardMinMil;
  const status = !accepted ? 'below-minimum' : distanceMil < resolved.neutralMinMil ? 'tight' : distanceMil > resolved.neutralMaxMil ? 'loose' : 'neutral';
  const deviation = distanceMil < resolved.neutralMinMil ? resolved.neutralMinMil - distanceMil : distanceMil > resolved.neutralMaxMil ? distanceMil - resolved.neutralMaxMil : 0;
  const penalty = Math.min(Number.MAX_VALUE, (deviation / resolved.baselineMil) ** 2);
  return { ratio, status, accepted, penalty };
}
