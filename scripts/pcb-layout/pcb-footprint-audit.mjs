/** Exact footprint names share the same rule as layout preparation. */
export function auditFootprintNames({ snapshot, contract }) {
  const expected = new Map(contract.components.map(component => [component.designator, component]));
  const diagnostics = [], uncovered = [];
  let compared = 0;
  for (const [index, actual] of snapshot.components.entries()) {
    const footprint = expected.get(actual?.ref)?.footprint;
    if (footprint?.selection !== 'exact' || typeof footprint.name !== 'string' || !footprint.name.trim()) {
      uncovered.push(actual?.ref);
      continue;
    }
    compared++;
    if (footprint.name !== actual.footprint?.name) diagnostics.push({ severity: 'error', code: 'FOOTPRINT_IDENTITY_MISMATCH', path: `snapshot.components[${index}].footprint`, ref: actual.ref, message: `Expected exact footprint ${footprint.name}; observed ${actual.footprint?.name ?? 'unknown'}.` });
  }
  return { status: diagnostics.length ? 'mismatch' : uncovered.length ? 'unverified' : 'matched', diagnostics, compared, uncovered, scope: 'exact-footprint-names;not-manufacturer-part-certification' };
}
