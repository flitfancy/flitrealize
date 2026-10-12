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
