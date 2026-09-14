// Provider-free normalization of explicit net classes and routing order.
// Priority is an execution plan, not a command sent to an autorouter.
return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? {} : flitrealizeInput;
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const clone = value => JSON.parse(JSON.stringify(value));
  if ((request.mode ?? 'generate') !== 'generate') fail('INVALID_MODE', 'Only generate is supported; this action cannot route or modify PCB rules.');
  const rules = request.rules;
  if (rules?.units !== 'mil' || !Array.isArray(rules.classes) || !rules.classes.length) fail('INVALID_RULES', 'rules needs units: mil and nonempty classes.');
  const classNames = new Set(), byNet = new Map();
  const widths = ['widthMil', 'trunkWidthMil', 'localWidthMil', 'viaHoleMil', 'viaDiameterMil', 'pairSpacingMil', 'minSwitchClearanceMil'];
  function positive(value, name) {
    if (!Number.isFinite(value) || value <= 0) fail('INVALID_DIMENSION', `${name} must be a positive finite number.`);
  }
  if (rules.generalClearanceMil !== undefined) positive(rules.generalClearanceMil, 'generalClearanceMil');
  if (rules.qfnEscape !== undefined) {
    positive(rules.qfnEscape.widthMil, 'qfnEscape.widthMil');
    positive(rules.qfnEscape.maxLengthMil, 'qfnEscape.maxLengthMil');
  }
  const classes = rules.classes.map((raw, index) => {
    if (typeof raw?.name !== 'string' || !raw.name.trim() || classNames.has(raw.name) || !Number.isInteger(raw.priority) || raw.priority < 1 || !Array.isArray(raw.nets) || !raw.nets.length) fail('INVALID_CLASS', 'Each class needs a unique name, positive integer priority and nets.');
    classNames.add(raw.name);
    for (const field of widths) if (raw[field] !== undefined) positive(raw[field], `${raw.name}.${field}`);
    if (raw.widthMil === undefined && (raw.trunkWidthMil === undefined || raw.localWidthMil === undefined)) fail('WIDTH_REQUIRED', `${raw.name} needs widthMil or both trunkWidthMil and localWidthMil.`);
    if ((raw.viaHoleMil === undefined) !== (raw.viaDiameterMil === undefined) || (raw.viaHoleMil !== undefined && raw.viaDiameterMil <= raw.viaHoleMil)) fail('INVALID_VIA', `${raw.name} needs an outer via diameter greater than its hole.`);
    if (Object.hasOwn(raw, 'color') && (typeof raw.color !== 'string' || !/^#[a-f0-9]{6}$/i.test(raw.color))) fail('INVALID_COLOR', 'Class color must be #RRGGBB; omit color to leave the class unchanged.');
    const item = { ...clone(raw), originalIndex: index };
    for (const net of raw.nets) {
      if (typeof net !== 'string' || !net.trim() || net !== net.trim() || byNet.has(net)) fail('DUPLICATE_NET', 'Each explicit network belongs to exactly one class.');
      byNet.set(net, item);
    }
    return item;
  }).sort((a, b) => a.priority - b.priority || a.originalIndex - b.originalIndex);
  if (rules.routingOrder !== undefined && JSON.stringify(rules.routingOrder) !== JSON.stringify(classes.map(c => c.name))) fail('ORDER_CONFLICT', 'routingOrder conflicts with numeric priority (ties retain class order).');
  const selected = request.selectNets === undefined ? [...byNet.keys()] : request.selectNets;
  if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(net => !byNet.has(net))) fail('INVALID_NET_SELECTION', 'selectNets must be unique known nets.');
  const selection = new Set(selected);
  const sequence = classes.map(({ originalIndex, ...item }) => ({ ...item, nets: item.nets.filter(net => selection.has(net)) }))
    .filter(item => item.nets.length).map((item, i) => ({ order: i + 1, class: item, status: 'planned',
      verificationBeforeNext: ['Read back current trace geometry/widths and connection endpoints.', 'Check configured DRC and relevant return/critical topology; record evidence before the next priority group.'] }));
  const assignments = request.segmentAssignments ?? [];
  if (!Array.isArray(assignments)) fail('INVALID_ASSIGNMENTS', 'segmentAssignments must be an array.');
  const ids = new Set();
  const widthRules = assignments.map(assignment => {
    const item = byNet.get(assignment.net);
    if (!item || !selection.has(assignment.net) || !['trunk', 'local', 'signal', 'escape'].includes(assignment.role) || !Array.isArray(assignment.primitiveIds) || !assignment.primitiveIds.length) fail('INVALID_ASSIGNMENTS', 'Each assignment needs selected net, role and explicit primitiveIds.');
    for (const id of assignment.primitiveIds) {
      if (typeof id !== 'string' || !id || ids.has(id)) fail('DUPLICATE_SEGMENT', 'Each segment ID must be explicit and unique.');
      ids.add(id);
    }
    const targetWidthMil = assignment.role === 'escape' ? rules.qfnEscape?.widthMil
      : assignment.role === 'trunk' ? item.trunkWidthMil ?? item.widthMil
        : assignment.role === 'local' ? item.localWidthMil ?? item.widthMil : item.widthMil;
    positive(targetWidthMil, `${item.name}/${assignment.role} width`);
    return { net: assignment.net, primitiveIds: [...assignment.primitiveIds], targetWidthMil };
  });
  const target = { expectedDocumentUuid: request.expectedDocumentUuid, expectedProjectUuid: request.expectedProjectUuid };
  const hasTarget = typeof target.expectedDocumentUuid === 'string' && target.expectedDocumentUuid.length > 0 && typeof target.expectedProjectUuid === 'string' && target.expectedProjectUuid.length > 0;
  const colorRules = sequence.filter(item => Object.hasOwn(item.class, 'color')).map(item => {
    if (item.class.nets.length !== byNet.get(item.class.nets[0]).nets.length) fail('PARTIAL_CLASS_COLOR', 'A color request must select the complete class; omit color when routing only a subset.');
    return { name: item.class.name, nets: item.class.nets, color: item.class.color };
  });
  return {
    schemaVersion: 1, status: 'generated', readOnly: true, units: 'mil', rules: clone(rules), sequence, widthRules, colorRules,
    ...(hasTarget && widthRules.length ? { widthPlanRequest: { mode: 'plan', ...target, rules: widthRules } } : {}),
    ...(hasTarget && colorRules.length ? { colorPlanRequest: { mode: 'plan', ...target, rules: colorRules } } : {}),
    capabilities: { orderedPlan: true, selectedSegmentWidthRequests: true, editorNetClassWritten: false, autorouterPriorityApplied: false, routed: false, saved: false },
    limitations: [
      'Widths/priorities are supplied design intent, not calculated ampacity or a live PCB audit.',
      'Execute and verify priority groups in order; this action neither invokes nor configures an autorouter.',
      'Pair spacing, via sizes, escape length and sensitivity constraints remain explicit review requirements, not enforced by the width edit action.',
      'Progress/completed fields in the input are not treated as verification evidence; no network is silently skipped.',
    ],
  };
})();
