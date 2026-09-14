// Scoped placement and cluster comparison, adapted from the project's placement/space scripts.
return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? {} : flitrealizeInput;
  const mode = request.mode ?? 'inspect';
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const clone = value => JSON.parse(JSON.stringify(value));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const near = (a, b) => Math.abs(a - b) < 0.001;
  function fingerprint(value) {
    let hash = 0x811c9dc5;
    for (const char of JSON.stringify(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
    return `fnv1a32-${hash.toString(16).padStart(8, '0')}`;
  }
  function read(object, key) {
    if (typeof object?.[`getState_${key}`] !== 'function') fail('GEOMETRY_READ_FAILED', `Missing getter ${key}.`);
    const result = object[`getState_${key}`]();
    if (result === undefined || result === null) fail('GEOMETRY_READ_FAILED', `Missing value ${key}.`);
    return result;
  }
  function box(value) {
    if (!value || !['minX', 'minY', 'maxX', 'maxY'].every(key => Number.isFinite(value[key])) || value.maxX <= value.minX || value.maxY <= value.minY) fail('INVALID_BOUNDS', 'A finite, positive rectangular bounding box is required.');
    return { minX: value.minX, minY: value.minY, maxX: value.maxX, maxY: value.maxY };
  }
  function nonnegative(value, label) {
    if (!Number.isFinite(value) || value < 0) fail('INVALID_INPUT', `${label} must be nonnegative.`);
    return value;
  }
  function targetInput(value) {
    if (typeof value?.expectedDocumentUuid !== 'string' || !value.expectedDocumentUuid || typeof value.expectedProjectUuid !== 'string' || !value.expectedProjectUuid) fail('TARGET_REQUIRED', 'Explicit project/PCB UUIDs are required.');
    return { expectedProjectUuid: value.expectedProjectUuid, expectedDocumentUuid: value.expectedDocumentUuid };
  }
  async function assertTarget(target) {
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    const project = await eda.dmt_Project.getCurrentProjectInfo();
    if (Number(document?.documentType) !== 3 || document?.uuid !== target.expectedDocumentUuid || project?.uuid !== target.expectedProjectUuid) fail('TARGET_MISMATCH', 'Active project or PCB differs from the requested target.');
  }
  const copper = layer => [1, 2].includes(layer) || (Number.isInteger(layer) && layer >= 15 && layer <= 44);
  async function list(namespace) {
    const value = await eda[namespace].getAll();
    if (!Array.isArray(value)) fail('SNAPSHOT_FAILED', `${namespace} did not return an array.`);
    return value;
  }
  async function capture(target) {
    await assertTarget(target);
    const source = await eda.sys_FileManager.getDocumentSource();
    if (typeof source !== 'string' || !source) fail('SOURCE_READ_FAILED', 'A nonempty source backup is required.');
    const raw = await list('pcb_PrimitiveComponent');
    const components = [];
    for (const component of raw) {
      const item = {};
      for (const key of ['PrimitiveId', 'Designator', 'X', 'Y', 'Rotation', 'Layer', 'PrimitiveLock']) item[key[0].toLowerCase() + key.slice(1)] = read(component, key);
      if (typeof item.primitiveId !== 'string' || !item.primitiveId || typeof item.designator !== 'string' || !item.designator || typeof item.primitiveLock !== 'boolean' || !['x', 'y', 'rotation', 'layer'].every(key => Number.isFinite(item[key]))) fail('GEOMETRY_READ_FAILED', 'Invalid component identity, lock or position.');
      item.bbox = box(await eda.pcb_Primitive.getPrimitivesBBox([item.primitiveId]));
      components.push(item);
    }
    components.sort((a, b) => a.primitiveId.localeCompare(b.primitiveId));
    if (new Set(components.map(c => c.designator)).size !== components.length || new Set(components.map(c => c.primitiveId)).size !== components.length) fail('DUPLICATE_COMPONENT', 'Component IDs/designators must be unique.');
    const regions = [];
    for (const region of await list('pcb_PrimitiveRegion')) {
      const primitiveId = read(region, 'PrimitiveId');
      regions.push({ primitiveId, bbox: box(await eda.pcb_Primitive.getPrimitivesBBox([primitiveId])) });
    }
    regions.sort((a, b) => String(a.primitiveId).localeCompare(String(b.primitiveId)));
    const routingCounts = {};
    for (const type of ['Line', 'Arc', 'Polyline', 'Via', 'Pour']) {
      const items = await list(`pcb_Primitive${type}`);
      routingCounts[type] = ['Via', 'Pour'].includes(type) ? items.length : items.filter(item => copper(read(item, 'Layer'))).length;
    }
    await assertTarget(target);
    if (await eda.sys_FileManager.getDocumentSource() !== source) fail('SNAPSHOT_CHANGED', 'Source changed during geometry readback.');
    const state = { target, source, components, regions, routingCounts };
    state.fingerprint = fingerprint(state);
    return state;
  }
  function configInput(value) {
    if (!Array.isArray(value.lockedDesignators) || !Array.isArray(value.reservedRegions)) fail('LAYOUT_CONSTRAINTS_REQUIRED', 'Provide lockedDesignators and reservedRegions explicitly (empty arrays allowed after review).');
    if (value.lockedDesignators.some(x => typeof x !== 'string' || !x)) fail('INVALID_LOCKS', 'lockedDesignators must contain names.');
    return { boardBounds: box(value.boardBounds), clearanceMil: nonnegative(value.clearanceMil ?? 5, 'clearanceMil'),
      lockedDesignators: [...new Set(value.lockedDesignators)], reservedRegions: value.reservedRegions.map(item => ({ name: item.name ?? null, bbox: box(item.bbox) })),
      cellMil: value.cellMil ?? 50 };
  }
  function intersects(a, b, clearance = 0) {
    return !(a.maxX + clearance <= b.minX || b.maxX + clearance <= a.minX || a.maxY + clearance <= b.minY || b.maxY + clearance <= a.minY);
  }
  function validateLayout(components, regions, config) {
    const issues = [];
    const bounds = config.boardBounds;
    for (const item of components) {
      const b = item.bbox;
      if (b.minX < bounds.minX - 0.001 || b.minY < bounds.minY - 0.001 || b.maxX > bounds.maxX + 0.001 || b.maxY > bounds.maxY + 0.001) issues.push({ code: 'OUT_OF_BOUNDS', designator: item.designator });
      for (const region of [...regions, ...config.reservedRegions]) {
        if (intersects(b, region.bbox, config.clearanceMil)) issues.push({ code: 'RESERVED_REGION', designator: item.designator, region: region.primitiveId ?? region.name });
      }
    }
    for (let i = 0; i < components.length; i++) for (let j = i + 1; j < components.length; j++) {
      if (intersects(components[i].bbox, components[j].bbox, config.clearanceMil)) issues.push({ code: 'BBOX_OVERLAP', designators: [components[i].designator, components[j].designator] });
    }
    return issues;
  }
  function freeSpace(components, regions, config) {
    // Conservative grid occupancy, then the largest empty rectangle by histogram.
    const bounds = config.boardBounds, cell = config.cellMil;
    if (!Number.isFinite(cell) || cell <= 0) fail('INVALID_GRID', 'cellMil must be positive.');
    const cols = Math.ceil((bounds.maxX - bounds.minX) / cell), rows = Math.ceil((bounds.maxY - bounds.minY) / cell);
    if (cols * rows > 100000) fail('GRID_TOO_LARGE', 'Choose a coarser grid (at most 100000 cells).');
    const occupied = Array.from({ length: rows }, () => Array(cols).fill(false));
    const obstacles = [...components.map(c => c.bbox), ...regions.map(r => r.bbox), ...config.reservedRegions.map(r => r.bbox)];
    for (const obstacle of obstacles) {
      const minCol = Math.max(0, Math.floor((obstacle.minX - config.clearanceMil - bounds.minX) / cell));
      const maxCol = Math.min(cols - 1, Math.floor((obstacle.maxX + config.clearanceMil - bounds.minX) / cell));
      const minRow = Math.max(0, Math.floor((obstacle.minY - config.clearanceMil - bounds.minY) / cell));
      const maxRow = Math.min(rows - 1, Math.floor((obstacle.maxY + config.clearanceMil - bounds.minY) / cell));
      for (let y = minRow; y <= maxRow; y++) for (let x = minCol; x <= maxCol; x++) occupied[y][x] = true;
    }
    const heights = Array(cols).fill(0);
    let best = null, freeAreaMil2 = 0;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        heights[col] = occupied[row][col] ? 0 : heights[col] + 1;
        if (!occupied[row][col]) freeAreaMil2 += Math.min(cell, bounds.maxX - bounds.minX - col * cell) * Math.min(cell, bounds.maxY - bounds.minY - row * cell);
      }
      const stack = [];
      for (let col = 0; col <= cols; col++) {
        const height = col < cols ? heights[col] : 0;
        let start = col;
        while (stack.length && stack.at(-1).height > height) {
          const popped = stack.pop();
          const candidate = { minX: bounds.minX + popped.start * cell, minY: bounds.minY + (row - popped.height + 1) * cell, maxX: Math.min(bounds.maxX, bounds.minX + col * cell), maxY: Math.min(bounds.maxY, bounds.minY + (row + 1) * cell) };
          const areaMil2 = (candidate.maxX - candidate.minX) * (candidate.maxY - candidate.minY);
          if (!best || areaMil2 > best.areaMil2) best = { ...candidate, areaMil2 };
          start = popped.start;
        }
        if (!stack.length || stack.at(-1).height < height) stack.push({ start, height });
      }
    }
    return { cellMil: cell, freeAreaMil2, largestComponentFreeRectangle: best, scope: 'component/region AABBs only; not usable routing, copper, antenna or assembly clearance' };
  }
  function projected(original, placement) {
    const rotation = placement.rotation ?? original.rotation;
    if (![placement.x, placement.y, rotation].every(Number.isFinite)) fail('INVALID_PLACEMENT', 'Finite x, y and rotation required.');
    const quarter = (rotation - original.rotation) / 90;
    if (!near(quarter, Math.round(quarter))) fail('UNSUPPORTED_ROTATION', 'Only translation and 90-degree relative rotations have bounded AABB predictions.');
    const angle = (rotation - original.rotation) * Math.PI / 180;
    const corners = [[original.bbox.minX, original.bbox.minY], [original.bbox.minX, original.bbox.maxY], [original.bbox.maxX, original.bbox.minY], [original.bbox.maxX, original.bbox.maxY]]
      .map(([x, y]) => [placement.x + (x - original.x) * Math.cos(angle) - (y - original.y) * Math.sin(angle), placement.y + (x - original.x) * Math.sin(angle) + (y - original.y) * Math.cos(angle)]);
    return { ...original, x: placement.x, y: placement.y, rotation,
      bbox: { minX: Math.min(...corners.map(p => p[0])), minY: Math.min(...corners.map(p => p[1])), maxX: Math.max(...corners.map(p => p[0])), maxY: Math.max(...corners.map(p => p[1])) } };
  }
  function candidate(value, before, config, target) {
    const byDesignator = new Map(before.components.map(c => [c.designator, c]));
    for (const name of config.lockedDesignators) if (!byDesignator.has(name)) fail('MISSING_LOCKED_COMPONENT', `Unknown locked designator ${name}.`);
    const placements = Array.isArray(value.placements) ? clone(value.placements) : [];
    if (value.groups !== undefined && !Array.isArray(value.groups)) fail('INVALID_GROUPS', 'groups must be an array.');
    for (const group of value.groups ?? []) {
      if (!Array.isArray(group.designators) || !group.designators.length || !Number.isFinite(group.dxMil) || !Number.isFinite(group.dyMil)) fail('INVALID_GROUPS', 'Each group needs explicit designators, dxMil and dyMil.');
      for (const name of group.designators) {
        const current = byDesignator.get(name);
        if (!current) fail('COMPONENT_NOT_FOUND', `Missing ${name}.`);
        placements.push({ designator: name, x: current.x + group.dxMil, y: current.y + group.dyMil });
      }
    }
    if (placements.length > 100) fail('BATCH_TOO_LARGE', 'At most 100 specified components per batch.');
    const moved = new Map();
    for (const placement of placements) {
      const current = byDesignator.get(placement.designator);
      if (!current) fail('COMPONENT_NOT_FOUND', `Missing ${placement.designator}.`);
      if (moved.has(current.designator)) fail('DUPLICATE_SELECTION', `Duplicate ${current.designator}.`);
      const next = projected(current, placement);
      if ((current.primitiveLock || config.lockedDesignators.includes(current.designator)) && (!near(current.x, next.x) || !near(current.y, next.y) || !near(current.rotation, next.rotation))) fail('LOCKED_COMPONENT', `Do not move locked ${current.designator}.`);
      moved.set(current.designator, next);
    }
    const projectedComponents = before.components.map(c => moved.get(c.designator) ?? c);
    const changes = before.components.filter(c => moved.has(c.designator) && (!near(c.x, moved.get(c.designator).x) || !near(c.y, moved.get(c.designator).y) || !near(c.rotation, moved.get(c.designator).rotation)))
      .map(c => ({ designator: c.designator, x: moved.get(c.designator).x, y: moved.get(c.designator).y, rotation: moved.get(c.designator).rotation }));
    const issues = validateLayout(projectedComponents, before.regions, config);
    if (changes.length && Object.values(before.routingCounts).some(count => count > 0)) issues.push({ code: 'ROUTED_BOARD', message: 'Moving footprints does not carry traces/vias/pours. Only unrouted boards are supported by this placement action.' });
    const plan = { schemaVersion: 1, ...target, ...config, placements: changes, expectedFingerprint: before.fingerprint };
    const space = freeSpace(projectedComponents, before.regions, config);
    return { name: value.name ?? null, plan, issues, space, changedCount: changes.length,
      ...(issues.length ? {} : { applyRequest: { mode: 'apply', plan } }) };
  }
  const target = targetInput(request.plan ?? request);
  if (!['inspect', 'plan', 'apply', 'verify', 'save'].includes(mode)) fail('INVALID_MODE', `Unsupported mode: ${mode}`);
  const before = await capture(target);
  if (mode === 'inspect' && request.boardBounds === undefined) return { status: 'inspected', readOnly: true, state: before, units: 'mil' };
  const config = configInput(request.plan ?? request);
  if (mode === 'inspect') return { status: 'inspected', readOnly: true, state: before, issues: validateLayout(before.components, before.regions, config), space: freeSpace(before.components, before.regions, config) };
  if (mode === 'plan') {
    if (request.scenarios !== undefined) {
      if (!Array.isArray(request.scenarios) || !request.scenarios.length || request.scenarios.length > 20) fail('INVALID_SCENARIOS', 'Provide 1–20 explicit candidate scenarios.');
      const candidates = request.scenarios.map(value => candidate(value, before, config, target));
      return { status: 'planned', readOnly: true, before, candidates, note: 'Compare proposals; no automatic electrical/topology ranking or application.' };
    }
    const result = candidate(request, before, config, target);
    return { status: result.issues.length ? 'blocked' : 'planned', readOnly: true, before, ...result };
  }
  const plan = request.plan;
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.placements)) fail('PLAN_REQUIRED', 'Use a returned placement plan.');
  if (mode === 'verify' || mode === 'save') {
    const issues = validateLayout(before.components, before.regions, config);
    if (mode === 'verify' && request.expectedFingerprint !== before.fingerprint) issues.push({ code: 'SOURCE_OR_OBJECTS_CHANGED' });
    for (const wanted of plan.placements) {
      const actual = before.components.find(c => c.designator === wanted.designator);
      if (!actual || !near(actual.x, wanted.x) || !near(actual.y, wanted.y) || !near(actual.rotation, wanted.rotation)) issues.push({ code: 'PLACEMENT_MISMATCH', designator: wanted.designator });
    }
    if (mode === 'verify') return { status: issues.length ? 'mismatch' : 'verified', readOnly: true, issues, state: before, saved: null, saveChecked: false, drc: 'not-run' };
    if (issues.length || before.fingerprint !== request.expectedFingerprint) fail('STALE_SAVE', 'Placement/source changed before save.');
    await assertTarget(target);
    if (await eda.pcb_Document.save() !== true) fail('SAVE_FAILED', 'PCB save did not confirm success.');
    const after = await capture(target);
    if (after.fingerprint !== before.fingerprint) fail('SAVE_READBACK_CHANGED', 'PCB changed while saving.');
    return { status: 'applied', saved: true, state: after, drc: 'not-run' };
  }
  if (plan.expectedFingerprint !== before.fingerprint) fail('STALE_PLAN', 'Source or geometry changed; regenerate placement.');
  const checked = candidate(plan, before, config, target);
  if (checked.issues.length) fail('BLOCKED_LAYOUT', JSON.stringify(checked.issues));
  const attempted = [];
  try {
    for (const item of checked.plan.placements) {
      await assertTarget(target);
      const original = before.components.find(c => c.designator === item.designator);
      const current = await eda.pcb_PrimitiveComponent.get(original.primitiveId);
      if (!current || read(current, 'Designator') !== original.designator || read(current, 'PrimitiveLock') !== false || !near(read(current, 'X'), original.x) || !near(read(current, 'Y'), original.y) || !near(read(current, 'Rotation'), original.rotation)) fail('STALE_COMPONENT', `${original.designator} changed during the batch.`);
      await assertTarget(target);
      attempted.push(original.primitiveId);
      if (!await eda.pcb_PrimitiveComponent.modify(original.primitiveId, { x: item.x, y: item.y, rotation: item.rotation })) fail('PLACEMENT_WRITE_FAILED', `Move not confirmed: ${item.designator}`);
    }
    const after = await capture(target);
    const issues = validateLayout(after.components, after.regions, config);
    const byName = new Map(checked.plan.placements.map(p => [p.designator, p]));
    if (before.components.length !== after.components.length || !same(before.regions, after.regions) || !same(before.routingCounts, after.routingCounts)) fail('UNEXPECTED_SCENE_CHANGE', 'Component count, regions or routing changed.');
    for (let i = 0; i < before.components.length; i++) {
      const old = before.components[i], actual = after.components[i];
      const expected = byName.has(old.designator) ? projected(old, byName.get(old.designator)) : old;
      if (old.primitiveId !== actual.primitiveId || old.designator !== actual.designator || old.layer !== actual.layer || old.primitiveLock !== actual.primitiveLock || !['x', 'y', 'rotation'].every(key => near(actual[key], expected[key])) || !Object.keys(expected.bbox).every(key => near(actual.bbox[key], expected.bbox[key]))) fail('PLACEMENT_READBACK_MISMATCH', `Unexpected geometry for ${old.designator}.`);
    }
    if (issues.length) fail('LAYOUT_READBACK_BLOCKED', JSON.stringify(issues));
    return { status: 'applied', saved: false, before, after, changedCount: attempted.length,
      verifyRequest: { mode: 'verify', plan: clone(plan), expectedFingerprint: after.fingerprint }, saveRequest: { mode: 'save', plan: clone(plan), expectedFingerprint: after.fingerprint },
      limitations: ['AABB geometry only; no whole-board DRC, pad clearance, connectivity, thermal or electrical optimization.'] };
  } catch (error) {
    let after = null, readbackError = null;
    try { after = await capture(target); } catch (readError) { readbackError = readError.message; }
    return { status: 'apply-failed', saved: false, before, after, attempted, error: { code: error.code ?? 'WRITE_FAILED', message: error.message }, readbackError, recovery: 'Preserve partial changes and reconcile IDs/geometry; no automatic rollback or replay.' };
  }
})();
