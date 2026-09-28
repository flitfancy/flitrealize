#!/usr/bin/env node
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { existsSync,realpathSync } from 'node:fs';
import { resolve,dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLayoutProject } from './pcb-layout/pcb-layout-project.mjs';
import { packFineLayout } from './pcb-layout/pcb-gravity-pack.mjs';
import { gravityReport,gravitySvg } from './pcb-layout/pcb-gravity-report.mjs';

const help=`1.5维重力算法：组块 → 预生成形状 → 原布局分层顺序 → 重力下落。
node scripts/pcb-fine-layout.mjs --project-root <project> --snapshot <snapshot.json>
  --report-dir <new-directory> [--config <project-relative-layout.json>] [--options-file <packing.json>]
Reads existing project configuration. Writes offline candidates/reports only; no EDA calls.
An existing native board is reused. Without one, create/verify the emitted board request first.`;
const json=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
export async function main(args=process.argv.slice(2),{log=v=>console.log(JSON.stringify(v))}={}){
 if(args.length===1&&args[0]==='--help'){console.log(help);return;}
 const opts={};
 for(let i=0;i<args.length;i++){const key=args[i],value=args[++i];if(!['--project-root','--snapshot','--report-dir','--config','--options-file'].includes(key)||opts[key]!==undefined||!value||value.startsWith('--'))throw Error('INVALID_OPTION '+key);opts[key]=value;}
 for(const key of ['--project-root','--snapshot','--report-dir'])if(!opts[key])throw Error('OPTION_REQUIRED '+key);
 const loaded=await loadLayoutProject(resolve(opts['--project-root']),{configFile:opts['--config']});
 const raw=await json(resolve(opts['--snapshot'])),snapshot=raw.response?.result??raw.result??raw;
 const config=loaded.config;
 const input={snapshot,spatial:config.spatial??{},layout:config,features:{components:config.componentFeatures??[]},geometryViews:config.geometryViews??{},assemblyRules:config.assemblyRules,mechanical:loaded.mechanical,options:opts['--options-file']?await json(resolve(opts['--options-file'])):{}};
 const result=packFineLayout(input),dir=resolve(opts['--report-dir']);
 await mkdir(dirname(dir),{recursive:true});await mkdir(dir);
 const write=(name,v)=>writeFile(join(dir,name),typeof v==='string'?v:JSON.stringify(v,null,2)+'\n',{flag:'wx'});
 await write('inputs.json',input);
 const {shapeLibrary,runs,candidate,geometry,...summary}=result;
 await write('summary.json',{...summary,runs:runs?.map(({placed,...r})=>r)});
 if(result.boardOutlineRequest)await write('board-outline-request.json',result.boardOutlineRequest);
 if(candidate){await write('candidate.json',candidate);await write('runs.json',runs);await write('shape-library.json',shapeLibrary);await write('geometry.json',geometry);await write('candidate.svg',gravitySvg(result));}
 await write('comparison.html',gravityReport(result));
 log({status:result.status,algorithmName:result.algorithmName,nativeWrites:0,report:dir,units:result.unitCount,shapes:result.shapeVariantCount,selectedRun:result.selectedRun,placed:result.candidate?.placedObjectCount,total:result.objectCount,complete:result.candidate?.complete});
 return result;
}
if(process.argv[1]&&existsSync(process.argv[1])&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url)))main().catch(error=>{console.error(JSON.stringify({status:'failed',error:error.message}));process.exitCode=1;});
