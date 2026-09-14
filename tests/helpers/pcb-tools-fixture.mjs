export function pcbFixture() {
  const scene = {
    documentUuid: 'pcb-test', projectUuid: 'project-test',
    components: [
      { primitiveId: 'c1', designator: 'U1', x: 100, y: 100, rotation: 0, layer: 1, primitiveLock: false, bbox: { minX: 80, minY: 80, maxX: 120, maxY: 120 } },
      { primitiveId: 'c2', designator: 'R1', x: 300, y: 100, rotation: 90, layer: 1, primitiveLock: false, bbox: { minX: 290, minY: 80, maxX: 310, maxY: 120 } },
    ],
    lines: [
      { primitiveId: 'l1', net: 'PWR', layer: 1, startX: 0, startY: 0, endX: 100, endY: 0, lineWidth: 10, primitiveLock: false },
      { primitiveId: 'l2', net: 'PWR', layer: 1, startX: 100, startY: 0, endX: 110, endY: 0, lineWidth: 6, primitiveLock: false },
      { primitiveId: 'l3', net: 'SIG', layer: 2, startX: 0, startY: 200, endX: 300, endY: 200, lineWidth: 8, primitiveLock: false },
    ],
    colors: { PWR: null, SIG: { r: 1, g: 2, b: 3, alpha: 1 } },
    netClasses: [
      { name: 'PWR', nets: ['PWR'], color: { r: 100, g: 50, b: 50, alpha: 1 / 255 } },
      { name: 'SIG', nets: ['SIG'], color: { r: 1, g: 2, b: 3, alpha: 1 } },
    ],
    ruleState: { currentRuleConfiguration: { config: { clearance: 6 } }, netRules: [], netByNetRules: [], regionRules: [] },
    writes: [], saves: 0, drcCalls: 0, drc: [], afterWrite: null,
    vias: [], arcs: [], pours: [], regions: [], polylines: [],
  };
  const primitive = (record) => record && Object.fromEntries(Object.entries(record).map(([key, value]) => [`getState_${key[0].toUpperCase()}${key.slice(1)}`, () => value]));
  function move(record, property) {
    const dx = property.x - record.x, dy = property.y - record.y;
    const radians = (property.rotation - record.rotation) * Math.PI / 180;
    const corners = [[record.bbox.minX, record.bbox.minY], [record.bbox.minX, record.bbox.maxY], [record.bbox.maxX, record.bbox.minY], [record.bbox.maxX, record.bbox.maxY]]
      .map(([x, y]) => [property.x + (x - record.x) * Math.cos(radians) - (y - record.y) * Math.sin(radians), property.y + (x - record.x) * Math.sin(radians) + (y - record.y) * Math.cos(radians)]);
    record.bbox = { minX: Math.min(...corners.map(p => p[0])), minY: Math.min(...corners.map(p => p[1])), maxX: Math.max(...corners.map(p => p[0])), maxY: Math.max(...corners.map(p => p[1])) };
    Object.assign(record, property);
    return { dx, dy };
  }
  const eda = {
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: scene.documentUuid, documentType: 3 }) },
    dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: scene.projectUuid }) },
    sys_FileManager: { getDocumentSource: async () => JSON.stringify({ components: scene.components, lines: scene.lines, colors: scene.colors, netClasses: scene.netClasses, ruleState: scene.ruleState, vias: scene.vias, arcs: scene.arcs, pours: scene.pours, regions: scene.regions, polylines: scene.polylines }) },
    pcb_Net: {
      getNetColor: async (net) => structuredClone(scene.colors[net]),
      setNetColor: async (net, color) => {
        if (!Object.hasOwn(scene.colors, net)) return false;
        scene.colors[net] = structuredClone(color);
        scene.writes.push({ type: 'color', net });
        await scene.afterWrite?.();
        return true;
      },
    },
    pcb_PrimitiveComponent: {
      getAll: async () => scene.components.map(primitive),
      get: async (id) => primitive(scene.components.find(c => c.primitiveId === id)),
      modify: async (id, property) => {
        const record = scene.components.find(c => c.primitiveId === id);
        move(record, property);
        scene.writes.push({ type: 'component', id });
        await scene.afterWrite?.();
        return primitive(record);
      },
    },
    pcb_Primitive: { getPrimitivesBBox: async ([id]) => structuredClone(scene.components.find(c => c.primitiveId === id)?.bbox) },
    pcb_PrimitiveLine: {
      getAll: async () => scene.lines.map(primitive),
      get: async (id) => primitive(scene.lines.find(c => c.primitiveId === id)),
      modify: async (id, property) => {
        const record = scene.lines.find(c => c.primitiveId === id);
        Object.assign(record, property);
        scene.writes.push({ type: 'line', id });
        await scene.afterWrite?.();
        return primitive(record);
      },
    },
    pcb_Document: { save: async () => { scene.saves++; return true; } },
    pcb_Drc: {
      check: async () => { scene.drcCalls++; return structuredClone(scene.drc); },
      getAllNetClasses: async () => structuredClone(scene.netClasses),
      getCurrentRuleConfiguration: async () => structuredClone(scene.ruleState.currentRuleConfiguration),
      getNetRules: async () => structuredClone(scene.ruleState.netRules),
      getNetByNetRules: async () => structuredClone(scene.ruleState.netByNetRules),
      getRegionRules: async () => structuredClone(scene.ruleState.regionRules),
      overwriteCurrentRuleConfiguration: async config => { scene.ruleState.currentRuleConfiguration.config = structuredClone(config); return true; },
      overwriteNetRules: async rules => { scene.ruleState.netRules = structuredClone(rules); return true; },
      deleteNetClass: async name => {
        const index = scene.netClasses.findIndex(item => item.name === name);
        if (index < 0) return false;
        scene.netClasses.splice(index, 1);
        scene.writes.push({ type: 'class-delete', name });
        await scene.afterWrite?.();
        return true;
      },
      createNetClass: async (name, nets, color) => {
        if (scene.netClasses.some(item => item.name === name)) return false;
        // Reproduce the observed API boundary: byte alpha in, normalized alpha out.
        scene.netClasses.push({ name, nets: structuredClone(nets), color: { ...color, alpha: color.alpha / 255 } });
        scene.writes.push({ type: 'class-create', name, color: structuredClone(color) });
        await scene.afterWrite?.();
        return true;
      },
    },
  };
  for (const [type, key] of [['Via', 'vias'], ['Arc', 'arcs'], ['Pour', 'pours'], ['Region', 'regions'], ['Polyline', 'polylines']]) {
    eda[`pcb_Primitive${type}`] = { getAll: async () => scene[key].map(primitive) };
  }
  return { scene, eda, target: { expectedDocumentUuid: 'pcb-test', expectedProjectUuid: 'project-test' } };
}
