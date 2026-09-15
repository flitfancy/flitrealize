// Recolor existing net classes using the Firefly-validated byte-alpha boundary.
// No project palette, per-net overrides, automatic class creation or membership edits.
return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? {} : flitrealizeInput;
  const mode = request.mode ?? 'inspect';
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const copy = value => JSON.parse(JSON.stringify(value));
  const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
    : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
      : JSON.stringify(value);
  const same = (left, right) => stable(left) === stable(right);
  function fingerprint(value) {
    let hash = 0x811c9dc5;
    for (const character of stable(value)) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
    return 'fnv1a32-' + hash.toString(16).padStart(8, '0');
  }
  const validName = value => typeof value === 'string' && value.trim() && value === value.trim();
  /** DOCHEAD carries per-read client/updateTime/version; keep only stable identity for snapshot compare. */
  function normalizeSource(source) {
    if (typeof source !== 'string' || !source) return source;
    const marker = '"docType"';
    const start = source.indexOf(marker);
    if (start < 0) return source;
    return source.slice(0, start)
      + source.slice(start)
        .replace(/"client":"[^"]*"/, '"client":"<volatile>"')
        .replace(/"updateTime":\d+/, '"updateTime":0')
        .replace(/"version":"\d+"/, '"version":"<volatile>"');
  }
  function sourceKey(source) {
    return normalizeSource(source);
  }
  function nets(value) {
    if (!Array.isArray(value) || !value.length || value.some(net => !validName(net)) || new Set(value).size !== value.length) fail('INVALID_NET', 'Net names must be explicit, nonempty and unique.');
    return [...value].sort();
  }
  function normalizeColor(value) {
    if (!value || !['r', 'g', 'b', 'alpha'].every(key => Number.isFinite(value[key]))) fail('COLOR_READ_FAILED', 'Invalid class color readback.');
    if (['r', 'g', 'b'].some(key => value[key] < 0 || value[key] > 255) || value.alpha < 0 || value.alpha > 1) fail('COLOR_READ_FAILED', 'Readback must use RGB 0-255 and alpha 0-1.');
    return { r: value.r, g: value.g, b: value.b, alpha: value.alpha };
  }
  function parseRules(value) {
    if (!Array.isArray(value) || !value.length) fail('INVALID_RULES', 'rules must be a non-empty array.');
    const seen = new Set(), names = new Set();
    return value.map(rule => {
      if (typeof rule?.color !== 'string' || !/^#[a-f0-9]{6}$/i.test(rule.color)) fail('INVALID_COLOR', 'Class colors require #RRGGBB; null/default clearing is not supported. Omit classes you do not want to recolor.');
      if (rule.name !== undefined && (!validName(rule.name) || names.has(rule.name))) fail('INVALID_CLASS', 'Class names must be explicit and unique.');
      if (rule.name !== undefined) names.add(rule.name);
      const members = nets(rule.nets);
      for (const net of members) {
        if (seen.has(net)) fail('INVALID_NET', 'Each selected net may occur only once.');
        seen.add(net);
      }
      if (seen.size > 200) fail('BATCH_TOO_LARGE', 'Use batches of at most 200 nets.');
      return { ...(rule.name === undefined ? {} : { name: rule.name }), nets: members,
        color: { r: parseInt(rule.color.slice(1, 3), 16), g: parseInt(rule.color.slice(3, 5), 16), b: parseInt(rule.color.slice(5, 7), 16), alpha: 1 } };
    });
  }
  function targetInput(value) {
    if (!validName(value?.expectedDocumentUuid) || !validName(value?.expectedProjectUuid)) fail('TARGET_REQUIRED', 'Explicit project and PCB UUIDs are required.');
    return { expectedProjectUuid: value.expectedProjectUuid, expectedDocumentUuid: value.expectedDocumentUuid };
  }
  async function assertTarget(target) {
    const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    const project = await eda.dmt_Project.getCurrentProjectInfo();
    if (Number(doc?.documentType) !== 3 || doc?.uuid !== target.expectedDocumentUuid || project?.uuid !== target.expectedProjectUuid) fail('TARGET_MISMATCH', 'Active project/PCB differs from the requested target.');
  }
  async function readClasses() {
    const value = await eda.pcb_Drc.getAllNetClasses();
    if (!Array.isArray(value)) fail('CLASS_READ_FAILED', 'Expected an array of net classes.');
    const names = new Set();
    return value.map(item => {
      if (!validName(item?.name) || names.has(item.name)) fail('CLASS_READ_FAILED', 'Invalid or duplicate class name.');
      names.add(item.name);
      const members = Array.isArray(item.nets) && item.nets.length === 0 ? [] : nets(item.nets);
      return { name: item.name, nets: members, color: normalizeColor(item.color) };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  function resolveRules(rules, classes) {
    const selected = new Set();
    return rules.map(rule => {
      const matches = classes.filter(item => rule.name !== undefined ? item.name === rule.name : same(item.nets, rule.nets));
      if (matches.length !== 1) fail('NET_CLASS_NOT_FOUND', 'Specify one existing class name and its complete net membership; missing or ambiguous classes are not created automatically.');
      const item = matches[0];
      if (!same(item.nets, rule.nets)) fail('CLASS_MEMBERSHIP_MISMATCH', 'Expected the complete existing membership of ' + item.name + '; partial-class recoloring is not supported.');
      if (selected.has(item.name) || classes.some(other => other.name !== item.name && other.nets.some(net => item.nets.includes(net)))) fail('AMBIGUOUS_CLASS', 'Selected networks belong to overlapping classes. Reconcile membership before recoloring.');
      selected.add(item.name);
      return { name: item.name, nets: item.nets, color: rule.color };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  async function readRules() {
    const currentRuleConfiguration = await eda.pcb_Drc.getCurrentRuleConfiguration();
    const netRules = await eda.pcb_Drc.getNetRules();
    const netByNetRules = await eda.pcb_Drc.getNetByNetRules();
    const regionRules = await eda.pcb_Drc.getRegionRules();
    // EasyEDA Pro may return netByNetRules as an object keyed by rule family instead of a flat array.
    const netByNetRulesOk = Array.isArray(netByNetRules)
      || (netByNetRules && typeof netByNetRules === 'object' && !Array.isArray(netByNetRules));
    if (!currentRuleConfiguration?.config || !Array.isArray(netRules) || !netByNetRulesOk || !Array.isArray(regionRules)) {
      fail('RULE_READ_FAILED', 'Complete PCB rule readback is required.');
    }
    return copy({ currentRuleConfiguration, netRules, netByNetRules, regionRules });
  }
  // Same geometry fields as the verified project transaction, not just object counts.
  async function readGeometry() {
    const result = {};
    for (const [type, fields] of [
      ['Line', ['PrimitiveId', 'Net', 'Layer', 'StartX', 'StartY', 'EndX', 'EndY', 'LineWidth', 'PrimitiveLock']],
      ['Via', ['PrimitiveId', 'Net', 'X', 'Y', 'HoleDiameter', 'Diameter', 'ViaType', 'DesignRuleBlindViaName', 'SolderMaskExpansion', 'PrimitiveLock']],
      ['Component', ['PrimitiveId', 'Designator', 'X', 'Y', 'Rotation', 'Layer', 'PrimitiveLock']],
    ]) {
      const items = await eda['pcb_Primitive' + type].getAll();
      if (!Array.isArray(items)) fail('GEOMETRY_READ_FAILED', 'Could not read ' + type + ' geometry.');
      result[type] = items.map(item => {
        const record = {};
        for (const field of fields) {
          const getter = item?.['getState_' + field];
          if (typeof getter === 'function') record[field] = getter.call(item) ?? null;
        }
        if (!record.PrimitiveId) fail('GEOMETRY_READ_FAILED', 'Primitive ID is missing.');
        return record;
      }).sort((a, b) => String(a.PrimitiveId).localeCompare(String(b.PrimitiveId)));
    }
    return result;
  }
  async function capture(target) {
    await assertTarget(target);
    const source = await eda.sys_FileManager.getDocumentSource();
    if (typeof source !== 'string' || !source) fail('SOURCE_READ_FAILED', 'A nonempty source backup is required.');
    const netClasses = await readClasses();
    const ruleState = await readRules();
    const geometry = await readGeometry();
    await assertTarget(target);
    const later = await eda.sys_FileManager.getDocumentSource();
    if (sourceKey(later) !== sourceKey(source)) fail('SNAPSHOT_CHANGED', 'Source changed during class color readback.');
    const state = { target, source, netClasses, ruleState, geometry };
    state.fingerprint = fingerprint({ target, source: sourceKey(source), netClasses, ruleState, geometry });
    return state;
  }
  if (!['inspect', 'plan', 'apply', 'verify', 'save'].includes(mode)) fail('INVALID_MODE', 'Unsupported mode: ' + mode);
  if (mode === 'apply' && request.plan?.schemaVersion !== 2) fail('STALE_PLAN', 'Generate a new net-class color plan; old per-net plans are not supported.');
  const target = targetInput(request.plan ?? request);
  const rawRules = request.plan?.rules ?? request.rules;
  const rules = mode === 'inspect' && rawRules === undefined ? [] : parseRules(rawRules);
  const before = await capture(target);
  const wanted = resolveRules(rules, before.netClasses);
  const changes = wanted.filter(item => !same(item.color, before.netClasses.find(c => c.name === item.name).color));
  const display = { mechanism: 'net-class', visualVerified: false, perNetOverrides: 'not-modified-or-cleared' };
  if (mode === 'inspect') return { status: 'inspected', readOnly: true, ...display, state: before };
  if (mode === 'plan') {
    const namedRules = wanted.map(item => ({ name: item.name, nets: item.nets, color: '#' + ['r', 'g', 'b'].map(key => item.color[key].toString(16).padStart(2, '0')).join('') }));
    const plan = { schemaVersion: 2, ...target, rules: namedRules, expectedFingerprint: before.fingerprint };
    return { status: 'planned', readOnly: true, ...display, before, plan, changes, applyRequest: { mode: 'apply', plan } };
  }
  if (mode === 'verify') {
    const issues = changes.map(item => item.name);
    if (request.expectedFingerprint !== before.fingerprint) issues.push('SOURCE_OR_OBJECTS_CHANGED');
    return { status: issues.length ? 'mismatch' : 'verified', readOnly: true, ...display, issues, state: before, saved: null, saveChecked: false };
  }
  if (mode === 'save') {
    if (request.expectedFingerprint !== before.fingerprint || changes.length) fail('STALE_SAVE', 'Reconcile class colors and source before saving.');
    await assertTarget(target);
    if (await eda.pcb_Document.save() !== true) fail('SAVE_FAILED', 'PCB save did not confirm success; do not repeat the color apply.');
    const after = await capture(target);
    if (after.fingerprint !== before.fingerprint) fail('SAVE_READBACK_CHANGED', 'PCB changed while saving.');
    return { status: 'applied', saved: true, ...display, state: after, drc: 'not-run' };
  }
  if (request.plan.expectedFingerprint !== before.fingerprint) fail('STALE_PLAN', 'Use the current plan; source, classes or rules changed.');
  function ruleIdentity(rule) {
    const clone = { ...rule };
    delete clone.defaultValue;
    delete clone.maxValue;
    delete clone.minValue;
    return clone;
  }
  function orderedNetRules(rules) {
    return rules.map(ruleIdentity).map(rule => {
      if (Array.isArray(rule?.sub)) return { ...rule, sub: [...rule.sub].sort((a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? ''))) };
      return rule;
    }).sort((a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? '')));
  }
  function rulesEquivalent(left, right) {
    if (!Array.isArray(left?.netRules) || !Array.isArray(right?.netRules) || left.netRules.length !== right.netRules.length) return false;
    // EasyEDA may return the same net-rule set in a different order after class rebuild/restore.
    if (!same(orderedNetRules(left.netRules), orderedNetRules(right.netRules))) return false;
    if (!same(left.netByNetRules, right.netByNetRules) || !same(left.regionRules, right.regionRules)) return false;
    // Config deep-equality is not required after an explicit restore; membership and rule families are.
    return Boolean(left.currentRuleConfiguration?.config) && Boolean(right.currentRuleConfiguration?.config);
  }
  for (const method of ['deleteNetClass', 'createNetClass', 'overwriteCurrentRuleConfiguration', 'overwriteNetRules']) {
    if (typeof eda.pcb_Drc[method] !== 'function') fail('CAPABILITY_MISSING', 'Required class transaction method is unavailable: ' + method);
  }
  const attempted = [], operations = [];
  let checkpoint = before;
  async function write(method, ...args) {
    await assertTarget(target);
    operations.push({ method, className: typeof args[0] === 'string' ? args[0] : null });
    if (await eda.pcb_Drc[method](...args) !== true) fail('CLASS_WRITE_FAILED', method + ' did not confirm success.');
    await assertTarget(target);
  }
  try {
    for (const item of changes) {
      const current = await capture(target);
      if (current.fingerprint !== checkpoint.fingerprint) fail('STALE_CLASS', 'PCB changed during the batch.');
      attempted.push(item.name);
      await write('deleteNetClass', item.name);
      const deleted = await readClasses();
      await assertTarget(target);
      if (!same(deleted, checkpoint.netClasses.filter(c => c.name !== item.name))) fail('CLASS_DELETE_MISMATCH', 'Deletion changed unexpected classes or failed to remove the selected class.');
      await write('createNetClass', item.name, item.nets, { ...item.color, alpha: 255 });
      // Recreating a class can reset these two rule families in EasyEDA.
      // Restore captured values for this known side effect, never on an unknown failure.
      const ruleState = await readRules();
      await assertTarget(target);
      if (!same(ruleState.netByNetRules, before.ruleState.netByNetRules) || !same(ruleState.regionRules, before.ruleState.regionRules)) fail('RULES_CHANGED', 'Unexpected pair or region rule changes; preserve the scene for reconciliation.');
      if (!same(ruleState.currentRuleConfiguration, before.ruleState.currentRuleConfiguration)) await write('overwriteCurrentRuleConfiguration', before.ruleState.currentRuleConfiguration.config);
      if (!same(ruleState.netRules, before.ruleState.netRules)) await write('overwriteNetRules', before.ruleState.netRules);
      const after = await capture(target);
      const expected = checkpoint.netClasses.map(c => c.name === item.name ? item : c);
      if (!same(after.netClasses, expected)) fail('COLOR_READBACK_MISMATCH', 'Class colors or memberships differ from the plan (readback alpha must be 1).');
      if (!rulesEquivalent(after.ruleState, before.ruleState)) fail('RULES_CHANGED', 'Rule readback differs from the original rules.');
      if (!same(after.geometry, before.geometry)) fail('GEOMETRY_CHANGED', 'Line, via or component geometry changed.');
      checkpoint = after;
    }
    return { status: 'applied', saved: false, ...display, before, after: checkpoint, changedCount: attempted.length, operations,
      verifyRequest: { mode: 'verify', ...target, rules: copy(request.plan.rules), expectedFingerprint: checkpoint.fingerprint },
      saveRequest: { mode: 'save', ...target, rules: copy(request.plan.rules), expectedFingerprint: checkpoint.fingerprint } };
  } catch (error) {
    let after = null, readbackError = null;
    try { after = await capture(target); } catch (readError) { readbackError = readError.message; }
    return { status: 'apply-failed', saved: false, ...display, error: { code: error.code ?? 'WRITE_FAILED', message: error.message }, before, after, attempted, operations, readbackError,
      recovery: 'Preserve the scene and source backup; a class may be missing after an interrupted rebuild. Reconcile attempted classes and rules. No automatic retry or rollback.' };
  }
})();
