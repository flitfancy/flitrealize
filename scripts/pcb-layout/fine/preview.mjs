import fs from 'node:fs/promises';
import path from 'node:path';
import { measure, score, scoreBreakdown, validatePlan } from '../pcb-layout-solver-core.mjs';
import { comparisonReport } from '../pcb-layout-solver-report.mjs';
import { auditFineCandidate } from './audit.mjs';

/** Package the existing comparison renderer; no new drawing or layout engine. */
export async function writeFinePreview(scope,compilation,candidate,directory,timing) {
  const model=scope.model;
  const renderCandidate=(plan,name,label,audit)=>{
    const metrics=measure(model,plan.components,plan.labels,plan.bundles,plan.testPads),validation=validatePlan(model,plan);
    return {name,label,plan,metrics,validation:{...validation,valid:audit.wholeBoardAccepted,issues:[...audit.blockingIssues,...audit.retainedOutsideIssues]},comparisonScore:score(model,metrics),scores:scoreBreakdown(model,metrics),stats:null};
  };
  const beforeAudit=auditFineCandidate(scope,compilation,compilation.baseline.plan,{timing});
  const before=renderCandidate(compilation.baseline.plan,'before','输入快照',beforeAudit),after=renderCandidate(candidate.plan,'after','细布局候选（局部与整板资格分列）',candidate.audit);
  const html=comparisonReport([before,after],before,model.config,model.contract,model.snapshot);
  const svgs=[...html.matchAll(/<svg\b[\s\S]*?<\/svg>/g)].map(m=>m[0]);
  if(svgs.length<2)throw Error('FINE_PREVIEW_SVG_MISSING');
  const css=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
  const files=[['comparison.html',html],...svgs.slice(0,2).map((svg,index)=>[index?'after.svg':'before.svg',svg.replace('<svg ','<svg xmlns="http://www.w3.org/2000/svg" ').replace(/(<svg[^>]*>)/,'$1<style><![CDATA['+css+']]></style>')])];
  const write=async()=>{for(const [name,content]of files)await fs.writeFile(path.join(directory,name),content+'\n',{flag:'wx'});};
  if(timing)await timing.run('files',write);else await write();
  return {status:'completed',files:files.map(([name])=>name),sourceHash:model.snapshot.sourceHash,candidateHash:candidate.candidateHash,scope:'Existing renderer of full frozen scene; visual comparison does not add routing or native acceptance.'};
}
