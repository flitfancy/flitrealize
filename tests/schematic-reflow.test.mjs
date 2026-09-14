import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadAction} from './helpers/action-harness.mjs';

const action=await loadAction('schematic-reflow','easyeda-pro');
import {fixture,rec,encode,decode} from './helpers/schematic-reflow-fixture.mjs';
const input={expectedProjectUuid:'project',expectedDocumentUuid:'sheet',phase:'initial',
  blocks:[{name:'main',members:['A1','B1'],columns:1}],
  layout:{unit:'easyeda-schematic',originX:200,originY:200,componentSpacing:72,blockSpacing:210,attachmentSpacing:140,mainFlow:['main']}};

const f=fixture(),original=f.source;
const plan=await action(f.eda,input);
assert.equal(plan.status,'planned');assert.equal(f.writes,0);assert.equal(f.source,original);assert.equal(plan.backupSource,original);
assert.equal(plan.componentCount,2);assert.equal(plan.movedCount,2);
await action(f.eda,plan.applyRequest);
assert.equal(f.writes,1);assert.equal(f.saves,1);assert.ok(!f.source.endsWith('|'));
assert.equal((await action(f.eda,{...input,mode:'verify'})).status,'verified');
// Same X is permitted when the rectangles are separated in Y.
assert.equal(f.component('A1').x,f.component('B1').x);
assert.ok(Math.abs(f.component('A1').y-f.component('B1').y)>=72);

await f.connect();
const connectedIds=f.all().map(r=>r.head.type+':'+r.head.id).sort();
const connectedSource=f.source,complete={...input,phase:'complete'};
await assert.rejects(()=>action(f.eda,input),/unconnected sheet/);
const fullPlan=await action(f.eda,complete);
await action(f.eda,fullPlan.applyRequest);
assert.equal((await action(f.eda,{...complete,mode:'verify'})).status,'verified');
assert.deepEqual(f.all().map(r=>r.head.type+':'+r.head.id).sort(),connectedIds);
await f.checkConnections();
const attributes=f.all().filter(r=>r.head.type==='ATTR');
assert.ok(attributes.filter(r=>r.payload.parentId.includes('-f')).every(r=>r.payload.valueVisible===false));
assert.ok(attributes.filter(r=>r.payload.key==='NET').every(r=>r.payload.valueVisible===true&&r.payload.rotation===(r.payload.parentId.startsWith('B1')?90:0)));
assert.ok(attributes.filter(r=>['A1','B1'].includes(r.payload.parentId)).every(r=>r.payload.valueVisible===true));
assert.deepEqual(f.all().find(r=>r.head.id==='unrelated-note'),decode(original).find(r=>r.head.id==='unrelated-note'));
const writes=f.writes;
await action(f.eda,(await action(f.eda,complete)).applyRequest);
assert.equal(f.writes,writes,'A converged rerun must not import source again');

// Complete reflow treats net ports as connection markers without changing Name visibility.
const portMarker=fixture();await portMarker.connect();
portMarker.source=portMarker.source.replace('"componentType":"netflag"','"componentType":"netport"');
const portNameBefore=portMarker.all().find(r=>r.head.id==='A1-f0-name').payload.valueVisible;
await action(portMarker.eda,(await action(portMarker.eda,complete)).applyRequest);
assert.equal(portMarker.all().find(r=>r.head.id==='A1-f0').payload.componentType,'netport');
assert.equal(portMarker.all().find(r=>r.head.id==='A1-f0-name').payload.valueVisible,portNameBefore);
assert.equal((await action(portMarker.eda,{...complete,mode:'verify'})).status,'verified');

const stale=await action(f.eda,complete);
f.source=f.source.replace('LONG_COMPONENT_VALUE','USER_EDIT');
await assert.rejects(()=>action(f.eda,stale.applyRequest),/Stale reflow/);
assert.equal(f.writes,writes);
await assert.rejects(()=>action(f.eda,{...input,expectedDocumentUuid:'other'}),/Unexpected schematic/);
await assert.rejects(()=>action(f.eda,{...complete,blocks:[{name:'main',members:['A1','A1'],columns:1}]}),/exactly once/);
await assert.rejects(()=>action(f.eda,{...complete,layout:{...input.layout,unit:'unknown'}}),/layout.unit/);

const rejected=fixture(),rejectedPlan=await action(rejected.eda,input);
rejected.reject();await assert.rejects(()=>action(rejected.eda,rejectedPlan.applyRequest),/import rejected/);
assert.equal(rejected.source,original);assert.equal(rejected.saves,0);
const malformed=fixture();
const malformedSource=malformed.source.replace('"grid":5','"grid":broken');
malformed.eda.sys_FileManager.getDocumentSource=async()=>malformedSource;
await assert.rejects(()=>action(malformed.eda,input),/Invalid source record/);

const units=fixture();
const mil={...input,layout:{...input.layout,unit:'mil',originX:2000,originY:2000,componentSpacing:720,blockSpacing:2100,attachmentSpacing:1400}};
assert.deepEqual((await action(units.eda,mil)).deltas,(await action(units.eda,input)).deltas);
const attached=fixture(),attachmentInput={...input,blocks:[{name:'main',members:['A1'],columns:1},{name:'aux',members:['B1'],columns:1}],
  layout:{...input.layout,mainFlow:['main'],attachments:[{block:'aux',targets:['main'],preferredSide:'top'}]}};
await action(attached.eda,(await action(attached.eda,attachmentInput)).applyRequest);
assert.ok(attached.component('B1').y>attached.component('A1').y,'Screen top is positive API Y');
assert.equal((await action(attached.eda,{...attachmentInput,mode:'verify'})).status,'verified');

const broken=fixture();broken.source=connectedSource.replace('"startX":','"startX":99999,"ignoredX":');
await assert.rejects(()=>action(broken.eda,complete),/wire owner|horizontal or vertical/);
assert.equal(broken.writes,0);

const invalid=fixture();invalid.source=invalid.source.replace('"x":10','"x":null');
await assert.rejects(()=>action(invalid.eda,input),/Invalid component\/pin geometry/);
assert.equal(invalid.writes,0);
const badWire=fixture();await badWire.connect();
badWire.source=badWire.source.replace(/"startX":-?\d+/, '"startX":null');
await assert.rejects(()=>action(badWire.eda,complete),/Invalid wire geometry/);
const changedConfig=fixture(),configPlan=await action(changedConfig.eda,input);
await assert.rejects(()=>action(changedConfig.eda,{...configPlan.applyRequest,layout:{...input.layout,componentSpacing:73}}),/Stale reflow/);

// Different project sizes, grid shapes, sides and signed origins use the same engine.
for(const [index,side] of ['top','bottom','left','right'].entries()) {
  const varied=fixture(5+index*4);
  const ids=(await varied.eda.sch_PrimitiveComponent.getAll()).map(c=>c.getState_Designator());
  const config={...complete,blocks:[{name:'flow',members:ids.slice(0,-2),columns:index+1},{name:'aux',members:ids.slice(-2),columns:2}],
    layout:{...input.layout,originX:-100,originY:-200,mainFlow:['flow'],attachments:[{block:'aux',targets:['flow'],preferredSide:side}]}};
  await varied.connect();
  const variedPlan=await action(varied.eda,config);
  assert.equal(variedPlan.componentCount,ids.length);
  await action(varied.eda,variedPlan.applyRequest);
  await varied.checkConnections();
  assert.equal((await action(varied.eda,{...config,mode:'verify'})).status,'verified');
}
// One snapshot per invocation, including geometry and ownership used by text.
const once=fixture();await once.connect();
let componentReads=0,wireReads=0,pinReads=0,lineReads=0;
const readComponents=once.eda.sch_PrimitiveComponent.getAll;
const readWires=once.eda.sch_PrimitiveWire.getAll;
once.eda.sch_PrimitiveComponent.getAll=async()=>{
  componentReads++;
  return (await readComponents()).map(c=>{
    const pins=c.getAllPins.bind(c);
    c.getAllPins=async()=>{pinReads++;return pins();};
    return c;
  });
};
once.eda.sch_PrimitiveWire.getAll=async()=>{
  wireReads++;
  return (await readWires()).map(w=>{
    const line=w.getState_Line;
    w.getState_Line=()=>{lineReads++;return line();};
    return w;
  });
};
await action(once.eda,complete);
assert.deepEqual({componentReads,wireReads,pinReads,lineReads},{componentReads:1,wireReads:1,pinReads:2,lineReads:4});

// Body margin feeds both passes; long mixed-width text and custom fonts converge.
const padded=fixture(),paddedInput={...input,text:{bodyMargin:40}};
await action(padded.eda,(await action(padded.eda,paddedInput)).applyRequest);
assert.equal(padded.component('A1').x,input.layout.originX+20+40);
await padded.connect();
padded.source=padded.source.replace('LONG_COMPONENT_VALUE','长文字_'+('ABC_'.repeat(24)));
const paddedComplete={...paddedInput,phase:'complete',text:{bodyMargin:40,nameFontSize:12,netFontSize:11}};
await action(padded.eda,(await action(padded.eda,paddedComplete)).applyRequest);
await padded.checkConnections();
assert.equal((await action(padded.eda,{...paddedComplete,mode:'verify'})).status,'verified');

const fractional=fixture();await fractional.connect();
fractional.source=encode(fractional.all().map(r=>{
  if(r.head.type==='COMPONENT'){r.payload.x+=0.125;r.payload.y-=0.375;}
  if(r.head.type==='LINE'){r.payload.startX+=0.125;r.payload.endX+=0.125;r.payload.startY-=0.375;r.payload.endY-=0.375;}
  return r;
}));
await action(fractional.eda,(await action(fractional.eda,complete)).applyRequest);
await fractional.checkConnections();
assert.equal((await action(fractional.eda,{...complete,mode:'verify'})).status,'verified');

// Duplicate attributes/flags must fail before any document mutation.
const duplicateAttr=fixture();
duplicateAttr.source=encode([...duplicateAttr.all(),rec('ATTR','extra-name',{
  parentId:'A1',key:'Name',value:'duplicate',valueVisible:true,x:10,y:-10})]);
await assert.rejects(()=>action(duplicateAttr.eda,complete),/Expected one Name attribute/);
assert.equal(duplicateAttr.writes,0);
const duplicateFlag=fixture();await duplicateFlag.connect();
const originalFlag=duplicateFlag.all().find(r=>r.head.id==='A1-f0');
duplicateFlag.source=encode([...duplicateFlag.all(),rec('COMPONENT','extra-flag',{...originalFlag.payload}),
  rec('ATTR','extra-flag-name',{parentId:'extra-flag',key:'Name',value:'NET_A1_0'})]);
await assert.rejects(()=>action(duplicateFlag.eda,complete),/Ambiguous flag/);
assert.equal(duplicateFlag.writes,0);

// Attribute expressions preserve valid falsy values instead of using fallback text.
const expression=fixture(),literal=fixture();
expression.source=encode([...expression.all().map(r=>{
  if(r.head.id==='A1-Name')r.payload.value='={Value}';return r;
}),rec('ATTR','value-zero',{parentId:'A1',key:'Value',value:0,valueVisible:false})]);
literal.source=literal.source.replace('LONG_COMPONENT_VALUE','0');
assert.deepEqual((await action(expression.eda,complete)).deltas,(await action(literal.eda,complete)).deltas);

// Full serialized outputs captured before refactoring, not generated by the new code.
const goldenHashes={
  top:'4f63c02d17942669b1313501303f11349f67f03ad4cbb03c37e708b41be2b2b3',
  bottom:'dc04b3f7bc02bde30983ae7fe51aa10651d500fee019a0133a8e30d72aba9122',
  left:'9323f1a9733d9d69b6e226b4ec973ad24e8360fb85da5cbaa2a2e3d576da3f5b',
  right:'9e31a56a554e663cb517fc91b75d9895e898ae799787066a66963d39e44f7b30',
};
for(const [side,expectedHash] of Object.entries(goldenHashes)) {
  const golden=fixture(5);await golden.connect();
  const config={expectedProjectUuid:'project',expectedDocumentUuid:'sheet',phase:'complete',
    blocks:[{name:'main',members:['A1','B1','X2'],columns:2},{name:'aux',members:['X3','X4'],columns:1}],
    layout:{unit:'easyeda-schematic',mainFlow:['main'],attachments:[{block:'aux',targets:['main'],preferredSide:side}]}};
  await action(golden.eda,(await action(golden.eda,config)).applyRequest);
  assert.equal(createHash('sha256').update(golden.source).digest('hex'),expectedHash,side+' legacy layout changed');
}
const unsaved=fixture(),unsavedPlan=await action(unsaved.eda,input);
unsaved.eda.sch_Document.save=async()=>false;
await assert.rejects(()=>action(unsaved.eda,unsavedPlan.applyRequest),/save.*failed/i);
assert.equal(unsaved.writes,1,'A failed save must not trigger another import or blind rollback');
console.log('schematic reflow tests passed');
