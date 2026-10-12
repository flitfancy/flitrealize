import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPrerouteStudy } from '../../pcb-preroute.mjs';
import { pcbImplementationFingerprint } from '../../lib/pcb-study.mjs';
import { layoutRealization } from '../pcb-layout-provider.mjs';
import { buildGeometryViews } from '../pcb-layout-geometry-views.mjs';
import { preparePrerouteInput } from '../../pcb-routing/preroute/prepare.mjs';
import { verifyPreroute } from '../../pcb-routing/preroute/verify.mjs';
import { digest, fail } from './common.mjs';

export const fineRoutingEngine=()=>pcbImplementationFingerprint(fileURLToPath(new URL('../../',import.meta.url)),{directories:['pcb-routing'],files:['pcb-preroute.mjs','lib/pcb-study.mjs','lib/pcb-python.mjs']});
export function fineRoutingRequest(scope,plan) {
  const {model,request}=scope,cfg=request.routing;
  if(!cfg.policy||!Array.isArray(cfg.nets)||!cfg.nets.length)fail('FINE_ROUTING_POLICY_REQUIRED');
  if(cfg.options?.verification?.enforceDeclaredWidths===false)fail('FINE_ROUTING_WIDTH_VERIFICATION_REQUIRED');
  const bounds=model.config.hard.boardBounds;if(bounds.minX!==0||bounds.minY!==0)fail('FINE_ROUTING_BOARD_UNSUPPORTED','Existing raster backend requires a zero-origin rectangular board.');
  const selected=cfg.policy.nets?.filter(n=>cfg.nets.includes(n.net));
  if(!selected||selected.length!==cfg.nets.length||selected.some(n=>!Number.isFinite(n.defaultWireWidthMil)||n.defaultWireWidthMil<=0))fail('FINE_ROUTING_NET_RULES_REQUIRED');
  const geometry=buildGeometryViews(model.geometryModel,plan.components,plan.labels,plan.testPads),layers=layoutRealization(model.snapshot).layers;
  const pads=geometry.pads.map(p=>{const b=p.bbox,layer=layers[p.id];if(!layer)fail('FINE_ROUTING_PAD_LAYER_REQUIRED',p.id);const shape={kind:'polygon',layers:[layer],points:[[b.minX,b.minY],[b.minX,b.maxY],[b.maxX,b.maxY],[b.maxX,b.minY]]};return {...p,owner:p.owner??p.ref,number:p.number??p.pin,shape,shapes:[shape],contactShapes:[shape]};});
  return {board:{units:'mil',bounds,boardMil:[bounds.maxX,bounds.maxY],pads,parts:geometry.footprint.map(p=>({ref:p.ref,bbox:p.bbox})),segments:[],vias:[],keepouts:[]},policy:{...cfg.policy,nets:selected},options:cfg.options??{}};
}
function connectedRequired(verification,nets) {return nets.every(net=>verification.connectivity?.some(n=>n.net===net&&n.connected));}
export async function routeFineCandidate({scope,candidate,directory,python,timeoutMs=30000,runner=runPrerouteStudy}) {
  if(candidate.kind!=='flitrealize.fine-layout.candidate'||candidate.audit.labelStatus==='pending'||candidate.candidateHash!==digest(candidate.plan)||!candidate.audit.localAccepted)fail('FINE_ROUTING_CANDIDATE_REJECTED');
  const request=fineRoutingRequest(scope,candidate.plan),input=preparePrerouteInput(request);
  if(scope.request.routing.nets.some(net=>!input.nets.some(n=>n.net===net)))fail('FINE_ROUTING_DELEGATED_NET','Ground-plane and excluded nets need their separate existing workflows.');
  const result=await runner(request,{mode:'route',directory,python,timeoutMs});
  let copper=result.candidate;
  if(!copper&&result.resultFile)copper=JSON.parse((await fs.readFile(result.resultFile,'utf8')).replace(/^\uFEFF/,''));
  if(!copper)fail('FINE_ROUTING_NO_CANDIDATE');
  const verification=verifyPreroute({input,candidate:copper}),passed=verification.status==='independently-verified'&&connectedRequired(verification,scope.request.routing.nets);
  const receipt={schemaVersion:1,kind:'flitrealize.fine-layout.routing',status:passed?'passed':'failed',candidateHash:candidate.candidateHash,requestHash:digest(request),inputHash:digest(input),routingEngine:await fineRoutingEngine(),nets:scope.request.routing.nets,copper,verification,nativeWrites:0,
    scope:'Offline two-layer trial on transformed native pad-bbox proxies; no native routing, ground-return, exact pad-outline or thermal qualification',report:directory};
  await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'fine-routing-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return receipt;
}
export async function verifyFineRoutingReceipt(scope,candidate,receipt) {
  if(!receipt||receipt.kind!=='flitrealize.fine-layout.routing'||receipt.status!=='passed'||receipt.nativeWrites!==0||receipt.candidateHash!==digest(candidate.plan)||digest(receipt.routingEngine)!==digest(await fineRoutingEngine()))fail('FINE_ROUTING_RECEIPT_MISMATCH');
  const request=fineRoutingRequest(scope,candidate.plan),input=preparePrerouteInput(request);
  if(receipt.requestHash!==digest(request)||receipt.inputHash!==digest(input)||digest(receipt.nets)!==digest(scope.request.routing.nets))fail('FINE_ROUTING_INPUT_CHANGED');
  const checked=verifyPreroute({input,candidate:receipt.copper});
  if(checked.status!=='independently-verified'||!connectedRequired(checked,scope.request.routing.nets))fail('FINE_ROUTING_REVERIFICATION_FAILED');
  return checked;
}
