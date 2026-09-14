// Reuses the project's scoped width-edit/readback approach; no default current or width.
return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? {} : flitrealizeInput;
  const mode = request.mode ?? 'inspect';
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const clone = (a) => JSON.parse(JSON.stringify(a));
  function fingerprint(value) {
    let hash = 0x811c9dc5;
    for (const char of JSON.stringify(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
    return `fnv1a32-${hash.toString(16).padStart(8, '0')}`;
  }
  function read(object, name) {
    if (typeof object?.[`getState_${name}`] !== 'function') fail('LINE_READ_FAILED', `Missing line getter: ${name}`);
    const value = object[`getState_${name}`]();
    if (value === undefined || value === null) fail('LINE_READ_FAILED', `Missing line value: ${name}`);
    return value;
  }
  function lineSnapshot(line) {
    const item = {};
    for (const name of ['PrimitiveId', 'Net', 'Layer', 'StartX', 'StartY', 'EndX', 'EndY', 'LineWidth', 'PrimitiveLock']) item[name[0].toLowerCase() + name.slice(1)] = read(line, name);
    if (typeof item.primitiveId !== 'string' || !item.primitiveId || typeof item.net !== 'string' || typeof item.primitiveLock !== 'boolean') fail('LINE_READ_FAILED', 'Invalid line identity/lock.');
    if (!['layer', 'startX', 'startY', 'endX', 'endY', 'lineWidth'].every(key => Number.isFinite(item[key])) || item.lineWidth <= 0) fail('LINE_READ_FAILED', 'Invalid line geometry.');
    return item;
  }
  function targetInput(value) {
    if (typeof value?.expectedDocumentUuid !== 'string' || !value.expectedDocumentUuid || typeof value.expectedProjectUuid !== 'string' || !value.expectedProjectUuid) fail('TARGET_REQUIRED', 'Explicit project/PCB UUIDs required.');
    return { expectedProjectUuid: value.expectedProjectUuid, expectedDocumentUuid: value.expectedDocumentUuid };
  }
  async function assertTarget(target) {
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    const project = await eda.dmt_Project.getCurrentProjectInfo();
    if (Number(document?.documentType) !== 3 || document?.uuid !== target.expectedDocumentUuid || project?.uuid !== target.expectedProjectUuid) fail('TARGET_MISMATCH', 'Active project or PCB changed.');
  }
  async function capture(target) {
    await assertTarget(target);
    const source = await eda.sys_FileManager.getDocumentSource();
    const lines = await eda.pcb_PrimitiveLine.getAll();
    if (typeof source !== 'string' || !source || !Array.isArray(lines)) fail('SNAPSHOT_FAILED', 'Source and line list must be available.');
    const records = lines.map(lineSnapshot).sort((a, b) => a.primitiveId.localeCompare(b.primitiveId));
    if (new Set(records.map(r => r.primitiveId)).size !== records.length) fail('DUPLICATE_ID', 'Line IDs are not unique.');
    await assertTarget(target);
    if (await eda.sys_FileManager.getDocumentSource() !== source) fail('SNAPSHOT_CHANGED', 'Source changed during line readback.');
    const state = { target, source, lines: records };
    state.fingerprint = fingerprint(state);
    return state;
  }
  function resolveRules(rules, state) {
    if (!Array.isArray(rules) || !rules.length) fail('INVALID_RULES', 'Nonempty rules required.');
    const known = new Map(state.lines.map(item => [item.primitiveId, item]));
    const selected = new Map();
    for (const rule of rules) {
      if (typeof rule?.net !== 'string' || !rule.net || !Number.isFinite(rule.targetWidthMil) || rule.targetWidthMil <= 0 || !Array.isArray(rule.primitiveIds) || !rule.primitiveIds.length) fail('INVALID_RULES', 'Each rule needs net, positive targetWidthMil and explicit primitiveIds.');
      for (const id of rule.primitiveIds) {
        if (typeof id !== 'string' || selected.has(id)) fail('DUPLICATE_SELECTION', 'Each line ID may be selected only once.');
        const item = known.get(id);
        if (!item || item.net !== rule.net) fail('LINE_NOT_FOUND', `Line ${id} does not belong to ${rule.net}.`);
        if (![1, 2].includes(item.layer) && !(item.layer >= 15 && item.layer <= 44 && Number.isInteger(item.layer))) fail('NON_COPPER_LINE', `Line ${id} is not on a copper layer.`);
        if (item.primitiveLock && item.lineWidth !== rule.targetWidthMil) fail('LOCKED_LINE', `Line ${id} is locked.`);
        selected.set(id, { ...item, lineWidth: rule.targetWidthMil });
      }
    }
    if (selected.size > 200) fail('BATCH_TOO_LARGE', 'At most 200 explicitly selected segments per batch.');
    return selected;
  }
  // Compare complete DRC records conservatively; never match by count alone.
  function drcKeys(records) {
    if (!Array.isArray(records)) fail('DRC_BASELINE_REQUIRED', 'Generate a fresh plan with a recorded DRC baseline.');
    function stable(value) {
      if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
      if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
      if (value === null || !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
        if (value === null) return 'null';
        fail('DRC_UNKNOWN', 'DRC contains a non-serializable value.');
      }
      return JSON.stringify(value);
    }
    return records.map(record => {
      if (!record || typeof record !== 'object' || Array.isArray(record) || !Object.keys(record).length) fail('DRC_UNKNOWN', 'DRC records must contain identifiable properties.');
      return stable(record);
    }).sort();
  }
  function compareDrc(current, baseline) {
    const remaining = drcKeys(baseline);
    let added = 0;
    for (const key of drcKeys(current.violations)) {
      const index = remaining.indexOf(key);
      if (index < 0) added++;
      else remaining.splice(index, 1);
    }
    const comparison = { ...current, newViolationCount: added, resolvedViolationCount: remaining.length };
    if (added) throw Object.assign(new Error(`${added} new or changed DRC record(s); preserve edits and reconcile.`), { code: 'DRC_VIOLATIONS', drc: comparison });
    return comparison;
  }
  async function drc(target) {
    await assertTarget(target);
    const result = await eda.pcb_Drc.check(true, false, true);
    await assertTarget(target);
    if (!Array.isArray(result)) fail('DRC_UNKNOWN', 'DRC did not return a violation array.');
    drcKeys(result);
    return { passed: result.length === 0, violationCount: result.length, violations: clone(result), scope: 'current configured PCB DRC; not connectivity or current capacity' };
  }
  if (!['inspect', 'plan', 'apply', 'verify', 'save'].includes(mode)) fail('INVALID_MODE', `Unsupported mode: ${mode}`);
  const target = targetInput(request.plan ?? request);
  const before = await capture(target);
  if (mode === 'inspect') return { status: 'inspected', readOnly: true, state: before, units: 'mil' };
  const rules = request.plan?.rules ?? request.rules;
  const selected = resolveRules(rules, before);
  if (mode === 'verify') {
    const issues = before.lines.filter(item => selected.has(item.primitiveId) && item.lineWidth !== selected.get(item.primitiveId).lineWidth).map(item => item.primitiveId);
    if (request.expectedFingerprint !== before.fingerprint) issues.push('SOURCE_OR_OBJECTS_CHANGED');
    return { status: issues.length ? 'mismatch' : 'verified', readOnly: true, state: before, issues, saved: null, saveChecked: false, drc: 'not-run' };
  }
  if (mode === 'plan') {
    const check = await drc(target);
    if ((await capture(target)).fingerprint !== before.fingerprint) fail('STALE_PLAN', 'Source changed during planning DRC.');
    const plan = { schemaVersion: 1, ...target, rules: clone(rules), expectedFingerprint: before.fingerprint, drcBaseline: check.violations };
    return { status: 'planned', readOnly: true, before, drc: check, plan, changes: before.lines.filter(item => selected.has(item.primitiveId) && item.lineWidth !== selected.get(item.primitiveId).lineWidth).map(item => ({ before: item, after: selected.get(item.primitiveId) })), applyRequest: { mode: 'apply', plan } };
  }
  if (mode === 'save') {
    if (request.expectedFingerprint !== before.fingerprint || before.lines.some(item => selected.has(item.primitiveId) && item.lineWidth !== selected.get(item.primitiveId).lineWidth)) fail('STALE_SAVE', 'Source/widths changed; do not repeat apply to retry saving.');
    const check = compareDrc(await drc(target), request.drcBaseline);
    if ((await capture(target)).fingerprint !== before.fingerprint) fail('STALE_SAVE', 'Source changed during DRC.');
    await assertTarget(target);
    if (await eda.pcb_Document.save() !== true) fail('SAVE_FAILED', 'PCB save did not confirm success.');
    const after = await capture(target);
    if (after.fingerprint !== before.fingerprint) fail('SAVE_READBACK_CHANGED', 'Source changed during save.');
    return { status: 'applied', saved: true, state: after, drc: check };
  }
  if (request.plan?.schemaVersion !== 1 || request.plan.expectedFingerprint !== before.fingerprint) fail('STALE_PLAN', 'Source changed; generate a new plan.');
  const preflight = await drc(target);
  if (!same(drcKeys(preflight.violations), drcKeys(request.plan.drcBaseline))) fail('DRC_BASELINE_CHANGED', 'DRC changed after planning; inspect the new baseline before editing.');
  if ((await capture(target)).fingerprint !== before.fingerprint) fail('STALE_PLAN', 'Source changed during preflight DRC.');
  const attempted = [];
  try {
    for (const original of before.lines) {
      const desired = selected.get(original.primitiveId);
      if (!desired || original.lineWidth === desired.lineWidth) continue;
      await assertTarget(target);
      const current = lineSnapshot(await eda.pcb_PrimitiveLine.get(original.primitiveId));
      if (!same(current, original)) fail('STALE_LINE', `Line ${original.primitiveId} changed during the batch.`);
      await assertTarget(target);
      attempted.push(original.primitiveId);
      const result = await eda.pcb_PrimitiveLine.modify(original.primitiveId, { lineWidth: desired.lineWidth });
      if (!result) fail('WIDTH_WRITE_FAILED', `Width write not confirmed: ${original.primitiveId}`);
    }
    const after = await capture(target);
    const expected = before.lines.map(item => selected.get(item.primitiveId) ?? item);
    if (!same(expected, after.lines)) fail('WIDTH_READBACK_MISMATCH', 'Line readback changed geometry, identity, or unselected widths.');
    const check = compareDrc(await drc(target), preflight.violations);
    if ((await capture(target)).fingerprint !== after.fingerprint) fail('POST_DRC_CHANGED', 'Source changed during post-write DRC.');
    return { status: 'applied', saved: false, before, after, changedCount: attempted.length, drc: check,
      verifyRequest: { mode: 'verify', ...target, rules: clone(rules), expectedFingerprint: after.fingerprint },
      saveRequest: { mode: 'save', ...target, rules: clone(rules), expectedFingerprint: after.fingerprint, drcBaseline: check.violations } };
  } catch (error) {
    let after = null;
    let readbackError = null;
    try { after = await capture(target); } catch (readError) { readbackError = readError.message; }
    return { status: 'apply-failed', saved: false, error: { code: error.code ?? 'WRITE_FAILED', message: error.message }, before, after, attempted, drc: error.drc ?? null, readbackError, recovery: 'Keep partial edits for reconciliation. Do not blindly replay or restore old widths.' };
  }
})();
