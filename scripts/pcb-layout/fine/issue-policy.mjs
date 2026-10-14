import { sameAngle } from '../pcb-layout-geometry.mjs';

/** Shared offline/native baseline proof. Unknown issues never establish eligibility.
 * Label IDs, bodies and pads are distinct objects; permission to move a label
 * says nothing about whether its owner's body participated in a change. */
export function classifyFineIssues({issues,baselineIssues,before,after,labelMode='joint',baselinePolicy='require-clean'}) {
  const stable=v=>typeof v==='number'?Math.round(v*10000)/10000:Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
  const key=v=>JSON.stringify(stable(v));
  const box=b=>b&&['minX','maxX','minY','maxY'].every(k=>Number.isFinite(b[k]))&&b.minX<=b.maxX&&b.minY<=b.maxY;
  const pose=o=>o&&[o.x,o.y,o.rotation].every(Number.isFinite);
  const angle=r=>(r%360+360)%360;
  function sameObject(a,b) {
    if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>sameObject(v,b[i]));
    if(!a||!b||typeof a!=='object'||typeof b!=='object')return key(a)===key(b);
    return [...new Set([...Object.keys(a),...Object.keys(b)])].every(k=>k==='rotation'?(a[k]===undefined&&b[k]===undefined||sameAngle(a[k],b[k],1e-4)):sameObject(a[k],b[k]));
  }
  function objects(frame) {
    const out=new Map(),components=frame.components??[],labels=frame.labels??[],pads=frame.pads??[];
    for(const c of components)if(c.ref&&pose(c)&&box(c.body??c.bbox))out.set('body:'+c.ref,{id:c.id,ref:c.ref,x:c.x,y:c.y,rotation:angle(c.rotation),bbox:c.body??c.bbox});
    for(const l of labels)if(l.id&&pose(l)&&box(l.bbox))out.set('label:'+l.id,Object.fromEntries(['id','owner','parentId','type','text','x','y','bbox','alignMode','fontSize','lineWidth'].map(k=>[k,l[k]]).concat([['rotation',angle(l.rotation)]])));
    for(const p of pads)if(p.id&&[p.x,p.y].every(Number.isFinite)&&(p.rotation===undefined||Number.isFinite(p.rotation))&&box(p.bbox))out.set('pad:'+p.id,{id:p.id,owner:p.owner??p.ref,number:p.number,net:p.net,x:p.x,y:p.y,rotation:p.rotation===undefined?undefined:angle(p.rotation),bbox:p.bbox});
    for(const ref of new Set([...components.map(c=>c.ref),...pads.filter(p=>!p.owner&&!components.some(c=>c.ref===p.ref)).map(p=>p.number??p.ref)])) {
      const body=out.get('body:'+ref),owned=pads.filter(p=>(p.owner??p.ref??p.number)===ref).map(p=>out.get('pad:'+p.id));
      if(components.some(c=>c.ref===ref)&&!body||!body&&!owned.length||owned.some(p=>!p))continue;
      const physical={body,pads:owned};out.set('physical:'+ref,physical);
      const glyphs=labels.filter(l=>l.owner===ref).map(l=>out.get('label:'+l.id));
      if(labelMode==='separate'||glyphs.every(Boolean))out.set('bundle:'+ref,{...physical,labels:labelMode==='separate'?[]:glyphs});
    }
    if(box(frame.boardBounds))out.set('board',frame.boardBounds);
    return out;
  }
  const a=objects(before),b=objects(after),oldKeys=new Set(baselineIssues.map(key));
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
      case 'MIN_CLEARANCE_UNSATISFIED':case 'BUNDLE_CLEARANCE':return pair(i).length===2?pair(i).map(ref=>'bundle:'+ref):[];
      case 'ASSEMBLY_COURTYARD_OVERLAP':case 'ASSEMBLY_PHYSICAL_CLEARANCE':case 'ASSEMBLY_DIRECTIONAL_CLEARANCE':return pair(i).length===2?pair(i).map(ref=>'physical:'+ref):[];
      case 'ASSEMBLY_COURTYARD_UNDERSIZED':return ['physical:'+i.ref];
      case 'ASSEMBLY_SPACING_HARD_LIMIT':return pair(i).length===2?pair(i).map(ref=>'bundle:'+ref):[];
      case 'PIN_DISTANCE_LIMIT':return i.refs?.length?i.refs.map(ref=>'physical:'+ref):[];
      case 'BLOCK_DISTANCE_EXCEEDED':return i.anchors?.length?[i.ref,...i.anchors].map(ref=>'body:'+ref):[];
      case 'EDGE_CONSTRAINT_UNSATISFIED':return ['body:'+i.ref,'board'];
      default:return [];
    }
  }
  const retainedOutsideIssues=[],retainedOutsideProofs=[],blockingIssues=[];
  for(const issue of issues) {
    const tokens=participants(issue),unchanged=tokens.length>0&&tokens.every(t=>a.has(t)&&b.has(t)&&sameObject(a.get(t),b.get(t)));
    const proven=oldKeys.has(key(issue))&&unchanged;
    if(proven){retainedOutsideIssues.push(issue);retainedOutsideProofs.push({issue,objects:tokens,baselineMatched:true,geometryUnchanged:true});}
    if(baselinePolicy!=='retain-outside-issues'||!proven)blockingIssues.push(issue);
  }
  return {blockingIssues,retainedOutsideIssues,retainedOutsideProofs,changedObjects:[...new Set([...a.keys(),...b.keys()])].filter(t=>!sameObject(a.get(t),b.get(t)))};
}
