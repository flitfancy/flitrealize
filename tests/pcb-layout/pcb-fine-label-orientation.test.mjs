import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareFixture } from '../helpers/pcb-layout-prepare-fixture.mjs';
import { fixture as nativeFixture } from '../helpers/pcb-layout-execution-fixture.mjs';
import { prepareLayoutInputs } from '../../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { normalizeFineRequest } from '../../scripts/pcb-layout/fine/request.mjs';
import { compileFineProblem } from '../../scripts/pcb-layout/fine/compile.mjs';
import { compileFineLabels, solveFineLabels } from '../../scripts/pcb-layout/fine/labels.mjs';
import { independentLabelGeometry } from '../../scripts/pcb-layout/fine/label-geometry.mjs';
import { normalizeExternalFinePlan, auditFineCandidate } from '../../scripts/pcb-layout/fine/audit.mjs';
import { classifyFineIssues } from '../../scripts/pcb-layout/fine/issue-policy.mjs';
import { solveFineLayout } from '../../scripts/pcb-layout/fine/workflow.mjs';
import { executeCpSat } from '../../scripts/pcb-layout/pcb-layout-cpsat.mjs';
import { inspectLayout, preflightLayout, applyLayout } from '../../scripts/pcb-layout/pcb-layout-execution.mjs';
import { transformBox } from '../../scripts/pcb-layout/pcb-layout-geometry.mjs';

const orientation='bottom-edge-to-owner';
const settings={resolutionMil:.5,timeLimitSeconds:3,workers:1,seed:92701,displacementWeight:0};
const runtime=()=>{assert.ok(process.env.FLITREALIZE_CPSAT_PYTHON,'Set the existing OR-Tools interpreter explicitly; do not fall back to system Python');return {pythonPath:process.env.FLITREALIZE_CPSAT_PYTHON};};
const shift=(b,dx,dy)=>({minX:b.minX+dx,maxX:b.maxX+dx,minY:b.minY+dy,maxY:b.maxY+dy});
function inputs(){
  const f=prepareFixture(200);f.config.hard.boardBounds={minX:0,maxX:400,minY:0,maxY:240};
  for(const c of f.snapshot.components){c.x+=100;c.y+=100;c.bbox=shift(c.bbox,100,100);}
  for(const p of f.snapshot.pads){p.x+=100;p.y+=100;p.bbox=shift(p.bbox,100,100);}
  for(const l of f.snapshot.items){l.original.x+=100;l.original.y+=100;l.original.bbox=shift(l.original.bbox,100,100);}
  return f;
}
function setup(labels={mode:'separate',orientation}){
  const f=inputs(),request={schemaVersion:1,movableRefs:['U1'],region:{mode:'available-space',basis:'Synthetic orientation test'},labels,objective:{retainSource:false}};
  const scope=normalizeFineRequest(prepareLayoutInputs(f).model,request),compilation=compileFineProblem(scope,settings);
  return {f,request,scope,compilation,body:compilation.baseline.plan};
}
function glyph(old,rotation,x,y){return {...old,x,y,rotation,alignMode:3,bbox:transformBox({minX:0,maxX:old.width??20,minY:0,maxY:old.height??10},{x:0,y:0,rotation:0},{x,y,rotation})};}
function restrict(problem,window){
  const b=problem.board,boxes=[{minX:b.minX,maxX:window.minX,minY:b.minY,maxY:b.maxY},{minX:window.maxX,maxX:b.maxX,minY:b.minY,maxY:b.maxY},{minX:b.minX,maxX:b.maxX,minY:b.minY,maxY:window.minY},{minX:b.minX,maxX:b.maxX,minY:window.maxY,maxY:b.maxY}];
  for(const [i,box] of boxes.entries())problem.zones.push({id:'test-window:'+i,mode:'keepout',geometry:'body',box,excludeRefs:[],targetRefs:problem.entities.filter(e=>!e.fixed).map(e=>e.ref)});
}
const sides=[
  {rotation:0,x:90,y:130,window:{minX:90,maxX:110,minY:130,maxY:190}},
  {rotation:90,x:70,y:90,window:{minX:10,maxX:70,minY:90,maxY:110}},
  {rotation:180,x:110,y:70,window:{minX:90,maxX:110,minY:10,maxY:70}},
  {rotation:270,x:130,y:110,window:{minX:130,maxX:190,minY:90,maxY:110}}
];

test('four sides face the owner with distinct bottom-edge normals; reverse and radial angles fail',()=>{
  const {body,scope}=setup(),old=scope.model.snapshot.items[0];
  for(const side of sides){
    const label=glyph(old,side.rotation,side.x,side.y),args={components:body.components,pads:[],labels:[label],clearanceMil:8,orientation};
    assert.equal(independentLabelGeometry(args).valid,true,JSON.stringify(side));
    const bad=independentLabelGeometry({...args,labels:[{...label,rotation:(side.rotation+180)%360}]});
    assert.ok(bad.issues.some(i=>i.code==='FINE_LABEL_OWNER_FACING'));
    assert.ok(independentLabelGeometry({...args,labels:[{...label,rotation:45}]}).issues.some(i=>i.code==='FINE_LABEL_ORIENTATION_ANGLE'));
  }
});

test('owner motion changes the facing check and compilation uses the accepted body centre',()=>{
  const {body,scope}=setup(),old=scope.model.snapshot.items[0],label=glyph(old,0,90,130);
  const moved=structuredClone(body);moved.components[0].body=shift(moved.components[0].body,0,80);moved.components[0].y+=80;
  assert.ok(independentLabelGeometry({components:moved.components,pads:[],labels:[label],orientation}).issues.some(i=>i.code==='FINE_LABEL_OWNER_FACING'));
  const compiled=compileFineLabels(scope,moved,settings),e=compiled.problem.entities.find(e=>!e.fixed);
  assert.equal(e.variants[0].ownerFacing.centerMil,180);assert.equal(e.variants[2].ownerFacing.centerMil,180);
});

test('old requests retain two angles; orientation validates its mode and does not expand permissions',()=>{
  const old=setup({mode:'separate'}),legacy=compileFineLabels(old.scope,old.body,settings);
  assert.deepEqual(legacy.problem.entities.find(e=>!e.fixed).variants.map(v=>v.rotation),[0,90]);
  assert.ok(legacy.problem.entities.every(e=>e.variants.every(v=>!v.ownerFacing)));
  const facing=setup(),compiled=compileFineLabels(facing.scope,facing.body,settings);
  assert.deepEqual(compiled.items.map(l=>l.owner),['U1']);assert.deepEqual(compiled.problem.entities.find(e=>!e.fixed).variants.map(v=>v.rotation),[0,90,180,270]);
  assert.throws(()=>normalizeFineRequest(facing.scope.model,{...facing.request,labels:{mode:'joint',orientation}}),/FINE_SEPARATE_LABEL_ORIENTATION_REQUIRED/);
  assert.throws(()=>normalizeFineRequest(facing.scope.model,{...facing.request,labels:{mode:'separate',orientation:'radial'}}),/FINE_INVALID_LABEL_POLICY/);
  const l=glyph(facing.scope.model.snapshot.items[0],180,90,130);
  assert.equal(independentLabelGeometry({components:facing.body.components,pads:[],labels:[l]}).valid,true);
});

test('functional strings keep their original angle domain and locked labels cannot gain permission',()=>{
  const {f,request}=setup();f.snapshot.items.push({...structuredClone(f.snapshot.items[0]),id:'functional-note',type:'string',parentId:null,text:'NOTE'});
  const scope=normalizeFineRequest(prepareLayoutInputs(f).model,request),body=compileFineProblem(scope,settings).baseline.plan,p=compileFineLabels(scope,body,settings).problem;
  assert.deepEqual(p.entities.find(e=>e.id==='functional-note').variants.map(v=>v.rotation),[0,90]);
  f.snapshot.items[0].locked=true;assert.throws(()=>normalizeFineRequest(prepareLayoutInputs(f).model,request),/FINE_LOCKED_LABEL_OWNER/);
});

test('outside labels are preserved; explicit additional owner permission remains label-only',async()=>{
  const {scope,body}=setup({mode:'separate',orientation,additionalOwnerRefs:['C1']}),before=structuredClone(body);
  const result=await solveFineLabels(scope,body,settings,{},async p=>({status:'FEASIBLE',sourceHash:p.sourceHash,placements:p.entities.map(e=>({ref:e.ref,dx:e.fixed?0:e.id.startsWith('U1')?220:620,dy:e.fixed?0:140,variant:e.fixed?0:2})),solver:{}}));
  assert.deepEqual(body,before);assert.deepEqual(scope.request.allMovableRefs,['U1']);
  assert.deepEqual(result.labels.map(l=>l.rotation),[180,180]);
  for(const l of result.labels){const old=scope.model.snapshot.items.find(o=>o.id===l.id);assert.equal(l.fontSize,old.fontSize);assert.equal(l.lineWidth,old.lineWidth);assert.equal(l.parentId,old.parentId);}
  const external={...before,labels:before.labels.map(l=>l.owner==='C1'?{...l,rotation:180}:l)};
  assert.equal(independentLabelGeometry({components:external.components,pads:[],labels:external.labels,orientation,orientationOwnerRefs:['U1']}).valid,true);
});

test('adoption and acceptance retain 180/270 and reject a reversed opted-in designator',()=>{
  const {scope,compilation,body}=setup();
  for(const side of sides.slice(2)){
    const proposal=structuredClone(body),old=scope.model.snapshot.items[0];proposal.labels[0]=glyph({...proposal.labels[0],width:old.width,height:old.height},side.rotation,side.x,side.y);
    const plan=normalizeExternalFinePlan(scope,compilation,proposal);
    assert.equal(plan.labels[0].rotation,side.rotation);assert.equal(plan.geometryPolicy.labelOrientation,orientation);
    assert.equal(auditFineCandidate(scope,compilation,plan).localAccepted,true);
    const bad=structuredClone(plan);bad.labels[0]=glyph({...bad.labels[0],width:old.width,height:old.height},(side.rotation+180)%360,side.rotation===180?90:140,side.rotation===180?60:90);
    assert.ok(auditFineCandidate(scope,compilation,bad).blockingIssues.some(i=>i.code==='FINE_LABEL_OWNER_FACING'));
  }
});

test('facing baseline proofs include the owner body; owner movement cannot retain an old issue',()=>{
  const {body,scope}=setup(),label=glyph(scope.model.snapshot.items[0],180,110,140),issue={code:'FINE_LABEL_OWNER_FACING',id:label.id,owner:'U1',rotation:180,distanceMil:-40};
  const before={components:body.components,labels:[label],pads:[]},same=classifyFineIssues({issues:[issue],baselineIssues:[issue],before,after:before,baselinePolicy:'retain-outside-issues'});
  assert.equal(same.blockingIssues.length,0);assert.deepEqual(same.retainedOutsideProofs[0].objects,['label:'+label.id,'body:U1']);
  const after=structuredClone(before);after.components[0].x+=1;
  assert.equal(classifyFineIssues({issues:[issue],baselineIssues:[issue],before,after,baselinePolicy:'retain-outside-issues'}).blockingIssues.length,1);
});

test('existing numeric backend solves all four sides without folding angles',async()=>{
  const {scope,body}=setup(),before=structuredClone(body);
  for(const side of sides){
    const result=await solveFineLabels(scope,body,settings,runtime(),async(p,r)=>{restrict(p,side.window);return executeCpSat(p,r);});
    assert.ok(['FEASIBLE','OPTIMAL'].includes(result.status),JSON.stringify(result));
    const label=result.labels.find(l=>l.owner==='U1');assert.equal(label.rotation,side.rotation);
    assert.equal(independentLabelGeometry({components:body.components,pads:scope.model.pads,labels:result.labels,clearanceMil:8,orientation,orientationOwnerRefs:['U1']}).valid,true);
    assert.deepEqual(result.labels.find(l=>l.owner==='C1'),body.labels.find(l=>l.owner==='C1'));
  }
  assert.deepEqual(body,before);
});

test('no legal facing/clearance solution keeps body evidence and produces no complete candidate',async()=>{
  const {f,request}=setup({mode:'separate',orientation,maxOwnerDistanceMil:0});
  const run=await solveFineLayout({inputs:f,request,settings:{...settings,timeLimitSeconds:6},runtime:runtime(),executor:async(p,r)=>p.coverage.stage==='independent-labels'?executeCpSat(p,r):{status:'FEASIBLE',sourceHash:p.sourceHash,placements:p.entities.map(e=>({ref:e.ref,dx:0,dy:0,variant:e.preferredVariant??0})),solver:{}}});
  assert.ok(run.bodyCandidate);assert.equal(run.candidate,null);assert.equal(run.result.candidateHash,null);assert.equal(run.result.status,'labels-infeasible-for-compiled-model');assert.equal(run.result.state.nativeWrites,0);
});

test('existing numeric backend follows the moved accepted owner rather than its source pose',async()=>{
  const {scope,body}=setup(),moved=structuredClone(body);moved.components[0].y+=70;moved.components[0].body=shift(moved.components[0].body,0,70);
  const result=await solveFineLabels(scope,moved,settings,runtime(),async(p,r)=>{restrict(p,{minX:90,maxX:110,minY:200,maxY:230});return executeCpSat(p,r);});
  assert.ok(['FEASIBLE','OPTIMAL'].includes(result.status),JSON.stringify(result));
  assert.equal(result.labels[0].rotation,0);assert.ok(result.labels[0].bbox.minY>=200);
  assert.equal(independentLabelGeometry({components:moved.components,pads:[],labels:result.labels,orientation,orientationOwnerRefs:['U1']}).valid,true);
});

test('strict facing quantization keeps a legal fractional owner-centre position',async()=>{
  const {scope,body}=setup(),moved=structuredClone(body);moved.components[0].y+=.25;moved.components[0].body=shift(moved.components[0].body,0,.25);
  const result=await solveFineLabels(scope,moved,settings,runtime(),async(p,r)=>{restrict(p,{minX:130,maxX:150,minY:100.5,maxY:110.5});return executeCpSat(p,r);});
  assert.ok(['FEASIBLE','OPTIMAL'].includes(result.status),JSON.stringify(result));
  assert.equal(result.labels[0].rotation,0);assert.equal(result.labels[0].bbox.minY,100.5);
  assert.equal(independentLabelGeometry({components:moved.components,pads:[],labels:result.labels,clearanceMil:8,orientation,orientationOwnerRefs:['U1']}).valid,true);
});

test('native Mock preflight/readback share facing rules and retain 180/270, font and line width',async t=>{
  for(const rotation of [180,270]){
    const f=await nativeFixture(t);f.attributes[1].Y+=10;f.attributes[1].bbox=shift(f.attributes[1].bbox,0,10);
    const snapshot=await inspectLayout(f.options()),plan=f.plan(snapshot,{firstDx:0}),old=snapshot.items[0];
    plan.geometryPolicy={labelMode:'separate',labelOrientation:orientation};
    plan.labels[0]=glyph(old,rotation,rotation===180?4:20,rotation===180?-20:4);
    const config={...f.options().config,labelGeometryMode:'separate',labelOrientation:orientation,labelOrientationOwnerRefs:['U1']};
    const good=await preflightLayout({...f.options(),config,snapshot,plan});assert.equal(good.status,'preflight-passed',JSON.stringify(good));assert.deepEqual(f.control.modifications,[]);
    const bad=structuredClone(plan);bad.labels[0].rotation=(rotation+180)%360;
    const blocked=await preflightLayout({...f.options(),config,snapshot,plan:bad});assert.notEqual(blocked.status,'preflight-passed');assert.match(blocked.error?.message??blocked.native?.error?.message??JSON.stringify(blocked),/FINE_LABEL_OWNER_FACING/);assert.deepEqual(f.control.modifications,[]);
    const modify=f.eda.pcb_PrimitiveAttribute.modify;f.eda.pcb_PrimitiveAttribute.modify=async(id,v)=>{const done=await modify(id,v),a=f.attributes.find(a=>a.PrimitiveId===id),l=snapshot.items.find(l=>l.id===id);if(done&&v.alignMode===3)a.bbox=glyph(l,v.rotation,v.x,v.y).bbox;return done;};
    const applied=await applyLayout({...f.options(),config,snapshot,plan});assert.equal(applied.status,'verified',JSON.stringify(applied));
    assert.equal(f.attributes[0].Rotation,rotation);assert.equal(f.attributes[0].FontSize,old.fontSize);assert.equal(f.attributes[0].LineWidth,old.lineWidth);
  }
});

test('native Mock catches post-write facing corruption rather than accepting equivalent occupied bounds',async t=>{
  const f=await nativeFixture(t);f.attributes[1].Y+=10;f.attributes[1].bbox=shift(f.attributes[1].bbox,0,10);
  const snapshot=await inspectLayout(f.options()),plan=f.plan(snapshot,{firstDx:0}),old=snapshot.items[0];plan.geometryPolicy={labelMode:'separate',labelOrientation:orientation};plan.labels[0]=glyph(old,180,4,-20);
  const modify=f.eda.pcb_PrimitiveAttribute.modify;f.eda.pcb_PrimitiveAttribute.modify=async(id,v)=>{const done=await modify(id,v),a=f.attributes.find(a=>a.PrimitiveId===id),l=snapshot.items.find(l=>l.id===id);if(done&&v.alignMode===3){a.bbox=glyph(l,v.rotation,v.x,v.y).bbox;a.Rotation=(v.rotation+180)%360;}return done;};
  const result=await applyLayout({...f.options(),config:{...f.options().config,labelGeometryMode:'separate',labelOrientation:orientation,labelOrientationOwnerRefs:['U1']},snapshot,plan});
  assert.notEqual(result.status,'verified');assert.equal(result.applyState,'apply-verification-failed');
  assert.match(await readFile(result.steps[0].reportFile,'utf8'),/FINE_LABEL_OWNER_FACING/);assert.equal(f.control.saves,0);
});
