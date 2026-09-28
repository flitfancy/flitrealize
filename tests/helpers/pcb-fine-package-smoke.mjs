import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const installed=process.argv[2],execute=promisify(execFile);
const temporary=await fs.mkdtemp(path.join(tmpdir(),'fine-release-smoke-'));
try{
 const project=path.join(temporary,'project');
 await fs.cp(path.join(installed,'assets/pcb-layout/minimal-project'),project,{recursive:true});
 const snapshotFile=path.join(project,'snapshot.json'),snapshot=JSON.parse(await fs.readFile(snapshotFile,'utf8'));
 const mechanical=JSON.parse(await fs.readFile(path.join(project,'design/PCB_SILK_RULES.v1.json'),'utf8'));
 mechanical.expectedProjectUuid='synthetic-fine-project';mechanical.expectedDocumentUuid='synthetic-fine-pcb';
 await fs.writeFile(path.join(project,'design/PCB_SILK_RULES.v1.json'),JSON.stringify(mechanical));
 snapshot.document={uuid:mechanical.expectedDocumentUuid,parentProjectUuid:mechanical.expectedProjectUuid};
 snapshot.outlines=[{id:'example-board',path:[-100,-100,'L',600,-100,600,400,-100,400,-100,-100]}];
 snapshot.regions=[];snapshot.routing={Line:0,Arc:0,Polyline:0,Via:0,Pour:0};
 await fs.writeFile(snapshotFile,JSON.stringify(snapshot));
 const packDir=path.join(temporary,'packing');
 const run=await execute(process.execPath,[path.join(installed,'scripts/pcb-fine-layout.mjs'),'--project-root',project,'--snapshot',snapshotFile,'--report-dir',packDir],{cwd:temporary});
 const packed=JSON.parse(run.stdout);assert.equal(packed.status,'packed-candidate');assert.equal(packed.algorithmName,'1.5维重力算法');assert.equal(packed.nativeWrites,0);assert.equal(packed.placed,snapshot.components.length);
 const candidate=JSON.parse(await fs.readFile(path.join(packDir,'candidate.json'),'utf8'));assert.equal(candidate.complete,true);
 const html=await fs.readFile(path.join(packDir,'comparison.html'),'utf8');new Function(html.match(/<script>\n([\s\S]*)<\/script>/)[1]);
 const inputFile=path.join(project,'review-input.json');
 const request={schemaVersion:1,expectedSourceHash:snapshot.sourceHash,movableDesignators:[],planInput:{mode:'plan',expectedProjectUuid:snapshot.document.parentProjectUuid,expectedDocumentUuid:snapshot.document.uuid,lockedDesignators:[],reservedRegions:[],clearanceMil:5,scenarios:[{name:'baseline',placements:[]}]}};
 await fs.writeFile(inputFile,JSON.stringify(request));
 const reviewed=await execute(process.execPath,[path.join(installed,'scripts/pcb-fine-review.mjs'),'--snapshot',snapshotFile,'--input-file',inputFile,'--report-dir',path.join(temporary,'review')],{cwd:temporary});
 assert.equal(JSON.parse(reviewed.stdout).status,'reviewed');
 console.log('Packaged 1.5D gravity and fine review ran without EDA.');
}finally{
 assert.equal(path.dirname(path.resolve(temporary)),path.resolve(tmpdir()));assert.ok(path.basename(temporary).startsWith('fine-release-smoke-'));
 await fs.rm(temporary,{recursive:true,force:true});
}
