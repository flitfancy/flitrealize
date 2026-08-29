return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
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

  // ─── Grid constants (EasyEDA schematic units, 1 unit = 10 mil) ───
  const COL_SPACING = 1400;
  const ROW_SPACING = 120;
  const IC_Y_TOP = 2500;
  const PASSIVE_OFFSET_BELOW = 350;
  const CONNECTOR_OFFSET_LEFT = 350;
  const STUB_LENGTH = 8;

  // ─── Signal-flow ordering (pcb-review: connector → protection → power → output) ───
  const FLOW_PRIORITY = {
    'connector': 0,
    'protection': 1,
    'power-input': 2,
    'charger': 3,
    'regulator': 4,
    'power-output': 5,
    'signal': 6,
    'output': 7,
  };

  function classifyComponents(contract, catalog) {
    const classified = {};
    for (const comp of contract.components) {
      const ref = comp.designator;
      const cat = catalog[ref] || {};
      const role = cat.role || inferRole(comp);
      classified[ref] = {
        ref,
        role,
        pinCount: cat.pinCount || (comp.pins ? comp.pins.length : 2),
        identity: comp.identity,
        pins: comp.pins || [],
        includeInBom: comp.includeInBom !== false,
        includeInPcb: comp.includeInPcb !== false,
        near: cat.near || null,
        direction: cat.direction || null,
        connects: cat.connects || null,
      };
    }
    return classified;
  }

  function inferRole(comp) {
    const ref = comp.designator;
    const role = (comp.role || '').toLowerCase();
    if (/^J/.test(ref)) return 'connector';
    if (role.includes('protect')) return 'protection';
    if (role.includes('charger')) return 'charger';
    if (role.includes('regulator') || role.includes('ldo')) return 'regulator';
    if (/^[UIC]/.test(ref)) {
      return (comp.pins && comp.pins.length > 3) ? 'main-ic' : 'passive';
    }
    return 'passive';
  }

  function inferBlockFlowType(block, classified) {
    const id = (block.id || '').toLowerCase();
    const purpose = (block.purpose || '').toLowerCase();
    const roles = (block.components || []).map(ref => classified[ref]?.role || 'passive');

    if (roles.includes('connector') || id.includes('usb') || id.includes('input') || purpose.includes('input')) return 'connector';
    if (roles.includes('protection') || id.includes('protect')) return 'protection';
    if (id.includes('charger') || purpose.includes('charge')) return 'charger';
    if (id.includes('regulator') || purpose.includes('regulat') || purpose.includes('ldo')) return 'regulator';
    if (id.includes('output') || id.includes('buck-boost') || purpose.includes('output') || purpose.includes('convert')) return 'power-output';
    if (roles.includes('main-ic')) return 'signal';
    return 'signal';
  }

  // ─── Build net lookup: pin → net name, net → set of power domain ───
  function buildNetMaps(contract) {
    const pinToNet = {};
    const netToPowerDomain = {};
    const netKind = {};

    for (const pd of (contract.powerDomains || [])) {
      if (pd.sourceNet) netToPowerDomain[pd.sourceNet] = pd.id;
      if (pd.returnNet) netToPowerDomain[pd.returnNet] = pd.id;
    }

    for (const net of (contract.nets || [])) {
      netKind[net.name] = net.kind || 'signal';
      for (const ep of (net.endpoints || [])) {
        const key = `${ep.component}:${ep.pin}`;
        pinToNet[key] = net.name;
      }
    }

    return { pinToNet, netToPowerDomain, netKind };
  }

  // ─── Determine which side of an IC a passive connects to ───
  function determinePassiveSide(passiveRef, nearIcRef, contract, catalog, pinToNet) {
    const cat = catalog[passiveRef];
    if (cat && cat.direction) return cat.direction;

    const passComp = contract.components.find(c => c.designator === passiveRef);
    const icComp = contract.components.find(c => c.designator === nearIcRef);
    if (!passComp || !icComp) return 'below';

    const passNets = (passComp.pins || []).map(p => pinToNet[`${passiveRef}:${p.number}`]).filter(Boolean);
    const icPins = icComp.pins || [];

    for (const icPin of icPins) {
      const icNet = pinToNet[`${nearIcRef}:${icPin.number}`];
      if (!icNet || !passNets.includes(icNet)) continue;
      const fn = (icPin.function || '').toLowerCase();
      const cls = (icPin.classification || '').toLowerCase();
      if (fn.includes('fb') || fn.includes('feedback') || fn.includes('comp')) return 'right';
      if (fn.includes('sw') || fn.includes('switch')) return 'left';
      if (cls === 'power-in' || fn.includes('vin') || fn.includes('in')) return 'above';
      if (cls === 'power-out' || fn.includes('vout') || fn.includes('out')) return 'below';
      if (cls === 'ground') return 'below';
    }
    return 'below';
  }

  // ─── Find the primary IC a passive connects to ───
  function findNearIc(passiveRef, blockRefs, contract, classified, pinToNet) {
    const cat = classified[passiveRef];
    if (cat && cat.near && blockRefs.includes(cat.near)) return cat.near;

    const passComp = contract.components.find(c => c.designator === passiveRef);
    if (!passComp) return null;
    const passNets = (passComp.pins || []).map(p => pinToNet[`${passiveRef}:${p.number}`]).filter(Boolean);

    let bestRef = null;
    let bestScore = 0;
    for (const ref of blockRefs) {
      if (ref === passiveRef) continue;
      const icClass = classified[ref];
      if (!icClass || icClass.role === 'passive' || icClass.role === 'connector') continue;
      const icComp = contract.components.find(c => c.designator === ref);
      if (!icComp) continue;
      const icNets = (icComp.pins || []).map(p => pinToNet[`${ref}:${p.number}`]).filter(Boolean);
      const shared = passNets.filter(n => icNets.includes(n)).length;
      if (shared > bestScore) { bestScore = shared; bestRef = ref; }
    }
    return bestRef;
  }

  // ─── Core layout algorithm ───
  function buildLayout(contract, classified, netMaps) {
    const blocks = contract.blocks || [];
    const placed = {};
    const diagnostics = [];

    // Sort blocks by signal-flow priority
    const sortedBlocks = blocks.map((block, index) => ({
      block,
      originalIndex: index,
      flowType: inferBlockFlowType(block, classified),
      priority: FLOW_PRIORITY[inferBlockFlowType(block, classified)] ?? 5,
    })).sort((a, b) => a.priority - b.priority || a.originalIndex - b.originalIndex);

    let colX = 600;

    for (const { block, flowType } of sortedBlocks) {
      const blockRefs = (block.components || []).filter(ref => classified[ref]);
      const mainIcs = blockRefs.filter(ref => classified[ref].role === 'main-ic' || classified[ref].role === 'charger' || classified[ref].role === 'regulator');
      const connectors = blockRefs.filter(ref => classified[ref].role === 'connector');
      const passives = blockRefs.filter(ref => classified[ref].role === 'passive' || classified[ref].role === 'protection');

      // Place connectors at block left edge
      let connY = IC_Y_TOP;
      for (const ref of connectors) {
        placed[ref] = { x: colX, y: connY, rotation: 0 };
        connY += ROW_SPACING * 2;
      }

      const icX = connectors.length > 0 ? colX + CONNECTOR_OFFSET_LEFT : colX;

      // Place ICs in column, spaced by pin count
      let icY = IC_Y_TOP;
      for (const ref of mainIcs) {
        placed[ref] = { x: icX, y: icY, rotation: 0 };
        icY += classified[ref].pinCount * 12 + 250;
      }

      // Place passives relative to their connected IC
      const passiveSlots = { above: [], below: [], left: [], right: [] };
      for (const ref of passives) {
        const nearIc = findNearIc(ref, blockRefs, contract, classified, netMaps.pinToNet);
        const side = nearIc
          ? determinePassiveSide(ref, nearIc, contract, classified, netMaps.pinToNet)
          : 'below';
        passiveSlots[side].push({ ref, nearIc });
      }

      // Position passives by side
      const baseIcX = icX;
      const baseIcY = mainIcs.length > 0 ? placed[mainIcs[0]].y : IC_Y_TOP;

      // Above: offset upward from IC
      let aboveY = baseIcY - PASSIVE_OFFSET_BELOW - passiveSlots.above.length * ROW_SPACING;
      for (const { ref } of passiveSlots.above) {
        placed[ref] = { x: baseIcX, y: aboveY, rotation: 0 };
        aboveY += ROW_SPACING;
      }

      // Below: offset downward from IC
      let belowY = baseIcY + PASSIVE_OFFSET_BELOW + (mainIcs.length - 1) * 250;
      for (const { ref } of passiveSlots.below) {
        placed[ref] = { x: baseIcX, y: belowY, rotation: 0 };
        belowY += ROW_SPACING;
      }

      // Left: offset leftward from IC
      let leftX = baseIcX - 300;
      let leftY = baseIcY;
      for (const { ref } of passiveSlots.left) {
        placed[ref] = { x: leftX, y: leftY, rotation: 0 };
        leftY += ROW_SPACING;
      }

      // Right: offset rightward from IC
      let rightX = baseIcX + 300;
      let rightY = baseIcY;
      for (const { ref } of passiveSlots.right) {
        placed[ref] = { x: rightX, y: rightY, rotation: 0 };
        rightY += ROW_SPACING;
      }

      // Advance column
      const maxPinCount = Math.max(...blockRefs.map(ref => classified[ref]?.pinCount || 2));
      const blockWidth = Math.max(COL_SPACING, maxPinCount * 12 + 400);
      colX += blockWidth;
    }

    // Place unassigned output connectors
    const outputRefs = Object.keys(classified).filter(ref =>
      classified[ref].role === 'connector' && !placed[ref]
    );
    let outY = IC_Y_TOP;
    for (const ref of outputRefs) {
      placed[ref] = { x: colX + 200, y: outY, rotation: 0 };
      outY += ROW_SPACING * 2;
    }

    // Fallback for unplaced components
    let fallbackY = IC_Y_TOP + 3000;
    for (const ref of Object.keys(classified)) {
      if (!placed[ref]) {
        placed[ref] = { x: colX / 2, y: fallbackY, rotation: 0 };
        fallbackY += ROW_SPACING;
        diagnostics.push({
          severity: 'warning',
          code: 'UNPLACED_COMPONENT',
          message: `${ref} has no block assignment; placed at fallback position`,
        });
      }
    }

    return { placed, diagnostics, totalWidth: colX + 600, sortedBlockOrder: sortedBlocks.map(b => b.block.id) };
  }

  // ─── Build snapshot from layout ───
  function buildSnapshot(contract, classified, layout, catalog, netMaps) {
    const components = [];
    const netEndpoints = {};

    for (const comp of contract.components) {
      const ref = comp.designator;
      const pos = layout.placed[ref];
      if (!pos) continue;

      const cat = catalog[ref] || {};
      const pins = (comp.pins || []).map((pin, idx) => {
        const pinNum = pin.number || String(idx + 1);
        const net = netMaps.pinToNet[`${ref}:${pinNum}`] || null;
        if (net) {
          if (!netEndpoints[net]) netEndpoints[net] = [];
          netEndpoints[net].push({ component: ref, pin: pinNum });
        }
        return {
          number: pinNum,
          nativeId: `${ref}.${pinNum}`,
          noConnect: pin.classification === 'no-connect' || pin.classification === 'dnc',
          net,
        };
      });

      components.push({
        designator: ref,
        nativeId: `layout-${ref}`,
        sheetId: 'sheet-1',
        name: cat.mpn || comp.identity?.mpn || '',
        value: comp.identity?.value || '',
        manufacturer: comp.identity?.manufacturer || '',
        mpn: comp.identity?.mpn || '',
        footprint: comp.footprint?.name || null,
        includeInBom: comp.includeInBom !== false,
        includeInPcb: comp.includeInPcb !== false,
        position: { x: pos.x, y: pos.y },
        rotation: pos.rotation || 0,
        pins,
        bindings: comp.bindings || {},
      });
    }

    const nets = Object.entries(netEndpoints).map(([name, endpoints]) => ({
      name,
      nativeId: null,
      endpoints,
    }));

    return { components, nets };
  }

  function validateCatalog(contract, catalog) {
    const issues = [];
    const contractRefs = new Set(contract.components.map(c => c.designator));
    for (const ref of Object.keys(catalog)) {
      if (!contractRefs.has(ref)) {
        issues.push({ severity: 'warning', code: 'CATALOG_EXTRA', message: `Catalog entry ${ref} not in contract` });
      }
    }
    for (const ref of contractRefs) {
      if (!catalog[ref]) {
        issues.push({ severity: 'info', code: 'CATALOG_MISSING', message: `Contract component ${ref} not in catalog; using inferred role` });
      }
    }
    return issues;
  }

  // ─── Main ───
  const mode = request.mode ?? 'inspect';
  const contract = request.contract;
  const catalog = request.catalog || {};

  if (mode === 'inspect') {
    if (!contract) fail('INVALID_INPUT', 'inspect mode requires contract');
    const classified = classifyComponents(contract, catalog);
    const catalogIssues = validateCatalog(contract, catalog);
    const netMaps = buildNetMaps(contract);
    const blockTypes = (contract.blocks || []).map(b => ({
      id: b.id,
      flowType: inferBlockFlowType(b, classified),
      componentCount: (b.components || []).length,
    }));
    return {
      schemaVersion: 1,
      status: 'inspected',
      readOnly: true,
      blockCount: (contract.blocks || []).length,
      componentCount: contract.components.length,
      catalogCoverage: {
        total: contract.components.length,
        cataloged: Object.keys(catalog).length,
        inferred: contract.components.length - Object.keys(catalog).length,
      },
      blockFlowTypes: blockTypes,
      netCount: (contract.nets || []).length,
      powerDomainCount: (contract.powerDomains || []).length,
      diagnostics: catalogIssues,
    };
  }

  if (mode === 'generate') {
    if (!contract) fail('INVALID_INPUT', 'generate mode requires contract');
    const classified = classifyComponents(contract, catalog);
    const catalogIssues = validateCatalog(contract, catalog);
    const netMaps = buildNetMaps(contract);
    const layout = buildLayout(contract, classified, netMaps);
    const { components, nets } = buildSnapshot(contract, classified, layout, catalog, netMaps);

    const fingerprint = hashText(stableStringify({
      projectId: contract.project?.id,
      blocks: layout.sortedBlockOrder,
      positions: Object.entries(layout.placed).map(([ref, pos]) => `${ref}:${pos.x},${pos.y}`).sort(),
    }));

    const snapshot = {
      kind: 'flitrealize.schematic-snapshot',
      schemaVersion: 1,
      provider: 'layout-calculated',
      capturedAt: new Date().toISOString(),
      project: {
        id: contract.project?.id || 'unknown',
        nativeId: contract.project?.id || 'unknown',
        name: contract.project?.title || '',
      },
      document: {
        id: 'layout-doc',
        nativeId: 'layout-doc',
        type: 'schematic',
        revision: contract.project?.revision || '',
      },
      sheets: [{ id: 'sheet-1', nativeId: 'sheet-1', name: 'Sheet 1' }],
      components,
      nets,
      diagnostics: [...catalogIssues, ...layout.diagnostics],
      coverage: {
        queried: ['contract.blocks', 'contract.components', 'contract.nets', 'contract.powerDomains'],
        unsupported: [],
        unknown: [],
      },
      fingerprints: {
        document: fingerprint,
        connectivity: hashText(stableStringify(nets.map(n => `${n.name}:${n.endpoints.length}`))),
        components: hashText(stableStringify(components.map(c => `${c.designator}:${c.position.x},${c.position.y}`))),
        capabilities: 'layout-v2',
      },
      extensions: {
        layout: {
          totalWidth: layout.totalWidth,
          blockCount: (contract.blocks || []).length,
          sortedBlockOrder: layout.sortedBlockOrder,
          algorithm: 'block-flow-v2',
        },
      },
    };

    return {
      schemaVersion: 1,
      status: 'generated',
      readOnly: true,
      snapshot,
      placementCount: components.length,
      netCount: nets.length,
      totalWidth: layout.totalWidth,
      sortedBlockOrder: layout.sortedBlockOrder,
      diagnostics: snapshot.diagnostics,
      fingerprint,
    };
  }

  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
