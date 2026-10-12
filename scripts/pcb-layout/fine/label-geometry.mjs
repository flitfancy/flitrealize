import { labelTemplate } from '../pcb-layout-label-policy.mjs';

export function fineLabelRules(model,policy) {
  const clearanceMil=policy.clearanceMil??model.mechanical.clearanceMil;
  return {clearanceMil,gapByOwner:Object.fromEntries([...model.components.values()].map(c=>[c.ref,Math.max(clearanceMil,labelTemplate(c,model.mechanical).minGapMil)])),maxOwnerDistanceMil:policy.maxOwnerDistanceMil};
}
/** One pure checker shared by offline acceptance and generated native preflight. */
export function independentLabelGeometry({components,pads,labels,clearanceMil=0,gapByOwner={},maxOwnerDistanceMil}) {
  const issues=[],gap=(a,b)=>Math.max(a.minX-b.maxX,b.minX-a.maxX,a.minY-b.maxY,b.minY-a.maxY),body=c=>c.body??c.bbox;
  for(const label of labels){
    const owner=components.find(c=>c.ref===label.owner),required=gapByOwner[label.owner]??clearanceMil;
    if(!owner){issues.push({code:'FINE_LABEL_OWNER',id:label.id,owner:label.owner});continue;}
    for(const c of components)if(gap(label.bbox,body(c))<required-.001)issues.push({code:'FINE_LABEL_BODY_GAP',id:label.id,owner:label.owner,ref:c.ref,gapMil:gap(label.bbox,body(c)),requiredMil:required});
    for(const p of pads)if(gap(label.bbox,p.bbox)<required-.001)issues.push({code:'FINE_LABEL_PAD_GAP',id:label.id,owner:label.owner,ref:p.owner??p.ref,padId:p.id,gapMil:gap(label.bbox,p.bbox),requiredMil:required});
    if(maxOwnerDistanceMil!==undefined){const a=label.bbox,b=body(owner),d=Math.abs((a.minX+a.maxX-b.minX-b.maxX)/2)+Math.abs((a.minY+a.maxY-b.minY-b.maxY)/2);if(d>maxOwnerDistanceMil+.001)issues.push({code:'FINE_LABEL_OWNER_DISTANCE',id:label.id,owner:label.owner,distanceMil:d,maxMil:maxOwnerDistanceMil});}
  }
  for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++){const a=labels[i],b=labels[j],required=Math.max(gapByOwner[a.owner]??clearanceMil,gapByOwner[b.owner]??clearanceMil);if(gap(a.bbox,b.bbox)<required-.001)issues.push({code:'FINE_LABEL_LABEL_GAP',ids:[a.id,b.id],refs:[a.owner,b.owner],gapMil:gap(a.bbox,b.bbox),requiredMil:required});}
  return {valid:!issues.length,issues,representation:'individual native glyph rectangles; body and pad rectangles checked separately'};
}
