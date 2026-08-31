return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;
  const DEFAULTS = {
    originX: 600,
    originY: 500,
    grid: 10,
    pinPitch: 50,
    clearance: 40,
    routingChannel: 100,
    blockGap: 180,
    clusterGap: 140,
    textMargin: 40,
  };

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

  function finitePositive(value, fallback, name) {
    if (value === undefined || value === null) return fallback;
    if (!Number.isFinite(value) || value <= 0 || value > 10000) fail('INVALID_LAYOUT_CONFIG', `${name} must be a finite number between 0 and 10000.`);
    return Number(value);
  }

  function layoutConfig(value = {}) {
    return {
      originX: Number.isFinite(value.originX) ? Number(value.originX) : DEFAULTS.originX,
      originY: Number.isFinite(value.originY) ? Number(value.originY) : DEFAULTS.originY,
      grid: finitePositive(value.grid, DEFAULTS.grid, 'layout.grid'),
      pinPitch: finitePositive(value.pinPitch, DEFAULTS.pinPitch, 'layout.pinPitch'),
      clearance: finitePositive(value.clearance, DEFAULTS.clearance, 'layout.clearance'),
      routingChannel: finitePositive(value.routingChannel, DEFAULTS.routingChannel, 'layout.routingChannel'),
      blockGap: finitePositive(value.blockGap, DEFAULTS.blockGap, 'layout.blockGap'),
      clusterGap: finitePositive(value.clusterGap, DEFAULTS.clusterGap, 'layout.clusterGap'),
      textMargin: finitePositive(value.textMargin, DEFAULTS.textMargin, 'layout.textMargin'),
      blockOrder: Array.isArray(value.blockOrder) ? value.blockOrder.map(String) : null,
    };
  }

  function snap(value, grid) {
    return Math.round(value / grid) * grid;
  }

  function pinsFromFootprint(name) {
    if (typeof name !== 'string' || !name.trim()) return null;
    const upper = name.toUpperCase();
    const pinWord = upper.match(/(?:^|[^0-9])(\d{1,3})\s*[- ]?PINS?(?:[^A-Z]|$)/);
    if (pinWord) return Number(pinWord[1]);
    const family = upper.match(/(?:W?QFN|DFN|WSON|BGA|TQFP|LQFP|TSSOP|SSOP|SOIC|MSOP|DIP)[-_ ]?(\d{1,3})(?:[^0-9]|$)/);
    if (family) return Number(family[1]);
    const sot = upper.match(/SOT[-_ ]?23[-_ ](\d{1,2})(?:[^0-9]|$)/);
    if (sot) return Number(sot[1]);
    return null;
  }

  function inferRole(component) {
    const designator = component.designator || '';
    const role = String(component.role || '').toLowerCase();
    if (/^J/.test(designator)) return 'connector';
    if (/^SW/.test(designator)) return 'switch';
    if (role.includes('charger')) return 'charger';
    if (role.includes('buck') || role.includes('boost') || role.includes('converter')) return 'converter';
    if (role.includes('regulator') || role.includes('ldo')) return 'regulator';
    if (role.includes('protect')) return /^U/.test(designator) ? 'protection-ic' : 'protection';
    if (/^[UI]/.test(designator)) return 'main-ic';
    return 'passive';
  }

  function bindingNamespace(provider) {
    if (provider === 'easyeda-pro') return 'easyedaPro';
    return provider.replace(/-([a-z0-9])/g, (_, character) => character.toUpperCase());
  }

  function normalizeSymbolPins(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result = {};
    for (const [pin, geometry] of Object.entries(value)) {
      if (!geometry || typeof geometry !== 'object') continue;
      const side = ['left', 'right', 'above', 'below', 'top', 'bottom'].includes(geometry.side)
        ? (geometry.side === 'top' ? 'above' : geometry.side === 'bottom' ? 'below' : geometry.side)
        : null;
      result[String(pin)] = {
        side,
        offset: Number.isFinite(geometry.offset) ? Number(geometry.offset) : null,
      };
    }
    return result;
  }

  function estimateGeometry(role, pinCount, config) {
    const count = Math.max(2, pinCount);
    if (role === 'connector') {
      return {
        width: Math.max(180, Math.min(480, Math.ceil(count / 2) * config.pinPitch * 0.7 + config.textMargin)),
        height: Math.max(180, Math.ceil(count / 2) * config.pinPitch + config.textMargin),
      };
    }
    if (role === 'passive' || role === 'protection') {
      return {
        width: Math.max(100, Math.min(220, count * config.pinPitch + config.textMargin)),
        height: Math.max(80, config.pinPitch + config.textMargin),
      };
    }
    if (role === 'switch') {
      return {
        width: Math.max(260, Math.ceil(count / 2) * config.pinPitch + config.textMargin),
        height: Math.max(260, Math.ceil(count / 2) * config.pinPitch + config.textMargin),
      };
    }
    return {
      width: Math.max(220, Math.ceil(count / 4) * config.pinPitch + config.textMargin * 2),
      height: Math.max(220, Math.ceil(count / 2) * config.pinPitch + config.textMargin * 2),
    };
  }

  function classifyComponents(contract, catalog, config) {
    const classified = {};
    for (const component of contract.components) {
      const designator = component.designator;
      const entry = catalog[designator] || {};
      const role = entry.role || inferRole(component);
      const footprintName = entry.footprint || component.footprint?.name || '';
      const catalogPinCount = Number.isInteger(entry.pinCount) && entry.pinCount > 0 ? entry.pinCount : null;
      const symbolPinCount = entry.symbol?.pins && typeof entry.symbol.pins === 'object'
        ? Object.keys(entry.symbol.pins).length
        : null;
      const pinCount = catalogPinCount
        || symbolPinCount
        || pinsFromFootprint(footprintName)
        || (Array.isArray(component.pins) ? component.pins.length : null)
        || 2;
      const explicitWidth = entry.symbol?.width ?? entry.symbolWidth;
      const explicitHeight = entry.symbol?.height ?? entry.symbolHeight;
      const estimated = estimateGeometry(role, pinCount, config);
      const symbolWidth = finitePositive(explicitWidth, estimated.width, `catalog.${designator}.symbol.width`);
      const symbolHeight = finitePositive(explicitHeight, estimated.height, `catalog.${designator}.symbol.height`);
      const rotation = Number.isFinite(entry.rotation) ? Number(entry.rotation) : 0;
      const normalizedRotation = ((rotation % 360) + 360) % 360;
      const quarterTurn = normalizedRotation === 90 || normalizedRotation === 270;
      const width = quarterTurn ? symbolHeight : symbolWidth;
      const height = quarterTurn ? symbolWidth : symbolHeight;
      const isConnector = role === 'connector';
      const isAnchor = !isConnector && (
        ['main-ic', 'charger', 'regulator', 'converter', 'controller', 'protection-ic', 'switch'].includes(role)
        || (pinCount > 4 && role !== 'passive' && role !== 'protection')
        || (/^SW/.test(designator) && pinCount > 4)
      );
      classified[designator] = {
        designator,
        role,
        pinCount,
        footprintName,
        width,
        height,
        geometrySource: Number.isFinite(explicitWidth) && Number.isFinite(explicitHeight) ? 'catalog-symbol' : 'conservative-estimate',
        symbolPins: normalizeSymbolPins(entry.symbol?.pins),
        near: typeof entry.near === 'string' ? entry.near : null,
        direction: ['left', 'right', 'above', 'below', 'top', 'bottom'].includes(entry.direction)
          ? (entry.direction === 'top' ? 'above' : entry.direction === 'bottom' ? 'below' : entry.direction)
          : null,
        rotation,
        isConnector,
        isAnchor,
        contract: component,
      };
    }
    return classified;
  }

  function buildNetMaps(contract) {
    const pinToNet = {};
    const componentToNets = {};
    for (const net of contract.nets || []) {
      for (const endpoint of net.endpoints || []) {
        const component = String(endpoint.component || '');
        const pin = String(endpoint.pin || '');
        pinToNet[`${component}:${pin}`] = net.name;
        if (!componentToNets[component]) componentToNets[component] = new Set();
        componentToNets[component].add(net.name);
      }
    }
    return { pinToNet, componentToNets };
  }

  function sharedNetCount(left, right, netMaps) {
    const leftNets = netMaps.componentToNets[left] || new Set();
    const rightNets = netMaps.componentToNets[right] || new Set();
    let count = 0;
    for (const net of leftNets) if (rightNets.has(net)) count += 1;
    return count;
  }

  function findNearTarget(reference, candidates, classified, netMaps) {
    const explicit = classified[reference]?.near;
    if (explicit && candidates.includes(explicit)) return explicit;
    let best = null;
    let score = 0;
    for (const candidate of candidates) {
      const current = sharedNetCount(reference, candidate, netMaps);
      if (current > score) {
        best = candidate;
        score = current;
      }
    }
    return best;
  }

  function determineSide(reference, target, classified, netMaps) {
    const component = classified[reference];
    if (component.direction) return component.direction;
    const targetPins = classified[target]?.contract?.pins || [];
    const referenceNets = netMaps.componentToNets[reference] || new Set();
    for (const pin of targetPins) {
      const net = netMaps.pinToNet[`${target}:${pin.number}`];
      if (!net || !referenceNets.has(net)) continue;
      const explicitPinSide = classified[target]?.symbolPins?.[String(pin.number)]?.side;
      if (explicitPinSide) return explicitPinSide;
      const fn = String(pin.function || '').toLowerCase();
      const pinClass = String(pin.classification || '').toLowerCase();
      if (fn.includes('fb') || fn.includes('feedback') || fn.includes('comp')) return 'right';
      if (fn.includes('sw') || fn.includes('switch')) return 'right';
      if (pinClass === 'power-in' || /(?:^|_)vin|input/.test(fn)) return 'left';
      if (pinClass === 'power-out' || /(?:^|_)vout|output/.test(fn)) return 'right';
      if (pinClass === 'ground') return 'below';
    }
    return 'below';
  }

  function rectFor(reference, center, classified) {
    const geometry = classified[reference];
    return {
      reference,
      minX: center.x - geometry.width / 2,
      maxX: center.x + geometry.width / 2,
      minY: center.y - geometry.height / 2,
      maxY: center.y + geometry.height / 2,
    };
  }

  function boundsOf(positions, classified, references = Object.keys(positions)) {
    const rectangles = references.filter((reference) => positions[reference]).map((reference) => rectFor(reference, positions[reference], classified));
    if (!rectangles.length) return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 };
    const minX = Math.min(...rectangles.map((rect) => rect.minX));
    const maxX = Math.max(...rectangles.map((rect) => rect.maxX));
    const minY = Math.min(...rectangles.map((rect) => rect.minY));
    const maxY = Math.max(...rectangles.map((rect) => rect.maxY));
    return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
  }

  function translatePositions(positions, dx, dy) {
    const translated = {};
    for (const [reference, position] of Object.entries(positions)) {
      translated[reference] = { ...position, x: position.x + dx, y: position.y + dy };
    }
    return translated;
  }

  function mergePositions(target, source) {
    for (const [reference, position] of Object.entries(source)) target[reference] = position;
  }

  function placeSide(targetReference, references, side, positions, classified, config) {
    if (!references.length) return;
    const target = positions[targetReference];
    const targetGeometry = classified[targetReference];
    const gap = config.clearance;
    if (side === 'above' || side === 'below') {
      const totalWidth = references.reduce((total, reference) => total + classified[reference].width, 0) + gap * Math.max(0, references.length - 1);
      const maxHeight = Math.max(...references.map((reference) => classified[reference].height));
      let x = target.x - totalWidth / 2;
      const y = target.y + (side === 'above' ? -1 : 1) * (targetGeometry.height / 2 + config.routingChannel + maxHeight / 2);
      for (const reference of references) {
        const geometry = classified[reference];
        positions[reference] = { x: x + geometry.width / 2, y, rotation: geometry.rotation, side, near: targetReference };
        x += geometry.width + gap;
      }
      return;
    }
    const totalHeight = references.reduce((total, reference) => total + classified[reference].height, 0) + gap * Math.max(0, references.length - 1);
    const maxWidth = Math.max(...references.map((reference) => classified[reference].width));
    const x = target.x + (side === 'left' ? -1 : 1) * (targetGeometry.width / 2 + config.routingChannel + maxWidth / 2);
    let y = target.y - totalHeight / 2;
    for (const reference of references) {
      const geometry = classified[reference];
      positions[reference] = { x, y: y + geometry.height / 2, rotation: geometry.rotation, side, near: targetReference };
      y += geometry.height + gap;
    }
  }

  function anchorCluster(anchor, attachments, classified, config) {
    const positions = {
      [anchor]: { x: 0, y: 0, rotation: classified[anchor].rotation, side: 'anchor', near: null },
    };
    const bySide = { left: [], right: [], above: [], below: [] };
    for (const attachment of attachments) bySide[attachment.side || 'below'].push(attachment.reference);
    for (const side of ['left', 'right', 'above', 'below']) {
      placeSide(anchor, bySide[side], side, positions, classified, config);
    }
    return { positions, bounds: boundsOf(positions, classified) };
  }

  function placeConnectors(connectors, coreBounds, positions, classified, config) {
    const bySide = { left: [], right: [], above: [], below: [] };
    for (const reference of connectors) bySide[classified[reference].direction || 'left'].push(reference);
    const coreCenterX = (coreBounds.minX + coreBounds.maxX) / 2;
    const coreCenterY = (coreBounds.minY + coreBounds.maxY) / 2;
    for (const side of ['left', 'right']) {
      const references = bySide[side];
      if (!references.length) continue;
      const totalHeight = references.reduce((total, reference) => total + classified[reference].height, 0) + config.clearance * Math.max(0, references.length - 1);
      const maxWidth = Math.max(...references.map((reference) => classified[reference].width));
      const x = side === 'left'
        ? coreBounds.minX - config.routingChannel - maxWidth / 2
        : coreBounds.maxX + config.routingChannel + maxWidth / 2;
      let y = coreCenterY - totalHeight / 2;
      for (const reference of references) {
        const geometry = classified[reference];
        positions[reference] = { x, y: y + geometry.height / 2, rotation: geometry.rotation, side, near: null };
        y += geometry.height + config.clearance;
      }
    }
    for (const side of ['above', 'below']) {
      const references = bySide[side];
      if (!references.length) continue;
      const totalWidth = references.reduce((total, reference) => total + classified[reference].width, 0) + config.clearance * Math.max(0, references.length - 1);
      const maxHeight = Math.max(...references.map((reference) => classified[reference].height));
      const y = side === 'above'
        ? coreBounds.minY - config.routingChannel - maxHeight / 2
        : coreBounds.maxY + config.routingChannel + maxHeight / 2;
      let x = coreCenterX - totalWidth / 2;
      for (const reference of references) {
        const geometry = classified[reference];
        positions[reference] = { x: x + geometry.width / 2, y, rotation: geometry.rotation, side, near: null };
        x += geometry.width + config.clearance;
      }
    }
  }

  function looseGrid(references, classified, config) {
    const positions = {};
    const columns = Math.max(1, Math.ceil(Math.sqrt(references.length)));
    const maxWidth = Math.max(0, ...references.map((reference) => classified[reference].width));
    const maxHeight = Math.max(0, ...references.map((reference) => classified[reference].height));
    references.forEach((reference, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      positions[reference] = {
        x: column * (maxWidth + config.routingChannel),
        y: row * (maxHeight + config.routingChannel),
        rotation: classified[reference].rotation,
        side: 'loose',
        near: null,
      };
    });
    return positions;
  }

  function buildBlockLayout(block, classified, netMaps, config) {
    const references = (block.components || []).filter((reference) => classified[reference]);
    const anchors = references.filter((reference) => classified[reference].isAnchor);
    const connectors = references.filter((reference) => classified[reference].isConnector);
    const dependents = references.filter((reference) => !classified[reference].isAnchor && !classified[reference].isConnector);
    const anchorAttachments = new Map(anchors.map((reference) => [reference, []]));
    const connectorAttachments = new Map(connectors.map((reference) => [reference, []]));
    const unassigned = [];
    const targets = [...anchors, ...connectors];
    for (const reference of dependents) {
      const target = findNearTarget(reference, targets, classified, netMaps);
      if (!target) {
        if (anchors.length) {
          anchorAttachments.get(anchors[0]).push({ reference, side: determineSide(reference, anchors[0], classified, netMaps) });
        } else {
          unassigned.push(reference);
        }
        continue;
      }
      const attachment = { reference, side: determineSide(reference, target, classified, netMaps) };
      if (anchorAttachments.has(target)) anchorAttachments.get(target).push(attachment);
      else connectorAttachments.get(target).push(attachment);
    }

    const positions = {};
    let cursorY = 0;
    for (const anchor of anchors) {
      const cluster = anchorCluster(anchor, anchorAttachments.get(anchor), classified, config);
      const translated = translatePositions(cluster.positions, -cluster.bounds.minX, cursorY - cluster.bounds.minY);
      mergePositions(positions, translated);
      const translatedBounds = boundsOf(translated, classified);
      cursorY = translatedBounds.maxY + config.clusterGap;
    }
    if (!anchors.length && unassigned.length) mergePositions(positions, looseGrid(unassigned, classified, config));
    else if (unassigned.length) {
      const loose = looseGrid(unassigned, classified, config);
      const looseBounds = boundsOf(loose, classified);
      const currentBounds = boundsOf(positions, classified);
      mergePositions(positions, translatePositions(loose, currentBounds.minX - looseBounds.minX, currentBounds.maxY + config.clusterGap - looseBounds.minY));
    }

    let coreBounds = boundsOf(positions, classified);
    if (!Object.keys(positions).length) coreBounds = { minX: 0, maxX: 200, minY: 0, maxY: 200, width: 200, height: 200 };
    placeConnectors(connectors, coreBounds, positions, classified, config);
    for (const [connector, attachments] of connectorAttachments) {
      const bySide = { left: [], right: [], above: [], below: [] };
      for (const attachment of attachments) bySide[attachment.side || 'below'].push(attachment.reference);
      for (const side of ['left', 'right', 'above', 'below']) {
        placeSide(connector, bySide[side], side, positions, classified, config);
      }
    }
    return { positions, bounds: boundsOf(positions, classified) };
  }

  function orderedBlocks(contract, config) {
    const blocks = contract.blocks || [];
    if (!config.blockOrder) return blocks;
    const byId = new Map(blocks.map((block) => [block.id, block]));
    const ordered = [];
    const seen = new Set();
    for (const id of config.blockOrder) {
      if (!byId.has(id)) fail('INVALID_BLOCK_ORDER', `layout.blockOrder references unknown block ${id}.`);
      if (seen.has(id)) fail('INVALID_BLOCK_ORDER', `layout.blockOrder repeats block ${id}.`);
      seen.add(id);
      ordered.push(byId.get(id));
    }
    for (const block of blocks) if (!seen.has(block.id)) ordered.push(block);
    return ordered;
  }

  function routingLanes(contract, blocks) {
    const blockIndex = {};
    blocks.forEach((block, index) => {
      for (const reference of block.components || []) blockIndex[reference] = index;
    });
    const lanes = Array(Math.max(0, blocks.length - 1)).fill(0);
    for (const net of contract.nets || []) {
      const indices = [...new Set((net.endpoints || []).map((endpoint) => blockIndex[endpoint.component]).filter(Number.isInteger))];
      if (indices.length < 2) continue;
      const minimum = Math.min(...indices);
      const maximum = Math.max(...indices);
      for (let boundary = minimum; boundary < maximum; boundary += 1) lanes[boundary] += 1;
    }
    return lanes;
  }

  function overlaps(positions, classified, clearance) {
    const references = Object.keys(positions);
    const issues = [];
    for (let leftIndex = 0; leftIndex < references.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < references.length; rightIndex += 1) {
        const left = rectFor(references[leftIndex], positions[references[leftIndex]], classified);
        const right = rectFor(references[rightIndex], positions[references[rightIndex]], classified);
        const separated = left.maxX + clearance <= right.minX
          || right.maxX + clearance <= left.minX
          || left.maxY + clearance <= right.minY
          || right.maxY + clearance <= left.minY;
        if (!separated) issues.push({ left: left.reference, right: right.reference });
      }
    }
    return issues;
  }

  function buildLayout(contract, classified, netMaps, config) {
    const blocks = orderedBlocks(contract, config);
    const lanes = routingLanes(contract, blocks);
    const positions = {};
    const blockEvidence = [];
    let cursorX = config.originX;
    let maximumX = cursorX;
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      const local = buildBlockLayout(block, classified, netMaps, config);
      const translated = translatePositions(
        local.positions,
        cursorX - local.bounds.minX,
        config.originY - local.bounds.minY,
      );
      for (const position of Object.values(translated)) {
        position.x = snap(position.x, config.grid);
        position.y = snap(position.y, config.grid);
      }
      mergePositions(positions, translated);
      const bounds = boundsOf(translated, classified);
      blockEvidence.push({
        id: block.id,
        order: index,
        bounds,
        componentCount: (block.components || []).length,
        routingLanesAfter: lanes[index] || 0,
      });
      maximumX = Math.max(maximumX, bounds.maxX);
      const boundaryLanes = Math.min(12, lanes[index] || 0);
      cursorX = bounds.maxX + config.blockGap + boundaryLanes * (config.clearance / 2);
    }

    const assigned = new Set(blocks.flatMap((block) => block.components || []));
    const unassigned = Object.keys(classified).filter((reference) => !assigned.has(reference));
    if (unassigned.length) {
      const loose = looseGrid(unassigned, classified, config);
      const looseBounds = boundsOf(loose, classified);
      const translated = translatePositions(loose, cursorX - looseBounds.minX, config.originY - looseBounds.minY);
      mergePositions(positions, translated);
      blockEvidence.push({ id: '__unassigned__', order: blockEvidence.length, bounds: boundsOf(translated, classified), componentCount: unassigned.length, routingLanesAfter: 0 });
      maximumX = Math.max(maximumX, boundsOf(translated, classified).maxX);
    }

    const collisionPairs = overlaps(positions, classified, config.clearance);
    const diagnostics = collisionPairs.slice(0, 50).map((pair) => ({
      severity: 'error',
      code: 'LAYOUT_OVERLAP',
      message: `${pair.left} and ${pair.right} violate the minimum layout clearance.`,
      designator: pair.left,
    }));
    if (collisionPairs.length > 50) diagnostics.push({
      severity: 'error',
      code: 'LAYOUT_OVERLAP_TRUNCATED',
      message: `${collisionPairs.length - 50} additional overlap pairs were omitted from diagnostics.`,
    });
    return {
      positions,
      diagnostics,
      blockEvidence,
      blockOrder: blocks.map((block) => block.id),
      routingLanes: lanes,
      totalWidth: maximumX - config.originX,
      bounds: boundsOf(positions, classified),
    };
  }

  function validateCatalog(contract, catalog, classified) {
    const diagnostics = [];
    const references = new Set(contract.components.map((component) => component.designator));
    for (const reference of Object.keys(catalog)) {
      if (!references.has(reference)) diagnostics.push({ severity: 'warning', code: 'CATALOG_EXTRA', message: `Catalog entry ${reference} is not in the Contract.`, designator: reference });
    }
    for (const reference of references) {
      if (!catalog[reference]) diagnostics.push({ severity: 'info', code: 'CATALOG_MISSING', message: `${reference} uses conservative inferred symbol geometry.`, designator: reference });
      else if (classified[reference].geometrySource !== 'catalog-symbol') diagnostics.push({ severity: 'warning', code: 'SYMBOL_GEOMETRY_ESTIMATED', message: `${reference} has no explicit symbol width and height; conservative geometry was used.`, designator: reference });
    }
    return diagnostics;
  }

  function placementComponents(contract, layout, classified, provider, namespace, providerBindings) {
    const components = [];
    const diagnostics = [];
    for (const component of contract.components) {
      const reference = component.designator;
      const position = layout.positions[reference];
      if (!position) {
        diagnostics.push({ severity: 'error', code: 'COMPONENT_NOT_PLACED', message: `${reference} has no generated position.`, designator: reference });
        continue;
      }
      const binding = providerBindings[reference] || component.bindings?.[namespace];
      if (!binding?.libraryUuid || !binding?.deviceUuid) {
        diagnostics.push({
          severity: 'error',
          code: 'PROVIDER_BINDING_MISSING',
          message: `${reference} needs bindings.${namespace}.libraryUuid and deviceUuid before placement.`,
          designator: reference,
        });
      }
      components.push({
        designator: reference,
        position: { x: position.x, y: position.y },
        rotation: position.rotation || 0,
        mirror: false,
        includeInBom: component.includeInBom !== false,
        includeInPcb: component.includeInPcb !== false,
        subPartName: null,
        bindings: {
          ...(component.bindings || {}),
          ...(binding ? { [namespace]: binding } : {}),
        },
        extensions: {
          layout: {
            provider,
            blockId: (contract.blocks || []).find((block) => (block.components || []).includes(reference))?.id || null,
            near: position.near || null,
            side: position.side || null,
            width: classified[reference].width,
            height: classified[reference].height,
            geometrySource: classified[reference].geometrySource,
          },
        },
      });
    }
    return { components, diagnostics };
  }

  const mode = request.mode ?? 'inspect';
  const contract = request.contract;
  if (!contract || contract.kind !== 'flitrealize.schematic-contract' || contract.schemaVersion !== 1) {
    fail('INVALID_INPUT', 'contract must be a SchematicContract v1.');
  }
  const catalog = request.catalog || {};
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) fail('INVALID_INPUT', 'catalog must be an object keyed by designator.');
  const config = layoutConfig(request.layout || {});
  const provider = request.targetProvider || 'easyeda-pro';
  const namespace = request.bindingNamespace || bindingNamespace(provider);
  const providerBindings = request.providerBindings || {};
  if (!providerBindings || typeof providerBindings !== 'object' || Array.isArray(providerBindings)) {
    fail('INVALID_INPUT', 'providerBindings must be an object keyed by designator.');
  }
  const contractDesignators = new Set(contract.components.map((component) => component.designator));
  const bindingInputDiagnostics = Object.keys(providerBindings)
    .filter((designator) => !contractDesignators.has(designator))
    .map((designator) => ({
      severity: 'error',
      code: 'PROVIDER_BINDING_COMPONENT_UNKNOWN',
      message: `${designator} has a Provider binding but is absent from the Contract.`,
      designator,
    }));
  const classified = classifyComponents(contract, catalog, config);
  const netMaps = buildNetMaps(contract);
  const layout = buildLayout(contract, classified, netMaps, config);
  const catalogDiagnostics = validateCatalog(contract, catalog, classified);

  if (mode === 'inspect') {
    const diagnostics = [...catalogDiagnostics, ...bindingInputDiagnostics, ...layout.diagnostics];
    return {
      schemaVersion: 2,
      status: diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 'inspected-with-blockers' : 'inspected',
      readOnly: true,
      blockCount: (contract.blocks || []).length,
      componentCount: contract.components.length,
      netCount: (contract.nets || []).length,
      targetProvider: provider,
      blockOrder: layout.blockOrder,
      blockEvidence: layout.blockEvidence,
      routingLanes: layout.routingLanes,
      bounds: layout.bounds,
      catalogCoverage: {
        total: contract.components.length,
        cataloged: contract.components.filter((component) => Boolean(catalog[component.designator])).length,
        explicitGeometry: contract.components.filter((component) => classified[component.designator].geometrySource === 'catalog-symbol').length,
      },
      diagnostics,
    };
  }

  if (mode === 'generate') {
    const contractFingerprint = hashText(stableStringify(contract));
    const layoutEvidence = {
      algorithm: 'cluster-bbox-v3',
      config,
      targetProvider: provider,
      blockOrder: layout.blockOrder,
      blockEvidence: layout.blockEvidence,
      routingLanes: layout.routingLanes,
      positions: Object.entries(layout.positions).map(([designator, position]) => ({
        designator,
        x: position.x,
        y: position.y,
        rotation: position.rotation || 0,
        near: position.near || null,
        side: position.side || null,
        width: classified[designator].width,
        height: classified[designator].height,
        geometrySource: classified[designator].geometrySource,
      })).sort((left, right) => left.designator.localeCompare(right.designator)),
    };
    const layoutFingerprint = hashText(stableStringify(layoutEvidence));
    const built = placementComponents(contract, layout, classified, provider, namespace, providerBindings);
    const diagnostics = [...catalogDiagnostics, ...bindingInputDiagnostics, ...layout.diagnostics, ...built.diagnostics];
    const bindingEvidence = built.components.map((component) => ({
      designator: component.designator,
      binding: component.bindings?.[namespace] || null,
    })).sort((left, right) => left.designator.localeCompare(right.designator));
    const bindingFingerprint = hashText(stableStringify(bindingEvidence));
    if (request.bindingFingerprint && request.bindingFingerprint !== bindingFingerprint) {
      diagnostics.push({
        severity: 'error',
        code: 'BINDING_FINGERPRINT_MISMATCH',
        message: 'Resolved Provider bindings changed before layout generation.',
      });
    }
    const planPayload = {
      targetProvider: provider,
      projectId: contract.project?.id || 'unknown',
      contractFingerprint,
      bindingFingerprint,
      components: built.components,
      layoutFingerprint,
    };
    const planFingerprint = hashText(stableStringify(planPayload));
    const placementPlan = {
      kind: 'flitrealize.schematic-placement-plan',
      schemaVersion: 1,
      targetProvider: provider,
      generatedAt: new Date().toISOString(),
      project: {
        id: contract.project?.id || 'unknown',
        name: contract.project?.title || '',
        revision: contract.project?.revision || '',
      },
      source: {
        contractFingerprint,
        contractRevision: contract.project?.revision || '',
      },
      components: built.components,
      diagnostics,
      fingerprints: {
        contract: contractFingerprint,
        bindings: bindingFingerprint,
        layout: layoutFingerprint,
        plan: planFingerprint,
      },
      extensions: {
        layout: {
          algorithm: 'cluster-bbox-v3',
          config,
          bounds: layout.bounds,
          totalWidth: layout.totalWidth,
          blockOrder: layout.blockOrder,
          blockEvidence: layout.blockEvidence,
          routingLanes: layout.routingLanes,
        },
      },
    };
    return {
      schemaVersion: 2,
      status: diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 'generated-with-blockers' : 'generated',
      readOnly: true,
      placementPlan,
      placementCount: built.components.length,
      netCount: (contract.nets || []).length,
      totalWidth: layout.totalWidth,
      sortedBlockOrder: layout.blockOrder,
      diagnostics,
      contractFingerprint,
      bindingFingerprint,
      layoutFingerprint,
      planFingerprint,
    };
  }

  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
