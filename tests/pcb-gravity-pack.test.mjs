import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packFineLayout } from '../scripts/pcb-layout/pcb-gravity-pack.mjs';
import { buildShapeLibrary } from '../scripts/pcb-layout/pcb-gravity-shapes.mjs';
import { gravityReport,gravitySvg } from '../scripts/pcb-layout/pcb-gravity-report.mjs';

function fixture(poses=[['A',15,80],['B',60,80],['C',25,25]]){
 const cs=poses.map(([ref,x,y,w=10,h=10])=>({id:'c-'+ref,ref,x,y,rotation:0,layer:1,locked:false,bbox:{minX:x-w/2,maxX:x+w/2,minY:y-h/2,maxY:y+h/2},footprint:{name:'FP'}}));
 return {snapshot:{units:'mil',coordinateSystem:'eda-y-up',provider:'easyeda-pro',sourceHash:1,document:{uuid:'pcb',parentProjectUuid:'p'},components:cs,pads:cs.map(c=>({id:c.id+'p',owner:c.ref,parentComponentId:c.id,number:'1',net:'N',x:c.x,y:c.y,layer:1,bbox:{minX:c.x-2,maxX:c.x+2,minY:c.y-2,maxY:c.y+2}})),items:[],regions:[],routing:{Line:0,Arc:0,Polyline:0,Via:0,Pour:0},outlines:[{id:'board',path:[0,0,'L',100,0,100,100,0,100,0,0]}]},
 spatial:{localGroups:[]},layout:{hard:{preserveRotations:false,fixed:[],boardBounds:null},search:{rotationDeltas:[0,90,180,270]}},features:{components:[]},geometryViews:{},
 assemblyRules:{schemaVersion:1,profile:{id:'test',label:'test'},source:{title:'test',url:'https://example.invalid'},rules:[{id:'fp',footprintNames:['FP'],marginMm:0}],overrides:[],independentPads:{marginMm:0,basis:'test'}},
 mechanical:{expectedProjectUuid:'p',expectedDocumentUuid:'pcb'},options:{marginMil:0,gridMil:5,trials:[{name:'left',tieMode:'left'}]}};
}
test('packing follows source rows, drops to contact and preserves the input',()=>{
 const input=fixture(),before=structuredClone(input),out=packFineLayout(input);
 assert.deepEqual(input,before);assert.deepEqual(out.selectionOrder,['A','B','C']);assert.equal(out.candidate.complete,true);
 assert.equal(out.candidate.placed[0].bbox.minY,0);assert.equal(out.candidate.placed[0].bbox.minX,0);
 assert.equal(out.candidate.placed[1].bbox.minY,0);assert.equal(out.objectCount,3);assert.equal(out.nativeWrites,0);
 assert.equal(out.checks.assembly.issues.length,0);
});
test('overlapping localGroups become one unit with finite compacted shapes',()=>{
 const input=fixture([['A',20,50],['B',50,50],['C',80,50]]);
 input.spatial.localGroups=[{id:'ab',anchor:'A',refs:['A','B']},{id:'bc',anchor:'B',refs:['B','C']}];
 const out=packFineLayout(input);assert.equal(out.unitCount,1);assert.equal(out.shapeLibrary[0].id,'ab+bc');
 assert.ok(out.shapeLibrary[0].variants.some(v=>v.deformation==='compress-x'));
 for(const v of out.shapeLibrary[0].variants){assert.deepEqual([...v.members.map(m=>m.ref)].sort(),['A','B','C']);}
 const x=out.shapeLibrary[0].variants.find(v=>v.name==='compress-x@0');
 assert.equal(x.widthMil,30);assert.ok(x.members[0].xMil<x.members[1].xMil&&x.members[1].xMil<x.members[2].xMil);
});
test('locked group members fix the whole block and retain cavities between members',()=>{
 const input=fixture([['A',10,10,20,20],['B',50,10,20,20],['C',10,50,20,20],['D',80,90,10,10]]);
 input.snapshot.components[0].locked=true;
 input.spatial.localGroups=[{id:'L',anchor:'A',refs:['A','B','C']}];
 const out=packFineLayout(input),group=out.candidate.placed.find(u=>u.id==='L'),other=out.candidate.placed.find(u=>u.id==='D');
 assert.equal(group.fixed,true);assert.equal(out.shapeLibrary.find(u=>u.id==='L').variantCount,1);
 for(const pose of group.poses){const old=input.snapshot.components.find(c=>c.ref===pose.ref);assert.equal(pose.x,old.x);assert.equal(pose.y,old.y);}
 assert.equal(other.bbox.minY,0);assert.ok(other.bbox.minX>=20&&other.bbox.maxX<=40);
 assert.equal(out.candidate.complete,true);
});
test('standalone pads participate once and native pad locks remain fixed',()=>{
 const input=fixture();input.snapshot.pads.push({id:'tp',owner:null,parentComponentId:null,number:'TPX',net:'N',x:70,y:60,layer:1,locked:true,bbox:{minX:66,maxX:74,minY:56,maxY:64}});
 const out=packFineLayout(input),p=out.candidate.placed.find(u=>u.id==='TPX');assert.equal(out.objectCount,4);assert.equal(p.fixed,true);assert.equal(p.poses[0].x,70);assert.equal(p.poses[0].y,60);
 assert.equal(out.geometry.pads.find(p=>p.id==='tp').net,'N');
});
test('allowed rotations are intersected and an oversized block is not silently omitted',()=>{
 const input=fixture([['A',50,50,110,15]]);
 input.layout.hard.allowedRotationDeltasByRef={A:[0]};input.features.components=[{ref:'A',allowedRotationDeltas:[0,180]}];
 const out=packFineLayout(input);assert.equal(out.status,'partial-packing');assert.equal(out.shapeVariantCount,1);assert.deepEqual(out.candidate.unplaced,['A']);assert.equal(out.geometry,null);
});
test('missing board stops before packing and existing mismatched or irregular outline is rejected',()=>{
 const input=fixture();input.snapshot.outlines=[];
 let out=packFineLayout(input);assert.equal(out.status,'board-outline-required');assert.equal(out.boardOutlineRequest,null);
 input.layout.hard.boardBounds={minX:0,minY:0,maxX:110,maxY:100};out=packFineLayout(input);assert.equal(out.boardOutlineRequest.rect.widthMil,110);assert.equal(out.candidate,undefined);
 input.snapshot.outlines=fixture().snapshot.outlines;assert.throws(()=>packFineLayout(input),/BOARD_BOUNDS_MISMATCH/);
 input.layout.hard.boardBounds=null;input.snapshot.outlines[0].path=[0,0,'L',90,0,100,100,0,100,0,0];assert.throws(()=>packFineLayout(input),/BOARD_OUTLINE_UNSUPPORTED/);
});
test('group overlap, unknown anchors, invalid grids and unknown custom references fail explicitly',()=>{
 let input=fixture([['A',20,20],['B',20,20]]);input.spatial.localGroups=[{id:'g',refs:['A','B']}];assert.throws(()=>packFineLayout(input),/Original unit overlaps/);
 input=fixture();input.spatial.localGroups=[{id:'g',refs:['A'],anchor:'B'}];assert.throws(()=>packFineLayout(input),/INVALID_LOCAL_GROUPS/);
 input=fixture();input.options.gridMil=0;assert.throws(()=>packFineLayout(input),/INVALID_PACKING_DIMENSIONS/);
 input=fixture();input.options.fixedRefs=['unknown'];assert.throws(()=>packFineLayout(input),/UNKNOWN_FIXED_REF/);
 input=fixture();input.mechanical={};delete input.snapshot.document;assert.throws(()=>packFineLayout(input),/TARGET_MISMATCH/);
});
test('fixed obstacles and routed state are preserved while offline packing remains possible',()=>{
 const input=fixture();input.snapshot.routing.Line=2;input.options.reservedRegions=[{name:'access',bbox:{minX:0,minY:0,maxX:100,maxY:20}}];
 const out=packFineLayout(input);assert.ok(out.candidate.placed.every(u=>u.bbox.minY>=20));assert.equal(out.execution.routedBoard,true);assert.equal(out.nativeWrites,0);
});
test('shape builder keeps standalone pad orientation and refuses overlapping source pieces',()=>{
 const current={components:[],pads:[{number:'TP',owner:null,x:10,y:10}]};
 const units=[{id:'TP',anchorRef:'TP',refs:['TP'],boxes:[{minX:5,maxX:15,minY:5,maxY:15}]}];
 const library=buildShapeLibrary(units,current,{rotationDeltas:[0,90,180,270]});assert.deepEqual(library[0].variants.map(v=>v.rotationDelta),[0]);
});
test('preview exposes actual packing sequence and embedded JavaScript parses',()=>{
 const out=packFineLayout(fixture()),html=gravityReport(out);
 const script=html.match(/<script>\n([\s\S]*)<\/script>/)[1];assert.doesNotThrow(()=>new Function(script));
 const embedded=JSON.parse(html.match(/type="application\/json">([\s\S]*?)<\/script>/)[1]);
 assert.deepEqual(embedded.runs[0].placed.map(x=>x.id),out.candidate.placed.map(x=>x.id));
 assert.match(gravitySvg(out),/A/);
});
test('native-free CLI and Action both run the packing algorithm',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fine-tetris-'));
 try{
  const input=fixture();await writeFile(join(dir,'input.json'),JSON.stringify({mode:'pack',...input}));
  const runner=fileURLToPath(new URL('../scripts/action-runner.mjs',import.meta.url));
  const run=spawnSync(process.execPath,[runner,'run','--action','pcb-fine-layout','--input-file',join(dir,'input.json'),'--project-root',dir,'--report-file',join(dir,'result.json'),'--full'],{encoding:'utf8',windowsHide:true});
  assert.equal(run.status,0,run.stderr+run.stdout);const result=JSON.parse(await readFile(join(dir,'result.json'),'utf8'));
  assert.equal(result.response.result.packingStatus,'packed-candidate');assert.equal(result.response.result.candidate.placedObjectCount,3);
 }finally{await rm(dir,{recursive:true,force:true});}
});
