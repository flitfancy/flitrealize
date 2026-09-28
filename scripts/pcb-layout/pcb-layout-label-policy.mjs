// The same footprint may use a different label template in a particular design.
// Selection is explicit; electrical reference prefixes have no geometric meaning.
export function labelTemplate(component, rules) {
  const input = rules.labelTemplates ?? {};
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const check = (value, allowed) => {
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw Error('INVALID_LABEL_TEMPLATE ' + component.ref);
  };
  check(input, ['default', 'footprints', 'overrides']);
  if (input.default !== undefined) check(input.default, ['anchor', 'minGapMil', 'basis']);
  if (input.footprints !== undefined && !Array.isArray(input.footprints)) throw Error('INVALID_LABEL_TEMPLATE ' + component.ref);
  for (const rule of input.footprints ?? []) {
    check(rule, ['names', 'anchor', 'minGapMil', 'basis']);
    if (!Array.isArray(rule.names) || !rule.names.length || rule.names.some(name => typeof name !== 'string' || !name)) throw Error('INVALID_LABEL_TEMPLATE ' + component.ref);
  }
  if (input.overrides !== undefined) {
    if (!object(input.overrides)) throw Error('INVALID_LABEL_TEMPLATE ' + component.ref);
    for (const value of Object.values(input.overrides)) check(value, ['anchor', 'minGapMil', 'basis']);
  }
  const candidates = (input.footprints ?? []).filter(r => r.names?.includes(component.footprint?.name));
  if (candidates.length > 1) throw Error('AMBIGUOUS_LABEL_TEMPLATE ' + component.ref);
  const selected = { anchor: 'body-and-pads', minGapMil: 0, ...(input.default ?? {}), ...(candidates[0] ?? {}), ...(input.overrides?.[component.ref] ?? {}) };
  if (!['pads', 'body-and-pads'].includes(selected.anchor) || !Number.isFinite(selected.minGapMil) || selected.minGapMil < 0) throw Error('INVALID_LABEL_TEMPLATE ' + component.ref);
  return selected;
}
