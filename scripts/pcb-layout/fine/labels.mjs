import { executeCpSat } from '../pcb-layout-cpsat.mjs';
import { buildGeometryViews } from '../pcb-layout-geometry-views.mjs';
import { layoutLabelAlignment } from '../pcb-layout-provider.mjs';
import { fineLabelRules } from './label-geometry.mjs';
import { fail, digest } from './common.mjs';

/** Reuse the existing numeric backend with immutable bodies and actual glyphs. */
export function compileFineLabels(scope,bodyPlan,settings) {
  const {model,labelMoving,request}=scope,geometry=buildGeometryViews(model.geometryModel,bodyPlan.components,bodyPlan.labels,bodyPlan.testPads),rules=fineLabelRules(model,request.labels);
  const items=model.snapshot.items.filter(l=>labelMoving.has(l.owner)),targets=items.map(l=>'fine-label:'+l.id),zero={minX:0,maxX:0,minY:0,maxY:0};
  const origin={x:model.config.hard.boardBounds.minX,y:model.config.hard.boardBounds.minY};
  const entities=bodyPlan.components.map(c=>({ref:c.ref,id:c.id,kind:'component',base:origin,fixed:true,variants:[{rotation:0,side:null,originOffset:{x:0,y:0},body:zero,bundle:zero,physical:zero,courtyard:zero,boardBox:zero,labels:[],pads:{},padCenters:{centre:{x:(c.body.minX+c.body.maxX)/2-origin.x,y:(c.body.minY+c.body.maxY)/2-origin.y}},views:{body:[zero],physical:[zero],bundle:[zero],placement:[zero],assembly:[],footprint:[],pads:[],operation:[],silkscreen:[]},zones:{}}]}));
  const problem={schemaVersion:1,kind:'flitrealize-cpsat-problem',sourceHash:model.snapshot.sourceHash,units:'mil',board:model.config.hard.boardBounds,settings,entities,pairs:[],assembly:false,links:[],limits:[],nets:[],spacing:[],blocks:[],relations:[],zones:[],noInitialHints:true,skipFeasibilityPhase:true,coverage:{stage:'independent-labels',bodyHash:digest(bodyPlan.components),bodies:'immutable accepted poses',geometry:'native glyph rectangles; fonts and line widths preserved'}};
  // Keep every real body, pad and outside glyph as a constant obstacle; do not
  // recreate their combined blank rectangular envelopes in this stage.
  const obstacles=[...bodyPlan.components.map(c=>({id:'body:'+c.ref,kind:'body',bbox:c.body})),...geometry.pads.map(p=>({id:'pad:'+p.id,kind:'pad',bbox:p.bbox})),...bodyPlan.labels.filter(l=>!labelMoving.has(l.owner)).map(l=>({id:'label:'+l.id,kind:'label',owner:l.owner,bbox:l.bbox}))];
  for(const l of items){const ref='fine-label:'+l.id,required=rules.clearancesByOwner[l.owner];
    for(const obstacle of obstacles){const b=obstacle.bbox,gap=obstacle.kind==='label'?Math.max(required.label,rules.clearancesByOwner[obstacle.owner].label):required[obstacle.kind];problem.zones.push({id:ref+'/'+obstacle.id,mode:'keepout',geometry:'body',box:{minX:b.minX-gap,maxX:b.maxX+gap,minY:b.minY-gap,maxY:b.maxY+gap},excludeRefs:[],targetRefs:[ref]});}
    const facing=rules.orientation==='bottom-edge-to-owner'&&l.type==='attribute',owner=bodyPlan.components.find(c=>c.ref===l.owner).body;
    const variants=(facing?[0,90,180,270]:[0,90]).map(rotation=>{
      const b=[{minX:0,maxX:l.width,minY:0,maxY:l.height},{minX:-l.height,maxX:0,minY:0,maxY:l.width},{minX:-l.width,maxX:0,minY:-l.height,maxY:0},{minX:0,maxX:l.height,minY:-l.width,maxY:0}][rotation/90];
      const ownerFacing=facing?[
        {axis:'y',sign:-1,edgeOffsetMil:b.minY,centerMil:(owner.minY+owner.maxY)/2},
        {axis:'x',sign:1,edgeOffsetMil:b.maxX,centerMil:(owner.minX+owner.maxX)/2},
        {axis:'y',sign:1,edgeOffsetMil:b.maxY,centerMil:(owner.minY+owner.maxY)/2},
        {axis:'x',sign:-1,edgeOffsetMil:b.minX,centerMil:(owner.minX+owner.maxX)/2}
      ][rotation/90]:undefined;
      return {rotation,side:null,originOffset:{x:0,y:0},body:b,bundle:b,physical:b,courtyard:b,boardBox:b,labels:[],pads:{},padCenters:{centre:{x:(b.minX+b.maxX)/2,y:(b.minY+b.maxY)/2}},views:{body:[b],physical:[b],bundle:[b],placement:[b],assembly:[b],footprint:[],pads:[],operation:[],silkscreen:[b]},zones:{},...(ownerFacing?{ownerFacing}:{})};
    });
    entities.push({ref,id:l.id,kind:'component',base:{x:0,y:0},fixed:false,variants});
    // Keep the backend's global minimum padding at zero for the zero-area
    // immutable owner anchors. Actual glyph/glyph gaps remain explicit below;
    // all real bodies and pads remain constant keepout rectangles above.
    problem.pairs.push({a:ref,b:l.owner,gapMil:0,physicalGapMil:0});
    const endpoint=r=>({ref:r,id:'centre',geometry:'bbox-center'});
    problem.links.push({id:'label-owner:'+l.id,left:[endpoint(ref)],right:[endpoint(l.owner)],weight:1});
    if(rules.maxOwnerDistanceMil!==undefined)problem.limits.push({id:'label-owner-cap:'+l.id,left:[endpoint(ref)],right:[endpoint(l.owner)],maxMil:rules.maxOwnerDistanceMil});
  }
  for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++)problem.pairs.push({a:targets[i],b:targets[j],gapMil:Math.max(rules.clearancesByOwner[items[i].owner].label,rules.clearancesByOwner[items[j].owner].label),physicalGapMil:0});
  return {problem,items,rules};
}
export async function solveFineLabels(scope,bodyPlan,settings,runtime,executor=executeCpSat,timing) {
  const compiled=timing?timing.sync('compile',()=>compileFineLabels(scope,bodyPlan,settings)):compileFineLabels(scope,bodyPlan,settings),result=timing?await timing.run('labelSolve',()=>executor(compiled.problem,runtime)):await executor(compiled.problem,runtime);
  if(!['FEASIBLE','OPTIMAL'].includes(result.status))return {status:result.status,solver:result,problem:compiled.problem};
  if(result.sourceHash!==scope.model.snapshot.sourceHash||!Array.isArray(result.placements)||result.placements.length!==compiled.problem.entities.length||new Set(result.placements.map(p=>p.ref)).size!==compiled.problem.entities.length||result.placements.some(p=>!compiled.problem.entities.some(e=>e.ref===p.ref)))fail('FINE_LABEL_RESULT_IDENTITY');
  const alignment=layoutLabelAlignment(scope.model.snapshot).bottomLeft,changed=new Map();
  for(const item of compiled.items){const e=compiled.problem.entities.find(e=>e.id===item.id),p=result.placements.find(p=>p.ref===e.ref),v=e.variants[p.variant];
    if(!v||![p.dx,p.dy,p.variant].every(Number.isSafeInteger))fail('FINE_LABEL_RESULT_POSE',item.id);
    const x=p.dx*settings.resolutionMil,y=p.dy*settings.resolutionMil,b=v.body;
    changed.set(item.id,{id:item.id,type:item.type,owner:item.owner,parentId:item.parentId,text:item.text,fontSize:item.fontSize,lineWidth:item.lineWidth,x,y,rotation:v.rotation,alignMode:alignment,bbox:{minX:b.minX+x,maxX:b.maxX+x,minY:b.minY+y,maxY:b.maxY+y},changed:true});
  }
  for(const p of result.placements){const e=compiled.problem.entities.find(e=>e.ref===p.ref);if(e.fixed&&(p.dx||p.dy||p.variant!==0))fail('FINE_LABEL_BODY_CHANGED',e.ref);}
  return {status:result.status,labels:bodyPlan.labels.map(l=>changed.get(l.id)??l),solver:result,problem:compiled.problem,rules:compiled.rules};
}
