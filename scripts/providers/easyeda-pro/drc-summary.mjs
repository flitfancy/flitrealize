/** Count the leaves of EasyEDA's verbose DRC groups, retaining unknown categories. */
export function summarizeNativeDrc(report) {
  if (!Array.isArray(report)) throw Error('DRC_RESULT_UNAVAILABLE');
  const totals = { physicalErrorCount: 0, connectionErrorCount: 0, netlistErrorCount: 0, totalErrorCount: 0 };
  const category = label => {
    const name = typeof label === 'string' ? label.trim().toLowerCase() : '';
    if (['connection error', 'no connection'].includes(name)) return 'connectionErrorCount';
    if (name === 'netlist error') return 'netlistErrorCount';
    return 'physicalErrorCount';
  };
  const visit = (node, inherited = 'physicalErrorCount', depth = 0) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw Error('DRC_ENTRY_INVALID');
    const own = typeof node.errorType === 'string' ? category(node.errorType)
      : depth === 0 ? category(node.name) : inherited;
    if (Object.hasOwn(node, 'list')) {
      if (!Array.isArray(node.list)) throw Error('DRC_GROUP_INVALID');
      if (!node.list.length && Number(node.count) > 0) throw Error('DRC_GROUP_INCOMPLETE');
      for (const child of node.list) visit(child, own, depth + 1);
      return;
    }
    totals[own]++;
    totals.totalErrorCount++;
  };
  for (const group of report) visit(group);
  return totals;
}

/** Exact physical records, including their rule/group context; never aggregate counts. */
export function nativeDrcRecords(report) {
  summarizeNativeDrc(report);
  const records = [];
  const visit = (node, parents = [], inherited = 'physical') => {
    const label = String(node.errorType ?? (parents.length ? '' : node.name) ?? '').trim().toLowerCase();
    const kind = ['connection error', 'no connection'].includes(label) ? 'connection' : label === 'netlist error' ? 'netlist' : label ? 'physical' : inherited;
    if (Object.hasOwn(node, 'list')) {
      const context = { ...node }; delete context.list; delete context.count;
      for (const child of node.list) visit(child, [...parents, context], kind);
    } else if (kind === 'physical') {
      const objects = node.objs ?? node.objects ?? node.primitives ?? node.primitiveIds ?? node.primitiveId ?? node.objectId;
      const bound = typeof objects === 'string' ? Boolean(objects.trim()) : Array.isArray(objects) && objects.length > 0 && objects.every(object => typeof object === 'string' ? object.trim() : object && typeof object === 'object' && typeof (object.primitiveId ?? object.id) === 'string');
      if (!bound || Object.hasOwn(node, 'count')) throw Error('DRC_RECORD_EVIDENCE_INCOMPLETE');
      records.push({ parents, record: node });
    }
  };
  for (const group of report) visit(group);
  return records;
}

export function compareNativeDrc(current, baseline) {
  const strict = summarizeNativeDrc(current).physicalErrorCount === 0;
  const key = value => {
    if (Array.isArray(value)) return '[' + value.map(key).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(name => JSON.stringify(name) + ':' + key(value[name])).join(',') + '}';
    if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    throw Error('DRC_RECORD_EVIDENCE_INCOMPLETE');
  };
  try {
    const remaining = nativeDrcRecords(baseline).map(key), records = nativeDrcRecords(current).map(key);
    let added = 0;
    for (const record of records) { const index = remaining.indexOf(record); if (index < 0) added++; else remaining.splice(index, 1); }
    return { passed: added === 0, newViolationCount: added, resolvedViolationCount: remaining.length, retainedViolationCount: records.length - added,
      coverage: 'complete-physical-records', measurementComparison: 'unsupported; changed records require reconciliation' };
  } catch (error) {
    return { passed: strict, coverage: 'strict-zero-physical', reason: error.message };
  }
}
