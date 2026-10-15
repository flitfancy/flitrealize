/** Local source ownership and native occupancy checks; no planning or EDA writes. */
export const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}' : JSON.stringify(value);

export function sourceRecords(source) {
  if (typeof source !== 'string' || !source.trim()) throw Object.assign(new Error('Native source is unavailable.'), { code: 'LOCAL_SOURCE_UNAVAILABLE' });
  const records = source.split(/\r?\n/).filter(Boolean).map(line => {
    const split = line.indexOf('||');
    try {
      if (split < 0) throw new Error();
      return { head: JSON.parse(line.slice(0, split)), payload: JSON.parse(line.slice(split + 2).replace(/\|$/, '')) };
    } catch { throw Object.assign(new Error('Cannot prove local ownership of an unsupported source record.'), { code: 'LOCAL_SOURCE_UNSUPPORTED' }); }
  }).filter(record => record.head.type !== 'DOCHEAD');
  if (records.some(record => !record.head.id) || new Set(records.map(record => record.head.id)).size !== records.length) {
    throw Object.assign(new Error('Native source IDs are missing or duplicated.'), { code: 'LOCAL_SOURCE_UNSUPPORTED' });
  }
  return records;
}

export function recordRoot(record, records) {
  const byId = new Map(records.map(item => [item.head.id, item]));
  const seen = new Set();
  const owner = item => item.payload.parentId || (item.head.type === 'LINE' ? item.payload.lineGroup : null);
  while (owner(record) && byId.has(owner(record))) {
    if (seen.has(record.head.id)) throw Object.assign(new Error('Cyclic source ownership.'), { code: 'LOCAL_SOURCE_UNSUPPORTED' });
    seen.add(record.head.id); record = byId.get(owner(record));
  }
  return owner(record) || record.head.id;
}

export function protectedSource(source, ownedIds = []) {
  const records = sourceRecords(source), owned = new Set(ownedIds);
  return stable(records.filter(record => !owned.has(recordRoot(record, records))).sort((a, b) => a.head.id.localeCompare(b.head.id)));
}

export function sourceChanges(before, current, ignoredIds = []) {
  const old = sourceRecords(before), now = sourceRecords(current), ignored = new Set(ignoredIds);
  const byId = new Map(now.map(record => [record.head.id, record]));
  const oldIds = new Set(old.map(record => record.head.id));
  return [...old.filter(record => stable(record) !== stable(byId.get(record.head.id))).map(record => ({ id: record.head.id,
    root: recordRoot(byId.get(record.head.id) || record, byId.has(record.head.id) ? now : old), beforeRoot: recordRoot(record, old), before: record, current: byId.get(record.head.id) || null })),
  ...now.filter(record => !oldIds.has(record.head.id)).map(record => ({ id: record.head.id, root: recordRoot(record, now), before: null, current: record }))]
    .filter(change => !ignored.has(change.root) || (change.before && !ignored.has(change.beforeRoot)));
}

export const validBounds = box => box && ['minX', 'minY', 'maxX', 'maxY'].every(key => Number.isFinite(box[key])) && box.minX <= box.maxX && box.minY <= box.maxY;
export const overlap = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

export function targetBounds(component) {
  const geometry = component.localGeometry, binding = component.bindings?.easyedaPro;
  // Bounds already describe the requested native rotation/mirror relative to the API anchor.
  // Neither center offsets nor transform conventions can be inferred from catalog width/height.
  if (geometry?.unit !== 'easyeda-schematic' || geometry.libraryUuid !== binding?.libraryUuid || geometry.deviceUuid !== binding?.deviceUuid
    || geometry.rotation !== (component.rotation ?? 0) || geometry.mirror !== (component.mirror ?? false)
    || geometry.value !== component.value || geometry.includesAttributes !== true || !validBounds(geometry.bounds)) return null;
  const { x, y } = component.position, bounds = geometry.bounds;
  return { designator: component.designator, minX: x + bounds.minX, maxX: x + bounds.maxX, minY: y + bounds.minY, maxY: y + bounds.maxY };
}

export function placementOccupancy(state, desired, ownedIds) {
  const evidence = state.localEvidence;
  if (!evidence?.complete) return [{ code: 'LOCAL_OCCUPANCY_UNAVAILABLE', message: '无法完整读取现场符号、引脚及源码图元边界，不能证明外部变化无干涉。', missing: evidence?.missing || ['native-occupancy'] }];
  const targets = desired.map(targetBounds);
  if (targets.some(target => !target)) return [{ code: 'LOCAL_TARGET_GEOMETRY_UNAVAILABLE', message: '需准确的 symbol.occupancy：原生单位、库/器件身份、Value、目标旋转/镜像及包含属性的锚点相对边界；宽高不能证明目标占位。' }];
  const owned = new Set(ownedIds), issues = [];
  for (const id of owned) {
    const actualParts = evidence.occupancy.filter(obstacle => (obstacle.ownerId || obstacle.id) === id).map(obstacle => obstacle.bounds);
    const actual = actualParts.length ? { minX: Math.min(...actualParts.map(box => box.minX)), maxX: Math.max(...actualParts.map(box => box.maxX)),
      minY: Math.min(...actualParts.map(box => box.minY)), maxY: Math.max(...actualParts.map(box => box.maxY)) } : null;
    const component = state.components.find(component => component.primitiveId === id);
    const target = targets.find(target => target.designator === component?.designator);
    if (!actual || !target || actual.minX < target.minX || actual.maxX > target.maxX || actual.minY < target.minY || actual.maxY > target.maxY) {
      issues.push({ code: 'LOCAL_TARGET_GEOMETRY_MISMATCH', message: '代表器件实际原生边界超出声明的目标矩形；停止扩批，不把尺寸或中心锚点假设当安全证明。', primitiveId: id });
    }
  }
  for (const obstacle of evidence.occupancy) if (!owned.has(obstacle.ownerId || obstacle.id)) for (const target of targets) {
    if (overlap(obstacle.bounds, target)) issues.push({ code: 'TARGET_OCCUPIED', message: '当前图元占据原计划目标位置；停止而不重新布局。', obstacleId: obstacle.id, designator: target.designator });
  }
  return issues;
}

export function assertPreserved(before, current, newIds = []) {
  if (protectedSource(before, newIds) !== protectedSource(current, newIds)) {
    throw Object.assign(new Error('预检之后的范围外源码发生变化；停止并对账。'), { code: 'EXECUTION_SOURCE_CHANGED' });
  }
}

// A local candidate keeps its original source. Acceptance of an invocation's
// current source is separate from the strict guard used after preflight.
export function connectionDependencies(input, snapshot) {
  const refs = new Set(input.designators || input.contract.components.map(component => component.designator));
  const nets = new Set(input.contract.nets.filter(net => net.endpoints.some(endpoint => refs.has(endpoint.component))).map(net => net.name));
  for (const net of snapshot.nets || []) if ((net.endpoints || []).some(endpoint => refs.has(endpoint.component))) nets.add(net.name);
  const members = new Set([...refs, ...input.contract.nets.filter(net => nets.has(net.name)).flatMap(net => net.endpoints.map(endpoint => endpoint.component)),
    ...(snapshot.nets || []).filter(net => nets.has(net.name)).flatMap(net => (net.endpoints || []).map(endpoint => endpoint.component))]);
  const components = snapshot.components.filter(component => refs.has(component.designator));
  const margin = (input.stubLength ?? 8) + (input.grid ?? 1) + (input.connectionTolerance ?? input.tolerance ?? 0.1);
  const regions = components.flatMap(component => [component.position, ...component.pins.map(pin => pin.position)]).filter(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))
    .map(point => ({ minX: point.x - margin, maxX: point.x + margin, minY: point.y - margin, maxY: point.y + margin }));
  for (const wire of snapshot.extensions?.easyedaPro?.wires || []) if (nets.has(wire.net)) {
    const points = wire.points;
    if (!Array.isArray(points) || points.length < 2 || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) continue;
    const pad = Math.max(1, (wire.lineWidth ?? 0) / 2) + (input.connectionTolerance ?? input.tolerance ?? 0.1);
    regions.push({ minX: Math.min(...points.map(point => point.x)) - pad, maxX: Math.max(...points.map(point => point.x)) + pad,
      minY: Math.min(...points.map(point => point.y)) - pad, maxY: Math.max(...points.map(point => point.y)) + pad });
  }
  const targetIds = new Set(snapshot.components.filter(component => members.has(component.designator)).map(component => component.nativeId));
  if (snapshot.executionSource) {
    const records = sourceRecords(snapshot.executionSource);
    for (const record of records) if (nets.has(record.payload.net) || record.head.type === 'ATTR' && ['NET', 'Name'].includes(record.payload.key) && nets.has(record.payload.value)) targetIds.add(recordRoot(record, records));
  }
  return { targetIds: [...targetIds], nets: [...nets], regions, occupancy: snapshot.localEvidence?.occupancy ?? [] };
}

export function connectionSourceIssues(before, current, dependencies, occupancy = []) {
  const changes = sourceChanges(before, current);
  if (!changes.length) return [];
  const old = sourceRecords(before), now = sourceRecords(current);
  const protectedIds = new Set(dependencies.targetIds), nets = new Set(dependencies.nets);
  const regions = dependencies.regions;
  if (!protectedIds.size || !Array.isArray(regions) || !regions.length || regions.some(box => !validBounds(box))) return [{ code: 'LOCAL_CHANGE_UNPROVEN', message: 'Candidate dependencies or space are incomplete.' }];
  const issues = [], roots = new Set();
  const trim = record => {
    const payload = { ...record.payload };
    for (const key of ['x', 'y', 'rotation', 'mirror', 'addIntoBom', 'addIntoPcb']) delete payload[key];
    return { ...record, payload };
  };
  for (const change of changes) {
    const root = change.root;
    if (protectedIds.has(root) || protectedIds.has(change.beforeRoot)) {
      issues.push({ code: 'RELATED_SCHEMATIC_CHANGED', id: change.id }); continue;
    }
    const members = [...old.filter(record => recordRoot(record, old) === root), ...now.filter(record => recordRoot(record, now) === root)];
    if (members.some(record => nets.has(record.payload.net) || nets.has(record.payload.Net)
      || (record.head.type === 'ATTR' && ['NET', 'Name'].includes(record.payload.key) && nets.has(record.payload.value)))) {
      issues.push({ code: 'RELATED_SCHEMATIC_CHANGED', id: change.id }); continue;
    }
    // Unknown settings, ownership changes and electrical edits are not spatial evidence.
    const rootRecord = now.find(record => record.head.id === root);
    if (!change.before || !change.current || change.beforeRoot !== root || !['COMPONENT', 'WIRE', 'TEXT', 'LINE', 'RECT', 'ARC', 'POLYLINE'].includes(rootRecord?.head.type)
      || stable(trim(change.before)) !== stable(trim(change.current))) {
      // Free text may change its content, but still needs its actual native extent.
      if (!(change.current?.head.type === 'TEXT' && change.root === change.id && (!change.before || change.before.head.type === 'TEXT' && change.beforeRoot === change.id))) {
        issues.push({ code: 'LOCAL_CHANGE_UNPROVEN', id: change.id }); continue;
      }
    }
    // Inclusion flags cannot move geometry, including attribute extents.
    const withoutFlags = record => { const payload = { ...record.payload }; delete payload.addIntoBom; delete payload.addIntoPcb; return { ...record, payload }; };
    if (change.before && stable(withoutFlags(change.before)) === stable(withoutFlags(change.current))) continue;
    roots.add(root);
  }
  if (!roots.size) return issues;
  // Both sides matter: moving an object away from a dependency is still a change to that dependency.
  const originalOccupancy = dependencies.occupancy || [];
  const protectedBounds = new Set([...protectedIds, ...old.filter(record => record.head.type === 'ATTR' && protectedIds.has(recordRoot(record, old))).map(record => record.head.id)]);
  const regionsWithBounds = regions.slice();
  for (const id of protectedBounds) for (const [kind, evidence] of [['baseline', originalOccupancy], ['current', occupancy]]) {
    const box = evidence.find(item => item.id === id)?.bounds;
    if (!validBounds(box)) issues.push({ code: 'LOCAL_CHANGE_UNPROVEN', id, message: kind === 'baseline' ? 'Native baseline bounds are unavailable.' : 'Native bounds are unavailable.' });
    else regionsWithBounds.push(box);
  }
  for (const root of roots) {
    for (const record of old.filter(record => record.head.id === root || record.head.type === 'ATTR' && recordRoot(record, old) === root)) {
      const box = originalOccupancy.find(item => item.id === record.head.id)?.bounds;
      if (!validBounds(box)) issues.push({ code: 'LOCAL_CHANGE_UNPROVEN', id: record.head.id, message: 'Native baseline bounds are unavailable.' });
      else if (regionsWithBounds.some(region => overlap(box, region))) issues.push({ code: 'TARGET_OCCUPIED', id: record.head.id });
    }
    const ids = [root, ...now.filter(record => record.head.type === 'ATTR' && recordRoot(record, now) === root).map(record => record.head.id)];
    for (const id of ids) {
      const box = occupancy.find(item => item.id === id)?.bounds;
      if (!validBounds(box)) issues.push({ code: 'LOCAL_CHANGE_UNPROVEN', id, message: 'Native bounds are unavailable.' });
      else if (regionsWithBounds.some(region => overlap(box, region))) issues.push({ code: 'TARGET_OCCUPIED', id });
    }
  }
  return issues;
}
