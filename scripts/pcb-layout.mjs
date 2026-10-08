#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDirectExecution } from './lib/cli-entrypoint.mjs';
import { loadLayoutProject, layoutEngineIdentity, readJson, hash } from './pcb-layout/pcb-layout-project.mjs';
import { prepareLayoutInputs } from './pcb-layout/pcb-layout-prepare.mjs';
import { inspectCandidate, validatePlan } from './pcb-layout/pcb-layout-solver-core.mjs';
import { comparisonReport } from './pcb-layout/pcb-layout-solver-report.mjs';
import { runLayoutSearch } from './pcb-layout/pcb-layout-search.mjs';
import { runCatalog } from './pcb-layout/pcb-layout-catalog-run.mjs';
import { inspectLayout, applyLayout, resumeLayoutSave } from './pcb-layout/pcb-layout-execution.mjs';
import { checkEdges } from './pcb-layout/pcb-layout-edge.mjs';
import { checkBlocks } from './pcb-layout/pcb-layout-features.mjs';
import { buildGeometryViews } from './pcb-layout/pcb-layout-geometry-views.mjs';
import { evaluateSpatial } from './pcb-layout/pcb-layout-spatial.mjs';
import { evaluateBlockCoupling } from './pcb-layout/pcb-layout-block-coupling.mjs';
import { evaluateSpacingPolicy } from './pcb-layout/pcb-layout-spacing-evaluation.mjs';
import { auditNativeNetlist } from './pcb-layout/pcb-layout-netlist.mjs';
import { runCpsatLayout } from './pcb-layout/pcb-layout-cpsat.mjs';
import { convertSemanticInputs } from './pcb-layout/pcb-layout-semantic.mjs';
import { resolvePcbPython } from './lib/pcb-python.mjs';

const help = `PCB layout: prepare inputs, solve candidates, or apply an explicit candidate.
node <skill>/scripts/pcb-layout.mjs --project-root <project> [--mode prepare|semantic|solve|apply]
  --snapshot <json> | --window-id <confirmed-window> | --prepared <report-directory>
  --config <project-relative-json> --weights-file <json> --weight <key=value>
  solve: --start-mode fresh|existing|mixed --starts N --start-seed N --exploration 0..1
         --start-gap-mil N --iterations N --catalog-count N --initial-plan <json>
  apply: --window-id <window> --from <report-directory> --candidate <stable-id>
  save recovery: --mode apply --window-id <window> --resume-save <execution-result.json>
  CP-SAT: --backend cpsat --python <executable> --seconds N --candidates N
          --semantic-policy <project-json>; cold start, no old placement hints
Default prepare reads and checks; it never searches or modifies EDA.`;

function options(args) {
  const values = new Set(['--project-root','--mode','--window-id','--snapshot','--prepared','--config','--weights-file','--weight','--start-mode','--starts','--start-seed','--exploration','--start-gap-mil','--iterations','--catalog-count','--initial-plan','--from','--candidate','--resume-save','--backend','--python','--seconds','--candidates','--semantic-policy']);
  const out = { weight: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') { out.help = true; continue; }
    if (!values.has(key)) throw Error('UNKNOWN_OPTION ' + key);
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw Error('MISSING_OPTION_VALUE ' + key);
    if (key === '--weight') out.weight.push(value);
    else { if (out[key] !== undefined) throw Error('DUPLICATE_OPTION ' + key); out[key] = value; }
  }
  return out;
}

function coverageSummary(coverage) {
  const count = (items, key) => (items ?? []).reduce((out,item)=>(out[item[key]]=(out[item[key]]??0)+1,out),{});
  return {requirements:count(coverage.requirements,'status'),relations:count(coverage.relations,'status'),explicitRules:coverage.explicitRules?.length??0};
}

function nativeCheckSummary(receipt) {
  const checks = receipt.preparation?.nativeChecks;
  return checks ? {
    ownership: checks.ownership.status,
    rawGeometryPads: checks.geometry.padsWithObservations,
    netlist: { status: checks.network.status, counts: checks.network.counts },
  } : null;
}

async function readbackChecks(model, actual) {
  const edge = checkEdges(model.edgeRules, actual.placements);
  const block = checkBlocks(model.blockRules, actual.placements);
  const geometry = buildGeometryViews(model.geometryModel, actual.placements, actual.labels, actual.testPads, actual.pads);
  geometry.pads = actual.pads.map(p => ({ ...p, ref: p.owner ?? p.number }));
  const spatial = evaluateSpatial(model.spatialRules, actual.placements, actual.bundles, geometry);
  const coupling = evaluateBlockCoupling(model.couplingModel, actual.placements, actual.pads);
  const spacingPolicy = evaluateSpacingPolicy(model.spacingPolicy, geometry, actual.placements.map(c => c.ref));
  const nativeNetwork = auditNativeNetlist({ snapshot: { ...actual, components: actual.placements }, contract: model.contract });
  return { edge, block, spatial, coupling, spacingPolicy, nativeNetwork, issues: [...edge.issues, ...block.issues, ...spatial.issues, ...coupling.issues, ...(spacingPolicy?.issues ?? []), ...nativeNetwork.diagnostics.filter(d => d.severity === 'error')] };
}

export async function main(args = process.argv.slice(2), { log = value => console.log(JSON.stringify(value)) } = {}) {
  const o = options(args);
  if (o.help) { console.log(help); return; }
  if (!o['--project-root']) throw Error('PROJECT_ROOT_REQUIRED');
  const root = await fs.realpath(o['--project-root']);
  const mode = o['--mode'] ?? 'prepare', windowId = o['--window-id'];
  if (!['prepare','semantic','solve','apply'].includes(mode)) throw Error('INVALID_LAYOUT_MODE');
  const backend=o['--backend']??'search';if(!['search','cpsat'].includes(backend))throw Error('INVALID_LAYOUT_BACKEND');
  if(mode!=='solve'&&['--backend','--python','--seconds','--candidates'].some(f=>o[f]!==undefined))throw Error('BACKEND_OPTIONS_REQUIRE_SOLVE');
  if(!['semantic','solve'].includes(mode)&&o['--semantic-policy'])throw Error('SEMANTIC_POLICY_REQUIRES_ANALYSIS_OR_SOLVE');
  if(backend!=='cpsat'&&['--python','--seconds','--candidates'].some(f=>o[f]!==undefined))throw Error('CPSAT_OPTIONS_REQUIRE_CPSAT_BACKEND');
  if(mode==='solve'&&o['--semantic-policy']&&backend!=='cpsat')throw Error('SEMANTIC_POLICY_REQUIRES_CPSAT_BACKEND');
  if(backend==='cpsat'&&['--exploration','--start-gap-mil','--iterations'].some(f=>o[f]!==undefined))throw Error('SEARCH_BACKEND_OPTIONS_NOT_SUPPORTED_BY_CPSAT');
  if(o['--candidates']&&o['--catalog-count'])throw Error('SELECT_ONE_CANDIDATE_COUNT_OPTION');
  const searchFlags = ['--start-mode','--starts','--start-seed','--exploration','--start-gap-mil','--iterations','--catalog-count','--initial-plan'];
  if (mode !== 'solve' && searchFlags.some(f => o[f] !== undefined)) throw Error('SEARCH_OPTIONS_REQUIRE_SOLVE_MODE');
  if (mode !== 'apply' && ['--from','--candidate','--resume-save'].some(f => o[f])) throw Error('WRITE_OPTIONS_REQUIRE_APPLY_MODE');
  if (mode === 'apply' && (o['--snapshot'] || o['--prepared'])) throw Error('APPLY_REQUIRES_LIVE_PROVIDER');
  if (mode !== 'apply' && [windowId,o['--snapshot'],o['--prepared']].filter(Boolean).length > 1) throw Error('SELECT_ONE_INPUT_SOURCE');
  const engine = await layoutEngineIdentity();
  const dir = path.join(root,'evidence/pcb-layout-solver',new Date().toISOString().replace(/[:.]/g,'-'));
  await fs.mkdir(dir,{recursive:true});
  const write = (name,value) => fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2));
  let loaded, snapshot, sourceKind;
  if (o['--resume-save']) {
    if (o['--from'] || o['--candidate']) throw Error('SAVE_RECOVERY_CANNOT_APPLY_ANOTHER_PLAN');
    if (o['--config'] || o['--weights-file'] || o.weight.length) throw Error('RECOVERY_INPUTS_ARE_FROZEN');
    const requested = await readJson(path.resolve(o['--resume-save']));
    const receipt = requested.kind === 'flitrealize.pcb-layout.execution'
      ? await readJson(path.resolve(requested.resumeSaveReport ?? '')) : requested;
    if (receipt.kind !== 'flitrealize.pcb-layout.apply-receipt' || receipt.projectRoot !== root || !receipt.workflowFile) throw Error('RECOVERY_RECEIPT_REQUIRED');
    const prior = path.dirname(path.resolve(receipt.workflowFile));
    const relative = path.relative(root,prior);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('RECOVERY_OUTSIDE_PROJECT');
    const manifest = await readJson(path.join(prior,'manifest.json'));
    const bundle = await readJson(path.join(prior,'inputs.json'));
    if (bundle.projectRoot !== root || hash(bundle.engine) !== hash(engine) || hash(manifest.engine) !== hash(engine)) throw Error('RECOVERY_INPUT_VERSION_CHANGED');
    if (hash(bundle) !== manifest.inputsHash || hash(bundle.snapshot) !== manifest.snapshotHash || hash(receipt.snapshot) !== hash(bundle.snapshot)) throw Error('RECOVERY_INPUT_CHANGED');
    const prepared = prepareLayoutInputs(bundle);
    if (!prepared.state.ready) throw Error('RECOVERY_INPUT_INVALID');
    if (hash(prepared.model.mechanical) !== hash(receipt.config)) throw Error('RECOVERY_RULES_CHANGED');
    const validateReadback = async actual => {
      const checked = await readbackChecks(prepared.model,actual);
      await write('feature-verification.json',checked);
      if (checked.issues.length) throw Error('READBACK_CONSTRAINTS_FAILED ' + JSON.stringify(checked.issues));
    };
    await write('inputs.json',bundle);
    await write('manifest.json',{...manifest,mode:'resume-save',originalReport:prior});
    const result = await resumeLayoutSave({projectRoot:root,windowId,providerId:bundle.config.provider,resumeSave:path.resolve(o['--resume-save']),reportDir:dir,validateReadback});
    await write('summary.json',result); log({...result,report:dir});
    if (result.saved !== true || result.status !== 'verified') process.exitCode = 1;
    return result;
  }
  if (o['--prepared']) {
    if (o['--config'] || o['--weights-file'] || o.weight.length) throw Error('PREPARED_INPUTS_ARE_FROZEN');
    const from = path.resolve(o['--prepared']), manifest = await readJson(path.join(from,'manifest.json'));
    const bundle = await readJson(path.join(from,'inputs.json'));
    if (bundle.projectRoot !== root || hash(bundle) !== manifest.inputsHash || hash(bundle.engine) !== hash(engine)) throw Error('PREPARED_INPUT_CHANGED');
    loaded = {root,...bundle}; snapshot=bundle.snapshot; sourceKind='prepared-snapshot';
  } else {
    loaded = await loadLayoutProject(root,{configFile:o['--config'],weightsFile:o['--weights-file'],weightOverrides:o.weight});
    if (mode === 'apply') {
      if (!o['--from'] || !o['--candidate']) throw Error('APPLY_REQUIRES_REPORT_AND_CANDIDATE');
      const manifest = await readJson(path.join(path.resolve(o['--from']),'manifest.json'));
      if (manifest.synthetic) throw Error('SYNTHETIC_CANDIDATE_NOT_APPLICABLE');
      if (manifest.schemaVersion !== 3 || hash(manifest.engine) !== hash(engine)) throw Error('REPORT_ENGINE_CHANGED_REGENERATE');
      if (manifest.projectRoot !== root || hash(manifest.fingerprints) !== hash(loaded.fingerprints)) throw Error('REPORT_INPUTS_CHANGED_REPLAN');
      snapshot = await readJson(path.join(path.resolve(o['--from']),'snapshot.json'));
      if (hash(snapshot) !== manifest.snapshotHash) throw Error('SNAPSHOT_CHANGED_REPLAN');
      sourceKind='selected-candidate';
    } else if (o['--snapshot']) {
      const input=await readJson(path.resolve(o['--snapshot'])); snapshot=input.result??input; sourceKind='offline-snapshot';
    } else {
      snapshot=await inspectLayout({projectRoot:root,windowId,providerId:loaded.config.provider,config:loaded.mechanical,reportDir:dir}); sourceKind='live-read-only';
    }
  }
  const bundle={schemaVersion:1,kind:'pcb-layout-input-bundle',projectRoot:root,snapshot,contract:loaded.contract,config:loaded.config,mechanical:loaded.mechanical,fingerprints:loaded.fingerprints,engine};
  await write('inputs.json',bundle); await write('snapshot.json',snapshot);
  const prepared=prepareLayoutInputs(bundle);
  await write('layout-input.json',prepared.receipt);
  await write('diagnostics.json',{state:prepared.state,diagnostics:prepared.diagnostics,coverage:prepared.coverage,nativeChecks:prepared.receipt.preparation?.nativeChecks});
  const synthetic=snapshot.sourceKind==='synthetic-example';
  const manifestBase={schemaVersion:3,mode,projectRoot:root,engine,synthetic,fingerprints:loaded.fingerprints,snapshotHash:hash(snapshot),inputsHash:hash(bundle)};
  await write('manifest.json',manifestBase);
  if (!prepared.state.ready) {
    const result={status:'inputs-not-ready',mode,applied:false,nativeWrites:0,state:prepared.state,diagnostics:prepared.diagnostics,report:dir};
    await write('summary.json',result);log(result);process.exitCode=1;return result;
  }
  const {model,contract,config,mechanical}=prepared,baseline=inspectCandidate(model);
  // New solves use the formal ownership contract. Historical snapshots remain
  // inspectable, but do not feed a second live-placement implementation.
  if (['solve','apply'].includes(mode) && snapshot.sourceKind !== 'synthetic-example' && snapshot.padOwnership?.status !== 'verified') throw Error('REFRESH_NATIVE_OWNERSHIP: prepare a new snapshot from the current PCB before solving or applying');
  await write('baseline.json',baseline);await write('effective-config.json',config);
  await write('effective-weights.json',{schemaVersion:1,weights:config.comparisonWeights,labels:config.weightLabels});
  const semanticPolicy=o['--semantic-policy']?await readJson(path.resolve(root,o['--semantic-policy'])):config.semanticPolicy;
  if(mode==='semantic'){
    const semantic=convertSemanticInputs(model,semanticPolicy);await write('semantic-conversion.json',semantic);
    const result={status:'semantic-ready',mode,groups:semantic.groups.length,unresolved:semantic.unresolvedRoles,nativeWrites:0,report:dir};await write('summary.json',result);log(result);return result;
  }
  if (mode === 'prepare') {
    const result={status:'inputs-ready',applied:false,nativeWrites:0,source:sourceKind,state:prepared.state,nativeChecks:nativeCheckSummary(prepared.receipt),currentLayout:{valid:baseline.validation.valid,issues:baseline.validation.issues},counts:{components:snapshot.components.length,standalonePads:model.pads.filter(p=>!p.owner).length,blocks:contract.blocks.length},coverage:coverageSummary(prepared.coverage),report:dir};
    await fs.writeFile(path.join(dir,'comparison.html'),comparisonReport([baseline],baseline,{...config,reportMode:'model-inspection',reportSource:sourceKind},contract,snapshot,prepared.receipt));
    await write('summary.json',result);log(result);return result;
  }
  if (mode === 'apply') {
    const from=path.resolve(o['--from']),manifest=await readJson(path.join(from,'manifest.json')),id=o['--candidate'];
    if (!/^[a-z0-9_-]+$/.test(id)) throw Error('INVALID_CANDIDATE_ID');
    const record=manifest.candidates?.find(c=>c.name===id);
    if (!record) throw Error('UNKNOWN_CANDIDATE');
    const raw=await fs.readFile(path.join(from,id+'.json'),'utf8');
    if(hash(raw)!==record.sha256)throw Error('CANDIDATE_FILE_CHANGED_REPLAN');
    const candidate=JSON.parse(raw),validation=validatePlan(model,candidate.plan);
    if(!validation.valid)throw Error('CANDIDATE_INVALID '+JSON.stringify(validation.issues));
    const validateReadback=async actual=>{const checked=await readbackChecks(model,actual);await write('feature-verification.json',checked);if(checked.issues.length)throw Error('READBACK_CONSTRAINTS_FAILED '+JSON.stringify(checked.issues));};
    const result=await applyLayout({projectRoot:root,windowId,providerId:config.provider,config:model.mechanical,plan:candidate.plan,snapshot,reportDir:dir,validateReadback});
    const summary={...result,candidate:id,from,report:dir};await write('summary.json',summary);log(summary);
    if(result.saved!==true||result.status!=='verified')process.exitCode=1;return summary;
  }
  const iterations=Number(o['--iterations']??config.search.iterations);
  if(!Number.isInteger(iterations)||iterations<1||iterations>100000)throw Error('INVALID_ITERATION_BUDGET');
  const startOverrides={};
  for(const [flag,key]of [['--start-mode','mode'],['--starts','count'],['--start-seed','seed'],['--exploration','explorationStrength'],['--start-gap-mil','packingGapMil']])if(o[flag]!==undefined)startOverrides[key]=key==='mode'?o[flag]:Number(o[flag]);
  if(o['--initial-plan']&&startOverrides.mode===undefined)startOverrides.mode='existing';
  const common={model,snapshot,contract,config,mechanical,root,projectRoot:root,dir,fingerprints:loaded.fingerprints,engine,inputReceipt:prepared.receipt,initialPlanFile:o['--initial-plan'],iterations,startOverrides,sourceKind,log};
  let result;
  if(backend==='cpsat'){
    if(o['--initial-plan']||o['--start-mode']&&o['--start-mode']!=='fresh')throw Error('CPSAT_COLD_START_NO_EXISTING_HINTS');
    const candidateCount=Number(o['--candidates']??o['--catalog-count']??1),seconds=Number(o['--seconds']??30),maxRuns=Number(o['--starts']??candidateCount);
    if(!Number.isInteger(candidateCount)||candidateCount<1||candidateCount>100||!Number.isFinite(seconds)||seconds<=0||seconds>600)throw Error('INVALID_CPSAT_BUDGET');
    const parameters={candidateCount,maxRuns,timeLimitSeconds:seconds,seed:Number(o['--start-seed']??0),semanticPolicy};await write('cpsat-parameters.json',parameters);
    const solved=await runCpsatLayout(model,{timeLimitSeconds:seconds,seed:parameters.seed},{candidateCount,maxRuns,coldSeconds:seconds,semanticPolicy,runtime:{pythonPath:resolvePcbPython({python:o['--python']})},onProgress:log});
    await write('cpsat-problem.json',solved.problem);await write('semantic-conversion.json',solved.semantic);await write('cpsat-runs.json',solved.runs);
    const records=[];for(const candidate of solved.candidates){const raw=JSON.stringify(candidate);await fs.writeFile(path.join(dir,candidate.name+'.json'),raw);records.push({name:candidate.name,sha256:hash(raw),score:candidate.comparisonScore,valid:candidate.validation.valid});}
    await fs.writeFile(path.join(dir,'comparison.html'),comparisonReport(solved.candidates,baseline,{...config,reportMode:'cpsat-candidates',reportSource:sourceKind},contract,snapshot,prepared.receipt));
    await write('manifest.json',{...manifestBase,backend:'cpsat',parameters,candidates:records});
    result={status:solved.status,backend:'cpsat',candidateCount:records.length,candidates:records,scope:solved.scope,nativeWrites:0,report:dir};await write('summary.json',result);log(result);if(solved.status==='no-candidate')process.exitCode=1;return result;
  }
  else if(o['--catalog-count']){const count=Number(o['--catalog-count']);if(!Number.isInteger(count)||count<1||count>500)throw Error('INVALID_CATALOG_COUNT');result=await runCatalog({...common,count});}
  else result=await runLayoutSearch(common);
  const manifest=await readJson(path.join(dir,'manifest.json'));await write('manifest.json',{...manifest,synthetic,inputsHash:hash(bundle)});
  return result;
}

if (isDirectExecution(import.meta.url)) {
  main().catch(error=>{console.error(JSON.stringify({status:'failed',error:error.message}));process.exitCode=1;});
}
