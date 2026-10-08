/** Map declared public layer purposes to the raster backend's layer IDs. */
export function normalizePrerouteGeometry(board,policy,options={}){
  const mapping={};
  for(const layer of policy.layers??[])if(typeof layer==='object'&&layer.purpose)mapping[layer.purpose]=layer.id;
  Object.assign(mapping,options.layerMap??{});
  const ids=options.routing?.layerIds??policy.preroute?.routing?.layerIds??policy.layers?.map(l=>typeof l==='number'?l:l.id);
  const layers=list=>[...new Set(list.flatMap(layer=>{
    if(layer==='all-copper'){if(!ids)throw Error('PREROUTE_PUBLIC_LAYER_STACK_REQUIRED');return ids;}
    if(Number.isInteger(layer))return[layer];
    if(!Number.isInteger(mapping[layer]))throw Error('PREROUTE_PUBLIC_LAYER_MAP_REQUIRED:'+layer);
    return[mapping[layer]];
  }))];
  const shape=s=>({...s,layers:layers(s.layers)});
  const copper=(board.copper??[]).map(c=>({...c,shape:shape(c.shape)})),byId=new Map(copper.filter(c=>c.type==='pad').map(c=>[c.id,c]));
  const pads=(board.pads??copper.filter(c=>c.type==='pad')).map(p=>{
    const source=p.shape??p.shapes?.[0]??byId.get(p.id)?.shape;
    if(!source)throw Error('PREROUTE_PREPARE:pad-shape:'+p.id);
    return{...p,shape:shape(source),shapes:(p.shapes??[source]).map(shape),contactShapes:(p.contactShapes??p.shapes??[source]).map(shape),...(p.layers?{layers:layers(p.layers)}:{}),owner:p.owner??p.ref,number:p.number??p.pin};
  });
  const normalized={...board,pads,copper};
  if(board.segments)normalized.segments=board.segments.map(s=>({...s,layer:layers([s.layer])[0]}));
  if(board.vias)normalized.vias=board.vias.map(v=>({...v,...(v.layers?{layers:layers(v.layers)}:{})}));
  if(board.keepouts)normalized.keepouts=board.keepouts.map(k=>({...k,...(k.shape?{shape:shape(k.shape)}:{})}));
  const rule=r=>({...r,...(r.allowedLayers?{allowedLayers:layers(r.allowedLayers)}:{}),...(r.viaTransition?{viaTransition:{sourceLayer:layers([r.viaTransition.sourceLayer])[0],targetLayer:layers([r.viaTransition.targetLayer])[0]}}:{})});
  const normalizedPolicy={...policy,nets:policy.nets.map(n=>({...n,...(n.roles?{roles:n.roles.map(rule)}:{}),...(n.primaryAutoLayers?{primaryAutoLayers:layers(n.primaryAutoLayers)}:{}),...(n.preroute?{preroute:{...rule(n.preroute),...(n.preroute.branches?{branches:n.preroute.branches.map(rule)}:{})}}:{})}))};
  return{board:normalized,policy:normalizedPolicy,layerMapping:mapping};
}
