function normalizeNativeWirePoints(value) {
  if(!Array.isArray(value)||!value.length)throw new Error('Invalid native wire coordinates');
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

// Two layout phases share the same geometry and source ownership model.
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
  if(options.gridOnly!==undefined&&typeof options.gridOnly!=='boolean')throw new Error('Invalid layout.gridOnly');
  if(options.groundElbows!==undefined&&typeof options.groundElbows!=='boolean')throw new Error('Invalid layout.groundElbows');
  const GROUND={enabled:options.groundElbows!==false,runs:[20,40,60,80,100,120],drop:10};
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
    attachmentSpacing:dimension('attachmentSpacing',options.unit==='mil'?1400:140),epsilon:0.001,
    gridStep:dimension('gridStep',options.unit==='mil'?50:5)};
  if(CONFIG.gridStep<0.1||CONFIG.gridStep>100)throw new Error('Electrical gridStep must be between 0.1 and 100 schematic units');
  const snap=value=>clean(Math.round(value/CONFIG.gridStep)*CONFIG.gridStep);
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
  const nativeComponents=await eda.sch_PrimitiveComponent.getAll();
  const frameIds=new Set(nativeComponents.filter(c=>c.getState_ComponentType()==='sheet').map(c=>c.getState_PrimitiveId()));
  const allComponents=nativeComponents.filter(c=>c.getState_ComponentType()!=='sheet');
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
  const getter=(object,name,fallback=null)=>typeof object?.[name]==='function'?object[name]():fallback;
  const pinNumber=pin=>String(getter(pin,'getState_PinNumber')??getter(pin,'getState_Number')??getter(pin,'getState_Name')??'').trim();
  function readNoConnectBoolean(pin){
    const value=getter(pin,'getState_NoConnected',getter(pin,'getState_NoConnect',undefined));
    return typeof value==='boolean'?value:null;
  }
  async function snapshotNoConnects(components,pinMap){
    const map=new Map();
    for(const c of components){
      const designator=String(c.getState_Designator()||'').trim();
      if(!designator)continue;
      const pins=pinMap?.get(c.getState_PrimitiveId())||await c.getAllPins();
      for(const pin of pins){
        const number=pinNumber(pin);
        const nc=readNoConnectBoolean(pin);
        if(nc===true){
          if(!number||map.has(designator+'.'+number))throw new Error('NC_PIN_IDENTITY_INVALID: '+designator);
          map.set(designator+'.'+number,true);
        }
      }
    }
    return map;
  }
  async function restoreNoConnects(expected){
    if(!expected.size)return {restored:0};
    if(typeof eda.sch_PrimitivePin?.modify!=='function')throw new Error('PIN_API_UNAVAILABLE: sch_PrimitivePin.modify is required to restore no-connect markers after reflow');
    const live=await eda.sch_PrimitiveComponent.getAll();
    const restored=[];
    for(const c of live){
      const designator=String(c.getState_Designator()||'').trim();
      if(!designator)continue;
      const pins=await c.getAllPins();
      for(const pin of pins){
        const key=designator+'.'+pinNumber(pin);
        if(!expected.has(key))continue;
        const current=readNoConnectBoolean(pin);
        if(current===true){restored.push(key);continue;}
        if(!await eda.sch_PrimitivePin.modify(pin,{noConnected:true}))throw new Error('PIN_RESTORE_FAILED: could not set no-connect on '+key);
        restored.push(key);
      }
    }
    for(const key of expected.keys())if(!restored.includes(key))throw new Error('PIN_RESTORE_FAILED: missing pin '+key+' after reflow import');
    return {restored:restored.length};
  }
  const primitiveBoundsById=new Map(),rawBoundsById=new Map(),textMetricsById=new Map();
  if(typeof eda.sch_Primitive?.getPrimitivesBBox!=='function')throw new Error('Native primitive bounds API required');
  const nativeRect=async id=>{
    const b=await eda.sch_Primitive.getPrimitivesBBox([id]);
    if(!b||![b.minX,b.maxX,b.minY,b.maxY].every(Number.isFinite)||b.maxX<b.minX||b.maxY<b.minY)throw new Error('Native bounds unavailable: '+id);
    return makeRect(b.minX,b.maxX,b.minY,b.maxY);
  };
  // Native text vertices use finite precision in world coordinates. Quantize a
  // conservative local envelope so moving a part does not change its size.
  const upper=n=>clean(Math.ceil((n-0.001)/0.1)*0.1+0.1),lower=n=>clean(Math.floor((n+0.001)/0.1)*0.1-0.1);
  await Promise.all(allComponents.map(async c=>{
    const b=await nativeRect(c.getState_PrimitiveId());
    rawBoundsById.set(c.getState_PrimitiveId(),b);
    primitiveBoundsById.set(c.getState_PrimitiveId(),makeRect(c.x+lower(b.minX-c.x),c.x+upper(b.maxX-c.x),c.y+lower(b.minY-c.y),c.y+upper(b.maxY-c.y)));
  }));
  const physicalIds=new Set(allComponents.filter(c=>c.getState_Designator()).map(c=>c.getState_PrimitiveId()));
  const wireIds=new Set(wires.map(w=>w.getState_PrimitiveId()));
  await Promise.all(readRecords(originalSource).records.filter(r=>r.head.type==='ATTR'&&
    (physicalIds.has(r.payload.parentId)&&['Designator','Name'].includes(r.payload.key)||wireIds.has(r.payload.parentId)&&r.payload.key==='NET')).map(async r=>{
    const p=r.payload;
    const b=await nativeRect(r.head.id),vertical=Math.abs(Number(p.rotation)||0)%180===90;
    // Preserve the provider's default font when source fontSize is null. Only
    // explicit font changes need a known base size for proportional measurement.
    const width=vertical?b.height:b.width,height=vertical?b.width:b.height,fontSize=Number(p.fontSize)>0?Number(p.fontSize):null;
    const perFont=n=>clean(Math.ceil((n-0.0001)/0.01)*0.01+0.01);
    const fontKey=p.key==='Designator'?'designatorFontSize':p.key==='Name'?'nameFontSize':'netFontSize';
    textMetricsById.set(r.head.id,{width:upper(width),height:upper(height),fontSize,normalizeFont:Object.hasOwn(input.text||{},fontKey),
      widthPerFont:fontSize?perFont(width/fontSize):null,heightPerFont:fontSize?perFont(height/fontSize):null});
  }));
  function targetFontSize(record,key){
    const explicit=Object.hasOwn(input.text||{},key);
    if(explicit&&!textMetricsById.get(record.head.id)?.fontSize)throw new Error('Native text font size unavailable: '+record.head.id);
    return explicit?TEXT[key]:Number(record.payload.fontSize)>0?Number(record.payload.fontSize):null;
  }
  function nativeTextSize(record,fontSize,rotation=0){
    const m=textMetricsById.get(record.head.id);if(!m||m.width<=0||m.height<=0)throw new Error('Native text metrics unavailable');
    const unchanged=fontSize===null||!m.normalizeFont;
    const w=unchanged?m.width:clean(m.widthPerFont*fontSize),h=unchanged?m.height:clean(m.heightPerFont*fontSize);
    return rotation===90?{width:h,height:w}:{width:w,height:h};
  }
  const noConnectSnapshot=await snapshotNoConnects(allComponents,pinsById);
  // Preflight only when restore will be required; empty boards need no pin write API.
  if(noConnectSnapshot.size&&typeof eda.sch_PrimitivePin?.modify!=='function')throw new Error('PIN_API_UNAVAILABLE: sch_PrimitivePin.modify is required before reflow when no-connect markers exist');
  const canonical=source=>source.split(/\r?\n/).filter(l=>l&&!l.includes('"type":"DOCHEAD"')).map(line=>{
    const record=parseRecord(line);
    if(record?.head.type==='ATTR'&&frameIds.has(record.payload.parentId)&&['@Update Time','@Update Date'].includes(record.payload.key)){
      return serializeRecord({head:record.head,payload:{...record.payload,value:'<editor-generated-clock>'}},line);
    }
    return line;
  }).join('\n');
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
  if(!Array.isArray(line))throw new Error('Wire geometry must be an array');
  line=normalizeNativeWirePoints(line).flatMap(p=>[p.x,p.y]);
  const result=[];for(let i=0;i+3<line.length;i+=2){const s=line.slice(i,i+4),[x1,y1,x2,y2]=s;
    if((x1===x2)===(y1===y2))throw new Error('Expected nonzero orthogonal wire segment');result.push(s);}
  return result;
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
      return { id: designator, width: localRect.width+CONFIG.gridStep, height: localRect.height+CONFIG.gridStep };
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
      // Reserve half a grid on every side, then snap the electrical anchor.
      // The snapped actual bounds stay inside the allocated packing rectangle.
      const targetComponentX=snap(blockMinX+localPlacement.rect.minX+CONFIG.gridStep/2-componentGeometry.localRect.minX);
      const targetComponentY=snap(blockMinY+localPlacement.rect.minY+CONFIG.gridStep/2-componentGeometry.localRect.minY);
      const targetRect=rectAt(targetComponentX+componentGeometry.localRect.minX,
        targetComponentY+componentGeometry.localRect.minY,componentGeometry.localRect.width,componentGeometry.localRect.height);
      componentRects.push(targetRect);
      plannedComponents.push({
        id: localPlacement.id,
        block: block.id,
        rect: targetRect,
        targetComponentX,
        targetComponentY,
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
 * Body bounds include the native outline and pins. Flag and stroke padding are explicit,
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
function rotatedBounds(bounds, x, y, delta) {
  const radians=delta*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
  const points=[[bounds.minX,bounds.minY],[bounds.minX,bounds.maxY],[bounds.maxX,bounds.minY],[bounds.maxX,bounds.maxY]].map(([px,py])=>({x:x+(px-x)*c-(py-y)*s,y:y+(px-x)*s+(py-y)*c}));
  return makeRect(Math.min(...points.map(p=>p.x)),Math.max(...points.map(p=>p.x)),Math.min(...points.map(p=>p.y)),Math.max(...points.map(p=>p.y)));
}
function wireRects(points,padding=0) {
  return points.slice(1).map((p,i)=>expandRect(makeRect(Math.min(points[i].x,p.x),Math.max(points[i].x,p.x),Math.min(points[i].y,p.y),Math.max(points[i].y,p.y)),padding));
}
function moveMarker(model,wire,point,rotation=wire.flag.rotation) {
  const flag=wire.flag,dx=point.x-flag.x,dy=point.y-flag.y;
  if(rotation!==flag.rotation)model.markerOrientationChanges.push({id:flag.id,designator:wire.bundle.designator,net:wire.net,before:flag.rotation,after:rotation});
  if(Math.hypot(dx,dy)>1e-6)model.markerPositionChanges.push({id:flag.id,designator:wire.bundle.designator,net:wire.net});
  const b=rotatedBounds(flag.bounds,flag.x,flag.y,rotation-flag.rotation);
  flag.bounds=makeRect(b.minX+dx,b.maxX+dx,b.minY+dy,b.maxY+dy);
  Object.assign(flag,{x:point.x,y:point.y,rotation});
  const record=model.recordsById.get(flag.id);
  record.payload={...record.payload,x:clean(point.x),y:clean(-point.y),rotation};
  for(const a of model.attrsByParent.get(flag.id)||[]) {
    if(Number.isFinite(a.payload.x))a.payload.x=clean(a.payload.x+dx);
    if(Number.isFinite(a.payload.y))a.payload.y=clean(a.payload.y-dy);
  }
}
function setWireRoute(model,wire,points) {
  const lines=model.records.filter(r=>r.head.type==='LINE'&&r.payload.lineGroup===wire.id);
  if(lines.length<1||lines.length>2)throw new Error('Unexpected owned wire segment count: '+wire.id);
  if(points.length===3&&lines.length===1) {
    // The same plan must generate the same new ID when apply recomputes it.
    let id,salt=0;
    do{id=hash(wire.id+':ground:'+salt).slice(-8)+hash('ground:'+wire.id+':'+salt++).slice(-8);}while(model.recordsById.has(id));
    const last=model.lines.length-1;
    if(model.lines[last]==='')model.lines.pop();
    if(model.lines.length&&!model.lines.at(-1).endsWith('|'))model.lines[model.lines.length-1]+='|';
    const record={head:{...lines[0].head,id,ticket:++model.nextTicket},payload:{...lines[0].payload},index:model.lines.length};
    model.lines.push(JSON.stringify(record.head)+'||'+JSON.stringify(record.payload));
    model.records.push(record);model.recordsById.set(id,record);lines.push(record);
  }
  if(lines.length!==points.length-1)throw new Error('Wire route/source mismatch: '+wire.id);
  for(let i=0;i<lines.length;i++)lines[i].payload={...lines[i].payload,startX:clean(points[i].x),startY:clean(-points[i].y),endX:clean(points[i+1].x),endY:clean(-points[i+1].y)};
  wire.points=points;
}
function arrangeGroundElbows(model) {
  const targets=model.wires.filter(w=>w.flag.symbol?.name==='Ground-GND'&&!w.flag.mirror&&Math.abs(w.points[1].y-w.points[0].y)<1e-6)
    .sort((a,b)=>a.bundle.designator.localeCompare(b.bundle.designator)||a.points[0].y-b.points[0].y||a.points[0].x-b.points[0].x||a.id.localeCompare(b.id));
  if(targets.length&&[...GROUND.runs,GROUND.drop].some(n=>Math.abs(n-snap(n))>1e-6))throw new Error('Ground elbow slots are incompatible with layout.gridStep');
  const excluded=new Set(),kept=[];let chosen=[];
  const clear=(a,bs)=>bs.every(b=>getClearanceStatus(a,b,0.25,1e-6).valid);
  // Failed originals become fixed obstacles; each retry excludes more wires.
  for(;;) {
    const active=targets.filter(w=>!excluded.has(w.id)),ids=new Set(active.map(w=>w.id)),flags=new Set(active.map(w=>w.flag.id));
    const shapes=[...model.bundles.map(b=>({id:b.id,rect:b.rawBody})),...model.flags.filter(f=>!flags.has(f.id)).map(f=>({id:f.id,rect:f.bounds}))];
    const fixedLines=model.wires.filter(w=>!ids.has(w.id)).flatMap(w=>wireRects(w.points,0.25));
    const placed=[];let failed=0;
    for(const wire of active) {
      const pin=wire.points[0],direction=Math.sign(wire.points[1].x-pin.x),flag=wire.flag;
      const b=rotatedBounds(flag.bounds,flag.x,flag.y,-flag.rotation);
      const local=makeRect(b.minX-flag.x,b.maxX-flag.x,b.minY-flag.y,b.maxY-flag.y);
      let best;
      for(const run of GROUND.runs) {
        const bend={x:clean(pin.x+direction*run),y:clean(pin.y)},point={x:bend.x,y:clean(bend.y-GROUND.drop)},points=[pin,bend,point];
        const body=makeRect(local.minX+point.x,local.maxX+point.x,local.minY+point.y,local.maxY+point.y);
        const lead=expandRect(makeRect(point.x,point.x,Math.min(point.y,body.maxY),Math.max(point.y,body.maxY)),0.25);
        const ownShapes=[body,lead],lines=wireRects(points,0.25),previousShapes=placed.flatMap(p=>p.shapes),previousLines=placed.flatMap(p=>p.lines);
        if(ownShapes.every(r=>clear(r,[...shapes.map(s=>s.rect),...previousShapes,...fixedLines,...previousLines]))&&
          lines.every(r=>clear(r,[...shapes.filter(s=>s.id!==wire.bundle.id).map(s=>s.rect),...previousShapes,...fixedLines,...previousLines]))) {
          best={wire,points,point,shapes:ownShapes,lines,run};break;
        }
      }
      if(best)placed.push(best);
      else {excluded.add(wire.id);kept.push({wireId:wire.id,designator:wire.bundle.designator,net:wire.net,reason:'NO_CLEAR_GROUND_SLOT'});failed++;}
    }
    if(!failed){chosen=placed;break;}
  }
  for(const p of chosen){setWireRoute(model,p.wire,p.points);moveMarker(model,p.wire,p.point,0);}
  model.groundElbows={enabled:true,runs:GROUND.runs,drop:GROUND.drop,targets:targets.length,applied:chosen.length,kept};
}
function addWireObstacles(model) {
  for(const wire of model.wires) {
    const f=wire.flag,b=f.bounds,anchor=makeRect(f.x,f.x,f.y,f.y);
    const marker=expandRect(unionRects([b,anchor]),TEXT.flagMargin);
    wire.bundle.bounds.push(...wireRects(wire.points,2),marker);
    wire.bundle.obstacles.push(...wireRects(wire.points,TEXT.wireMargin),marker);
  }
}
function alignNoConnectAttributes(model) {
  const active=new Set();
  for(const record of model.records){
    if(record.head.type!=='ATTR'||record.payload.key!=='NO_CONNECT')continue;
    const owner=model.pinOwnersById.get(record.payload.parentId);
    if(!owner)throw new Error('NC_ATTRIBUTE_UNOWNED: '+record.payload.parentId);
    if(record.payload.value==='yes'&&owner.noConnected!==true)throw new Error('NC_ATTRIBUTE_STATE_MISMATCH');
    if(record.payload.value==='yes'){
      if(active.has(record.payload.parentId))throw new Error('NC_ATTRIBUTE_DUPLICATED: '+record.payload.parentId);
      active.add(record.payload.parentId);
    }
    record.payload={...record.payload,x:clean(owner.pin.x),y:clean(-owner.pin.y)};
  }
  for(const [id,owner] of model.pinOwnersById)if(owner.noConnected===true&&!active.has(id))throw new Error('NC_ATTRIBUTE_MISSING: '+id);
}
function buildModel(source) {
  const model={...readRecords(source),bundles:[],wires:[],flags:[],ownerById:new Map(),pinOwnersById:new Map(),markerOrientationChanges:[],markerPositionChanges:[],groundElbows:{enabled:false},nextTicket:0};
  model.nextTicket=Math.max(0,...model.records.map(r=>Number(r.head.ticket)||0));
  function own(id,bundle,type) {
    if(model.ownerById.has(id))throw new Error('Primitive shared by multiple owners: '+id);
    if(model.recordsById.get(id)?.head.type!==type)throw new Error('Missing source '+type+': '+id);
    model.ownerById.set(id,bundle);
  }
  for(const c of allComponents.filter(c=>c.getState_Designator())) {
    const id=c.getState_PrimitiveId(),pins=pinsById.get(id),points=[c,...pins];
    const rawBody=rawBoundsById.get(id),nativeBody=primitiveBoundsById.get(id);
    const pinBounds=makeRect(Math.min(...points.map(p=>p.x)),Math.max(...points.map(p=>p.x)),Math.min(...points.map(p=>p.y)),Math.max(...points.map(p=>p.y)));
    const body=expandRect(unionRects([nativeBody,pinBounds]),TEXT.bodyMargin);
    const bundle={id,designator:c.getState_Designator(),x:c.x,y:c.y,pins,rawBody,body,bounds:[body],obstacles:[body],wires:[]};
    model.bundles.push(bundle);own(id,bundle,'COMPONENT');
    for(const pin of pins) {
      const pinId=getter(pin,'getState_PrimitiveId');
      if(!pinId||model.pinOwnersById.has(pinId))throw new Error('Native pin identity unavailable or duplicated');
      model.pinOwnersById.set(pinId,{pin,bundle,noConnected:readNoConnectBoolean(pin)});
    }
  }
  model.flags=flags.map(f=>({id:f.getState_PrimitiveId(),x:f.x,y:f.y,net:f.getState_Net(),type:f.getState_ComponentType(),
    rotation:getter(f,'getState_Rotation',0),mirror:getter(f,'getState_Mirror',false),symbol:getter(f,'getState_Symbol'),bounds:rawBoundsById.get(f.getState_PrimitiveId())}));
  for(const primitive of wires) {
    const id=primitive.getState_PrimitiveId(),net=primitive.getState_Net(),segments=stubSegments(primitive.getState_Line());
    if(!segments.length||segments.length>2)throw new Error('Only straight stubs and single ground elbows supported');
    const p1={x:segments[0][0],y:segments[0][1]},last=segments.at(-1),p2={x:last[2],y:last[3]};
    const matches=model.flags.filter(f=>f.net===net&&(samePoint(f,p1)||samePoint(f,p2)));
    if(matches.length!==1)throw new Error('Ambiguous flag for wire '+id);
    const flag=matches[0],pinPoint=samePoint(flag,p1)?p2:p1;
    const owners=model.bundles.filter(b=>b.pins.some(p=>samePoint(p,pinPoint)));
    if(owners.length!==1)throw new Error('Ambiguous wire owner '+id);
    const bundle=owners[0],ordered=samePoint(pinPoint,p1)?segments:segments.slice().reverse().map(([a,b,c,d])=>[c,d,a,b]);
    const points=[pinPoint,...ordered.map(s=>({x:s[2],y:s[3]}))];
    if(points.length===3&&(flag.symbol?.name!=='Ground-GND'||points[0].y!==points[1].y||points[1].x!==points[2].x||points[2].y>=points[1].y))throw new Error('Expected horizontal then downward ground elbow');
    own(id,bundle,'WIRE');own(flag.id,bundle,'COMPONENT');
    const attr=oneAttribute(model,id,'NET');
    if(String(attr.payload.value??'')!==String(net??''))throw new Error('Wire NET differs from source: '+id);
    const outward={x:Math.sign(points[1].x-pinPoint.x),y:Math.sign(points[1].y-pinPoint.y)};
    const wire={id,net,attr,flag,outward,points,flagPoint:flag,bundle};
    model.wires.push(wire);bundle.wires.push(wire);
    if(phase==='complete'&&options.gridOnly!==true) {
      const angle=(Math.round(Math.atan2(outward.y,outward.x)*180/Math.PI)+360)%360;
      let rotation=flag.rotation;
      if(flag.type==='netport') {
        if(flag.mirror)throw new Error('Mirrored netport orientation is unsupported');
        rotation=angle;
      } else if(!flag.mirror&&flag.symbol?.name==='Power-5V')rotation=(angle+270)%360;
      else if(GROUND.enabled&&!flag.mirror&&flag.symbol?.name==='Ground-GND'&&outward.x===0)rotation=(angle+90)%360;
      if(rotation!==flag.rotation)moveMarker(model,wire,flag,rotation);
    }
  }
  if(model.flags.some(f=>!model.ownerById.has(f.id)))throw new Error('Unowned flag');
  alignNoConnectAttributes(model);
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
    const lines=['Designator','Name'].map(key=>{
      const attr=oneAttribute(model,bundle.id,key);
      const fontSize=targetFontSize(attr,key==='Designator'?'designatorFontSize':'nameFontSize');
      return {attr,fontSize,size:nativeTextSize(attr,fontSize)};
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
    const rotation=wire.flag.type==='netflag'?0:wire.outward.y!==0?90:0;
    return {wire,rotation,fontSize:targetFontSize(wire.attr,'netFontSize'),size:nativeTextSize(wire.attr,targetFontSize(wire.attr,'netFontSize'),rotation)};
  }).sort((a,b)=>b.size.width-a.size.width||a.wire.id.localeCompare(b.wire.id));
  for(const {wire,rotation,size,fontSize} of netRequests) {
    const {bundle}=wire;
    const selected=netCandidates(wire.flagPoint,wire.outward,size.width,size.height)
      .find(p=>clearOf(centerRect(p.x,p.y,size.width,size.height),bundle.obstacles));
    if(!selected)throw new Error('No NET text position for wire '+wire.id);
    bundle.obstacles.push(place(wire.attr,bundle,selected.x,selected.y,size,fontSize,rotation));
  }
  // Unknown displayed fields need explicit support, not an unmeasured rectangle.
  for(const record of model.records) {
    const p=record.payload;
    if(record.head.type==='ATTR'&&model.ownerById.has(p.parentId)&&p.valueVisible===true&&
      !['Designator','Name','NET'].includes(p.key))throw new Error('Unexpected visible attribute '+p.key);
  }
}
function planLayout(model) {
  if(options.gridOnly===true){
    const deltas=new Map(model.bundles.map(b=>[b.designator,{x:clean(snap(b.x)-b.x),y:clean(snap(b.y)-b.y)}]));
    const boxes=model.bundles.map(b=>{const r=unionRects(b.bounds),d=deltas.get(b.designator);
      return {id:b.designator,rect:makeRect(r.minX+d.x,r.maxX+d.x,r.minY+d.y,r.maxY+d.y)};});
    if(findClearanceViolations(boxes,0).length)throw new Error('Grid alignment would overlap component bundles');
    return deltas;
  }
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
    const bundle=model.ownerById.get(ownerId)||(type==='ATTR'&&record.payload.key==='NO_CONNECT'?model.pinOwnersById.get(ownerId)?.bundle:null);
    if(!bundle)continue;
    const delta=deltas.get(bundle.designator),p={...record.payload};
    if(type==='COMPONENT'||type==='ATTR') {
      // Translate each bundle uniformly. Independently snapping wire endpoints
      // can disconnect a pin whose local pitch is incompatible with the grid.
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
  if(phase==='complete'&&options.gridOnly!==true&&GROUND.enabled)arrangeGroundElbows(model);
  addWireObstacles(model);
  if(phase==='complete'&&options.gridOnly!==true)placeText(model);
  if(options.gridOnly===true){
    for(const record of model.records){
      const p=record.payload,b=model.ownerById.get(p.parentId);
      if(record.head.type==='ATTR'&&b&&p.valueVisible===true&&Number.isFinite(p.x)&&Number.isFinite(p.y)){
        const size=nativeTextSize(record,Number(p.fontSize)>0?Number(p.fontSize):null,p.rotation||0);
        if(p.align!=='CENTER_MIDDLE')throw new Error('Grid-only mode requires measured centered text');
        b.bounds.push(centerRect(p.x,-p.y,size.width,size.height));
      }
    }
  }
  const deltas=planLayout(model);
  // Reject an incompatible grid before import, rather than moving endpoints
  // away from the symbol's immutable pin geometry.
  const onGrid=n=>Math.abs(n-snap(n))<=1e-6;
  for(const bundle of model.bundles){
    const d=deltas.get(bundle.designator);
    for(const pin of bundle.pins)if(!onGrid(pin.x+d.x)||!onGrid(pin.y+d.y))throw new Error('GRID_INCOMPATIBLE_PIN: '+bundle.designator+'; choose a gridStep matching the symbol pin pitch');
  }
  const planned={source:translateSource(model,deltas),deltas:[...deltas]};
  for(const r of readRecords(planned.source).records)if(r.head.type==='LINE'&&model.ownerById.has(r.payload.lineGroup)&&
    ['startX','startY','endX','endY'].some(k=>!onGrid(r.payload[k])))throw new Error('GRID_INCOMPATIBLE_WIRE: '+r.head.id);
  const changed=canonical(planned.source)!==canonical(originalSource);
  const planFingerprint=hash(JSON.stringify({sourceFingerprint,phase,blocks:BLOCK_DEFINITIONS,config:CONFIG,flow:FUNCTION_LAYOUT,text:TEXT,gridOnly:options.gridOnly===true,ground:GROUND,output:canonical(planned.source)}));
  const summary={schemaVersion:2,phase,document:{uuid:document.uuid},componentCount:allComponents.filter(c=>c.getState_Designator()).length,
    wireCount:wires.length,flagCount:flags.length,blockCount:BLOCK_DEFINITIONS.length,sourceGeometryFingerprint:sourceFingerprint,planFingerprint,
    movedCount:planned.deltas.filter(([,d])=>Math.abs(d.x)>0.02||Math.abs(d.y)>0.02).length,
    componentViolations:[],blockViolations:[],markerOrientationChanges:model.markerOrientationChanges,markerPositionChanges:model.markerPositionChanges,groundElbows:model.groundElbows,nativeGeometry:true};
  const currentProject=await eda.dmt_Project.getCurrentProjectInfo(),currentDocument=await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if(currentProject?.uuid!==project.uuid||currentDocument?.uuid!==document.uuid||currentDocument?.documentType!==1)throw new Error('Unexpected schematic target changed during reflow');
  if(canonical(await eda.sys_FileManager.getDocumentSource())!==canonical(originalSource))throw new Error('Schematic source changed during reflow; read and plan again');
  if(mode==='verify')return {...summary,status:changed?'mismatch':'verified',readOnly:true,issues:changed?[{code:'REFLOW_REQUIRED'}]:[]};
  if(mode==='plan')return {...summary,status:'planned',readOnly:true,changed,
    backupSource:originalSource,deltas:planned.deltas,
    applyRequest:{...input,mode:'apply',expectedSourceFingerprint:sourceFingerprint,expectedPlanFingerprint:planFingerprint}};
  if(input.expectedSourceFingerprint!==sourceFingerprint||input.expectedPlanFingerprint!==planFingerprint)throw new Error('Stale reflow plan; read and plan again');
  if(changed) {
    if(!await eda.sys_FileManager.setDocumentSource(planned.source))throw new Error('Reflow source import rejected; inspect current state before retrying');
    await new Promise(resolve=>setTimeout(resolve,500));
    // Pin-owned NO_CONNECT coordinates were translated with their component.
    // Restore native pin state if the provider drops it during source import.
    const ncRestore=await restoreNoConnects(noConnectSnapshot);
    if(noConnectSnapshot.size)summary.noConnectRestore={expected:noConnectSnapshot.size,restored:ncRestore.restored};
  }
  const readback=await eda.sys_FileManager.getDocumentSource();
  if(canonical(readback)!==canonical(planned.source))throw new Error('Reflow readback mismatch; retain the plan backup and inspect current state');
  if(!await eda.sch_Document.save())throw new Error('Document save failed; inspect current state and retain the plan backup');
  const saved=await eda.sys_FileManager.getDocumentSource();
  if(canonical(saved)!==canonical(planned.source))throw new Error('Saved source differs from reflow plan');
  if(noConnectSnapshot.size){
    const afterNc=await snapshotNoConnects(await eda.sch_PrimitiveComponent.getAll());
    for(const key of noConnectSnapshot.keys())if(!afterNc.has(key))throw new Error('PIN_RESTORE_FAILED: no-connect lost after save: '+key);
  }
  const activeNcRecords=readRecords(saved).records.filter(r=>r.head.type==='ATTR'&&r.payload.key==='NO_CONNECT'&&r.payload.value==='yes');
  const ncPinPositions=new Map();
  for(const c of await eda.sch_PrimitiveComponent.getAll()){
    if(!c.getState_Designator())continue;
    for(const pin of await c.getAllPins())if(readNoConnectBoolean(pin)===true)ncPinPositions.set(getter(pin,'getState_PrimitiveId'),{x:pin.x,y:-pin.y});
  }
  if(activeNcRecords.length!==ncPinPositions.size)throw new Error('NC_GEOMETRY_MISMATCH: marker/pin count differs');
  for(const r of activeNcRecords){
    const pin=ncPinPositions.get(r.payload.parentId);
    if(!pin||Math.hypot(r.payload.x-pin.x,r.payload.y-pin.y)>1e-6)throw new Error('NC_GEOMETRY_MISMATCH: '+r.payload.parentId);
  }
  return {...summary,status:'applied',readOnly:false,saved:true,changed,noConnectGeometry:{checked:ncPinPositions.size,passed:true},afterFingerprint:hash(canonical(saved))};
})();
