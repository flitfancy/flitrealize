import { sameAngle } from '../pcb-layout-geometry.mjs';

/** Shared offline/native baseline proof. Unknown issues never establish eligibility.
 * Label IDs, bodies and pads are distinct objects; permission to move a label
 * says nothing about whether its owner's body participated in a change. */
export function classifyFineIssues({issues,baselineIssues,before,after,labelMode='joint',baselinePolicy='require-clean',allowMovedIssues=true,mustFix=()=>false}) {
  // Rule/identity values are exact. Only measured geometry has a tolerance.
  // Keep this function self-contained: the native provider embeds its source.
  const toleranceMil=1e-6;
  const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
  const key=v=>JSON.stringify(stable(v));
  const box=b=>b&&['minX','maxX','minY','maxY'].every(k=>Number.isFinite(b[k]))&&b.minX<=b.maxX&&b.minY<=b.maxY;
  const pose=o=>o&&[o.x,o.y,o.rotation].every(Number.isFinite);
  const angle=r=>(r%360+360)%360;
  function sameObject(a,b) {
    if(Number.isFinite(a)&&Number.isFinite(b))return Math.abs(a-b)<=toleranceMil;
    if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>sameObject(v,b[i]));
    if(!a||!b||typeof a!=='object'||typeof b!=='object')return key(a)===key(b);
    return [...new Set([...Object.keys(a),...Object.keys(b)])].every(k=>k==='rotation'?(a[k]===undefined&&b[k]===undefined||sameAngle(a[k],b[k],1e-4)):sameObject(a[k],b[k]));
  }
  function objects(frame) {
    const out=new Map(),components=frame.components??[],labels=frame.labels??[],pads=frame.pads??[];
    for(const c of components)if(c.id&&c.ref&&pose(c)&&box(c.body??c.bbox))out.set('body:'+c.ref,{id:c.id,ref:c.ref,layer:c.layer,x:c.x,y:c.y,rotation:angle(c.rotation),bbox:c.body??c.bbox,padIdentity:pads.filter(p=>(p.owner??p.ref)===c.ref).map(p=>({id:p.id,owner:p.owner??p.ref,number:p.number,net:p.net,layer:p.layer})).sort((p,q)=>String(p.id).localeCompare(String(q.id)))});
    for(const l of labels)if(l.id&&pose(l)&&box(l.bbox))out.set('label:'+l.id,Object.fromEntries(['id','owner','parentId','type','text','x','y','bbox','alignMode','fontSize','lineWidth'].map(k=>[k,l[k]]).concat([['rotation',angle(l.rotation)]])));
    for(const p of pads)if(p.id&&[p.x,p.y].every(Number.isFinite)&&(p.rotation===undefined||Number.isFinite(p.rotation))&&box(p.bbox))out.set('pad:'+p.id,{id:p.id,owner:p.owner??p.ref,number:p.number,net:p.net,layer:p.layer,x:p.x,y:p.y,rotation:p.rotation===undefined?undefined:angle(p.rotation),bbox:p.bbox});
    for(const ref of new Set([...components.map(c=>c.ref),...pads.filter(p=>!p.owner&&!components.some(c=>c.ref===p.ref)).map(p=>p.number??p.ref)])) {
      const body=out.get('body:'+ref),owned=pads.filter(p=>(p.owner??p.ref??p.number)===ref).map(p=>out.get('pad:'+p.id));
      if(components.some(c=>c.ref===ref)&&!body||!body&&!owned.length||owned.some(p=>!p))continue;
      const physical={body,pads:owned.sort((p,q)=>p.id.localeCompare(q.id))};out.set('physical:'+ref,physical);
      const glyphs=labels.filter(l=>l.owner===ref).map(l=>out.get('label:'+l.id));
      if(labelMode==='separate'||glyphs.every(Boolean))out.set('bundle:'+ref,{...physical,labels:labelMode==='separate'?[]:glyphs});
    }
    if(box(frame.boardBounds))out.set('board',frame.boardBounds);
    for(const z of frame.zones??[])if(z.id&&box(z.box))out.set('zone:'+z.id,{id:z.id,owner:z.owner,geometry:z.geometry,box:z.box});
    return out;
  }
  const a=objects(before),b=objects(after);
  const omit=(value,fields)=>Object.fromEntries(Object.entries(value).filter(([k])=>!fields.includes(k)));
  const union=boxes=>boxes.length&&boxes.every(box)?{minX:Math.min(...boxes.map(b=>b.minX)),maxX:Math.max(...boxes.map(b=>b.maxX)),minY:Math.min(...boxes.map(b=>b.minY)),maxY:Math.max(...boxes.map(b=>b.maxY))}:null;
  const identity=o=>o&&typeof o==='object'?Array.isArray(o)?o.map(identity):{...Object.fromEntries(Object.entries(omit(o,['x','y','rotation','bbox','box'])).map(([k,v])=>[k,identity(v)])),...(Object.hasOwn(o,'rotation')?{rotationSupplied:o.rotation!==undefined}:{})}:o;
  const sameIdentity=t=>a.has(t)&&b.has(t)&&key(identity(a.get(t)))===key(identity(b.get(t)));
  const reliableIdentity=t=>{
    const value=a.get(t),pads=value?.padIdentity??value?.body?.padIdentity??value?.pads??(t.startsWith('pad:')?[value]:[]);
    return pads.every(p=>p?.id&&p.number!==undefined&&p.net!==undefined)&&new Set(pads.map(p=>p.id)).size===pads.length;
  };
  function validRectangleChange(old,now){
    if(!old||!now||!box(old.bbox)||!box(now.bbox)||![old.x,old.y,now.x,now.y].every(Number.isFinite))return false;
    const owner=old.number!==undefined&&old.owner?a.get('body:'+old.owner):null,nextOwner=owner?b.get('body:'+old.owner):null;
    const delta=owner&&nextOwner?nextOwner.rotation-owner.rotation:(now.rotation??0)-(old.rotation??0),q=Math.round(delta/90);
    if(!sameAngle(delta,q*90,1e-4))return false;
    const turn=((q%4)+4)%4,points=[[old.bbox.minX,old.bbox.minY],[old.bbox.minX,old.bbox.maxY],[old.bbox.maxX,old.bbox.minY],[old.bbox.maxX,old.bbox.maxY]].map(([x,y])=>{x-=old.x;y-=old.y;const p=[[x,y],[-y,x],[-x,-y],[y,-x]][turn];return {minX:p[0]+now.x,maxX:p[0]+now.x,minY:p[1]+now.y,maxY:p[1]+now.y};});
    const expected=union(points);return ['minX','maxX','minY','maxY'].every(k=>Math.abs(expected[k]-now.bbox[k])<=toleranceMil);
  }
  function validGeometry(t){
    const old=a.get(t),now=b.get(t);
    if(t==='board'||t.startsWith('zone:'))return true;
    if(old?.bbox)return validRectangleChange(old,now);
    if(old?.body&&!validRectangleChange(old.body,now?.body))return false;
    return ['pads','labels'].every(k=>(old?.[k]??[]).every(p=>{const q=now?.[k]?.find(q=>q.id===p.id);return validRectangleChange(p,q);}));
  }
  function bounds(objects,token){const o=objects.get(token);return !o?null:o.bbox??(o.body||o.pads?union([...(o.body?[o.body.bbox]:[]),...(!token.startsWith('bundle:')||!o.body?o.pads??[]:[]).map(p=>p.bbox),...(o.labels??[]).map(l=>l.bbox)]):o.box);}
  function rectangleMeasures(x,y){
    if(!box(x)||!box(y))return null;
    const overlapXMil=Math.max(0,Math.min(x.maxX,y.maxX)-Math.max(x.minX,y.minX)),overlapYMil=Math.max(0,Math.min(x.maxY,y.maxY)-Math.max(x.minY,y.minY));
    return {gapMil:Math.max(x.minX-y.maxX,y.minX-x.maxX,x.minY-y.maxY,y.minY-x.maxY),overlapXMil:overlapXMil&&overlapYMil?overlapXMil:0,overlapYMil:overlapXMil&&overlapYMil?overlapYMil:0,
      penetrationXMil:overlapXMil&&overlapYMil?Math.min(x.maxX-y.minX,y.maxX-x.minX):0,penetrationYMil:overlapXMil&&overlapYMil?Math.min(x.maxY-y.minY,y.maxY-x.minY):0};
  }
  const finite=(...values)=>values.every(Number.isFinite);
  const notLess=(now,old)=>finite(now,old)&&now>=old-toleranceMil;
  const notMore=(now,old)=>finite(now,old)&&now<=old+toleranceMil;
  const overlapFields=['overlapXMil','overlapYMil','penetrationXMil','penetrationYMil'];
  const overlapOK=(now,old)=>overlapFields.every(k=>now[k]>=0&&old[k]>=0&&notMore(now[k],old[k]));
  const gapFields=['gapMil','mil'];
  const metrics=i=>['FINE_LABEL_BODY_GAP','FINE_LABEL_PAD_GAP','FINE_LABEL_LABEL_GAP','MIN_CLEARANCE_UNSATISFIED','BUNDLE_CLEARANCE','ASSEMBLY_PHYSICAL_CLEARANCE','FINE_PHYSICAL_GAP'].includes(i.code)?gapFields:
    i.code==='ASSEMBLY_COURTYARD_OVERLAP'?overlapFields:i.code==='ASSEMBLY_SPACING_HARD_LIMIT'?['distanceMil','from','to','fit','ratio','penalty']:
    ['FINE_LABEL_OWNER_DISTANCE','PIN_DISTANCE_LIMIT','BLOCK_DISTANCE_EXCEEDED','BLOCK_COUPLING_DISTANCE_LIMIT','SPATIAL_DISTANCE_LIMIT'].includes(i.code)?['distanceMil','mil','blockCenter','satisfied']:
    i.code==='SPATIAL_KEEPOUT'?['box','shapes',...overlapFields]:i.code==='ASSEMBLY_DIRECTIONAL_CLEARANCE'?['physicalGapsMil','courtyardGapsMil']:
    i.code==='ASSEMBLY_COURTYARD_UNDERSIZED'?['physical','courtyard']:['BOARD_BOUNDARY_VIOLATION','FINE_LABEL_BOARD_BOUNDARY'].includes(i.code)?['bbox']:[];
  const issueIdentity=i=>{
    const value=omit(i,metrics(i));
    // Spacing thresholds below are derived from transformed courtyard bounds.
    // Compare them with geometric tolerance only when exact source rules bind
    // both frames; requirement/absolute-floor sources remain exact identities.
    if(i.code==='ASSEMBLY_SPACING_HARD_LIMIT'&&before.rules!==undefined&&after.rules!==undefined){
      for(const k of ['marginMil','hardMinMil','baselineMil','neutralMinMil','neutralMaxMil'])delete value[k];
      if(value.sources)value.sources=value.sources.map(s=>s.type==='assembly-courtyard'?omit(s,['hardMinimumMil']):s);
    }
    return key(value);
  };
  const pair=i=>i.refs??[i.a,i.b];
  function participants(i) {
    switch(i.code) {
      case 'FINE_LABEL_BODY_GAP':return ['label:'+i.id,'body:'+i.ref];
      case 'FINE_LABEL_PAD_GAP':return ['label:'+i.id,'pad:'+i.padId];
      case 'FINE_LABEL_LABEL_GAP':return i.ids?.length===2?i.ids.map(id=>'label:'+id):[];
      case 'FINE_LABEL_OWNER_DISTANCE':return ['label:'+i.id,'body:'+i.owner];
      case 'FINE_LABEL_OWNER_FACING':case 'FINE_LABEL_ORIENTATION_ANGLE':return ['label:'+i.id,'body:'+i.owner];
      case 'FINE_LABEL_BOARD_BOUNDARY':return ['label:'+i.id,'board'];
      case 'BOARD_BOUNDARY_VIOLATION':return i.kind==='label'?['label:'+i.id,'board']:i.kind==='pad'?['pad:'+i.id,'board']:i.kind==='component'?['body:'+i.ref,'board']:i.kind==='placement'?['bundle:'+i.ref,'board']:[];
      case 'MIN_CLEARANCE_UNSATISFIED':return pair(i).length===2?pair(i).map(ref=>'bundle:'+ref):[];
      case 'BUNDLE_CLEARANCE':return pair(i).length===2?pair(i).map(ref=>(labelMode==='separate'?'physical:':'bundle:')+ref):[];
      case 'ASSEMBLY_COURTYARD_OVERLAP':case 'ASSEMBLY_PHYSICAL_CLEARANCE':case 'ASSEMBLY_DIRECTIONAL_CLEARANCE':return pair(i).length===2?pair(i).map(ref=>'physical:'+ref):[];
      case 'ASSEMBLY_COURTYARD_UNDERSIZED':return ['physical:'+i.ref];
      case 'ASSEMBLY_SPACING_HARD_LIMIT':case 'FINE_PHYSICAL_GAP':return pair(i).length===2?pair(i).map(ref=>'physical:'+ref):[];
      case 'PIN_DISTANCE_LIMIT':return i.refs?.length?i.refs.map(ref=>'physical:'+ref):[];
      case 'BLOCK_COUPLING_DISTANCE_LIMIT':return i.refs?.length?i.refs.map(ref=>'physical:'+ref):[];
      case 'BLOCK_DISTANCE_EXCEEDED':return i.anchors?.length?[i.ref,...i.anchors].map(ref=>'body:'+ref):[];
      case 'SPATIAL_DISTANCE_LIMIT':return i.anchors?.length?[i.ref,...i.anchors].map(ref=>(i.metric==='bundle-gap'?'bundle:':'physical:')+ref):[];
      case 'SPATIAL_KEEPOUT':return i.ref?['physical:'+i.ref,'zone:'+i.id,...(i.owner?['physical:'+i.owner]:[]),...(['bundle','placement','silkscreen'].includes(i.geometry)?(before.labels??[]).filter(l=>l.owner===i.ref).map(l=>'label:'+l.id):[])]:[];
      case 'EDGE_CONSTRAINT_UNSATISFIED':return ['body:'+i.ref,'board'];
      default:return [];
    }
  }
  function nonWorsening(now,old,tokens){
    const fields=metrics(now);
    if(!fields.length)return null;
    if(fields===gapFields||now.code==='ASSEMBLY_SPACING_HARD_LIMIT'){
      if(tokens.length!==2)return null;
      const prior=rectangleMeasures(...tokens.map(t=>bounds(a,t))),current=rectangleMeasures(...tokens.map(t=>bounds(b,t)));
      if(!prior||!current||!overlapOK(current,prior)||!notLess(current.gapMil,prior.gapMil))return null;
      if(now.code==='ASSEMBLY_SPACING_HARD_LIMIT'&&before.rules!==undefined&&after.rules!==undefined&&['marginMil','hardMinMil','baselineMil','neutralMinMil','neutralMaxMil'].some(k=>!finite(now[k],old[k])||Math.abs(now[k]-old[k])>toleranceMil))return null;
      const distance=now.code==='ASSEMBLY_SPACING_HARD_LIMIT'?'distanceMil':now.mil!==undefined?'mil':'gapMil';
      if(!notLess(now[distance],old[distance]))return null;
      if(now.code!=='ASSEMBLY_SPACING_HARD_LIMIT'&&(!notMore(Math.abs(now[distance]-current.gapMil),0)||!notMore(Math.abs(old[distance]-prior.gapMil),0)))return null;
      return {metric:'rectangle-gap-and-axis-penetration',before:prior,after:current};
    }
    if(now.code==='ASSEMBLY_COURTYARD_OVERLAP')return overlapOK(now,old)?{metric:'intersection-and-separation-depth-per-axis',before:Object.fromEntries(overlapFields.map(k=>[k,old[k]])),after:Object.fromEntries(overlapFields.map(k=>[k,now[k]]))}:null;
    if(now.code==='ASSEMBLY_DIRECTIONAL_CLEARANCE'){
      const deficit=i=>Array.from({length:4},(_,k)=>Math.max(0,i.hardMinMil-i.physicalGapsMil?.[k],-i.courtyardGapsMil?.[k]));
      const prior=deficit(old),current=deficit(now);return current.every((v,k)=>notMore(v,prior[k]))?{metric:'shared-direction-deficits',before:prior,after:current}:null;
    }
    if(['ASSEMBLY_COURTYARD_UNDERSIZED','BOARD_BOUNDARY_VIOLATION','FINE_LABEL_BOARD_BOUNDARY'].includes(now.code)){
      const overflow=(inner,outer)=>box(inner)&&box(outer)?[Math.max(0,outer.minX-inner.minX),Math.max(0,inner.maxX-outer.maxX),Math.max(0,outer.minY-inner.minY),Math.max(0,inner.maxY-outer.maxY)]:null;
      const prior=overflow(old.physical??old.bbox,old.courtyard??before.boardBounds),current=overflow(now.physical??now.bbox,now.courtyard??after.boardBounds);
      return prior&&current&&current.every((v,k)=>notMore(v,prior[k]))?{metric:'containment-overflow-per-side',before:prior,after:current}:null;
    }
    if(now.code==='SPATIAL_KEEPOUT'){
      // Each target/shape must have its own proof; aggregate area is insufficient.
      if(!Array.isArray(now.shapes)||!now.shapes.length||now.shapes.length!==old.shapes?.length)return null;
      const valid=now.shapes.every(s=>{const p=old.shapes.find(p=>p.id===s.id);return p&&overlapOK(s,p);});
      return valid?{metric:'keepout-per-shape-axis-penetration',before:old.shapes,after:now.shapes}:null;
    }
    if(['PIN_DISTANCE_LIMIT','BLOCK_COUPLING_DISTANCE_LIMIT'].includes(now.code)&&(!now.endpoints||!old.endpoints))return null;
    const field=now.mil!==undefined?'mil':'distanceMil';
    if(now.code==='SPATIAL_DISTANCE_LIMIT'){
      const deficit=i=>[Math.max(0,(i.band.hardMinMil??-Infinity)-i.distanceMil),Math.max(0,i.distanceMil-(i.band.hardMaxMil??Infinity))];
      return finite(now.distanceMil,old.distanceMil)&&deficit(now).every((v,k)=>notMore(v,deficit(old)[k]))?{metric:'distance-band-deficits',before:deficit(old),after:deficit(now)}:null;
    }
    return notMore(now[field],old[field])?{metric:'maximum-distance',before:old[field],after:now[field]}:null;
  }
  const retainedOutsideIssues=[],retainedOutsideProofs=[],blockingIssues=[];
  for(const issue of issues) {
    const tokens=participants(issue),unchanged=tokens.length>0&&tokens.every(t=>a.has(t)&&b.has(t)&&sameObject(a.get(t),b.get(t)));
    const matches=baselineIssues.filter(old=>issueIdentity(old)===issueIdentity(issue));
    const old=matches.length===1?matches[0]:null,rulesUnchanged=key(before.rules)===key(after.rules);
    const measurement=old&&(allowMovedIssues||unchanged)&&tokens.length&&tokens.every(t=>sameIdentity(t)&&reliableIdentity(t)&&validGeometry(t))&&rulesUnchanged?nonWorsening(issue,old,tokens):null;
    const proven=!mustFix(issue)&&rulesUnchanged&&old&&tokens.every(t=>sameIdentity(t)&&reliableIdentity(t))&&((unchanged&&key(issue)===key(old))||measurement);
    if(proven){retainedOutsideIssues.push(issue);retainedOutsideProofs.push({issue,objects:tokens,baselineMatched:true,geometryUnchanged:unchanged,proof:measurement?'per-issue-non-worsening':'unchanged-participants',...(measurement?{measurement,toleranceMil}:{})});}
    if(baselinePolicy!=='retain-outside-issues'||!proven)blockingIssues.push(issue);
  }
  return {blockingIssues,retainedOutsideIssues,retainedOutsideProofs,changedObjects:[...new Set([...a.keys(),...b.keys()])].filter(t=>!sameObject(a.get(t),b.get(t)))};
}
