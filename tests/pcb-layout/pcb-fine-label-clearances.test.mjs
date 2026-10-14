import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareFixture } from '../helpers/pcb-layout-prepare-fixture.mjs';
import { fixture as nativeFixture } from '../helpers/pcb-layout-execution-fixture.mjs';
import { prepareLayoutInputs } from '../../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { normalizeFineRequest } from '../../scripts/pcb-layout/fine/request.mjs';
import { compileFineProblem } from '../../scripts/pcb-layout/fine/compile.mjs';
import { compileFineLabels, solveFineLabels } from '../../scripts/pcb-layout/fine/labels.mjs';
import { fineLabelRules, independentLabelGeometry } from '../../scripts/pcb-layout/fine/label-geometry.mjs';
import { adoptFineLayout, preflightFineLayout, applyFineLayout, verifyFineLayout, resumeFineSave } from '../../scripts/pcb-layout/fine/workflow.mjs';
import { executeCpSat } from '../../scripts/pcb-layout/pcb-layout-cpsat.mjs';
import { inspectLayout, preflightLayout } from '../../scripts/pcb-layout/pcb-layout-execution.mjs';
import { transformBox } from '../../scripts/pcb-layout/pcb-layout-geometry.mjs';

const clearancesMil={body:3,pad:4,label:5},orientation='bottom-edge-to-owner';
const settings={resolutionMil:.5,timeLimitSeconds:3,workers:1,seed:92701,displacementWeight:0};
const shift=(b,dx,dy)=>({minX:b.minX+dx,maxX:b.maxX+dx,minY:b.minY+dy,maxY:b.maxY+dy});
const runtime=()=>{assert.ok(process.env.FLITREALIZE_CPSAT_PYTHON,'Use the existing OR-Tools interpreter explicitly');return {pythonPath:process.env.FLITREALIZE_CPSAT_PYTHON};};
function glyph(old,rotation,x,y){return {...old,x,y,rotation,alignMode:3,bbox:transformBox({minX:0,maxX:old.width??20,minY:0,maxY:old.height??10},{x:0,y:0,rotation:0},{x,y,rotation})};}
function setup(labels={mode:'separate',clearancesMil,orientation},rotation=0){
  const inputs=prepareFixture(200);inputs.config.hard.boardBounds={minX:0,maxX:400,minY:0,maxY:240};
  for(const c of inputs.snapshot.components){c.x+=100;c.y+=100;c.bbox=shift(c.bbox,100,100);}
  inputs.snapshot.components[0].rotation=rotation;
  for(const p of inputs.snapshot.pads){p.x+=100;p.y+=100;p.bbox=shift(p.bbox,100,100);}
  for(const l of inputs.snapshot.items){l.original.x+=100;l.original.y+=100;l.original.bbox=shift(l.original.bbox,100,100);}
  const request={schemaVersion:1,movableRefs:['U1'],region:{mode:'available-space',basis:'Synthetic category clearance test'},labels,objective:{retainSource:false}};
  const scope=normalizeFineRequest(prepareLayoutInputs(inputs).model,request),compilation=compileFineProblem(scope,settings);
  return {inputs,request,scope,compilation,body:compilation.baseline.plan};
}
function restrict(problem,window){
  const b=problem.board,boxes=[{minX:b.minX,maxX:window.minX,minY:b.minY,maxY:b.maxY},{minX:window.maxX,maxX:b.maxX,minY:b.minY,maxY:b.maxY},{minX:b.minX,maxX:b.maxX,minY:b.minY,maxY:window.minY},{minX:b.minX,maxX:b.maxX,minY:window.maxY,maxY:b.maxY}];
  for(const [i,box] of boxes.entries())problem.zones.push({id:'test-window:'+i,mode:'keepout',geometry:'body',box,excludeRefs:[],targetRefs:problem.entities.filter(e=>!e.fixed).map(e=>e.ref)});
}
const sides=[{rotation:0,x:90,y:113},{rotation:90,x:87,y:90},{rotation:180,x:110,y:87},{rotation:270,x:113,y:110}];

test('legacy rules inherit per-owner maxima; explicit categories override only their own minimum',()=>{
  const {inputs,request}=setup();inputs.mechanical.labelTemplates={default:{minGapMil:12},overrides:{C1:{minGapMil:14}}};
  const model=prepareLayoutInputs(inputs).model;
  assert.deepEqual(fineLabelRules(model,{mode:'separate'}).clearancesByOwner,{U1:{body:12,pad:12,label:12},C1:{body:14,pad:14,label:14}});
  assert.deepEqual(fineLabelRules(model,{mode:'separate',clearanceMil:16}).clearancesByOwner.U1,{body:16,pad:16,label:16});
  assert.deepEqual(fineLabelRules(model,{mode:'separate',clearanceMil:6,clearancesMil:{body:3}}).clearancesByOwner,{U1:{body:3,pad:12,label:12},C1:{body:3,pad:14,label:14}});
  const rules=fineLabelRules(model,request.labels);assert.deepEqual(rules.clearancesByOwner.U1,clearancesMil);assert.deepEqual(rules.clearancesByOwner.C1,clearancesMil);
  assert.equal(inputs.mechanical.clearanceMil,8);assert.equal(inputs.mechanical.labelTemplates.default.minGapMil,12);
  assert.throws(()=>normalizeFineRequest(model,{...request,labels:{mode:'joint',clearancesMil}}),/FINE_SEPARATE_LABEL_CLEARANCES_REQUIRED/);
  for(const bad of [null,[],{body:-1},{pad:'4'},{label:NaN},{text:5}])assert.throws(()=>normalizeFineRequest(model,{...request,labels:{mode:'separate',clearancesMil:bad}}),/FINE_INVALID_LABEL_POLICY/);
});

test('body 3 is accepted independently of legacy 8; body, pad and text each enforce their own boundary',()=>{
  const {scope,body}=setup(),rules=fineLabelRules(scope.model,scope.request.labels),old=scope.model.snapshot.items[0],label=glyph(old,0,90,113);
  const args={components:body.components,pads:scope.model.pads,labels:[label],...rules,orientation};
  assert.equal(independentLabelGeometry(args).valid,true);
  const close=glyph(old,0,90,112.5),under=independentLabelGeometry({...args,labels:[close]});
  assert.ok(under.issues.some(i=>i.code==='FINE_LABEL_BODY_GAP'&&i.requiredMil===3));
  // A label belonging to U1 must also clear C1's body.
  const neighbor=glyph(old,0,290,112.5);
  assert.ok(independentLabelGeometry({...args,labels:[neighbor]}).issues.some(i=>i.code==='FINE_LABEL_BODY_GAP'&&i.ref==='C1'));
  const pad={...scope.model.pads[0],bbox:{minX:90,maxX:110,minY:100,maxY:109}};
  assert.equal(independentLabelGeometry({...args,pads:[pad]}).valid,true);
  assert.ok(independentLabelGeometry({...args,pads:[{...pad,bbox:{...pad.bbox,maxY:109.5}}]}).issues.some(i=>i.code==='FINE_LABEL_PAD_GAP'&&i.requiredMil===4));
  const other=glyph(scope.model.snapshot.items[1],0,115,113);
  assert.equal(independentLabelGeometry({...args,labels:[label,other]}).valid,true);
  assert.ok(independentLabelGeometry({...args,labels:[label,{...other,x:114.5,bbox:shift(other.bbox,-.5,0)}]}).issues.some(i=>i.code==='FINE_LABEL_LABEL_GAP'&&i.requiredMil===5));
  const inherited=fineLabelRules(scope.model,{mode:'separate',clearancesMil:{body:3}});
  assert.equal(independentLabelGeometry({...args,...inherited}).valid,true);
  assert.ok(independentLabelGeometry({...args,...inherited,pads:[pad]}).issues.some(i=>i.code==='FINE_LABEL_PAD_GAP'&&i.requiredMil===8));
  assert.ok(independentLabelGeometry({...args,...inherited,labels:[label,other]}).issues.some(i=>i.code==='FINE_LABEL_LABEL_GAP'&&i.requiredMil===8));
  assert.ok(independentLabelGeometry({...args,...fineLabelRules(scope.model,{mode:'separate'})}).issues.some(i=>i.code==='FINE_LABEL_BODY_GAP'&&i.requiredMil===8));
});

test('compilation uses separate body/pad context zones and symmetric text minima without expanding permissions',()=>{
  const {scope,compilation,body}=setup(),compiled=compileFineLabels(scope,body,settings),ref='fine-label:'+compiled.items[0].id;
  const zones=compiled.problem.zones,bodyZone=zones.find(z=>z.id===ref+'/body:U1'),pad=scope.model.pads[0],padZone=zones.find(z=>z.id===ref+'/pad:'+pad.id),outside=body.labels[1],textZone=zones.find(z=>z.id===ref+'/label:'+outside.id);
  assert.equal(bodyZone.box.maxY,body.components[0].body.maxY+3);assert.equal(padZone.box.maxY,pad.bbox.maxY+4);assert.equal(textZone.box.maxX,outside.bbox.maxX+5);
  assert.equal(compilation.problem.zones.find(z=>z.id==='fine-context-label:'+outside.id).geometry,'body');
  assert.equal(compilation.problem.zones.find(z=>z.id==='fine-context-label:'+outside.id+':pads').geometry,'pads');
  assert.deepEqual(scope.request.allMovableRefs,['U1']);assert.deepEqual([...scope.labelMoving],['U1']);
  const added=setup({mode:'separate',clearancesMil,additionalOwnerRefs:['C1']}),both=compileFineLabels(added.scope,added.body,settings);
  assert.equal(both.problem.pairs.find(p=>p.a.startsWith('fine-label:')&&p.b.startsWith('fine-label:')).gapMil,5);
  assert.deepEqual(added.scope.request.allMovableRefs,['U1']);assert.equal(added.compilation.problem.entities.find(e=>e.ref==='C1').fixed,true);
  const legacy=setup({mode:'separate'});assert.equal(legacy.compilation.problem.zones.find(z=>z.id==='fine-context-label:'+legacy.body.labels[1].id).geometry,'physical');
  legacy.inputs.mechanical.labelTemplates={overrides:{C1:{minGapMil:14}}};
  const model=prepareLayoutInputs(legacy.inputs).model,s=normalizeFineRequest(model,legacy.request),c=compileFineProblem(s),l=compileFineLabels(s,c.baseline.plan,settings);
  assert.equal(l.problem.zones.find(z=>z.id==='fine-label:'+l.items[0].id+'/label:'+c.baseline.plan.labels[1].id).box.maxX,c.baseline.plan.labels[1].bbox.maxX+14);
});

test('existing numeric backend and adoption agree at body 3 on all four sides and source quarter-turns',async()=>{
  for(const [index,side] of sides.entries()){
    const {scope,body,inputs,request}=setup(undefined,[0,-90,180,270][index]),old=scope.model.snapshot.items[0],target=glyph(old,side.rotation,side.x,side.y),before=structuredClone(body);
    const result=await solveFineLabels(scope,body,settings,runtime(),async(p,r)=>{restrict(p,target.bbox);return executeCpSat(p,r);});
    assert.ok(['FEASIBLE','OPTIMAL'].includes(result.status),JSON.stringify(result));assert.equal(result.labels[0].rotation,side.rotation);assert.deepEqual(body,before);
    assert.equal(independentLabelGeometry({components:body.components,pads:scope.model.pads,labels:result.labels,...result.rules,orientation}).valid,true);
    const proposal={...body,labels:result.labels},adopted=await adoptFineLayout({inputs,request,plan:proposal});
    assert.equal(adopted.result.status,'candidate-passed',JSON.stringify(adopted.result.audit));assert.equal(adopted.result.state.nativeWrites,0);
    assert.deepEqual(adopted.candidate.plan.geometryPolicy.labelRules.clearancesByOwner.U1,clearancesMil);
    const delta=[{x:0,y:-.5},{x:.5,y:0},{x:0,y:.5},{x:-.5,y:0}][index],bad=glyph(old,side.rotation,side.x+delta.x,side.y+delta.y);
    const no=await solveFineLabels(scope,body,settings,runtime(),async(p,r)=>{restrict(p,bad.bbox);return executeCpSat(p,r);});
    assert.equal(no.status,'INFEASIBLE',JSON.stringify(no));
    const rejected=await adoptFineLayout({inputs,request,plan:{...body,labels:body.labels.map(l=>l.id===old.id?bad:l)}});
    assert.equal(rejected.result.status,'candidate-rejected');assert.ok(rejected.result.audit.blockingIssues.some(i=>i.code==='FINE_LABEL_BODY_GAP'&&i.requiredMil===3));
  }
});

async function nativeSetup(t,rotation=0){
  const f=await nativeFixture(t),bounds={minX:-100,minY:-100,maxX:550,maxY:200};
  f.routing.Polyline.push(f.primitive({PrimitiveId:'board',Layer:11,Polygon:{getSource:()=>[-100,-100,'L',-100,200,550,200,550,-100,-100,-100]}}));
  f.components[0].Rotation=rotation;f.components[0].bbox=transformBox(f.components[0].bbox,{x:0,y:0,rotation:0},{x:0,y:0,rotation});
  for(const a of f.attributes){a.Y+=10;a.bbox=shift(a.bbox,0,10);}
  const snapshot=await inspectLayout(f.options()),inputs=prepareFixture();inputs.snapshot=snapshot;inputs.config.hard.boardBounds=bounds;
  inputs.contract.components=[...snapshot.components.map(c=>({designator:c.ref,role:'mock fixture',includeInPcb:true,pins:[{number:'1'}]})),{designator:'TP1',role:'mock pad',includeInPcb:true,pins:[{number:'1'}]}];
  inputs.contract.blocks=[{id:'fixture',purpose:'Native Mock only',components:['U1','U2']}];inputs.contract.nets=[{name:'N0',kind:'signal',endpoints:[{component:'U1',pin:'1'},{component:'TP1',pin:'1'}]},{name:'N1',kind:'signal',endpoints:[{component:'U2',pin:'1'}]}];inputs.contract.constraints=[];inputs.mechanical={...f.options().config,boardBounds:bounds};
  const request={schemaVersion:1,movableRefs:['U1'],fixedRefs:['U2'],region:{mode:'available-space',basis:'Native Mock only'},labels:{mode:'separate',clearancesMil,orientation},objective:{retainSource:false}},plan=f.plan(snapshot,{firstDx:0,rotation});plan.boardBounds=bounds;
  const b=snapshot.components[0].bbox,pose=[{x:-4,y:b.maxY+3},{x:b.minX-3,y:-4},{x:4,y:b.minY-3},{x:b.maxX+3,y:4}][rotation/90];
  plan.labels[0]=glyph(snapshot.items[0],rotation,pose.x,pose.y);
  const modify=f.eda.pcb_PrimitiveAttribute.modify;f.eda.pcb_PrimitiveAttribute.modify=async(id,v)=>{const done=await modify(id,v),a=f.attributes.find(a=>a.PrimitiveId===id),old=snapshot.items.find(l=>l.id===id);if(done&&v.alignMode===3)a.bbox=glyph(old,v.rotation,v.x,v.y).bbox;return done;};
  return {f,inputs,request,plan};
}

test('adopt/native preflight/readback/save use 3/4/5 for all four rotations and bind the same rules',async t=>{
  for(const rotation of [0,90,180,270]){
    const {f,inputs,request,plan}=await nativeSetup(t,rotation),adopted=await adoptFineLayout({inputs,request,plan});
    assert.equal(adopted.result.status,'candidate-passed',JSON.stringify(adopted.result.audit));
    const input={inputs,request,candidate:adopted.candidate,result:adopted.result,options:f.options()},preflight=await preflightFineLayout(input);
    assert.equal(preflight.status,'preflight-passed',JSON.stringify(preflight));assert.deepEqual(f.control.modifications,[]);
    const nativeConfig=fineLabelRules(adopted.prepared.model,request.labels);
    const wrong=structuredClone(adopted.candidate.plan);wrong.geometryPolicy.labelRules.clearancesByOwner.U1.body=8;
    const rejected=await preflightLayout({...f.options(),config:{...inputs.mechanical,labelGeometryMode:'separate',labelRules:nativeConfig,labelOrientation:orientation,labelOrientationOwnerRefs:['U1']},snapshot:inputs.snapshot,plan:wrong});
    assert.notEqual(rejected.status,'preflight-passed');assert.match(rejected.error?.message??JSON.stringify(rejected),/PLAN_LABEL_CLEARANCES_POLICY/);
    const applied=await applyFineLayout({...input,options:f.options()});assert.equal(applied.status,'verified',JSON.stringify(applied));assert.equal(applied.state.saved,true);
    assert.equal(f.attributes[0].Rotation,rotation);assert.equal(f.attributes[0].FontSize,inputs.snapshot.items[0].fontSize);assert.equal(f.attributes[0].LineWidth,inputs.snapshot.items[0].lineWidth);
    assert.deepEqual(f.control.modifications,[inputs.snapshot.items[0].id]);
    const verified=await verifyFineLayout({...input,options:f.options(),receiptFile:applied.execution.reportFile});assert.equal(verified.status,'verified',JSON.stringify(verified));assert.equal(verified.state.saved,true);
  }
});

test('native Mock rejects body under 3, pad under 4 and text under 5 before any writes',async t=>{
  for(const [kind,code] of [['body','FINE_LABEL_BODY_GAP'],['pad','FINE_LABEL_PAD_GAP'],['label','FINE_LABEL_LABEL_GAP']]){
    const {f,inputs,request,plan}=await nativeSetup(t),model=prepareLayoutInputs(inputs).model,rules=fineLabelRules(model,request.labels);
    if(kind==='body')plan.labels[0]=glyph(inputs.snapshot.items[0],0,-4,7.5);
    if(kind==='pad'){
      const p=f.pads[0];p.Y=4;p.bbox={minX:-2,maxX:2,minY:2.5,maxY:4.5};
      inputs.snapshot=await inspectLayout(f.options());plan.sourceHash=inputs.snapshot.sourceHash;
    }
    if(kind==='label')plan.labels[0]=glyph(inputs.snapshot.items[0],0,283.5,19);
    plan.geometryPolicy={labelMode:'separate',labelOrientation:orientation,labelRules:rules};
    const preflight=await preflightLayout({...f.options(),config:{...inputs.mechanical,labelGeometryMode:'separate',labelRules:rules,labelOrientation:orientation,labelOrientationOwnerRefs:['U1']},snapshot:inputs.snapshot,plan});
    assert.notEqual(preflight.status,'preflight-passed');assert.match(preflight.error?.message??JSON.stringify(preflight),new RegExp(code));assert.deepEqual(f.control.modifications,[]);assert.equal(f.control.saves,0);
  }
});

test('unowned native text uses the explicit text gap and retains its legacy global fallback',async t=>{
  for(const explicit of [true,false]){
    const {f,inputs,request,plan}=await nativeSetup(t);
    if(!explicit){request.labels={mode:'separate',orientation};inputs.mechanical.labelTemplates={default:{minGapMil:14}};plan.labels[0]=glyph(inputs.snapshot.items[0],0,-4,19);}
    const adopted=await adoptFineLayout({inputs,request,plan});assert.equal(adopted.result.status,'candidate-passed');
    const gap=explicit?5:8,b=adopted.candidate.plan.labels[0].bbox,obstacle=f.primitive({PrimitiveId:'outside-string',Text:'NOTE',Layer:3,X:b.maxX+gap,Y:b.minY,Rotation:0,bbox:{minX:b.maxX+gap,maxX:b.maxX+gap+8,minY:b.minY,maxY:b.maxY}});
    f.strings.push(obstacle);
    const input={inputs,request,candidate:adopted.candidate,result:adopted.result},good=await preflightFineLayout({...input,options:f.options()});assert.equal(good.status,'preflight-passed',JSON.stringify(good));
    obstacle.bbox=shift(obstacle.bbox,-.5,0);obstacle.X-=.5;
    const bad=await preflightFineLayout({...input,options:f.options()});assert.notEqual(bad.status,'preflight-passed');assert.match(bad.error?.message??JSON.stringify(bad),/LAYOUT_OBSTACLE_GAP/);assert.deepEqual(f.control.modifications,[]);assert.equal(f.control.saves,0);
  }
});

test('write/readback and post-save corruption recheck each category; save recovery retains 3/4/5',async t=>{
  for(const [kind,code] of [['body','FINE_LABEL_BODY_GAP'],['pad','FINE_LABEL_PAD_GAP'],['label','FINE_LABEL_LABEL_GAP']]){
    const {f,inputs,request,plan}=await nativeSetup(t),adopted=await adoptFineLayout({inputs,request,plan}),input={inputs,request,candidate:adopted.candidate,result:adopted.result,options:f.options()};
    const corrupt=()=>{if(kind==='body')f.components[0].bbox.maxY+=.5;else if(kind==='pad')f.pads[0].bbox.maxY=4.5;else f.attributes[1].bbox={minX:8.5,maxX:16.5,minY:8,maxY:10};};
    if(kind==='label'){let afterSave=false;const getBox=f.eda.pcb_Primitive.getPrimitivesBBox;f.eda.pcb_Primitive.getPrimitivesBBox=async ids=>afterSave&&ids[0]===f.attributes[1].PrimitiveId?{minX:8.5,maxX:16.5,minY:8,maxY:10}:getBox(ids);f.control.afterSave=()=>{afterSave=true;};}
    else{const modify=f.eda.pcb_PrimitiveAttribute.modify;f.eda.pcb_PrimitiveAttribute.modify=async(id,v)=>{const done=await modify(id,v);corrupt();return done;};}
    const result=await applyFineLayout(input);assert.notEqual(result.status,'verified');const reports=await Promise.all(result.execution.steps.filter(step=>step.reportFile).map(step=>readFile(step.reportFile,'utf8')));assert.match(JSON.stringify(result)+'\n'+reports.join('\n'),new RegExp(code));
    assert.equal(f.control.saves,kind==='label'?1:0);
  }
  const {f,inputs,request,plan}=await nativeSetup(t),adopted=await adoptFineLayout({inputs,request,plan}),input={inputs,request,candidate:adopted.candidate,result:adopted.result};
  f.control.saveResult=false;const failed=await applyFineLayout({...input,options:f.options()});assert.equal(failed.status,'save-failed',JSON.stringify(failed));
  f.control.saveResult=true;const saved=await resumeFineSave({...input,options:f.options(),resumeSave:failed.execution.resumeSaveReport});assert.equal(saved.status,'verified',JSON.stringify(saved));assert.equal(saved.state.saved,true);assert.equal(f.calls.filter(p=>p==='apply').length,1);
});
