// Actual-geometry layout, adapted from the verified two-pass schematic experiment.
// Standalone EDA Action; no project IDs, device bindings or network table embedded.
return await (async () => {
  const input=typeof flitrealizeInput==='undefined'?{}:flitrealizeInput;
  const mode=input.mode || 'plan', phase=input.phase || 'complete';
  if(!['plan','apply','verify'].includes(mode))throw new Error('Unsupported reflow mode');
  if(!['initial','complete'].includes(phase))throw new Error('Unsupported reflow phase');
  if(!input.expectedProjectUuid||!input.expectedDocumentUuid)throw new Error('Project and document identities required');
  const project=await eda.dmt_Project.getCurrentProjectInfo();
  const document=await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if(project?.uuid!==input.expectedProjectUuid||document?.uuid!==input.expectedDocumentUuid||document?.documentType!==1)throw new Error('Unexpected schematic target');
  const options=input.layout || {};
  if(!['easyeda-schematic','mil'].includes(options.unit))throw new Error('layout.unit must be easyeda-schematic or mil');
  const scale=options.unit==='mil'?0.1:1;
  const dimension=(key,fallback,signed=false)=>{
    const n=options[key]===undefined?fallback:options[key];
    if(typeof n!=='number'||!Number.isFinite(n)||(!signed&&n<0))throw new Error('Invalid layout.'+key);
    return n*scale;
  };
  const CONFIG={originX:dimension('originX',0,true),originY:dimension('originY',0,true),
    componentSpacing:dimension('componentSpacing',options.unit==='mil'?720:72),
    blockSpacing:dimension('blockSpacing',options.unit==='mil'?2100:210),
    attachmentSpacing:dimension('attachmentSpacing',options.unit==='mil'?1400:140),epsilon:0.001};
  if(!Array.isArray(input.blocks)||!input.blocks.length)throw new Error('Nonempty blocks required');
  const BLOCK_DEFINITIONS=input.blocks.map(b=>{
    if(typeof b.name!=='string'||!b.name||!Array.isArray(b.members)||!b.members.length||b.members.some(m=>typeof m!=='string'||!m)||!Number.isInteger(b.columns)||b.columns<1||b.columns>256)throw new Error('Invalid block');
    return {name:b.name,members:b.members,columns:b.columns};
  });
  const names=BLOCK_DEFINITIONS.map(b=>b.name);
  if(new Set(names).size!==names.length)throw new Error('Duplicate block names');
  const mainFlow=options.mainFlow || names;
  const attachments=options.attachments || [];
  if(!Array.isArray(mainFlow)||!mainFlow.length||!Array.isArray(attachments))throw new Error('Invalid mainFlow/attachments');
  const configured=[...mainFlow,...attachments.map(a=>a.block)];
  if(configured.length!==names.length||new Set(configured).size!==configured.length||configured.some(n=>!names.includes(n)))throw new Error('Every block must occur once in mainFlow or attachments');
  for(const a of attachments)if(!Array.isArray(a.targets)||!a.targets.length||a.targets.some(t=>!mainFlow.includes(t))||!['top','bottom','left','right'].includes(a.preferredSide))throw new Error('Attachments must target main-flow blocks and have a preferredSide');
  // API Y points upward (source Y is negated); translate screen directions into engine Y.
  const FUNCTION_LAYOUT={mainFlow,attachments:attachments.map(a=>({...a,preferredSide:a.preferredSide==='top'?'bottom':a.preferredSide==='bottom'?'top':a.preferredSide}))};
  const TEXT={bodyMargin:6,wireMargin:1.5,flagMargin:2,textGap:1.5,componentTextMargin:6,
    designatorFontSize:10,nameFontSize:8,netFontSize:8};
  for(const [key,value] of Object.entries(input.text || {})) {
    if(!Object.hasOwn(TEXT,key)||typeof value!=='number'||!Number.isFinite(value)||value<=0)throw new Error('Invalid text option '+key);
    TEXT[key]=value;
  }
  const originalSource=await eda.sys_FileManager.getDocumentSource();
  const allComponents=await eda.sch_PrimitiveComponent.getAll();
  const wires=await eda.sch_PrimitiveWire.getAll();
  // Read geometry once. Missing coordinates are errors, never coerced to zero.
  const pinsById=new Map();
  for(const c of allComponents) {
    const id=c.getState_PrimitiveId();
    const pins=c.getState_Designator()?await c.getAllPins():[];
    if([c,...pins].some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))throw new Error('Invalid component/pin geometry: '+id);
    pinsById.set(id,pins);
  }
  const designators=allComponents.map(c=>c.getState_Designator()).filter(Boolean);
  if(new Set(designators).size!==designators.length)throw new Error('Duplicate designators');
  const members=BLOCK_DEFINITIONS.flatMap(b=>b.members);
  if(new Set(members).size!==members.length||members.length!==designators.length||members.some(d=>!designators.includes(d)))throw new Error('Blocks must own each current component exactly once');
  const flags=allComponents.filter(c=>['netflag','netport'].includes(c.getState_ComponentType()));
  if(phase==='initial'&&(wires.length||flags.length))throw new Error('Initial pass requires an unconnected sheet; use complete to preserve connections');
  if(allComponents.some(c=>!c.getState_Designator()&&!['netflag','netport'].includes(c.getState_ComponentType())))throw new Error('Unsupported component/marker without a layout owner');
  const canonical=source=>source.split(/\r?\n/).filter(l=>l&&!l.includes('"type":"DOCHEAD"')).join('\n');
  const hash=text=>{
    let n=0x811c9dc5;
    for(let i=0;i<text.length;i++){n^=text.charCodeAt(i);n=Math.imul(n,0x01000193)>>>0;}
    return 'fnv1a32-'+n.toString(16).padStart(8,'0');
  };
  const sourceFingerprint=hash(canonical(originalSource));

// Shared source codec: preserve each record's delimiter, including the final one.
function parseRecord(line) {
  const split=line.indexOf('||');
  if(split<0) {
    if(line.trim())throw new Error('Invalid source record: missing separator');
    return null;
  }
  try {return {head:JSON.parse(line.slice(0,split)),payload:JSON.parse(line.slice(split+2).replace(/\|$/,''))};}
  catch(error) {throw new Error('Invalid source record: '+error.message);}
}
function serializeRecord(record,originalLine) {
  return JSON.stringify(record.head)+'||'+JSON.stringify(record.payload)+(originalLine.endsWith('|')?'|':'');
}
function stubSegments(line) {
  if(!Array.isArray(line))throw new Error('Expected straight pin stub');
  if(line.some(Array.isArray))return line.flatMap(stubSegments);
  if(line.length!==4||line.some(v=>!Number.isFinite(v)))throw new Error('Invalid wire geometry');
  const [x1,y1,x2,y2]=line;
  if((x1===x2)===(y1===y2))throw new Error('Expected nonzero horizontal or vertical pin stub');
  return [line];
}

function clean(value) {
  return Math.round(Number(value) * 1000000) / 1000000;
}

function makeRect(minX, maxX, minY, maxY) {
  minX = clean(minX);
  maxX = clean(maxX);
  minY = clean(minY);
  maxY = clean(maxY);
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: clean(maxX - minX),
    height: clean(maxY - minY),
    centerX: clean((minX + maxX) / 2),
    centerY: clean((minY + maxY) / 2),
    halfWidth: clean((maxX - minX) / 2),
    halfHeight: clean((maxY - minY) / 2),
  };
}

function rectAt(minX, minY, width, height) {
  return makeRect(minX, minX + width, minY, minY + height);
}

function unionRects(rects) {
  if (!rects.length) throw new Error("Cannot union an empty rectangle list");
  return makeRect(
    Math.min.apply(null, rects.map(function (rect) { return rect.minX; })),
    Math.max.apply(null, rects.map(function (rect) { return rect.maxX; })),
    Math.min.apply(null, rects.map(function (rect) { return rect.minY; })),
    Math.max.apply(null, rects.map(function (rect) { return rect.maxY; }))
  );
}

function naturalDesignatorCompare(a, b) {
  const matchA = String(a).match(/^([^0-9]*)([0-9]+)?(.*)$/);
  const matchB = String(b).match(/^([^0-9]*)([0-9]+)?(.*)$/);
  const prefixOrder = matchA[1].localeCompare(matchB[1]);
  if (prefixOrder !== 0) return prefixOrder;
  const numberA = matchA[2] === undefined ? Number.MAX_SAFE_INTEGER : Number(matchA[2]);
  const numberB = matchB[2] === undefined ? Number.MAX_SAFE_INTEGER : Number(matchB[2]);
  if (numberA !== numberB) return numberA - numberB;
  return matchA[3].localeCompare(matchB[3]);
}

function packGrid(items, columns, spacing) {
  if (!items.length) throw new Error("Cannot lay out an empty item list");
  if (columns < 1) throw new Error("Grid column count must be positive");

  const rowCount = Math.ceil(items.length / columns);
  const columnWidths = new Array(columns).fill(0);
  const rowHeights = new Array(rowCount).fill(0);

  items.forEach(function (item, index) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    columnWidths[column] = Math.max(columnWidths[column], item.width);
    rowHeights[row] = Math.max(rowHeights[row], item.height);
  });

  const columnStarts = [];
  const rowStarts = [];
  let cursor = 0;
  columnWidths.forEach(function (width, index) {
    columnStarts[index] = cursor;
    cursor += width + spacing;
  });
  cursor = 0;
  rowHeights.forEach(function (height, index) {
    rowStarts[index] = cursor;
    cursor += height + spacing;
  });

  const placements = items.map(function (item, index) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const minX = columnStarts[column] + (columnWidths[column] - item.width) / 2;
    const minY = rowStarts[row] + (rowHeights[row] - item.height) / 2;
    return {
      id: item.id,
      row,
      column,
      rect: rectAt(minX, minY, item.width, item.height),
    };
  });

  return {
    placements,
    bounds: unionRects(placements.map(function (placement) { return placement.rect; })),
    columnWidths: columnWidths.map(clean),
    rowHeights: rowHeights.map(clean),
  };
}

function getClearanceStatus(a, b, spacing, epsilon = CONFIG.epsilon) {
  const centerDistanceX = Math.abs(a.centerX - b.centerX);
  const centerDistanceY = Math.abs(a.centerY - b.centerY);
  const requiredDistanceX = a.halfWidth + b.halfWidth + spacing;
  const requiredDistanceY = a.halfHeight + b.halfHeight + spacing;
  const separatedX = centerDistanceX + epsilon >= requiredDistanceX;
  const separatedY = centerDistanceY + epsilon >= requiredDistanceY;
  return {
    valid: separatedX || separatedY,
    separatedX,
    separatedY,
    edgeGapX: clean(centerDistanceX - a.halfWidth - b.halfWidth),
    edgeGapY: clean(centerDistanceY - a.halfHeight - b.halfHeight),
  };
}

function findClearanceViolations(items, spacing) {
  const violations = [];
  for (let first = 0; first < items.length; first += 1) {
    for (let second = first + 1; second < items.length; second += 1) {
      const status = getClearanceStatus(items[first].rect, items[second].rect, spacing);
      if (!status.valid) {
        violations.push({
          first: items[first].id,
          second: items[second].id,
          edgeGapX: status.edgeGapX,
          edgeGapY: status.edgeGapY,
        });
      }
    }
  }
  return violations;
}

function getFunctionBlockSpacing(firstId, secondId) {
  const firstIsMain = FUNCTION_LAYOUT.mainFlow.indexOf(firstId) >= 0;
  const secondIsMain = FUNCTION_LAYOUT.mainFlow.indexOf(secondId) >= 0;
  return firstIsMain && secondIsMain ? CONFIG.blockSpacing : CONFIG.attachmentSpacing;
}

function findFunctionBlockViolations(items) {
  const violations = [];
  for (let first = 0; first < items.length; first += 1) {
    for (let second = first + 1; second < items.length; second += 1) {
      const spacing = getFunctionBlockSpacing(items[first].id, items[second].id);
      const status = getClearanceStatus(items[first].rect, items[second].rect, spacing);
      if (!status.valid) {
        violations.push({
          first: items[first].id,
          second: items[second].id,
          requiredSpacing: spacing,
          edgeGapX: status.edgeGapX,
          edgeGapY: status.edgeGapY,
        });
      }
    }
  }
  return violations;
}

function isValidAgainstPlaced(candidate, placed, spacing) {
  return placed.every(function (item) {
    return getClearanceStatus(candidate, item.rect, spacing).valid;
  });
}

function calculateAttachmentBaseRect(attachment, block, targetRects) {
  const targetBounds = unionRects(targetRects);
  const averageCenterX = targetRects.reduce(function (sum, rect) { return sum + rect.centerX; }, 0) / targetRects.length;
  const averageCenterY = targetRects.reduce(function (sum, rect) { return sum + rect.centerY; }, 0) / targetRects.length;
  let minX = averageCenterX - block.width / 2;
  let minY = averageCenterY - block.height / 2;

  if (attachment.preferredSide === "bottom") minY = targetBounds.maxY + CONFIG.attachmentSpacing;
  else if (attachment.preferredSide === "top") minY = targetBounds.minY - CONFIG.attachmentSpacing - block.height;
  else if (attachment.preferredSide === "right") minX = targetBounds.maxX + CONFIG.attachmentSpacing;
  else if (attachment.preferredSide === "left") minX = targetBounds.minX - CONFIG.attachmentSpacing - block.width;
  else throw new Error("Unsupported attachment side " + attachment.preferredSide);

  return rectAt(minX, minY, block.width, block.height);
}

function placeAttachment(attachment, block, targetRects, placed) {
  const baseRect = calculateAttachmentBaseRect(attachment, block, targetRects);
  const xCandidates = [baseRect.minX];
  const yCandidates = [baseRect.minY];

  placed.forEach(function (item) {
    xCandidates.push(item.rect.minX - CONFIG.attachmentSpacing - block.width);
    xCandidates.push(item.rect.maxX + CONFIG.attachmentSpacing);
    yCandidates.push(item.rect.minY - CONFIG.attachmentSpacing - block.height);
    yCandidates.push(item.rect.maxY + CONFIG.attachmentSpacing);
  });

  const targetBounds = unionRects(targetRects);
  const candidates = [];
  xCandidates.forEach(function (minX) {
    yCandidates.forEach(function (minY) {
      const rect = rectAt(minX, minY, block.width, block.height);
      const respectsPreferredSide = attachment.preferredSide === "bottom"
        ? rect.minY + CONFIG.epsilon >= targetBounds.maxY + CONFIG.attachmentSpacing
        : attachment.preferredSide === "top"
          ? rect.maxY <= targetBounds.minY - CONFIG.attachmentSpacing + CONFIG.epsilon
          : attachment.preferredSide === "right"
            ? rect.minX + CONFIG.epsilon >= targetBounds.maxX + CONFIG.attachmentSpacing
            : rect.maxX <= targetBounds.minX - CONFIG.attachmentSpacing + CONFIG.epsilon;
      if (!respectsPreferredSide || !isValidAgainstPlaced(rect, placed, CONFIG.attachmentSpacing)) return;

      candidates.push({
        rect,
        score: Math.abs(rect.minX - baseRect.minX) + Math.abs(rect.minY - baseRect.minY),
      });
    });
  });

  if (!candidates.length) throw new Error("No valid position found for attachment block " + attachment.block);
  candidates.sort(function (a, b) { return a.score - b.score; });
  return candidates[0].rect;
}

function layoutFunctionBlocks(blockLayouts) {
  const blocksById = Object.create(null);
  blockLayouts.forEach(function (block) { blocksById[block.id] = block; });
  const configuredNames = FUNCTION_LAYOUT.mainFlow.concat(FUNCTION_LAYOUT.attachments.map(function (item) { return item.block; }));
  const missingNames = blockLayouts.map(function (block) { return block.id; }).filter(function (name) {
    return configuredNames.indexOf(name) < 0;
  });
  const unknownNames = configuredNames.filter(function (name) { return !blocksById[name]; });
  if (missingNames.length || unknownNames.length) {
    throw new Error("Function layout mismatch; missing=" + missingNames.join(",") + "; unknown=" + unknownNames.join(","));
  }

  const mainBlocks = FUNCTION_LAYOUT.mainFlow.map(function (name) { return blocksById[name]; });
  const mainRowHeight = Math.max.apply(null, mainBlocks.map(function (block) { return block.height; }));
  const placed = [];
  const placementMap = Object.create(null);
  let cursorX = CONFIG.originX;

  mainBlocks.forEach(function (block) {
    const minY = CONFIG.originY + (mainRowHeight - block.height) / 2;
    const rect = rectAt(cursorX, minY, block.width, block.height);
    const placement = { id: block.id, rect };
    placed.push(placement);
    placementMap[block.id] = placement;
    cursorX = rect.maxX + CONFIG.blockSpacing;
  });

  const attachments = FUNCTION_LAYOUT.attachments.slice().sort(function (a, b) {
    return a.targets.length - b.targets.length;
  });
  attachments.forEach(function (attachment) {
    const block = blocksById[attachment.block];
    const targetRects = attachment.targets.map(function (target) {
      if (!placementMap[target]) throw new Error("Attachment target " + target + " has not been placed");
      return placementMap[target].rect;
    });
    const rect = placeAttachment(attachment, block, targetRects, placed);
    const placement = { id: block.id, rect };
    placed.push(placement);
    placementMap[block.id] = placement;
  });

  return { placements: placed, placementMap };
}

function calculateLayout(geometry) {
  const blockLayouts = BLOCK_DEFINITIONS.map(function (definition) {
    const sortedMembers = definition.members.slice().sort(naturalDesignatorCompare);
    const items = sortedMembers.map(function (designator) {
      const localRect = geometry[designator].localRect;
      return { id: designator, width: localRect.width, height: localRect.height };
    });
    const grid = packGrid(items, definition.columns, CONFIG.componentSpacing);
    return {
      id: definition.name,
      definition,
      sortedMembers,
      localPlacements: grid.placements,
      width: grid.bounds.width,
      height: grid.bounds.height,
      localViolations: findClearanceViolations(grid.placements, CONFIG.componentSpacing),
    };
  });

  const functionLayout = layoutFunctionBlocks(blockLayouts);
  const blockPlacementMap = functionLayout.placementMap;

  const plannedComponents = [];
  const plannedBlocks = [];
  blockLayouts.forEach(function (block) {
    const blockPlacement = blockPlacementMap[block.id];
    const blockMinX = blockPlacement.rect.minX;
    const blockMinY = blockPlacement.rect.minY;
    const componentRects = [];

    block.localPlacements.forEach(function (localPlacement) {
      const componentGeometry = geometry[localPlacement.id];
      const targetRect = rectAt(
        blockMinX + localPlacement.rect.minX,
        blockMinY + localPlacement.rect.minY,
        localPlacement.rect.width,
        localPlacement.rect.height
      );
      componentRects.push(targetRect);
      plannedComponents.push({
        id: localPlacement.id,
        block: block.id,
        rect: targetRect,
        targetComponentX: clean(targetRect.minX - componentGeometry.localRect.minX),
        targetComponentY: clean(targetRect.minY - componentGeometry.localRect.minY),
      });
    });

    plannedBlocks.push({ id: block.id, rect: unionRects(componentRects) });
  });

  return {
    blockLayouts,
    plannedBlocks,
    plannedComponents,
    componentViolations: findClearanceViolations(plannedComponents, CONFIG.componentSpacing),
    blockViolations: findFunctionBlockViolations(plannedBlocks),
  };
}


/** One geometry model serves text placement and both layout passes.
 * All rectangles use API coordinates (Y upward); only the source codec negates Y.
 * Body bounds remain a pin/anchor estimate. Flag and stroke padding are explicit,
 * not symbol-specific special cases.
 */
function expandRect(rect, margin) {
  return makeRect(rect.minX-margin,rect.maxX+margin,rect.minY-margin,rect.maxY+margin);
}
function centerRect(x,y,width,height) {
  return makeRect(x-width/2,x+width/2,y-height/2,y+height/2);
}
function samePoint(a,b) {
  return Math.abs(a.x-b.x)<0.02 && Math.abs(a.y-b.y)<0.02;
}
function textSize(value,fontSize,rotation=0) {
  let units=0;
  for(const char of String(value ?? ''))units+=char.charCodeAt(0)>127?1:0.62;
  const width=Math.max(fontSize,units*fontSize+2);
  return rotation===90?{width:fontSize,height:width}:{width,height:fontSize};
}
function displayValue(record,siblings) {
  const value=String(record.payload.value ?? '');
  const expression=value.match(/^=\{(.+)\}$/);
  return expression?String(siblings.find(r=>r.payload.key===expression[1])?.payload.value ?? expression[1]):value;
}
function clearOf(rect,obstacles) {
  return obstacles.every(other=>getClearanceStatus(rect,other,TEXT.textGap,0).valid);
}
function componentCandidates(body, groupWidth, groupHeight) {
  const candidates = [];
  const extras = [0, 10, 20, 30, 40, 60, 80, 120, 160];
  for (const extra of extras) {
    const topY = body.minY - TEXT.componentTextMargin - extra - groupHeight / 2;
    const bottomY = body.maxY + TEXT.componentTextMargin + extra + groupHeight / 2;
    const leftX = body.minX - TEXT.componentTextMargin - extra - groupWidth / 2;
    const rightX = body.maxX + TEXT.componentTextMargin + extra + groupWidth / 2;
    const centerX = (body.minX + body.maxX) / 2;
    const centerY = (body.minY + body.maxY) / 2;
    candidates.push(
      { x: centerX, y: topY, score: extra },
      { x: centerX, y: bottomY, score: extra + 1 },
      { x: leftX, y: centerY, score: extra + 3 },
      { x: rightX, y: centerY, score: extra + 4 },
      { x: body.minX + groupWidth / 2, y: topY, score: extra + 5 },
      { x: body.maxX - groupWidth / 2, y: topY, score: extra + 6 },
      { x: body.minX + groupWidth / 2, y: bottomY, score: extra + 7 },
      { x: body.maxX - groupWidth / 2, y: bottomY, score: extra + 8 },
    );
  }
  return candidates.sort((a, b) => a.score - b.score);
}

function netCandidates(flagPoint, outward, width, height) {
  const perpendicular = { x: -outward.y, y: outward.x };
  const extras = [0, 10, 20, 30, 40, 60, 80, 120, 160, 220, 300];
  const lanes = [0, -10, 10, -20, 20, -30, 30, -40, 40, -60, 60, -80, 80];
  const extent = outward.x ? width / 2 : height / 2;
  const candidates = [];
  for (const extra of extras) {
    for (const lane of lanes) {
      const distance = extent + 4 + extra;
      candidates.push({
        x: clean(flagPoint.x + outward.x * distance + perpendicular.x * lane),
        y: clean(flagPoint.y + outward.y * distance + perpendicular.y * lane),
        score: extra + Math.abs(lane) * 1.25,
      });
    }
  }
  return candidates.sort((a, b) => a.score - b.score);
}


function readRecords(source) {
  const lines=source.split(/\r?\n/);
  const records=lines.map((line,index)=>{
    const record=parseRecord(line);
    return record?{...record,index}:null;
  }).filter(Boolean);
  const attrsByParent=new Map();
  const recordsById=new Map();
  for(const record of records) {
    if(record.head.id) {
      if(recordsById.has(record.head.id))throw new Error('Duplicate source ID: '+record.head.id);
      recordsById.set(record.head.id,record);
    }
    if(record.head.type==='ATTR') {
      const parent=record.payload.parentId;
      if(!attrsByParent.has(parent))attrsByParent.set(parent,[]);
      attrsByParent.get(parent).push(record);
    }
  }
  return {lines,records,attrsByParent,recordsById};
}
function oneAttribute(model,id,key) {
  const matches=(model.attrsByParent.get(id)||[]).filter(r=>r.payload.key===key);
  if(matches.length!==1)throw new Error('Expected one '+key+' attribute for '+id);
  return matches[0];
}
function buildModel(source) {
  const model={...readRecords(source),bundles:[],ownerById:new Map()};
  function own(id,bundle,type) {
    if(model.ownerById.has(id))throw new Error('Primitive shared by multiple owners: '+id);
    if(model.recordsById.get(id)?.head.type!==type)throw new Error('Missing source '+type+': '+id);
    model.ownerById.set(id,bundle);
  }
  for(const c of allComponents.filter(c=>c.getState_Designator())) {
    const id=c.getState_PrimitiveId(),pins=pinsById.get(id);
    const points=[c,...pins];
    const body=expandRect(makeRect(
      Math.min(...points.map(p=>p.x)),Math.max(...points.map(p=>p.x)),
      Math.min(...points.map(p=>p.y)),Math.max(...points.map(p=>p.y))),TEXT.bodyMargin);
    const bundle={id,designator:c.getState_Designator(),x:c.x,y:c.y,pins,body,
      bounds:[body],obstacles:[body],wires:[]};
    model.bundles.push(bundle);
    own(id,bundle,'COMPONENT');
  }
  const flagInfos=flags.map(f=>({id:f.getState_PrimitiveId(),x:f.x,y:f.y,net:f.getState_Net()}));
  for(const wire of wires) {
    const id=wire.getState_PrimitiveId(),net=wire.getState_Net();
    const segments=stubSegments(wire.getState_Line());
    if(segments.length!==1)throw new Error('Expected one segment for wire '+id);
    const [x1,y1,x2,y2]=segments[0],p1={x:x1,y:y1},p2={x:x2,y:y2};
    const matches=flagInfos.filter(f=>f.net===net&&(samePoint(f,p1)||samePoint(f,p2)));
    if(matches.length!==1)throw new Error('Ambiguous flag for wire '+id);
    const flag=matches[0],pinPoint=samePoint(flag,p1)?p2:p1;
    const owners=model.bundles.filter(b=>b.pins.some(p=>samePoint(p,pinPoint)));
    if(owners.length!==1)throw new Error('Ambiguous wire owner '+id);
    const bundle=owners[0];
    own(id,bundle,'WIRE');
    own(flag.id,bundle,'COMPONENT');
    const attr=oneAttribute(model,id,'NET');
    if(String(attr.payload.value ?? '')!==String(net ?? ''))throw new Error('Wire NET differs from source: '+id);
    const lineBounds=makeRect(Math.min(x1,x2),Math.max(x1,x2),Math.min(y1,y2),Math.max(y1,y2));
    const flagEndpoint=samePoint(flag,p1)?p1:p2;
    const outward={x:Math.sign(flagEndpoint.x-pinPoint.x),y:Math.sign(flagEndpoint.y-pinPoint.y)};
    // Bounds include conservative symbol/stroke extent; text uses its own clearance.
    bundle.bounds.push(expandRect(lineBounds,2),centerRect(flag.x,flag.y,24,24));
    bundle.obstacles.push(expandRect(lineBounds,TEXT.wireMargin),centerRect(flag.x,flag.y,TEXT.flagMargin*2,TEXT.flagMargin*2));
    bundle.wires.push({id,net,attr,flagPoint:flag,outward,bundle});
  }
  if(flagInfos.some(f=>!model.ownerById.has(f.id)))throw new Error('Unowned flag');
  return model;
}
function placeText(model) {
  function place(record,bundle,x,y,size,fontSize,rotation=0) {
    record.payload={...record.payload,x:clean(x),y:clean(-y),rotation,fontSize,
      align:'CENTER_MIDDLE',valueVisible:true,keyVisible:false};
    const rect=centerRect(x,y,size.width,size.height);
    bundle.bounds.push(expandRect(rect,1));
    return rect;
  }
  const requests=model.bundles.map(bundle=>{
    const siblings=model.attrsByParent.get(bundle.id)||[];
    const lines=['Designator','Name'].map(key=>{
      const attr=oneAttribute(model,bundle.id,key);
      const fontSize=key==='Designator'?TEXT.designatorFontSize:TEXT.nameFontSize;
      return {attr,fontSize,size:textSize(displayValue(attr,siblings),fontSize)};
    });
    return {bundle,lines,width:Math.max(...lines.map(l=>l.size.width)),
      height:lines.reduce((sum,l)=>sum+l.size.height,0)+2};
  }).sort((a,b)=>b.width-a.width||a.bundle.designator.localeCompare(b.bundle.designator));
  for(const {bundle,lines,width,height} of requests) {
    const selected=componentCandidates(bundle.body,width,height).find(p=>clearOf(centerRect(p.x,p.y,width,height),bundle.obstacles));
    if(!selected)throw new Error('No component text position for '+bundle.designator);
    let y=selected.y-height/2;
    const rects=[];
    for(const line of lines) {
      y+=line.size.height/2;
      rects.push(place(line.attr,bundle,selected.x,y,line.size,line.fontSize));
      y+=line.size.height/2+2;
    }
    bundle.obstacles.push(unionRects(rects));
  }
  const netRequests=model.bundles.flatMap(b=>b.wires).map(wire=>{
    const rotation=wire.outward.y!==0?90:0;
    return {wire,rotation,size:textSize(wire.net,TEXT.netFontSize,rotation)};
  }).sort((a,b)=>b.size.width-a.size.width||a.wire.id.localeCompare(b.wire.id));
  for(const {wire,rotation,size} of netRequests) {
    const {bundle}=wire;
    const selected=netCandidates(wire.flagPoint,wire.outward,size.width,size.height)
      .find(p=>clearOf(centerRect(p.x,p.y,size.width,size.height),bundle.obstacles));
    if(!selected)throw new Error('No NET text position for wire '+wire.id);
    bundle.obstacles.push(place(wire.attr,bundle,selected.x,selected.y,size,TEXT.netFontSize,rotation));
  }
  // Unknown displayed fields need explicit support, not an unmeasured rectangle.
  for(const record of model.records) {
    const p=record.payload;
    if(record.head.type==='ATTR'&&model.ownerById.has(p.parentId)&&p.valueVisible===true&&
      !['Designator','Name','NET'].includes(p.key))throw new Error('Unexpected visible attribute '+p.key);
  }
}
function planLayout(model) {
  const geometry=Object.create(null);
  for(const bundle of model.bundles) {
    const rect=unionRects(bundle.bounds);
    geometry[bundle.designator]={componentX:bundle.x,componentY:bundle.y,
      localRect:makeRect(rect.minX-bundle.x,rect.maxX-bundle.x,rect.minY-bundle.y,rect.maxY-bundle.y)};
  }
  const layout=calculateLayout(geometry);
  if(layout.componentViolations.length||layout.blockViolations.length)throw new Error('Bundle packing failed');
  return new Map(layout.plannedComponents.map(p=>[p.id,{
    x:clean(p.targetComponentX-geometry[p.id].componentX),
    y:clean(p.targetComponentY-geometry[p.id].componentY)}]));
}
function translateSource(model,deltas) {
  const output=model.lines.slice();
  for(const record of model.records) {
    const type=record.head.type;
    const ownerId=type==='ATTR'?record.payload.parentId:type==='LINE'?record.payload.lineGroup:record.head.id;
    const bundle=model.ownerById.get(ownerId);
    if(!bundle)continue;
    const delta=deltas.get(bundle.designator),p={...record.payload};
    if(type==='COMPONENT'||type==='ATTR') {
      if(Number.isFinite(p.x))p.x=clean(p.x+delta.x);
      if(Number.isFinite(p.y))p.y=clean(p.y-delta.y);
    } else if(type==='LINE') {
      for(const key of ['startX','endX'])p[key]=clean(p[key]+delta.x);
      for(const key of ['startY','endY'])p[key]=clean(p[key]-delta.y);
    } else continue;
    output[record.index]=serializeRecord({head:record.head,payload:p},model.lines[record.index]);
  }
  return output.join('\n');
}
  const model=buildModel(originalSource);
  if(phase==='complete')placeText(model);
  const deltas=planLayout(model);
  const planned={source:translateSource(model,deltas),deltas:[...deltas]};
  const changed=canonical(planned.source)!==canonical(originalSource);
  const planFingerprint=hash(JSON.stringify({sourceFingerprint,phase,blocks:BLOCK_DEFINITIONS,config:CONFIG,flow:FUNCTION_LAYOUT,text:TEXT,output:canonical(planned.source)}));
  const summary={schemaVersion:2,phase,document:{uuid:document.uuid},componentCount:allComponents.filter(c=>c.getState_Designator()).length,
    wireCount:wires.length,flagCount:flags.length,blockCount:BLOCK_DEFINITIONS.length,sourceGeometryFingerprint:sourceFingerprint,planFingerprint,
    movedCount:planned.deltas.filter(([,d])=>Math.abs(d.x)>0.02||Math.abs(d.y)>0.02).length,
    componentViolations:[],blockViolations:[]};
  if(mode==='verify')return {...summary,status:changed?'mismatch':'verified',readOnly:true,issues:changed?[{code:'REFLOW_REQUIRED'}]:[]};
  if(mode==='plan')return {...summary,status:'planned',readOnly:true,changed,
    backupSource:originalSource,deltas:planned.deltas,
    applyRequest:{...input,mode:'apply',expectedSourceFingerprint:sourceFingerprint,expectedPlanFingerprint:planFingerprint}};
  if(input.expectedSourceFingerprint!==sourceFingerprint||input.expectedPlanFingerprint!==planFingerprint)throw new Error('Stale reflow plan; read and plan again');
  if(changed) {
    if(!await eda.sys_FileManager.setDocumentSource(planned.source))throw new Error('Reflow source import rejected; inspect current state before retrying');
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  const readback=await eda.sys_FileManager.getDocumentSource();
  if(canonical(readback)!==canonical(planned.source))throw new Error('Reflow readback mismatch; retain the plan backup and inspect current state');
  if(!await eda.sch_Document.save())throw new Error('Document save failed; inspect current state and retain the plan backup');
  const saved=await eda.sys_FileManager.getDocumentSource();
  if(canonical(saved)!==canonical(planned.source))throw new Error('Saved source differs from reflow plan');
  return {...summary,status:'applied',readOnly:false,saved:true,changed,afterFingerprint:hash(canonical(saved))};
})();
