// Local source comparison mirrors schematic-local-state.mjs for this standalone EDA Action.
const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}' : JSON.stringify(value);

function sourceRecords(source) {
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

function recordRoot(record, records) {
  const byId = new Map(records.map(item => [item.head.id, item]));
  const seen = new Set();
  const owner = item => item.payload.parentId || (item.head.type === 'LINE' ? item.payload.lineGroup : null);
  while (owner(record) && byId.has(owner(record))) {
    if (seen.has(record.head.id)) throw Object.assign(new Error('Cyclic source ownership.'), { code: 'LOCAL_SOURCE_UNSUPPORTED' });
    seen.add(record.head.id); record = byId.get(owner(record));
  }
  return owner(record) || record.head.id;
}

function sourceChanges(before, current, ignoredIds = []) {
  const old = sourceRecords(before), now = sourceRecords(current), ignored = new Set(ignoredIds);
  const byId = new Map(now.map(record => [record.head.id, record]));
  const oldIds = new Set(old.map(record => record.head.id));
  return [...old.filter(record => stable(record) !== stable(byId.get(record.head.id))).map(record => ({ id: record.head.id,
    root: recordRoot(byId.get(record.head.id) || record, byId.has(record.head.id) ? now : old), beforeRoot: recordRoot(record, old), before: record, current: byId.get(record.head.id) || null })),
  ...now.filter(record => !oldIds.has(record.head.id)).map(record => ({ id: record.head.id, root: recordRoot(record, now), before: null, current: record }))]
    .filter(change => !ignored.has(change.root) || (change.before && !ignored.has(change.beforeRoot)));
}

const validBounds = box => box && ['minX', 'minY', 'maxX', 'maxY'].every(key => Number.isFinite(box[key])) && box.minX <= box.maxX && box.minY <= box.maxY;

const overlap = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

function connectionSourceIssues(before, current, dependencies, occupancy = []) {
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


// Execution guard is independent of the immutable candidate's source fingerprint.
async function guardSource(expected, ownedIds = []) {
  if (expected == null) return;
  const protect = source => {
    if (typeof source !== 'string' || !source.trim()) throw Object.assign(new Error('Source guard unavailable.'), { code: 'LOCAL_SOURCE_UNAVAILABLE' });
    const records = source.split(/\r?\n/).filter(Boolean).map(line => {
      const split = line.indexOf('||');
      try {
        if (split < 0) throw new Error();
        return { head: JSON.parse(line.slice(0, split)), payload: JSON.parse(line.slice(split + 2).replace(/\|$/, '')) };
      } catch { throw Object.assign(new Error('Unsupported native source for execution guard.'), { code: 'LOCAL_SOURCE_UNSUPPORTED' }); }
    }).filter(record => record.head.type !== 'DOCHEAD');
    if (records.some(record => !record.head.id) || new Set(records.map(record => record.head.id)).size !== records.length) throw Object.assign(new Error('Ambiguous source IDs.'), { code: 'LOCAL_SOURCE_UNSUPPORTED' });
    const byId = new Map(records.map(record => [record.head.id, record])), owned = new Set(ownedIds);
    const root = record => {
      const seen = new Set();
      const owner = item => item.payload.parentId || (item.head.type === 'LINE' ? item.payload.lineGroup : null);
      while (owner(record) && byId.has(owner(record))) {
        if (seen.has(record.head.id)) throw Object.assign(new Error('Cyclic source ownership.'), { code: 'LOCAL_SOURCE_UNSUPPORTED' });
        seen.add(record.head.id); record = byId.get(owner(record));
      }
      return owner(record) || record.head.id;
    };
    const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
      : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}' : JSON.stringify(value);
    return stable(records.filter(record => !owned.has(root(record))).sort((a, b) => a.head.id.localeCompare(b.head.id)));
  };
  if (protect(expected) !== protect(await eda.sys_FileManager.getDocumentSource())) throw Object.assign(new Error('Source changed after preflight; stop and reconcile.'), { code: 'EXECUTION_SOURCE_CHANGED' });
}

return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;
  const MAX_WIRES_PER_APPLY = 200;
  const APPLY_BATCH_SIZE = 20;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  async function assertTarget(documentUuid, projectUuid = null) {
    const current = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if (Number(current?.documentType) !== 1 || current?.uuid !== documentUuid
      || (projectUuid && current.parentProjectUuid !== projectUuid)) fail('DOCUMENT_MISMATCH', 'The active schematic changed during the operation.');
  }

  function callGetter(object, name, fallback = null) {
    try {
      return typeof object?.[name] === 'function' ? object[name]() : fallback;
    } catch {
      return fallback;
    }
  }

  function finiteOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function hashText(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a32-${hash.toString(16).padStart(8, '0')}`;
  }

  async function optionalCall(namespace, method, ...args) {
    if (typeof eda?.[namespace]?.[method] !== 'function') return { value: null, error: null, unsupported: true };
    try {
      return { value: await eda[namespace][method](...args), error: null, unsupported: false };
    } catch (error) {
      return { value: null, error: error.message, unsupported: false };
    }
  }

  function normalizePoints(value) {
    if(!Array.isArray(value)||!value.length)return [];
    if(value.every(p=>p&&typeof p==='object'&&!Array.isArray(p)&&Number.isFinite(p.x)&&Number.isFinite(p.y)))return value.map(p=>({x:p.x,y:p.y}));
    if(value.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)))return value.map(([x,y])=>({x,y}));
    const segments=[];
    const add=line=>{
      if(!Array.isArray(line)||line.some(n=>!Number.isFinite(n))||line.length<4||line.length%2)throw new Error('Invalid native wire coordinates');
      if(line.length%4===0){for(let i=0;i<line.length;i+=4)segments.push([{x:line[i],y:line[i+1]},{x:line[i+2],y:line[i+3]}]);}
      else for(let i=0;i+3<line.length;i+=2)segments.push([{x:line[i],y:line[i+1]},{x:line[i+2],y:line[i+3]}]);
    };
    if(value.every(Number.isFinite))add(value);else for(const line of value)add(line);
    if(segments.length===1)return segments[0];
    const key=p=>Math.round(p.x*1e6)+','+Math.round(p.y*1e6),vertices=new Map(),adjacency=new Map();
    for(const [i,edge]of segments.entries())for(let side=0;side<2;side++){
      const p=edge[side],k=key(p);if(!vertices.has(k))vertices.set(k,p);if(!adjacency.has(k))adjacency.set(k,[]);adjacency.get(k).push({index:i,other:key(edge[1-side])});
    }
    const ends=[...vertices.keys()].filter(k=>adjacency.get(k).length===1);
    if(ends.length!==2||[...adjacency.values()].some(a=>a.length>2))throw new Error('Only a connected wire chain is supported');
    ends.sort((a,b)=>vertices.get(a).x-vertices.get(b).x||vertices.get(a).y-vertices.get(b).y);
    const used=new Set(),points=[];let current=ends[0];
    for(;;){points.push(vertices.get(current));const edge=adjacency.get(current).find(e=>!used.has(e.index));if(!edge)break;used.add(edge.index);current=edge.other;}
    if(used.size!==segments.length)throw new Error('Disconnected native wire chain');
    return points;
  }
  function pointsEqual(left, right) {
    const a = normalizePoints(left);
    const b = normalizePoints(right);
    if (a.length !== b.length) return false;
    const forward = a.every((point, index) => point.x === b[index].x && point.y === b[index].y);
    if (forward) return true;
    return a.every((point, index) => {
      const opposite = b[b.length - 1 - index];
      return point.x === opposite.x && point.y === opposite.y;
    });
  }

  function summarizeWire(wire) {
    return {
      primitiveId: callGetter(wire, 'getState_PrimitiveId'),
      net: callGetter(wire, 'getState_Net', '') || '',
      points: normalizePoints(callGetter(wire, 'getState_Line', callGetter(wire, 'getState_Points', []))),
      color: callGetter(wire, 'getState_Color'),
      lineWidth: finiteOrNull(callGetter(wire, 'getState_LineWidth')),
      lineType: callGetter(wire, 'getState_LineType'),
    };
  }

  async function summarizePin(pin, componentId) {
    const number = String(callGetter(pin, 'getState_PinNumber', callGetter(pin, 'getState_Number', callGetter(pin, 'getState_Name', ''))) || '');
    if (!number) return null;
    const nativeId = callGetter(pin, 'getState_PrimitiveId', callGetter(pin, 'getState_Id', `${componentId}:${number}`));
    const x = finiteOrNull(callGetter(pin, 'getState_X'));
    const y = finiteOrNull(callGetter(pin, 'getState_Y'));
    return {
      number,
      nativeId,
      position: x !== null && y !== null ? { x, y } : null,
      rotation: finiteOrNull(callGetter(pin, 'getState_Rotation')),
      noConnect: callGetter(pin, 'getState_NoConnected', callGetter(pin, 'getState_NoConnect', false)) === true,
    };
  }

  async function summarizeComponent(component) {
    const nativeId = callGetter(component, 'getState_PrimitiveId');
    const designator = callGetter(component, 'getState_Designator');
    if (!nativeId || !designator) return null;
    const pinsProbe = await optionalCall('sch_PrimitiveComponent', 'getAllPinsByPrimitiveId', nativeId);
    const pins = Array.isArray(pinsProbe.value)
      ? (await Promise.all(pinsProbe.value.map((pin) => summarizePin(pin, nativeId)))).filter(Boolean)
      : [];
    const x = finiteOrNull(callGetter(component, 'getState_X'));
    const y = finiteOrNull(callGetter(component, 'getState_Y'));
    return {
      designator,
      nativeId,
      position: x !== null && y !== null ? { x, y } : null,
      rotation: finiteOrNull(callGetter(component, 'getState_Rotation')),
      mirror: callGetter(component, 'getState_Mirror', false) === true,
      pins,
      pinCoverage: pinsProbe.unsupported ? 'unsupported' : pinsProbe.error ? 'error' : 'ok',
    };
  }

  function geometryEvidence(components, wires) {
    return {
      components: components.map((component) => ({
        designator: component.designator,
        nativeId: component.nativeId,
        position: component.position,
        rotation: component.rotation,
        mirror: component.mirror,
        pins: component.pins.map((pin) => ({
          number: pin.number,
          nativeId: pin.nativeId,
          position: pin.position,
          rotation: pin.rotation,
          noConnect: pin.noConnect,
        })).sort((left, right) => left.number.localeCompare(right.number)),
      })).sort((left, right) => left.designator.localeCompare(right.designator)),
      wires: wires.map((wire) => ({
        primitiveId: wire.primitiveId,
        net: wire.net,
        points: wire.points,
        lineWidth: wire.lineWidth,
        lineType: wire.lineType,
      })).sort((left, right) => String(left.primitiveId).localeCompare(String(right.primitiveId))),
    };
  }

  async function captureState() {
    const documentProbe = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    const document = documentProbe.value
      ? { uuid: documentProbe.value.uuid ?? null, parentProjectUuid: documentProbe.value.parentProjectUuid ?? null, documentType: documentProbe.value.documentType ?? null }
      : null;
    const componentsProbe = await optionalCall('sch_PrimitiveComponent', 'getAll');
    const componentValues = Array.isArray(componentsProbe.value) ? componentsProbe.value : [];
    const components = (await Promise.all(componentValues.map(summarizeComponent))).filter(Boolean);
    const wiresProbe = await optionalCall('sch_PrimitiveWire', 'getAll');
    const wires = Array.isArray(wiresProbe.value) ? wiresProbe.value.map(summarizeWire) : [];
    const evidence = geometryEvidence(components, wires);
    const geometryFingerprint = hashText(stableStringify(evidence));
    const inspectionFingerprint = hashText(stableStringify({
      documentUuid: document?.uuid,
      geometryFingerprint,
    }));
    await assertTarget(document?.uuid, document?.parentProjectUuid);
    return {
      document,
      components,
      wires,
      geometryFingerprint,
      inspectionFingerprint,
      coverage: {
        components: componentsProbe.unsupported ? 'unsupported' : componentsProbe.error ? 'error' : Array.isArray(componentsProbe.value) ? 'queried' : 'unexpected-result',
        wires: wiresProbe.unsupported ? 'unsupported' : wiresProbe.error ? 'error' : Array.isArray(wiresProbe.value) ? 'queried' : 'unexpected-result',
        pins: components.some((component) => component.pinCoverage !== 'ok') ? 'incomplete' : 'queried',
      },
    };
  }

  function normalizeWire(item, index) {
    if (!Array.isArray(item.points) || item.points.length < 2) {
      fail('INVALID_PLAN_ITEM', `Wire ${index}: points must contain at least two positions.`);
    }
    const points = item.points.map((point, pointIndex) => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        fail('INVALID_PLAN_ITEM', `Wire ${index}, point ${pointIndex}: x and y must be finite numbers.`);
      }
      return { x: Number(point.x), y: Number(point.y) };
    });
    if (typeof item.net !== 'string' || !item.net.trim()) fail('INVALID_PLAN_ITEM', `Wire ${index}: net is required.`);
    return {
      index,
      key: typeof item.key === 'string' && item.key ? item.key : `${item.net}:${index}`,
      net: item.net.trim(),
      endpoint: item.endpoint || null,
      points,
      color: item.color ?? null,
      lineWidth: item.lineWidth ?? null,
      lineType: item.lineType ?? null,
    };
  }

  function normalizePlan(value) {
    if (!value || typeof value !== 'object') fail('INVALID_PLAN', 'plan must be an object.');
    const wirePlan = value.kind === 'flitrealize.schematic-wire-plan' && value.schemaVersion === 1;
    const sourceWires = wirePlan ? value.wires : value.wires ?? value.items;
    if (!Array.isArray(sourceWires)) fail('INVALID_PLAN', 'WirePlan wires or legacy plan.wires/items must be an array.');
    return {
      wires: sourceWires.map(normalizeWire),
      expectedDocumentUuid: wirePlan ? value.document?.nativeId ?? null : value.expectedDocumentUuid ?? null,
      expectedProjectUuid: wirePlan ? value.project?.nativeId ?? null : value.expectedProjectUuid ?? null,
      sourceGeometryFingerprint: wirePlan ? value.source?.geometryFingerprint ?? null : value.sourceGeometryFingerprint ?? null,
      sourceSnapshotFingerprint: wirePlan ? value.source?.snapshotFingerprint ?? null : value.sourceSnapshotFingerprint ?? null,
      sourceWirePlanFingerprint: wirePlan ? value.fingerprints?.plan ?? null : value.sourceWirePlanFingerprint ?? null,
      sourceNativeSource: wirePlan ? value.source?.nativeSource ?? null : value.sourceNativeSource ?? null,
      localDependencies: wirePlan ? value.source?.localDependencies ?? null : value.localDependencies ?? null,
      unresolved: wirePlan && Array.isArray(value.unresolved) ? value.unresolved : [],
      executionSource: value.executionSource ?? null,
    };
  }

  async function analyzePlan(state, plan) {
    const globalIssues = [];
    if (plan.expectedProjectUuid && state.document?.parentProjectUuid !== plan.expectedProjectUuid) globalIssues.push({ code: 'PROJECT_MISMATCH' });
    if (state.coverage.components !== 'queried' || state.coverage.wires !== 'queried') globalIssues.push({ code: 'INCOMPLETE_INSPECTION_COVERAGE' });
    if (!plan.expectedDocumentUuid) globalIssues.push({ code: 'DOCUMENT_IDENTITY_REQUIRED' });
    else if (state.document?.uuid !== plan.expectedDocumentUuid) {
      globalIssues.push({ code: 'DOCUMENT_MISMATCH', expected: plan.expectedDocumentUuid, actual: state.document?.uuid });
    }
    if (!plan.sourceGeometryFingerprint) globalIssues.push({ code: 'SOURCE_GEOMETRY_REQUIRED' });
    else if (plan.sourceNativeSource && plan.localDependencies) {
      try {
        const current = await eda.sys_FileManager.getDocumentSource();
        const changes = sourceChanges(plan.sourceNativeSource, current), dependencies = JSON.parse(JSON.stringify(plan.localDependencies));
        if (!changes.length && state.geometryFingerprint !== plan.sourceGeometryFingerprint) throw Object.assign(new Error('Geometry differs without matching source evidence.'), { code: 'SOURCE_GEOMETRY_STALE' });
        let issues = connectionSourceIssues(plan.sourceNativeSource, current, dependencies);
        if (issues.length && issues.every(issue => issue.message === 'Native bounds are unavailable.')) {
          const records = sourceRecords(current), roots = new Set([...changes.map(change => change.root), ...dependencies.targetIds]);
          const ids = new Set([...roots, ...records.filter(record => record.head.type === 'ATTR' && roots.has(recordRoot(record, records))).map(record => record.head.id)]);
          const occupancy = [];
          for (const id of ids) {
            const probe = await optionalCall('sch_Primitive', 'getPrimitivesBBox', [id]);
            if (validBounds(probe.value)) occupancy.push({ id, bounds: probe.value });
          }
          const protectedBounds = new Set([...dependencies.targetIds, ...records.filter(record => record.head.type === 'ATTR' && dependencies.targetIds.includes(recordRoot(record, records))).map(record => record.head.id)]);
          for (const id of protectedBounds) {
            const box = occupancy.find(item => item.id === id)?.bounds;
            if (!box) throw Object.assign(new Error('Target bounds unavailable.'), { code: 'LOCAL_CHANGE_UNPROVEN' });
            dependencies.regions.push(box);
          }
          issues = connectionSourceIssues(plan.sourceNativeSource, current, dependencies, occupancy);
        }
        // Native exports refresh DOCHEAD stamps on every read. Compare parsed
        // object records, retaining CANVAS and every drawable/property change.
        if (sourceChanges(current, await eda.sys_FileManager.getDocumentSource()).length) throw Object.assign(new Error('Source changed during local check.'), { code: 'EXECUTION_SOURCE_CHANGED' });
        globalIssues.push(...issues);
      } catch (error) { globalIssues.push({ code: error.code || 'LOCAL_CHANGE_UNPROVEN', message: error.message }); }
    } else if (state.geometryFingerprint !== plan.sourceGeometryFingerprint) {
      globalIssues.push({ code: 'SOURCE_GEOMETRY_STALE', expected: plan.sourceGeometryFingerprint, actual: state.geometryFingerprint });
    }
    if (plan.unresolved.length) globalIssues.push({ code: 'WIRE_PLAN_UNRESOLVED', count: plan.unresolved.length });
    if (plan.wires.length > MAX_WIRES_PER_APPLY) globalIssues.push({ code: 'TOO_MANY_WIRES', count: plan.wires.length, max: MAX_WIRES_PER_APPLY });
    const keys = new Set();
    const segments = new Set();
    for (const wire of plan.wires) {
      if (keys.has(wire.key)) globalIssues.push({ code: 'DUPLICATE_WIRE_KEY', key: wire.key });
      keys.add(wire.key);
      const segmentKey = stableStringify({ net: wire.net, points: wire.points });
      if (segments.has(segmentKey)) globalIssues.push({ code: 'DUPLICATE_WIRE_SEGMENT', key: wire.key });
      segments.add(segmentKey);
    }
    const planFingerprint = hashText(stableStringify({
      documentUuid: state.document?.uuid,
      geometryFingerprint: state.geometryFingerprint,
      plan,
      globalIssues,
    }));
    return {
      applyReady: plan.wires.length > 0 && globalIssues.length === 0,
      noOp: plan.wires.length === 0 && globalIssues.length === 0,
      wireCount: plan.wires.length,
      unresolvedCount: plan.unresolved.length,
      globalIssues,
      planFingerprint,
    };
  }

  async function getWiresByIds(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return [];
    if (typeof eda?.sch_PrimitiveWire?.get !== 'function') fail('CAPABILITY_UNAVAILABLE', 'sch_PrimitiveWire.get is unavailable.');
    try {
      const value = await eda.sch_PrimitiveWire.get(unique);
      if (Array.isArray(value)) return value.filter(Boolean).map(summarizeWire);
      if (value && unique.length === 1) return [summarizeWire(value)];
    } catch {
      // Fall back to one deterministic read per primitive ID.
    }
    const values = await Promise.all(unique.map(async (id) => {
      try {
        return await eda.sch_PrimitiveWire.get(id);
      } catch (error) {
        fail('WIRE_READBACK_FAILED', `Cannot read wire ${id}: ${error.message}`);
      }
    }));
    return values.filter(Boolean).map(summarizeWire);
  }

  function wireMatchesRequest(actual, expected) {
    if (!actual || actual.net !== expected.net || !pointsEqual(actual.points, expected.points)) return false;
    if (expected.color !== null && actual.color !== expected.color) return false;
    if (expected.lineWidth !== null && actual.lineWidth !== expected.lineWidth) return false;
    if (expected.lineType !== null && actual.lineType !== expected.lineType) return false;
    return true;
  }

  function wireMatchesRecord(actual, expected) {
    return actual
      && actual.primitiveId === expected.primitiveId
      && actual.net === expected.net
      && pointsEqual(actual.points, expected.points)
      && actual.color === expected.color
      && actual.lineWidth === expected.lineWidth
      && actual.lineType === expected.lineType;
  }

  function targetedFingerprint(wires) {
    return hashText(stableStringify(wires.map((wire) => ({
      primitiveId: wire.primitiveId,
      net: wire.net,
      points: normalizePoints(wire.points),
      color: wire.color ?? null,
      lineWidth: wire.lineWidth ?? null,
      lineType: wire.lineType ?? null,
    })).sort((left, right) => String(left.primitiveId).localeCompare(String(right.primitiveId)))));
  }

  async function deleteAndVerify(created, document) {
    await assertTarget(document.uuid, document.parentProjectUuid);
    const ids = created.map((wire) => wire.primitiveId).filter(Boolean);
    if (!ids.length) return { deleted: true, remaining: 0, remainingIds: [], coverage: 'targeted-by-id' };
    let deleted = false;
    try {
      deleted = await eda.sch_PrimitiveWire.delete(ids);
    } catch {
      deleted = false;
    }
    const remaining = await getWiresByIds(ids);
    await assertTarget(document.uuid, document.parentProjectUuid);
    return {
      deleted: Boolean(deleted),
      remaining: remaining.length,
      remainingIds: remaining.map((wire) => wire.primitiveId),
      coverage: 'targeted-by-id',
    };
  }

  function globalEnumerationCoverage(before, after, createdIds) {
    if (after.coverage.wires !== 'queried') return 'unknown';
    const afterIds = new Set(after.wires.map((wire) => wire.primitiveId));
    const beforeIds = new Set(before.wires.map((wire) => wire.primitiveId));
    const protectedMissing = [...beforeIds].filter((id) => !afterIds.has(id));
    const createdMissing = createdIds.filter((id) => !afterIds.has(id));
    return protectedMissing.length || createdMissing.length ? 'inconsistent' : 'consistent';
  }

  async function applyPlan(plan, expectedPlanFingerprint) {
    const before = await captureState();
    try { await guardSource(plan.executionSource); }
    catch (error) { return { status: 'blocked', readOnly: true, error: { code: error.code, message: error.message } }; }
    const analysis = await analyzePlan(before, plan);
    if (!analysis.applyReady || analysis.planFingerprint !== expectedPlanFingerprint) {
      return {
        schemaVersion: 2,
        status: 'blocked',
        readOnly: true,
        reason: analysis.planFingerprint !== expectedPlanFingerprint ? 'PLAN_FINGERPRINT_MISMATCH' : 'PLAN_NOT_APPLY_READY',
        state: { document: before.document, inspectionFingerprint: before.inspectionFingerprint, geometryFingerprint: before.geometryFingerprint },
        analysis,
      };
    }
    try { await guardSource(plan.executionSource); }
    catch (error) { return { status: 'blocked', readOnly: true, error: { code: error.code, message: error.message } }; }
    const created = [];
    const createdIds = [];
    const existingIds = new Set(before.wires.map(item => item.primitiveId));
    let uncertainWrite = false;
    try {
      for (let offset = 0; offset < plan.wires.length; offset += APPLY_BATCH_SIZE) {
        const batch = plan.wires.slice(offset, offset + APPLY_BATCH_SIZE);
        const batchCreated = [];
        for (const item of batch) {
          await guardSource(plan.executionSource, createdIds);
          const line = item.points.flatMap((point) => [point.x, point.y]);
          await assertTarget(before.document.uuid, before.document.parentProjectUuid);
          uncertainWrite = true;
          const primitive = await eda.sch_PrimitiveWire.create(line, item.net, item.color, item.lineWidth, item.lineType);
          if (!primitive) fail('CREATE_WIRE_FAILED', `EasyEDA rejected wire ${item.key}.`);
          const primitiveId = callGetter(primitive, 'getState_PrimitiveId');
          if (!primitiveId) fail('CREATE_WIRE_WITHOUT_ID', `Wire ${item.key} has no primitive ID.`);
          if (existingIds.has(primitiveId) || createdIds.includes(primitiveId)) fail('CREATE_ID_NOT_NEW', 'Create returned an existing primitive ID; ownership is unconfirmed.');
          await assertTarget(before.document.uuid, before.document.parentProjectUuid);
          createdIds.push(primitiveId);
          uncertainWrite = false;
          await guardSource(plan.executionSource, createdIds);
          batchCreated.push({ item, primitiveId });
        }
        const readback = await getWiresByIds(batchCreated.map((entry) => entry.primitiveId));
        await assertTarget(before.document.uuid, before.document.parentProjectUuid);
        const byId = new Map(readback.map((wire) => [wire.primitiveId, wire]));
        for (const entry of batchCreated) {
          const actual = byId.get(entry.primitiveId);
          if (!wireMatchesRequest(actual, entry.item)) {
            fail('WIRE_READBACK_MISMATCH', `Wire ${entry.item.key} did not retain the requested net, geometry, or style.`);
          }
          created.push({
            index: entry.item.index,
            key: entry.item.key,
            endpoint: entry.item.endpoint,
            ...actual,
          });
        }
      }
      const targeted = await getWiresByIds(created.map((wire) => wire.primitiveId));
      const targetedById = new Map(targeted.map((wire) => [wire.primitiveId, wire]));
      const mismatches = created.filter((wire) => !wireMatchesRecord(targetedById.get(wire.primitiveId), wire));
      if (mismatches.length) fail('POST_APPLY_TARGETED_VERIFY_FAILED', `${mismatches.length} created wire(s) failed ID-based verification.`);
      const after = await captureState();
      await guardSource(plan.executionSource, createdIds);
      await assertTarget(before.document.uuid, before.document.parentProjectUuid);
      const expectedCreatedFingerprint = targetedFingerprint(created);
      return {
        schemaVersion: 2,
        status: 'applied',
        readOnly: false,
        saved: false,
        beforeInspectionFingerprint: before.inspectionFingerprint,
        afterInspectionFingerprint: after.inspectionFingerprint,
        planFingerprint: analysis.planFingerprint,
        created,
        verification: {
          coverage: 'targeted-by-id',
          verifiedCount: targeted.length,
          globalWireEnumeration: globalEnumerationCoverage(before, after, created.map((wire) => wire.primitiveId)),
        },
        rollbackRequest: {
          mode: 'rollback',
          request: {
            expectedDocumentUuid: plan.expectedDocumentUuid,
            expectedProjectUuid: before.document.parentProjectUuid,
            expectedCreatedFingerprint,
            expectedRestoredFingerprint: before.inspectionFingerprint,
            created,
          },
        },
      };
    } catch (error) {
      const rollbackTargets = createdIds.map((primitiveId) => created.find((wire) => wire.primitiveId === primitiveId) || { primitiveId });
      let rollback = { deleted: false, remaining: null };
      if (!uncertainWrite) {
        try { rollback = await deleteAndVerify(rollbackTargets, before.document); }
        catch (recoveryError) { rollback.error = recoveryError.message; }
      }
      let restored = null;
      try {
        await assertTarget(before.document.uuid, before.document.parentProjectUuid);
        const captured = await captureState();
        await assertTarget(before.document.uuid, before.document.parentProjectUuid);
        restored = captured;
      } catch { /* Preserve known IDs when the original schematic cannot be read. */ }
      return {
        schemaVersion: 2,
        status: !uncertainWrite && rollback.remaining === 0 && restored?.coverage.wires === 'queried' && restored.coverage.components === 'queried' && restored.inspectionFingerprint === before.inspectionFingerprint
          ? 'rolled-back'
          : 'rollback-incomplete',
        error: { code: error.code ?? 'APPLY_FAILED', message: error.message },
        createdBeforeFailure: rollbackTargets,
        uncertainWrite,
        rollback,
        restoredInspectionFingerprint: restored?.inspectionFingerprint ?? null,
        expectedRestoredFingerprint: before.inspectionFingerprint,
        saved: false,
      };
    }
  }

  function operationRequest(root) {
    return root.request || root.applyRequest || root;
  }

  const mode = request.mode ?? 'inspect';
  if (mode === 'inspect') {
    const state = await captureState();
    return {
      schemaVersion: 2,
      status: 'inspected',
      readOnly: true,
      state: {
        document: state.document,
        inspectionFingerprint: state.inspectionFingerprint,
        geometryFingerprint: state.geometryFingerprint,
        componentCount: state.components.length,
        wireCount: state.wires.length,
        coverage: state.coverage,
      },
    };
  }
  if (mode === 'plan') {
    const plan = normalizePlan(request.plan);
    const state = await captureState();
    if (plan.sourceNativeSource && !plan.executionSource) plan.executionSource = plan.localDependencies ? await eda.sys_FileManager.getDocumentSource() : plan.sourceNativeSource;
    const analysis = await analyzePlan(state, plan);
    await guardSource(plan.executionSource);
    return {
      schemaVersion: 2,
      status: analysis.noOp ? 'planned-noop' : analysis.applyReady ? 'planned' : 'planned-with-blockers',
      readOnly: true,
      state: {
        document: state.document,
        inspectionFingerprint: state.inspectionFingerprint,
        geometryFingerprint: state.geometryFingerprint,
        wireCount: state.wires.length,
        coverage: state.coverage,
      },
      plan,
      analysis,
      applyRequest: analysis.applyReady
        ? { mode: 'apply', request: { plan, expectedPlanFingerprint: analysis.planFingerprint } }
        : null,
    };
  }
  if (mode === 'apply') {
    const input = operationRequest(request);
    if (typeof input.expectedPlanFingerprint !== 'string' || !input.expectedPlanFingerprint) {
      fail('INVALID_APPLY_REQUEST', 'apply requires expectedPlanFingerprint from plan mode.');
    }
    return applyPlan(normalizePlan(input.plan), input.expectedPlanFingerprint);
  }
  if (mode === 'verify') {
    const input = operationRequest(request);
    if (!Array.isArray(input.created) || !input.expectedDocumentUuid) {
      fail('INVALID_VERIFY_REQUEST', 'verify requires expectedDocumentUuid and created readback records.');
    }
    const documentProbe = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    if (documentProbe.value?.uuid !== input.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'Verify request belongs to another schematic.');
    const actual = await getWiresByIds(input.created.map((wire) => wire.primitiveId));
    await assertTarget(input.expectedDocumentUuid, input.expectedProjectUuid ?? documentProbe.value.parentProjectUuid);
    const byId = new Map(actual.map((wire) => [wire.primitiveId, wire]));
    const issues = input.created
      .filter((expected) => !wireMatchesRecord(byId.get(expected.primitiveId), expected))
      .map((expected) => ({ code: 'WIRE_MISSING_OR_CHANGED', primitiveId: expected.primitiveId, index: expected.index ?? null }));
    return {
      schemaVersion: 2,
      status: issues.length ? 'mismatch' : 'verified',
      readOnly: true,
      coverage: 'targeted-by-id',
      verifiedCount: actual.length,
      targetedFingerprint: targetedFingerprint(actual),
      issues,
    };
  }
  if (mode === 'rollback') {
    const input = operationRequest(request);
    if (!input.expectedDocumentUuid || !input.expectedCreatedFingerprint || !input.expectedRestoredFingerprint || !Array.isArray(input.created)) {
      fail('INVALID_ROLLBACK_REQUEST', 'rollback requires document identity, created/restored fingerprints, and created records.');
    }
    const documentProbe = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    if (documentProbe.value?.uuid !== input.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'Rollback request belongs to another schematic.');
    const currentTargets = await getWiresByIds(input.created.map((wire) => wire.primitiveId));
    if (targetedFingerprint(currentTargets) !== input.expectedCreatedFingerprint) {
      fail('STALE_ROLLBACK', 'One or more created wires changed after apply.');
    }
    const rollback = await deleteAndVerify(input.created, { uuid: input.expectedDocumentUuid, parentProjectUuid: input.expectedProjectUuid ?? documentProbe.value.parentProjectUuid });
    const restored = await captureState();
    await assertTarget(input.expectedDocumentUuid, input.expectedProjectUuid ?? documentProbe.value.parentProjectUuid);
    return {
      schemaVersion: 2,
      status: rollback.remaining
        ? 'rollback-incomplete'
        : restored.coverage.wires === 'queried' && restored.coverage.components === 'queried' && restored.inspectionFingerprint === input.expectedRestoredFingerprint ? 'rolled-back' : 'rolled-back-targeted',
      rollback,
      restoredInspectionFingerprint: restored.inspectionFingerprint,
      expectedRestoredFingerprint: input.expectedRestoredFingerprint,
      globalWireEnumeration: restored.coverage.wires,
      saved: false,
    };
  }
  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
