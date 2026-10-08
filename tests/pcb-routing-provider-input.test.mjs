import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {normalizeBoard} from '../scripts/providers/easyeda-pro/routing-input.mjs';
import * as provider from '../scripts/providers/easyeda-pro/routing-provider.mjs';
import * as compatibility from '../scripts/pcb-routing/provider.mjs';
import {compileTasks} from '../scripts/pcb-routing/model.mjs';
import * as sourceInvariant from '../scripts/providers/easyeda-pro/source-invariant.mjs';
import * as legacyInvariant from '../scripts/pcb-routing/source-invariant.mjs';

function fixture(){
 const exported={project:'PROJECT',document:'BOARD',netNames:['N'],objects:{lines:[{PrimitiveId:'line',Net:'N',Layer:1,LineWidth:6,StartX:10,StartY:10,EndX:40,EndY:10}],vias:[],arcs:[],polylines:[]},
  dsnText:'(PCB demo (structure (layer TopLayer (type signal)) (layer BottomLayer (type signal)) (via v)) (library (image u1 (pin p A 10 10) (pin p B 40 10)) (padstack p (shape (circle TopLayer 4))) (padstack v (shape (circle TopLayer 24)) (shape (circle BottomLayer 24)))) (placement (component u1 (place u1 0 0 front 0))) (network (net N (pins u1-A u1-B))) (wiring))'};
 const padRead={pads:[{id:'eA',net:'N',x:10,y:10},{id:'eB',net:'N',x:40,y:10}],components:[{id:'e',ref:'PART',pads:[{primitiveId:'A',padNumber:'1'},{primitiveId:'B',padNumber:'2'}]}]};
 const policy={units:'mil',clearances:{ordinaryCopperMil:6},nets:[{net:'N',defaultWireWidthMil:6,primaryAutoLayers:[1,2],endpoints:[{endpoint:'PART.1',padId:'eA'},{endpoint:'PART.2',padId:'eB'}],roles:[{name:'ordinary_signal',endpoints:['PART.1','PART.2'],widthMil:6,allowedLayers:[1,2]}]}]};
 return{exported,padRead,policy};
}
test('EasyEDA Provider owns native/DSN binding and exposes a public net inventory',()=>{
 const f=fixture(),board=normalizeBoard(f.exported,f.padRead,f.policy);
 assert.equal(board.provider,'easyeda-pro');assert.equal(board.units,'mil');assert.deepEqual(board.layers,[1,2]);assert.deepEqual(board.netNames,['N']);
 assert.deepEqual(board.pads.map(p=>[p.id,p.ref,p.pin,p.dsnRef]),[['eA','PART','1','u1-A'],['eB','PART','2','u1-B']]);
 const publicBoard={layers:board.layers,pads:board.pads,segments:board.segments,vias:board.vias};
 assert.equal(compileTasks(publicBoard,f.policy)[0].status,'already-connected');
 const before=structuredClone(f.padRead);f.padRead.pads[0].x+=1;assert.throws(()=>normalizeBoard(f.exported,f.padRead,f.policy),/PAD_BINDING_CHANGED/);assert.deepEqual(before.pads[1],f.padRead.pads[1]);
});
test('legacy Provider exports delegate to the same implementation and assemble the same native source',async()=>{
 for(const name of ['digest','prepareNativeSource','executeNative','activeWindow','legacySnapshot','updateBoardSnapshot'])assert.equal(compatibility[name],provider[name]);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'routing-provider-'));
 try{const file=await provider.prepareNativeSource(dir),text=await fs.readFile(file,'utf8');assert.ok(text.includes('routingViaLayers'));assert.ok(text.includes('NATIVE_DRC_FAILED'));assert.ok(text.includes('sourceInvariantHash'));}
 finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('native source normalization is Provider-owned and the legacy module only delegates',async()=>{
 assert.equal(legacyInvariant.invariant,sourceInvariant.invariant);assert.equal(legacyInvariant.canonical,sourceInvariant.canonical);
 const record=(type,id,value)=>JSON.stringify({type,id})+'||'+JSON.stringify(value)+'|';
 const source=(session,x,copper)=>[record('DOCHEAD','head',{session}),record('COMPONENT','part',{x,y:20,zIndex:session}),record('LINE','wire',{layerId:1,x:copper})].join('\n');
 assert.equal(sourceInvariant.invariant(source(1,10,5)),sourceInvariant.invariant(source(2,10,30)));
 assert.notEqual(sourceInvariant.invariant(source(1,10,5)),sourceInvariant.invariant(source(1,11,5)));
 const compatibilitySource=await fs.readFile(new URL('../scripts/pcb-routing/source-invariant.mjs',import.meta.url),'utf8');
 assert.match(compatibilitySource,/export \{ canonical, invariant \} from/);assert.ok(!compatibilitySource.includes('DOCHEAD'));
});
