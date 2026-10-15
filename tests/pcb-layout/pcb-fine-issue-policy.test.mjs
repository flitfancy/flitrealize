import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyFineIssues} from '../../scripts/pcb-layout/fine/issue-policy.mjs';
const body=(ref,x)=>({id:ref,ref,x,y:0,rotation:0,body:{minX:x-10,maxX:x+10,minY:-10,maxY:10}});
const label=(id,owner,x)=>({id,owner,x,y:0,rotation:0,bbox:{minX:x-2,maxX:x+2,minY:-2,maxY:2}});
const frame=()=>({components:[body('A',0),body('B',100)],labels:[label('LA','A',30),label('LB','B',0)],pads:[{id:'PA',owner:'A',number:'1',net:'n',x:0,y:0,bbox:{minX:-1,maxX:1,minY:-1,maxY:1}}],bundles:[],boardBounds:{minX:-50,maxX:200,minY:-50,maxY:50}});
const issue={code:'FINE_LABEL_BODY_GAP',id:'LB',owner:'B',ref:'A',gapMil:-12,requiredMil:8};
const check=(before,after,issues=[issue],baselineIssues=[issue],extra={})=>classifyFineIssues({before,after,issues,baselineIssues,labelMode:'separate',baselinePolicy:'retain-outside-issues',...extra});
test('unchanged external label versus fixed body survives an unrelated owner label move',()=>{const a=frame(),b=structuredClone(a);b.labels[0].x+=10;b.labels[0].bbox.minX+=10;b.labels[0].bbox.maxX+=10;const r=check(a,b);assert.equal(r.blockingIssues.length,0);assert.equal(r.retainedOutsideIssues.length,1);assert.deepEqual(r.retainedOutsideProofs[0].objects,['label:LB','body:A']);});
test('a moving body versus an external label is affected even with identical issue metrics',()=>{const a=frame(),b=structuredClone(a);b.components[0].x+=1;assert.equal(check(a,b).blockingIssues.length,1);});
test('a moving label versus a fixed body or pad is affected even with identical metrics',()=>{for(const i of [issue,{code:'FINE_LABEL_PAD_GAP',id:'LB',owner:'B',ref:'A',padId:'PA',gapMil:-2,requiredMil:8}]){const a=frame(),b=structuredClone(a);b.labels[1].x+=1;assert.equal(check(a,b,[i],[i]).blockingIssues.length,1);}});
test('a pad is a distinct participant from its owner label',()=>{const a=frame(),b=structuredClone(a),i={code:'FINE_LABEL_PAD_GAP',id:'LB',owner:'B',ref:'A',padId:'PA',gapMil:-2,requiredMil:8};b.labels[0].x++;assert.equal(check(a,b,[i],[i]).blockingIssues.length,0);b.pads[0].x++;assert.equal(check(a,b,[i],[i]).blockingIssues.length,1);});
test('label pair dependencies use both label IDs',()=>{const a=frame(),b=structuredClone(a),i={code:'FINE_LABEL_LABEL_GAP',ids:['LA','LB'],refs:['A','B'],gapMil:-2,requiredMil:8};b.labels[0].x++;assert.equal(check(a,b,[i],[i]).blockingIssues.length,1);});
test('new, worse, unknown or unidentified old issues are never retained',()=>{const a=frame();for(const [issues,old] of [[[issue],[]],[[{...issue,gapMil:-3}],[issue]],[[{code:'UNKNOWN',refs:['A']}],[{code:'UNKNOWN',refs:['A']}]],[[{...issue,id:'missing'}],[{...issue,id:'missing'}]]])assert.equal(check(a,a,issues,old).blockingIssues.length,1);assert.equal(check(a,a,[issue],[issue],{baselinePolicy:'require-clean'}).blockingIssues.length,1);});
test('old cross-block pin distance still blocks when either physical endpoint moves',()=>{const a=frame(),b=structuredClone(a),i={code:'PIN_DISTANCE_LIMIT',refs:['A','B'],id:'cross',mil:100,maxMil:50};assert.equal(check(a,b,[i],[i]).blockingIssues.length,0);b.components[0].x++;assert.equal(check(a,b,[i],[i]).blockingIssues.length,1);});

test('outside proof folds equivalent and seam angles but preserves real changes',()=>{
  const a=frame(),b=structuredClone(a);b.components[0].rotation=359.999999;b.labels[1].rotation=360;
  assert.equal(check(a,b).blockingIssues.length,0);
  b.components[0].rotation=.01;assert.equal(check(a,b).blockingIssues.length,1);
  a.components[0].rotation=360-7e-5;b.components[0].rotation=7e-5;
  assert.equal(check(a,b).blockingIssues.length,1,'compare the pair directly; snapping both sides to zero hides a real change');
});

test('missing and invalid required rotations cannot prove unchanged participants',()=>{
  for(const collection of ['components','labels'])for(const value of [null,undefined,NaN,'0']){
    const a=frame(),index=collection==='components'?0:1;a[collection][index].rotation=value;
    assert.equal(check(a,structuredClone(a)).blockingIssues.length,1);
  }
});

test('optional pad rotation stays absent rather than becoming a zero-angle proof',()=>{
  const a=frame(),b=structuredClone(a),i={code:'FINE_LABEL_PAD_GAP',id:'LB',owner:'B',ref:'A',padId:'PA',gapMil:-2,requiredMil:8};
  assert.equal(check(a,b,[i],[i]).blockingIssues.length,0);
  b.pads[0].rotation=0;assert.equal(check(a,b,[i],[i]).blockingIssues.length,1);
  a.pads[0].rotation=null;b.pads[0].rotation=null;assert.equal(check(a,b,[i],[i]).blockingIssues.length,1);
});

const halfTurnFrames=()=>{
  const a=frame();a.pads=[-5,5].map((x,i)=>({id:'PA'+i,owner:'A',number:String(i+1),net:'net'+i,x,y:0,bbox:{minX:x-1,maxX:x+1,minY:-1,maxY:1}}));
  const b=structuredClone(a);b.components[0].rotation=180;
  for(const p of b.pads){p.x=-p.x;p.bbox={minX:-p.bbox.maxX,maxX:-p.bbox.minX,minY:-p.bbox.maxY,maxY:-p.bbox.minY};}
  return [a,b];
};
test('same-centre half-turn with identical occupied geometry retains an unchanged old body-gap issue',()=>{
  const [a,b]=halfTurnFrames(),r=check(a,b);
  assert.equal(r.blockingIssues.length,0,'body orientation alone must not invalidate an unchanged geometric gap');
  assert.equal(r.retainedOutsideProofs[0].proof,'per-issue-non-worsening');
});
test('same-centre symmetric half-turn retains old physical assembly issues',()=>{
  for(const code of ['ASSEMBLY_COURTYARD_OVERLAP','ASSEMBLY_SPACING_HARD_LIMIT']){
    const [a,b]=halfTurnFrames(),i=code==='ASSEMBLY_COURTYARD_OVERLAP'?{code,a:'A',b:'B',overlapXMil:2,overlapYMil:4,penetrationXMil:2,penetrationYMil:4}:{code,a:'A',b:'B',refs:['A','B'],geometry:'physical',axis:'x+',distanceMil:80,hardMinMil:90};
    assert.equal(check(a,b,[i],[i]).blockingIssues.length,0,code);
  }
});
test('half-turn geometric proof cannot retain new or worsened issues or electrical endpoint failures',()=>{
  const [a,b]=halfTurnFrames();
  assert.equal(check(a,b,[{...issue,gapMil:-3}],[issue]).blockingIssues.length,1);
  assert.equal(check(a,b,[issue],[]).blockingIssues.length,1);
  const pin={code:'PIN_DISTANCE_LIMIT',refs:['A','B'],id:'cross',mil:100,maxMil:50};
  assert.equal(check(a,b,[pin],[pin]).blockingIssues.length,1);
  const pad={code:'FINE_LABEL_PAD_GAP',id:'LB',owner:'B',ref:'A',padId:'PA0',gapMil:-2,requiredMil:8};
  assert.equal(check(a,b,[pad],[pad]).blockingIssues.length,1);
});
test('geometric proof requires full identity and consistent measured body geometry',()=>{
  for(const change of [b=>b.components[0].x+=1,b=>b.pads[0].net='other',b=>b.pads.pop()]){
    const [a,b]=halfTurnFrames();change(b);assert.equal(check(a,b).blockingIssues.length,1);
  }
});

const shift=(object,dx,dy=0)=>{object.x+=dx;object.y+=dy;const box=object.body??object.bbox;for(const key of ['minX','maxX'])box[key]+=dx;for(const key of ['minY','maxY'])box[key]+=dy;};
test('real translation may improve an old gap; deeper intrusion cannot hide behind the same gap',()=>{
  const a=frame(),b=structuredClone(a);shift(b.labels[1],1);
  assert.equal(check(a,b,[{...issue,gapMil:-11}]).blockingIssues.length,0,'moving away from the centre reduces separation depth');
  shift(b.labels[1],10);
  assert.equal(check(a,b,[{...issue,gapMil:-1}]).blockingIssues.length,0);
  const c=structuredClone(b);shift(c.labels[1],-1);
  assert.equal(check(b,c,[{...issue,gapMil:-2}],[{...issue,gapMil:-1}]).blockingIssues.length,1);
});
test('a quarter-turn and tangential motion use actual gap evidence without a two-pad exception',()=>{
 const a=frame(),b=structuredClone(a);a.pads=[];b.pads=[];b.components[0].rotation=90;
 assert.equal(check(a,b).blockingIssues.length,0);
 const x=frame(),y=structuredClone(x);shift(x.labels[1],20,14);shift(y.labels[1],0,15);
 assert.equal(check(x,y,[{...issue,gapMil:3}],[{...issue,gapMil:8}]).blockingIssues.length,1,'a smaller gap still worsens');
 assert.equal(check(y,x,[{...issue,gapMil:8}],[{...issue,gapMil:3}]).blockingIssues.length,0);
});
test('same issue count cannot substitute objects, rules, networks or missing geometry',()=>{
  const a=frame();
  for(const i of [{...issue,id:'LA'},{...issue,ref:'B'},{...issue,requiredMil:7}])assert.equal(check(a,a,[i]).blockingIssues.length,1);
  for(const change of [b=>b.pads[0].net='new',b=>b.rules={clearanceMil:7},b=>b.labels.pop(),b=>delete b.components[0].body]){const b=structuredClone(a);change(b);assert.equal(check(a,b).blockingIssues.length,1);}
});
test('improvement in overlap area or one issue cannot offset deeper intrusion or another issue',()=>{
  const [a,b]=halfTurnFrames(),old={code:'ASSEMBLY_COURTYARD_OVERLAP',a:'A',b:'B',overlapXMil:10,overlapYMil:10,penetrationXMil:10,penetrationYMil:10};
  for(const now of [{...old,overlapXMil:5,overlapYMil:11,penetrationXMil:5,penetrationYMil:11},{...old,overlapXMil:5,overlapYMil:5,penetrationXMil:11,penetrationYMil:5}])assert.equal(check(a,b,[now],[old]).blockingIssues.length,1);
  assert.equal(check(a,b,[{...issue,gapMil:-13},old],[issue,old]).blockingIssues.length,1);
  const missing={...old};delete missing.penetrationXMil;
  assert.equal(check(a,b,[missing],[missing]).blockingIssues.length,1);
});
test('explicit repair obligations and require-clean remain strict; disappearing issues need no exemption',()=>{
  const a=frame();assert.equal(check(a,a,[issue],[issue],{mustFix:()=>true}).blockingIssues.length,1);
  assert.equal(check(a,a,[issue],[issue],{baselinePolicy:'require-clean'}).blockingIssues.length,1);
  assert.equal(check(a,a,[],[issue]).blockingIssues.length,0);
});
test('require-clean live-scope retention cannot grant moved objects the retain-outside-issues permission',()=>{
 const [a,b]=halfTurnFrames();
 assert.equal(check(a,b).blockingIssues.length,0);
 assert.equal(check(a,b,[issue],[issue],{allowMovedIssues:false}).blockingIssues.length,1);
 const fixed=structuredClone(a);fixed.components[0].body.minX+=1e-13;
 assert.equal(check(a,fixed,[issue],[issue],{allowMovedIssues:false}).blockingIssues.length,0,'unchanged fixed geometry tolerates numerical reconstruction noise');
});
test('native embedded policy and offline policy produce identical decisions and proof data',async()=>{
  const {sameAngle}=await import('../../scripts/pcb-layout/pcb-layout-geometry.mjs');
  const native=Function('sameAngle','return ('+classifyFineIssues.toString()+')')(sameAngle);
  const [before,after]=halfTurnFrames();
  for(const issues of [[issue],[{...issue,gapMil:-13}],[]]){
    const args={before,after,issues,baselineIssues:[issue],labelMode:'separate',baselinePolicy:'retain-outside-issues'};
    assert.deepEqual(native(args),classifyFineIssues(args));
  }
});
test('pad clearance compares the exact numbered/net-bound pad after rotation, never an interchangeable occupied pad',()=>{
 const [a,b]=halfTurnFrames(),pad={code:'FINE_LABEL_PAD_GAP',id:'LB',owner:'B',ref:'A',padId:'PA0',gapMil:2,requiredMil:8};
 assert.equal(check(a,b,[pad],[pad]).blockingIssues.length,0);
 assert.equal(check(a,b,[{...pad,padId:'PA1'}],[pad]).blockingIssues.length,1);
 b.pads[0].net='different';assert.equal(check(a,b,[pad],[pad]).blockingIssues.length,1);
});
test('native separate bundles include protruding pads while offline body bundles keep their original meaning',()=>{
 const a=frame();shift(a.pads[0],20);const b=structuredClone(a);shift(b.components[0],-1);shift(b.pads[0],-1);
 const native={code:'BUNDLE_CLEARANCE',refs:['A','B'],gapMil:69,requiredMil:90};
 assert.equal(check(a,b,[{...native,gapMil:70}],[native]).blockingIssues.length,0);
 const offline={code:'MIN_CLEARANCE_UNSATISFIED',refs:['A','B'],mil:80,requiredMil:90};
 assert.equal(check(a,b,[{...offline,mil:81}],[offline]).blockingIssues.length,0);
 assert.equal(check(a,b,[{...native,gapMil:68}],[native]).blockingIssues.length,1);
});
