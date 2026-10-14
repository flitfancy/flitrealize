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
