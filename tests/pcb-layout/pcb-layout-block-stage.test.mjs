import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { prepareFixture, addIntent, filterRelation } from '../helpers/pcb-layout-prepare-fixture.mjs';
import { prepareLayoutInputs } from '../../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { scopeLayoutModel } from '../../scripts/pcb-layout/pcb-layout-scope.mjs';
import { compileCpSatProblem, compileSemanticCpSatProblem, decodeCpSatCandidate, executeCpSat, runCpsatLayout } from '../../scripts/pcb-layout/pcb-layout-cpsat.mjs';
import { convertSemanticInputs } from '../../scripts/pcb-layout/pcb-layout-semantic.mjs';
import { applyBlockLayoutObjective, scoreBlockLayoutMetrics, blockLayoutPhysicalIssues, blockLayoutStageModel, blockLayoutHardLimitIssues } from '../../scripts/pcb-layout/pcb-layout-block-objective.mjs';
import { inspectCandidate } from '../../scripts/pcb-layout/pcb-layout-solver-core.mjs';
import { normalizeFineRequest } from '../../scripts/pcb-layout/fine/request.mjs';
import { compileFineProblem } from '../../scripts/pcb-layout/fine/compile.mjs';
import { comparisonReport } from '../../scripts/pcb-layout/pcb-layout-solver-report.mjs';

const runtime={pythonPath:process.env.FLITREALIZE_CPSAT_PYTHON},skip=!runtime.pythonPath&&'Existing OR-Tools runtime required';
const settings={resolutionMil:.1,timeLimitSeconds:1,workers:1,seed:19};
function fixture(){const f=prepareFixture();f.config.hard.boardBounds={minX:-100,minY:-100,maxX:400,maxY:300};return f;}
function model(f=fixture(),labels=false){const p=prepareLayoutInputs(f);assert.equal(p.state.ready,true,JSON.stringify(p.diagnostics));return labels?p.model:scopeLayoutModel(p.model,{includeLabels:false});}
function compile(m,policy){return compileSemanticCpSatProblem(m,settings,{includeLabels:!!m.snapshot.items.length,...(policy?{roughLayoutPolicy:policy}:{})}).problem;}
function decode(m,p,poses){return decodeCpSatCandidate(m,p,{status:'FEASIBLE',sourceHash:m.snapshot.sourceHash,placements:p.entities.map(e=>{const c=poses[e.ref];return {ref:e.ref,dx:Math.round((c.x-e.base.x)/p.settings.resolutionMil),dy:Math.round((c.y-e.base.y)/p.settings.resolutionMil),variant:e.variants.findIndex(v=>v.rotation===(c.rotation??0))};})});}

test('confirmed membership includes every member without requiring any relation or role heuristic',()=>{
  const f=fixture(),m=model(f),before=JSON.stringify(f),s=convertSemanticInputs(m,{groupScope:'declared-block'});
  assert.deepEqual(s.groups.map(g=>[g.id,g.members]),[['supply',['U1','C1']]]);assert.equal(s.inferredLinks.length,0);assert.equal(JSON.stringify(f),before);
  m.contract.blocks.push({id:'shared',components:['C1']});assert.throws(()=>convertSemanticInputs(m),/SEMANTIC_BLOCK_MEMBERSHIP_REQUIRED C1/);
  m.contract.blocks=[{id:'missing',components:['U1']}];assert.throws(()=>convertSemanticInputs(m),/SEMANTIC_BLOCK_MEMBERSHIP_REQUIRED C1/);
});

test('physical centre includes protruding pads and rotates its offset instead of using the component origin',()=>{
  const f=fixture(),pad=f.snapshot.pads[0];pad.x=35;pad.bbox={minX:30,maxX:40,minY:-2,maxY:2};
  const m=model(f),p=compile(m),c=decode(m,p,{U1:{x:20,y:40,rotation:90},C1:{x:160,y:40}}),e=c.blockLayoutMetrics.relations[0];
  assert.equal(c.validation.valid,true,JSON.stringify(c.validation.issues));
  const u=e.centers[e.a==='U1'?0:1];assert.equal(u.x,20);assert.equal(u.y,55);assert.equal(e.euclideanMil,Math.hypot(140,15));
  assert.ok(Math.abs(e.distanceMil-e.euclideanMil)<=e.euclideanMil*.01936+Math.SQRT2*.1);
});

test('cross-block links remain real sparse relations, deduplicated across objective groups and nets',()=>{
  const f=addIntent(fixture(),filterRelation());f.contract.blocks=[{id:'source',components:['U1']},{id:'load',components:['C1']}];
  for(const id of ['power','sense'])f.config.groups.find(g=>g.id===id).links.push({a:'U1',b:'C1',nets:['SUPPLY']});
  const m=model(f),p=compile(m);assert.equal(p.blockLayout.relations.length,1);assert.equal(p.blockLayout.relations[0].sameBlock,false);
  assert.deepEqual(p.blockLayout.relations[0].groups,['bypass','connectivity','power','sense']);assert.deepEqual(p.links,[]);assert.deepEqual(p.nets,[]);assert.deepEqual(p.semanticGroups,[]);
  const c=decode(m,p,{U1:{x:0,y:0},C1:{x:100,y:30}}),edge=c.blockLayoutMetrics.relations[0];
  assert.ok(Math.abs(c.comparisonScore-edge.distanceMil*p.blockLayout.relations[0].weight)<1e-10);
  assert.equal(c.blockLayout.blocks.length,2);assert.equal(c.blockLayout.blocks[0].connections.length,1);assert.equal(c.blockLayout.derivedRegionsBecomeKeepouts,false);
});

test('a multi-owner net adds n-1 real bridges rather than all owner pairs and ignores source poses',()=>{
  const f=fixture();for(let i=2;i<5;i++){
    const ref='P'+i,x=80*i,c={...structuredClone(f.snapshot.components[0]),id:ref+':',ref,x,bbox:{minX:x-10,maxX:x+10,minY:-10,maxY:10}};
    f.snapshot.components.push(c);f.snapshot.pads.push({id:ref+':1',owner:ref,number:'1',net:'SUPPLY',x,y:0,bbox:{minX:x-2,maxX:x+2,minY:-2,maxY:2},layer:1});
    const label=structuredClone(f.snapshot.items[0]);label.id=ref+':label';label.owner=ref;label.parentId=c.id;label.text=ref;label.original.x=x-10;label.original.bbox={minX:x-10,maxX:x+10,minY:25,maxY:35};f.snapshot.items.push(label);
    f.contract.components.push({designator:ref,includeInPcb:true,role:'uninterpreted',pins:[{number:'1'}]});f.contract.blocks[0].components.push(ref);f.contract.nets[0].endpoints.push({component:ref,pin:'1'});
  }
  const m=model(f),p=compile(m);assert.equal(p.blockLayout.relations.length,4);
  const before=p.blockLayout.relations.map(e=>e.id);m.snapshot.components.reverse();assert.deepEqual(compile(m).blockLayout.relations.map(e=>e.id),before);
});

test('ordinary shared ground has no attraction while explicitly declared ground pin limits survive',()=>{
  const f=fixture();f.contract.nets[0].name='GND';f.contract.nets[0].kind='ground';for(const p of f.snapshot.pads)p.net='GND';
  f.config.groups[0].links=[{a:'U1',b:'C1',nets:['GND']}];f.config.hard.pinDistanceLimits=[{id:'ground-hard',a:'U1',aPin:'1',b:'C1',bPin:'1',net:'GND',maxMil:80}];
  const m=model(f),p=compile(m);assert.deepEqual(p.blockLayout.relations,[]);assert.equal(p.limits[0].id,'ground-hard');
  const c=decode(m,p,{U1:{x:0,y:0},C1:{x:100,y:0}});assert.equal(c.validation.valid,false);assert.ok(c.validation.issues.some(i=>i.code==='PIN_DISTANCE_LIMIT'));
});

test('stage default, override, stricter source/pair minima and fine spacing stay isolated',()=>{
  const f=fixture(),m=model(f,true),before=JSON.stringify(f),p=compile(m);
  assert.equal(p.pairs[0].gapMil,16);assert.equal(m.mechanical.clearanceMil,8);assert.equal(p.blockLayout.spacing.requestSource,'block-stage-default');
  assert.equal(compile(m,{schemaVersion:1,clearanceMil:10}).pairs[0].gapMil,10);
  assert.equal(compileCpSatProblem(m,settings).pairs[0].gapMil,8);
  const fine=normalizeFineRequest(m,{schemaVersion:1,blockId:'supply',region:{mode:'available-space',basis:'Stage isolation'},labels:{mode:'joint'},objective:{retainSource:false}});
  assert.equal(compileFineProblem(fine,settings).problem.pairs[0].gapMil,8);
  m.mechanical.clearanceMil=20;m.pairClearanceMap.set(JSON.stringify(['C1','U1']),30);assert.equal(compile(m,{schemaVersion:1,clearanceMil:10}).pairs[0].gapMil,30);
  assert.equal(JSON.stringify(f),before);
});

test('independent decoding rejects physical clearance violations even when centres score better',()=>{
  const f=fixture(),m=model(f),p=compile(m),c=decode(m,p,{U1:{x:0,y:0},C1:{x:28,y:0}});
  assert.equal(c.validation.valid,false);assert.ok(c.validation.issues.some(i=>i.code==='BLOCK_LAYOUT_PHYSICAL_GAP'));
  assert.ok(blockLayoutPhysicalIssues(blockLayoutStageModel(m),c.plan).length);
});

test('projection error remains bounded over angle, scale and negative quantized centres',()=>{
  const m=model(),p=compile(m);
  for(let i=0;i<90;i++){
    const r=50+i*2,a=i*Math.PI/45,x=Math.round(r*Math.cos(a)*10)/10,y=Math.round(r*Math.sin(a)*10)/10;
    const c=decode(m,p,{U1:{x:-20,y:-20},C1:{x:-20+x,y:-20+y}}),e=c.blockLayoutMetrics.relations[0];
    assert.ok(e.distanceMil<=e.euclideanMil+1e-8);assert.ok(e.euclideanMil-e.distanceMil<=e.euclideanMil*.01936+1e-8);
  }
});

test('real small solve, independent ranking and standalone HTML reweighting share one objective',{skip},async(t)=>{
  const f=addIntent(fixture(),filterRelation({maxDistanceMil:100}));f.config.roughLayoutPolicy={schemaVersion:1,groupCompactnessWeight:.3,density:{weight:.2,cellMil:100,targetCount:1,offsetFractions:[0,.5]}};
  f.config.comparisonWeights.uniformity=99;const m=model(f,true),startedAt=performance.now(),solved=await runCpsatLayout(m,settings,{candidateCount:1,runtime});
  assert.equal(solved.status,'candidates-ready',JSON.stringify(solved.runs));const c=solved.candidates[0];
  assert.ok(Math.abs(c.comparisonScore-solved.runs[0].solver.objective)<1e-7);assert.equal(c.rankingScore,c.comparisonScore);assert.equal(c.semanticCompactnessScore,0);
  t.diagnostic(JSON.stringify({solveCallMs:performance.now()-startedAt,solverWallSeconds:solved.runs[0].solver.wallSeconds}));
  const baseline=applyBlockLayoutObjective(m,solved.problem,inspectCandidate(m)),html=comparisonReport([c],baseline,m.config,m.contract,m.snapshot);
  const inputs=Object.entries(m.config.comparisonWeights).map(([key,value])=>({dataset:{weight:key},value:String(value),addEventListener(_,callback){this.update=callback;}}));
  const score={textContent:''},status={textContent:''},noop={addEventListener(){}},document={querySelectorAll(selector){if(selector==='[data-weight]')return inputs;return [];},querySelector(){return score;},getElementById(id){return id==='weight-status'?status:noop;}};
  vm.runInNewContext(html.slice(html.lastIndexOf('<script>')+8,html.lastIndexOf('</script>')),{document});
  assert.equal(score.textContent,c.comparisonScore.toFixed(4));inputs.find(i=>i.dataset.weight==='connectivity').value='8';inputs[0].update();
  assert.equal(score.textContent,scoreBlockLayoutMetrics(c.blockLayoutMetrics,{...m.config.comparisonWeights,connectivity:8}).total.toFixed(4));
  assert.ok(html.includes('block-layout-details'));assert.ok(html.includes('derivedRegionsBecomeKeepouts')===false);
});

test('real solve cannot trade an explicit pin-distance hard limit for any lower centre score',{skip},async()=>{
  const f=fixture();f.config.hard.pinDistanceLimits=[{id:'impossible-pin',a:'U1',aPin:'1',b:'C1',bPin:'1',net:'SUPPLY',maxMil:1}];
  const m=model(f),p=compile(m),r=await executeCpSat(p,runtime);assert.equal(r.status,'INFEASIBLE');assert.equal(p.limits[0].maxMil,1);
});

test('real readback keeps the exact original electrical pin caps and refuses missing measurements',()=>{
  const f=fixture();f.config.hard.pinDistanceLimits=[{id:'readback-hard',a:'U1',aPin:'1',b:'C1',bPin:'1',net:'SUPPLY',maxMil:80}];
  const m=model(f),pads=structuredClone(m.pads);assert.equal(blockLayoutHardLimitIssues(m,pads)[0].id,'readback-hard');
  pads[1].x=60;assert.deepEqual(blockLayoutHardLimitIssues(m,pads),[]);
  assert.equal(blockLayoutHardLimitIssues(m,pads.slice(1))[0].code,'BLOCK_LAYOUT_REQUIRED_PAD_MISSING');
});

test('baseline signed angle aliases and off-grid poses retain their real physical centre',()=>{
  const f=fixture();for(const c of f.snapshot.components){c.x+=.049;c.bbox.minX+=.098;c.bbox.maxX+=.098;const p=f.snapshot.pads.find(p=>p.owner===c.ref);p.x+=.049;p.bbox.minX+=.049;p.bbox.maxX+=.049;}f.snapshot.components[0].rotation=-90;
  const m=model(f),p=compile(m),baseline=applyBlockLayoutObjective(m,p,inspectCandidate(m));
  for(const center of baseline.blockLayoutMetrics.relations[0].centers){assert.equal(center.quantized.x,Math.floor(center.x/settings.resolutionMil+.5));assert.equal(center.quantized.y,Math.floor(center.y/settings.resolutionMil+.5));}
  assert.equal(baseline.blockLayout.blocks[0].memberPoses[0].rotation,-90);
});

test('a stricter assembly courtyard still rejects a pose satisfying the stage floor',()=>{
  const f=fixture();f.config.assemblyRules={schemaVersion:1,profile:{id:'strict-test',label:'Strict synthetic courtyard'},source:{title:'Synthetic assembly regression',url:'https://example.test/assembly'},rules:[{id:'strict',footprintNames:['synthetic-package'],marginMm:.8}],independentPads:{marginMm:0,basis:'No standalone pads'}};
  const m=model(f),p=compile(m),c=decode(m,p,{U1:{x:0,y:0},C1:{x:40,y:0}});assert.equal(c.validation.valid,false);assert.ok(c.validation.issues.some(i=>i.code==='ASSEMBLY_COURTYARD_OVERLAP'));assert.ok(!c.validation.issues.some(i=>i.code==='BLOCK_LAYOUT_PHYSICAL_GAP'));
});

test('reported geometric totals are unscaled while the one stage score includes the intra-block factor',()=>{
  const m=model(),p=compile(m,{schemaVersion:1,groupCompactnessWeight:.2}),c=decode(m,p,{U1:{x:0,y:0},C1:{x:100,y:0}});
  assert.equal(Object.values(c.metrics.groups).reduce((n,g)=>n+g.mil,0),100);assert.equal(c.blockLayoutMetrics.relations[0].factor,.2);
  assert.equal(c.metrics.groups.connectivity.count,1);assert.equal(c.metrics.groups.power.count,0);
});

test('group counts and weighted scores match hand-calculated multi-category relations',()=>{
  const metrics={groupKeys:['power','sense','connectivity'],references:{power:10,sense:20,connectivity:10},roughScore:.75,relations:[
    {groups:['power','connectivity'],distanceMil:100,factor:.2},
    {groups:['sense'],distanceMil:40,factor:1},
    {groups:['power','sense'],distanceMil:20,factor:.5}
  ]};
  const score=scoreBlockLayoutMetrics(metrics,{power:2,sense:4,connectivity:1});
  // Divisor 7; normalized weights power=.2, sense=.2, connectivity=.1.
  // The equal power/sense ratio chooses power once; raw distances stay unscaled.
  assert.deepEqual(score.groups,{power:{mil:120,count:2},sense:{mil:40,count:1},connectivity:{mil:0,count:0}});
  assert.equal(score.electrical,2);assert.equal(score.spatial,.75);assert.equal(score.total,2.75);
  assert.deepEqual(scoreBlockLayoutMetrics({...metrics,relations:[],roughScore:0},{power:2,sense:4,connectivity:1}),{
    electrical:0,spatial:0,total:0,groups:{power:{mil:0,count:0},sense:{mil:0,count:0},connectivity:{mil:0,count:0}}
  });
});

test('block and ordinary reports distinguish score labels, spacing observations and rerun backends',()=>{
  const f=fixture();f.config.spatial={uniformity:{targetMil:40,toleranceMil:10}};f.config.comparisonWeights.uniformity=.5;
  const m=model(f,true),p=compile(m,{schemaVersion:1,clearanceMil:23}),c=decode(m,p,{U1:{x:0,y:0},C1:{x:100,y:0}});
  const baseline=applyBlockLayoutObjective(m,p,inspectCandidate(m));
  const input={blocks:[],components:[],standalonePads:[],board:{scoreReferences:c.metrics.scoreReferences}};
  const visible=comparisonReport([c],baseline,m.config,m.contract,m.snapshot,input).split('<script>')[0];
  assert.match(visible,/<th>中心连接<\/th><th>疏密与连接侧留白<\/th>/);
  assert.match(visible,/稀疏中心连接/);assert.match(visible,/间距均匀（本阶段不计分）/);
  assert.match(visible,/成员独立移动、旋转/);assert.match(visible,/不含装配留白/);
  assert.match(visible,/已验候选按当前权重比较/);assert.match(visible,/联合间距至少 23 mil/);
  assert.match(visible,/--mode solve --backend cpsat --window-id/);
  assert.doesNotMatch(visible,/有限非支配采样|全板网络跨度|局部组可整体移动|<h2>间距分布比较|<h3>相邻间距均匀度/);
  assert.doesNotMatch(visible,/pcb-layout-solve\.mjs|--spacing-target-mil|--spacing-tolerance-mil|全局 8 mil/);
  const ordinary=inspectCandidate(m),search=comparisonReport([ordinary],ordinary,m.config,m.contract,m.snapshot).split('<script>')[0];
  assert.match(search,/<th>电气<\/th><th>间距均匀<\/th>/);assert.match(search,/全板网络跨度/);
  assert.match(search,/<h2>间距分布比较/);assert.match(search,/<h3>相邻间距均匀度/);
  assert.match(search,/间距均匀权重控制相邻器件的间距偏好/);assert.match(search,/--backend search/);
  assert.match(search,/spatial\.uniformity/);assert.doesNotMatch(search,/全局 8 mil|pcb-layout-solve\.mjs|--spacing-target-mil|--spacing-tolerance-mil/);
  delete ordinary.plan.clearanceMil;
  assert.match(comparisonReport([ordinary],ordinary,m.config,m.contract,m.snapshot),/硬间距以本次输入为准。/);
});

test('block reports retain physical ratio hard checks while marking their soft penalty as observation',()=>{
  const m=model(fixture(),true),p=compile(m),c=decode(m,p,{U1:{x:0,y:0},C1:{x:100,y:0}}),baseline=applyBlockLayoutObjective(m,p,inspectCandidate(m));
  const policy={source:'assembly-courtyard',geometry:'physical',effective:true,absoluteFloorMil:27,
    bandRatios:{rejectBelow:.75,neutralMin:.9,neutralMax:1.2},penalty:4,stats:{checkedPairs:1},neighbors:[]};
  c.metrics.spacingPolicy=structuredClone(policy);baseline.metrics.spacingPolicy={...structuredClone(policy),absoluteFloorMil:8};
  const visible=comparisonReport([c],baseline,m.config,m.contract,m.snapshot).split('<script>')[0];
  assert.match(visible,/比例间距软惩罚仅作观察，不计功能块阶段总分；硬下限继续验收/);
  assert.match(visible,/低于 H，拒绝；硬下限不打折/);assert.match(visible,/当前绝对底线：27 mil/);
  assert.doesNotMatch(visible,/当前绝对底线：8 mil/);
  assert.match(visible,/软惩罚观测：4\.0000/);assert.doesNotMatch(visible,/相邻器件参与间距评分/);
});

test('stage meanings survive legacy and custom labels without changing exported names',()=>{
  const f=fixture();f.config.comparisonWeights.uniformity=.5;
  const m=model(f,true),p=compile(m),c=decode(m,p,{U1:{x:0,y:0},C1:{x:100,y:0}}),baseline=applyBlockLayoutObjective(m,p,inspectCandidate(m));
  m.config.weightLabels={connectivity:'全板网络跨度',uniformity:'间距均匀',power:'自定义电源'};
  const html=comparisonReport([c],baseline,m.config,m.contract,m.snapshot),visible=html.split('<script>')[0];
  assert.match(visible,/<label>稀疏中心连接（项目名称：全板网络跨度）<input/);
  assert.match(visible,/<td>稀疏中心连接（项目名称：全板网络跨度）<\/td>/);
  assert.match(visible,/<label>间距均匀（本阶段不计分）（项目名称：间距均匀）<input[^>]* disabled/);
  assert.match(visible,/<label>自定义电源<input/);
  const exportedLabels=JSON.parse(/"labels":(\{[^}]+\}),"groups":/.exec(html)[1]);
  assert.equal(exportedLabels.connectivity,'全板网络跨度');assert.equal(exportedLabels.uniformity,'间距均匀');assert.equal(exportedLabels.power,'自定义电源');
  m.config.weightLabels=exportedLabels;
  assert.equal(comparisonReport([c],baseline,m.config,m.contract,m.snapshot).split('<script>')[0],visible);
  m.config.weightLabels={connectivity:'电气 & 连接',uniformity:'自定义疏密'};
  const custom=comparisonReport([c],baseline,m.config,m.contract,m.snapshot).split('<script>')[0];
  assert.match(custom,/<label>稀疏中心连接（项目名称：电气 &amp; 连接）<input/);
  assert.match(custom,/<label>间距均匀（本阶段不计分）（项目名称：自定义疏密）<input/);
  const ordinary=inspectCandidate(m),search=comparisonReport([ordinary],ordinary,m.config,m.contract,m.snapshot).split('<script>')[0];
  assert.match(search,/<label>电气 &amp; 连接<input/);assert.doesNotMatch(search,/项目名称：/);
});
