const box = (x, y, radius = 10) => ({ minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius });

export function prepareFixture(secondX = 150) {
  const components = ['U1', 'C1'].map((ref, i) => ({ id: ref + ':', ref, x: i * secondX, y: 0, rotation: 0, bbox: box(i * secondX, 0), footprint: { name: 'synthetic-package' }, layer: 1 }));
  const snapshot = {
    units: 'mil', coordinateSystem: 'eda-y-up', sourceHash: 7, components,
    pads: components.map(c => ({ id: c.id + '1', owner: c.ref, number: '1', net: 'SUPPLY', x: c.x, y: c.y, bbox: box(c.x, c.y, 2), layer: 1 })),
    items: components.map(c => ({ id: c.id + 'label', owner: c.ref, parentId: c.id, type: 'attribute', text: c.ref, layer: 3, fontSize: 10, lineWidth: 1, width: 20, height: 10,
      original: { x: c.x - 10, y: 25, rotation: 0, alignMode: 3, bbox: { minX: c.x - 10, maxX: c.x + 10, minY: 25, maxY: 35 } } })),
    outlines: [], regions: [], routing: { Line: 0, Arc: 0, Polyline: 0, Via: 0, Pour: 0 }, capabilities: { unsupported: [] }
  };
  const contract = {
    schemaVersion: 1, project: { id: 'synthetic', revision: '1' },
    components: components.map(c => ({ designator: c.ref, role: 'synthetic component', includeInPcb: true, pins: [{ number: '1' }] })),
    blocks: [{ id: 'supply', purpose: 'synthetic supply', components: ['U1', 'C1'] }],
    nets: [{ name: 'SUPPLY', kind: 'power', endpoints: components.map(c => ({ component: c.ref, pin: '1' })) }],
    constraints: [{ id: 'supply-filtering', type: 'layout', requirement: 'Place the supply capacitor near the supply pin; verify return routing separately.', appliesTo: [{ kind: 'component', id: 'C1' }], evidenceState: 'OPEN' }]
  };
  const config = {
    scoringMode: 'simple-v1', hard: { boardBounds: null, fixed: [], preserveRotations: false },
    groups: ['power', 'sense', 'bypass'].map(id => ({ id, label: id, links: [] })),
    connectivity: { excludeNets: [], includeTestPads: false },
    comparisonWeights: { power: 1, sense: 1, bypass: 1, connectivity: 1 },
    search: { iterations: 2, gridMil: 5, maxMoveStepMil: 5, profiles: [{ name: 'balanced', label: 'Balanced', seed: 42, weights: { power: 1, sense: 1, bypass: 1, connectivity: 1 } }] }
  };
  return { snapshot, contract, config, mechanical: { clearanceMil: 8 } };
}

export const filterRelation = extra => ({ id: 'supply-filter', kind: 'bypass', from: { ref: 'U1', pin: '1' }, to: { ref: 'C1', pin: '1' }, net: 'SUPPLY', basis: 'Explicit synthetic layout requirement', requirementId: 'supply-filtering', ...extra });
export function addIntent(fixture, ...relations) { fixture.contract.extensions = { pcbLayout: { schemaVersion: 1, relations } }; return fixture; }
