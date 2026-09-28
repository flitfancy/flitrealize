// Finite shape catalog migrated from the project gravity-packing prototype.
// Deformations preserve each member's ordering toward the chosen anchor.

const copy = objects => objects.map(o => ({...o,bbox:{...o.bbox}}));
const boxUnion = boxes => ({minX:Math.min(...boxes.map(b=>b.minX)),maxX:Math.max(...boxes.map(b=>b.maxX)),
  minY:Math.min(...boxes.map(b=>b.minY)),maxY:Math.max(...boxes.map(b=>b.maxY))});
const overlaps = (a,b) => a.minX<b.maxX-.0001 && a.maxX>b.minX+.0001 && a.minY<b.maxY-.0001 && a.maxY>b.minY+.0001;
function shift(o,axis,distance){o[axis]+=distance;o.bbox[`min${axis.toUpperCase()}`]+=distance;o.bbox[`max${axis.toUpperCase()}`]+=distance}
function compress(objects,anchorRef,axis){
  const anchor=objects.find(o=>o.ref===anchorRef);
  const low=`min${axis.toUpperCase()}`,high=`max${axis.toUpperCase()}`,otherAxis=axis==='x'?'y':'x',
    otherLow=`min${otherAxis.toUpperCase()}`,otherHigh=`max${otherAxis.toUpperCase()}`;
  for(const o of objects.filter(o=>o.ref!==anchorRef).sort((a,b)=>Math.abs(a[axis]-anchor[axis])-Math.abs(b[axis]-anchor[axis])||a.ref.localeCompare(b.ref))){
    const dir=Math.sign(anchor[axis]-o[axis]);if(!dir)continue;
    let limit=Math.abs(anchor[axis]-o[axis]);
    for(const n of objects){
      if(n===o)continue;
      const centerGap=dir*(n[axis]-o[axis]);
      if(centerGap>0)limit=Math.min(limit,centerGap);
      const perpendicular=o.bbox[otherLow]<n.bbox[otherHigh]-.0001 && o.bbox[otherHigh]>n.bbox[otherLow]+.0001;
      if(!perpendicular)continue;
      const gap=dir>0?n.bbox[low]-o.bbox[high]:o.bbox[low]-n.bbox[high];
      if(gap>=-.0001)limit=Math.min(limit,Math.max(0,gap));
    }
    if(limit>.001)shift(o,axis,dir*limit);
  }
}
function rotatePoint(x,y,pivot,delta){
  const a=((delta%360)+360)%360,dx=x-pivot.x,dy=y-pivot.y;
  if(a===0)return{x,y};if(a===90)return{x:pivot.x-dy,y:pivot.y+dx};
  if(a===180)return{x:pivot.x-dx,y:pivot.y-dy};
  if(a===270)return{x:pivot.x+dy,y:pivot.y-dx};
  throw Error(`Unsupported quarter turn: ${delta}`);
}
function rotateBox(box,pivot,delta){
  const corners=[[box.minX,box.minY],[box.minX,box.maxY],[box.maxX,box.minY],[box.maxX,box.maxY]]
    .map(([x,y])=>rotatePoint(x,y,pivot,delta));
  return boxUnion(corners.map(p=>({minX:p.x,maxX:p.x,minY:p.y,maxY:p.y})));
}
function internalValid(objects){
  for(let i=0;i<objects.length;i++)for(let j=i+1;j<objects.length;j++)if(overlaps(objects[i].bbox,objects[j].bbox))return false;
  return true;
}
export function buildShapeLibrary(units,current,{rotationDeltas,allowedRotationDeltasByRef={}}){
  if(!Array.isArray(rotationDeltas)||!rotationDeltas.length||rotationDeltas.some(d=>![0,90,180,270].includes(d)))throw Error('INVALID_ROTATION_DELTAS');
  const componentRefs=new Set(current.components.map(c=>c.ref));
  const poses=new Map([...current.components.map(c=>[c.ref,{x:c.x,y:c.y,rotation:c.rotation}]),
    ...current.pads.filter(p=>!p.owner).map(p=>[p.number,{x:p.x,y:p.y,rotation:0}])]);
  const summaries=[];
  for(const unit of units){
    const original=unit.refs.map((ref,i)=>({ref,...poses.get(ref),bbox:{...unit.boxes[i]}}));
    if(original.some(o=>!Number.isFinite(o.x)||!Number.isFinite(o.y)))throw Error(`Missing pose in ${unit.id}`);
    if(!internalValid(original))throw Error(`Original unit overlaps: ${unit.id}`);
    const allowed=(unit.fixed?[0]:rotationDeltas).filter(delta=>unit.refs.every(ref=>(componentRefs.has(ref)||delta===0)&&
      (!allowedRotationDeltasByRef[ref]||allowedRotationDeltasByRef[ref].includes(delta))));
    const modes=unit.fixed||unit.refs.length===1?['rigid']:['rigid','compress-x','compress-y','compress-xy'];
    const variants=[],seen=new Set();
    for(const mode of modes){
      const deformed=copy(original);
      if(mode.includes('x'))compress(deformed,unit.anchorRef,'x');
      if(mode.includes('y'))compress(deformed,unit.anchorRef,'y');
      if(!internalValid(deformed))throw Error(`Deformation overlaps: ${unit.id}/${mode}`);
      const pivot=deformed.find(o=>o.ref===unit.anchorRef);
      for(const delta of allowed){
        const objects=deformed.map(o=>{
          const pose=rotatePoint(o.x,o.y,pivot,delta);
          return{ref:o.ref,x:pose.x,y:pose.y,rotation:(o.rotation+delta+360)%360,bbox:rotateBox(o.bbox,pivot,delta)};
        });
        if(!internalValid(objects))throw Error(`Rotated variant overlaps: ${unit.id}/${mode}/${delta}`);
        const key=objects.map(o=>[o.ref,...['minX','minY','maxX','maxY'].map(k=>Math.round(o.bbox[k]*1000)),Math.round(o.rotation*1000)]).join('|');
        if(seen.has(key))continue;seen.add(key);
        variants.push({name:`${mode}@${delta}`,deformation:mode,rotationDelta:delta,
          refs:unit.refs,objects,boxes:objects.map(o=>o.bbox),bbox:boxUnion(objects.map(o=>o.bbox)),
          alterationCost:(mode==='rigid'?0:1)+(delta===0?0:1)});
      }
    }
    unit.variants=variants;
    summaries.push({id:unit.id,refs:unit.refs,anchorRef:unit.anchorRef,variantCount:variants.length,
      variants:variants.map(v=>({name:v.name,deformation:v.deformation,rotationDelta:v.rotationDelta,
        widthMil:v.bbox.maxX-v.bbox.minX,heightMil:v.bbox.maxY-v.bbox.minY,
        members:v.objects.map(o=>({ref:o.ref,xMil:o.x-v.bbox.minX,yMil:o.y-v.bbox.minY,rotation:o.rotation,
          bboxMil:{minX:o.bbox.minX-v.bbox.minX,maxX:o.bbox.maxX-v.bbox.minX,
            minY:o.bbox.minY-v.bbox.minY,maxY:o.bbox.maxY-v.bbox.minY}}))}))});
  }
  return summaries;
}
