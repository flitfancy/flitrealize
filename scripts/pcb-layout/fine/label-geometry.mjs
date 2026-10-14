import { labelTemplate } from '../pcb-layout-label-policy.mjs';

/** Explicit categories replace the legacy per-owner minimum, never max with it.
 * Pure and embedded unchanged in native requests alongside the geometry checker. */
export function resolveLabelClearances({clearanceMil=0,clearancesMil={},gapByOwner={}}={}) {
  const kinds=['body','pad','label'],valid=n=>Number.isFinite(n)&&n>=0;
  if(!valid(clearanceMil)||!clearancesMil||typeof clearancesMil!=='object'||Array.isArray(clearancesMil)||Object.keys(clearancesMil).some(k=>!kinds.includes(k)||!valid(clearancesMil[k]))||!gapByOwner||typeof gapByOwner!=='object'||Array.isArray(gapByOwner)||Object.values(gapByOwner).some(n=>!valid(n)))throw Object.assign(Error('FINE_INVALID_LABEL_POLICY clearancesMil'),{code:'FINE_INVALID_LABEL_POLICY'});
  const resolve=legacy=>Object.fromEntries(kinds.map(k=>[k,clearancesMil[k]??legacy]));
  return {clearancesMil:resolve(clearanceMil),clearancesByOwner:Object.fromEntries(Object.entries(gapByOwner).map(([ref,gap])=>[ref,resolve(Math.max(clearanceMil,gap))]))};
}
export function fineLabelRules(model,policy) {
  return {...resolveLabelClearances({clearanceMil:policy.clearanceMil??model.mechanical.clearanceMil,clearancesMil:policy.clearancesMil,gapByOwner:Object.fromEntries([...model.components.values()].map(c=>[c.ref,labelTemplate(c,model.mechanical).minGapMil]))}),maxOwnerDistanceMil:policy.maxOwnerDistanceMil,orientation:policy.orientation};
}
/** One pure checker shared by offline acceptance and generated native preflight. */
export function independentLabelGeometry({components,pads,labels,clearanceMil=0,gapByOwner={},clearancesMil,clearancesByOwner,maxOwnerDistanceMil,orientation,orientationOwnerRefs}) {
  const rules=clearancesByOwner?{clearancesMil,clearancesByOwner}:resolveLabelClearances({clearanceMil,gapByOwner,clearancesMil}),requiredFor=owner=>rules.clearancesByOwner[owner]??rules.clearancesMil;
  const issues=[],gap=(a,b)=>Math.max(a.minX-b.maxX,b.minX-a.maxX,a.minY-b.maxY,b.minY-a.maxY),body=c=>c.body??c.bbox;
  if(orientation!==undefined&&orientation!=='bottom-edge-to-owner')issues.push({code:'FINE_LABEL_ORIENTATION_POLICY'});
  for(const label of labels){
    const owner=components.find(c=>c.ref===label.owner),required=requiredFor(label.owner);
    if(!owner){issues.push({code:'FINE_LABEL_OWNER',id:label.id,owner:label.owner});continue;}
    if(orientation==='bottom-edge-to-owner'&&label.type==='attribute'&&(!orientationOwnerRefs||orientationOwnerRefs.includes(label.owner))){
      const r=((label.rotation%360)+360)%360,q=Math.round(r/90)%4,b=body(owner),cx=(b.minX+b.maxX)/2,cy=(b.minY+b.maxY)/2,a=label.bbox;
      const delta=Math.abs(r-q*90)%360;
      if(!Number.isFinite(r)||Math.min(delta,360-delta)>1e-4)issues.push({code:'FINE_LABEL_ORIENTATION_ANGLE',id:label.id,owner:label.owner,rotation:label.rotation});
      else{
        // Y-up bottom-edge outward normals: -Y, +X, +Y, -X. The
        // owner centre must be strictly beyond that edge; tangent motion
        // stays available for collision repair. Do not fold angles modulo 180.
        const distanceMil=[a.minY-cy,cx-a.maxX,cy-a.maxY,a.minX-cx][q];
        if(distanceMil<=1e-7)issues.push({code:'FINE_LABEL_OWNER_FACING',id:label.id,owner:label.owner,rotation:label.rotation,distanceMil});
      }
    }
    for(const c of components)if(gap(label.bbox,body(c))<required.body-.001)issues.push({code:'FINE_LABEL_BODY_GAP',id:label.id,owner:label.owner,ref:c.ref,gapMil:gap(label.bbox,body(c)),requiredMil:required.body});
    for(const p of pads)if(gap(label.bbox,p.bbox)<required.pad-.001)issues.push({code:'FINE_LABEL_PAD_GAP',id:label.id,owner:label.owner,ref:p.owner??p.ref,padId:p.id,gapMil:gap(label.bbox,p.bbox),requiredMil:required.pad});
    if(maxOwnerDistanceMil!==undefined){const a=label.bbox,b=body(owner),d=Math.abs((a.minX+a.maxX-b.minX-b.maxX)/2)+Math.abs((a.minY+a.maxY-b.minY-b.maxY)/2);if(d>maxOwnerDistanceMil+.001)issues.push({code:'FINE_LABEL_OWNER_DISTANCE',id:label.id,owner:label.owner,distanceMil:d,maxMil:maxOwnerDistanceMil});}
  }
  for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++){const a=labels[i],b=labels[j],required=Math.max(requiredFor(a.owner).label,requiredFor(b.owner).label);if(gap(a.bbox,b.bbox)<required-.001)issues.push({code:'FINE_LABEL_LABEL_GAP',ids:[a.id,b.id],refs:[a.owner,b.owner],gapMil:gap(a.bbox,b.bbox),requiredMil:required});}
  return {valid:!issues.length,issues,representation:'individual native glyph rectangles; body and pad rectangles checked separately'};
}
