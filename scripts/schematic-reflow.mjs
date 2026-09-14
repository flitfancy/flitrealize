#!/usr/bin/env node
/**
 * Invoke the registered schematic-reflow Action; never connects to Bridge directly.
 *
 * node <skill>/scripts/schematic-reflow.mjs --input-file <layout.json>
 *   --project-root <project> --window-id <window> [--apply]
 *
 * Input (units are explicit; top/bottom refer to screen directions):
 * {
 *   "expectedProjectUuid": "...", "expectedDocumentUuid": "...",
 *   "phase": "initial",
 *   "blocks": [{"name":"input","members":["J1","R1"],"columns":1}],
 *   "layout": {"unit":"easyeda-schematic","componentSpacing":72,
 *     "blockSpacing":210,"attachmentSpacing":140,"mainFlow":["input"],
 *     "attachments":[]}
 * }
 *
 * initial: unconnected components, after the existing component-create workflow.
 * complete: existing straight pin stubs, one net flag per stub, local text + reflow.
 * Attachments: {block, targets: [main-flow block names], preferredSide}.
 * Default: read-only plan. --apply plans, backs up source, applies and verifies.
 * Complete mode does not create/delete primitives or redesign the circuit.
 * Both passes use one ownership/geometry model. text.bodyMargin applies to both;
 * text options use native schematic units, independent of layout.unit.
 * Bounds estimate symbol extent from pins/anchor and text from character widths.
 * Free-standing notes/graphics are preserved, but are not layout obstacles.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const scriptRoot=dirname(fileURLToPath(import.meta.url));
const args={apply:false};
for(let i=2;i<process.argv.length;i++) {
  const a=process.argv[i];
  if(a==='--help'){console.log((await readFile(fileURLToPath(import.meta.url),'utf8')).split(' */')[0].replace(/^#!.*\n/,''));process.exit(0);}
  if(a==='--apply'){args.apply=true;continue;}
  if(!['--input-file','--project-root','--window-id'].includes(a)||!process.argv[i+1])throw new Error('Unknown or incomplete argument '+a);
  args[a.slice(2)]=process.argv[++i];
}
if(!args['input-file']||!args['project-root']||!args['window-id'])throw new Error('Required: --input-file, --project-root, --window-id');
const input=JSON.parse(await readFile(resolve(args['input-file']),'utf8'));
const reportRoot=join(resolve(args['project-root']),'evidence','schematic-reflow-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());
await mkdir(reportRoot,{recursive:true});
async function invoke(mode,request) {
  const inputPath=join(reportRoot,mode+'-input.json'),reportPath=join(reportRoot,mode+'-report.json');
  await writeFile(inputPath,JSON.stringify({...request,mode},null,2));
  const flags=[join(scriptRoot,'action-runner.mjs'),'run','--action','schematic-reflow',
    '--input-file',inputPath,'--project-root',resolve(args['project-root']),
    '--window-id',args['window-id'],'--report-file',reportPath];
  if(mode==='apply')flags.push('--allow-write');
  try {
    await promisify(execFile)(process.execPath,flags,{windowsHide:true,timeout:90000,maxBuffer:4*1024*1024});
  } catch(error) {
    throw new Error(mode+' failed; inspect '+reportPath+'; '+(error.stderr||error.message));
  }
  const report=JSON.parse(await readFile(reportPath,'utf8'));
  const result=report.response?.result;
  const expected={plan:'planned',apply:'applied',verify:'verified'}[mode];
  if(report.response?.success===false||result?.status!==expected)throw new Error(mode+' did not complete: '+reportPath);
  return result;
}
try {
  const started=Date.now();
  const plan=await invoke('plan',input);
  const backup=join(reportRoot,'before.esch');
  await writeFile(backup,plan.backupSource);
  if(!args.apply) {
    console.log(JSON.stringify({ok:true,readOnly:true,phase:plan.phase,changed:plan.changed,
      componentCount:plan.componentCount,wireCount:plan.wireCount,movedCount:plan.movedCount,reportRoot,backup}));
  } else {
    const applied=await invoke('apply',plan.applyRequest);
    const verified=await invoke('verify',input);
    console.log(JSON.stringify({ok:true,phase:applied.phase,saved:applied.saved,verified:verified.status==='verified',
      componentCount:applied.componentCount,wireCount:applied.wireCount,movedCount:applied.movedCount,elapsedMs:Date.now()-started,reportRoot,backup}));
  }
} catch(error) {
  console.error(JSON.stringify({ok:false,error:error.message,reportRoot}));process.exitCode=1;
}
