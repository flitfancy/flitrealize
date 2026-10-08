import {parseSpecctra,serializeSpecctra,child,children} from './specctra.mjs';
import {checkConnectivity,conductiveGap,conductiveContact,traceCovered,outsidePadSegments,pointInsidePad,contactOutsidePad,routingViaLayers} from './geometry.mjs';

const clone=x=>structuredClone(x);
const shapesFor=s=>({kind:'capsule',a:[s.x1,s.y1],b:[s.x2,s.y2],radius:s.width/2,layers:[s.layer]});
const viaShape=(v,layers)=>({kind:'circle',center:[v.x,v.y],radius:v.diameter/2,layers:routingViaLayers(v,layers)});
export function routingNetNames(board){
 const declared=board.netNames;
 if(declared!==undefined&&(!Array.isArray(declared)||declared.some(n=>typeof n!=='string'||!n)||new Set(declared).size!==declared.length))throw Error('INVALID_PUBLIC_NET_INVENTORY');
 return declared??[...new Set([...board.pads,...board.segments,...board.vias].map(o=>o.net).filter(n=>typeof n==='string'&&n))];
}

function endpoints(rule,names,board){
 return names.map(name=>{const entry=rule.endpoints.find(e=>e.endpoint===name),pad=board.pads.find(p=>p.id===entry?.padId);if(!pad||pad.net!==rule.net)throw Error('ROLE_ENDPOINT_MISSING:'+name);return pad;});
}
function routingLayerPolicy(board,policy){
 const declarations=policy.layers??[];
 if(!Array.isArray(declarations))throw Error('INVALID_POLICY_LAYER_DECLARATIONS');
 const rows=declarations.map(layer=>typeof layer==='number'?{id:layer}:layer);
 if(rows.some(layer=>!layer||!Number.isInteger(layer.id)||!board.layers.includes(layer.id)||layer.signalRoutingAllowed!==undefined&&typeof layer.signalRoutingAllowed!=='boolean')||new Set(rows.map(layer=>layer.id)).size!==rows.length)throw Error('INVALID_POLICY_LAYER_DECLARATIONS');
 return{reservedLayers:rows.filter(layer=>layer.signalRoutingAllowed===false).map(layer=>layer.id),source:'policy.layers[].signalRoutingAllowed',diagnostics:policy.layers===undefined?[{code:'LEGACY_LAYER_PERMISSIONS_UNDECLARED',message:'Only explicit role allowedLayers are used; no layer ID is inferred as ground or power.'}]:[]};
}
function loadViaTransition(rule,role,layers){
 if(role.name!=='load_current_main')return undefined;
 const transition=role.viaTransition;
 if(transition===undefined){if(layers.length===1)return null;throw Error('LOAD_VIA_TRANSITION_RULE_REQUIRED:'+rule.net);}
 if(!transition||typeof transition!=='object'||Array.isArray(transition)||Object.keys(transition).some(key=>!['sourceLayer','targetLayer'].includes(key))||![transition.sourceLayer,transition.targetLayer].every(layer=>Number.isInteger(layer)&&layers.includes(layer))||transition.sourceLayer===transition.targetLayer)throw Error('INVALID_LOAD_VIA_TRANSITION:'+rule.net);
 const minimum=rule.via?.minParallelLoadVias;
 if(!Number.isInteger(minimum)||minimum<1)throw Error('LOAD_PARALLEL_VIA_COUNT_REQUIRED:'+rule.net);
 return{...transition,minParallelVias:minimum,source:'role.viaTransition + net.via.minParallelLoadVias'};
}
export function taskConnectivity(board,task,segments=board.segments,vias=board.vias){
 const pads=board.pads.filter(p=>task.requiredPadIds.includes(p.id));
 if(pads.length<2)return{connected:false,disconnected:pads.map(p=>({role:'pad',id:p.id}))};
 const result=checkConnectivity(task.net,pads,segments,vias,{layers:board.layers});
 return{...result,connected:!result.disconnected.some(x=>x.role==='pad'),floatingCopper:result.disconnected.filter(x=>x.role!=='pad')};
}
export function compileTasks(board,policy,{nets=routingNetNames(board),roles=null}={}){
 const tasks=[],layerPolicy=routingLayerPolicy(board,policy);
 for(const net of nets){
  const rule=policy.nets.find(n=>n.net===net);if(!rule)throw Error('NET_RULE_MISSING:'+net);
  const main=rule.roles.find(r=>r.name==='load_current_main');
  for(const [index,r]of rule.roles.entries()){
   if(roles&&!roles.includes(r.name))continue;
   if(r.name==='ground_plane'){tasks.push({id:net+':ground_plane',net,role:r.name,status:'delegated',reason:'Use the existing grounding/pour workflow.'});continue;}
   const names=[...r.endpoints];
   if(main&&['local_decoupling','input_protection_local','logic_supply_branch','low_current_branch'].includes(r.name))names.push(...main.endpoints);
   const required=[...new Map(endpoints(rule,[...new Set(names)],board).map(p=>[p.id,p])).values()];
   const width=r.widthMil??rule.defaultWireWidthMil,layers=r.allowedLayers??rule.primaryAutoLayers;
   if(!Number.isFinite(width)||width<=0||!Array.isArray(layers)||!layers.length||layers.some(l=>!board.layers.includes(l)))throw Error('INVALID_TASK_RULE:'+net);
   if(layers.some(layer=>layerPolicy.reservedLayers.includes(layer)))throw Error('RESERVED_AUTO_ROUTING_LAYER:'+net);
   const kelvin=(policy.kelvinBranches??[]).find(k=>k.net===net&&k.to===r.destination);
   const noiseNets=policy.nets.filter(n=>n.roles.some(r=>['local_bootstrap','local_switch_power'].includes(r.name))).map(n=>n.net);
   const task={id:net+':'+r.name+':'+index,net,role:r.name,width,localWidth:r.localWidthMil??width,layers,requiredPadIds:required.map(p=>p.id),endpointNames:[...new Set(names)],sourcePadId:r.junctionEndpoint?endpoints(rule,[r.junctionEndpoint],board)[0].id:null,pickup:kelvin?.pickup??r.pickup??null,via:rule.via??{holeMil:12,diameterMil:24},viaTransition:loadViaTransition(rule,r,layers),layerPolicy,clearance:policy.clearances?.ordinaryCopperMil??6,dependentOnMain:!!main&&['local_decoupling','logic_supply_branch','low_current_branch'].includes(r.name),priority:rule.priority??10,sensitive:['sensitive_signal','kelvin_sense'].includes(r.name),noiseGap:policy.clearances?.minimumSensitiveToSwitchCopperMil??0,noiseTarget:policy.clearances?.sensitiveToSwitchCopperTargetMil??0,noiseNets};
   if(r.name==='kelvin_sense'&&(!task.sourcePadId||!task.pickup))throw Error('KELVIN_PICKUP_MISSING:'+net);
   if(r.name==='kelvin_sense'&&!pointInsidePad([task.pickup.xMil,task.pickup.yMil],board.pads.find(p=>p.id===task.sourcePadId),task.width/2))throw Error('KELVIN_PICKUP_OUTSIDE_PAD:'+net);
   task.status=taskConnectivity(board,task).connected?'already-connected':'pending';tasks.push(task);
  }
 }
 const rank={load_current_main:0,local_decoupling:1,input_protection_local:1,logic_supply_branch:2,kelvin_sense:3,low_current_branch:4};
 tasks.sort((a,b)=>a.priority-b.priority||(rank[a.role]??2)-(rank[b.role]??2)||a.id.localeCompare(b.id));
 return tasks;
}

function stackName(v){return 'FLIT_VIA_'+v.diameter+'_'+v.hole;}
function fixedObstacles(board,selected){
 const result={pads:new Map(),aliases:{}};
 for(const [i,pad]of board.pads.entries())if(pad.net&&!selected.has(pad.net)){
  const name='FLIT_FIXED_PAD_'+i;if(routingNetNames(board).includes(name))throw Error('TEMP_NET_NAME_COLLISION');
  result.pads.set(pad,name);result.aliases[name]=pad.net;
 }
 return result;
}
function capsulePolygon(s,margin=0){
 const direction=Math.atan2(s.y2-s.y1,s.x2-s.x1),radius=(s.width/2+margin)/Math.cos(Math.PI/16),points=[];
 for(const [x,y,start]of [[s.x2,s.y2,direction-Math.PI/2],[s.x1,s.y1,direction+Math.PI/2]])for(let i=0;i<=8;i++){const angle=start+i*Math.PI/8;points.push(x+radius*Math.cos(angle),y+radius*Math.sin(angle));}
 return points;
}
export function buildTaskDsn(board,task,policy,{escapes={seeds:[],traceSeeds:[]},reworkNets=[],relaxPreferences=false}={}){
 const ast=clone(board.ast),structure=child(ast,'structure'),library=child(ast,'library'),network=child(ast,'network');
 const mutable=new Set(reworkNets);if(board.segments.some(s=>mutable.has(s.net)&&s.locked)||board.vias.some(v=>mutable.has(v.net)&&v.locked))throw Error('LOCKED_REWORK_NET');
 for(const net of mutable){const rule=policy.nets.find(n=>n.net===net);if(!rule||rule.roles.length!==1)throw Error('REWORK_REQUIRES_SINGLE_ROLE_NET:'+net);}
 const kelvin=task.role==='kelvin_sense',sourcePad=kelvin?board.pads.find(p=>p.id===task.sourcePadId):null;
 if(kelvin&&mutable.has(task.net))throw Error('KELVIN_CANNOT_REWORK_LOAD_NET');
 const required=new Set(task.requiredPadIds),refs=new Set(board.pads.map(p=>p.dsnRef));
 const routingNets=new Set([task.net,...reworkNets]),islands=fixedObstacles(board,routingNets);
 // Drop exporter-generated via pins, then rebuild them from the current snapshot.
 for(const image of children(library,'image'))for(const pin of [...children(image,'pin')]){const ref=image[1]+'-'+pin[2];if(!refs.has(ref)&&children(network,'net').some(n=>child(n,'pins')?.includes(ref)))image.splice(image.indexOf(pin),1);}
 for(const n of children(network,'net')){const pinList=child(n,'pins');if(pinList)pinList.splice(1);}
 const ensureNet=name=>{let n=children(network,'net').find(n=>n[1]===name);if(!n){n=['net',name,['pins']];network.push(n);}return n;};
 const attached=pad=>pad.shapes.some(g=>board.segments.some(s=>s.net===pad.net&&conductiveContact(g,shapesFor(s)))||board.vias.some(v=>v.net===pad.net&&conductiveContact(g,viaShape(v,board.layers))));
 const assignedNet=pad=>islands.pads.get(pad)??(pad.net===task.net?(required.has(pad.id)?task.net:'FLIT_OBSTACLE_'+pad.id):(mutable.has(pad.net)||attached(pad)?pad.net:'FLIT_OBSTACLE_'+pad.id));
 for(const pad of board.pads){if(!pad.net)continue;const name=assignedNet(pad);child(ensureNet(name),'pins').push(pad.dsnRef);if(name.startsWith('FLIT_OBSTACLE_'))network.push(['class',name,name,['rule',['width','6'],['clearance',String(task.clearance)]]]);}
 for(const [name,net]of Object.entries(islands.aliases)){
  ensureNet(name);const sourceClass=children(network,'class').find(c=>c.slice(2).some(n=>n===net));
  if(sourceClass)sourceClass.push(name);else network.push(['class',name,name,['rule',['width','6'],['clearance',String(task.clearance)]]]);
 }
 const stack=v=>{const name=stackName(v);if(!children(library,'padstack').some(s=>s[1]===name))library.push(['padstack',name,...board.layerNames.map(l=>['shape',['circle',l,String(v.diameter)]])]);const allowed=child(structure,'via');if(!allowed.includes(name))allowed.push(name);return name;};
 const image=children(library,'image')[0],wiring=['wiring'];
 const layerName=id=>Object.keys(board.layerMap).find(k=>board.layerMap[k]===id);
 if(kelvin){
  const pin=children(library,'image').flatMap(im=>children(im,'pin').map(p=>({p,ref:im[1]+'-'+p[2]}))).find(x=>x.ref===sourcePad.dsnRef).p;
  library.push(['padstack','FLIT_KELVIN_PICKUP',['shape',['circle',layerName(task.pickup.layer),String(task.width)]]]);pin[1]='FLIT_KELVIN_PICKUP';pin[3]=String(task.pickup.xMil);pin[4]=String(task.pickup.yMil);
 }
 const extraGap=net=>task.sensitive&&task.noiseNets.includes(net)?Math.max(0,Math.max(task.noiseGap,relaxPreferences?0:task.noiseTarget)-task.clearance):0;
 for(const original of board.segments){
  if(mutable.has(original.net))continue;
  if(!routingNets.has(original.net)){structure.push(['keepout',['polygon',layerName(original.layer),'0',...capsulePolygon(original,extraGap(original.net)).map(String)]]);continue;}
  if(kelvin&&original.net===task.net){for(const s of outsidePadSegments(original,sourcePad,original.width/2+task.clearance))structure.push(['keepout',['polygon',layerName(s.layer),'0',...capsulePolygon(s).map(String)]]);continue;}
  const wire=['wire',['path',layerName(original.layer),String(original.width),String(original.x1),String(original.y1),String(original.x2),String(original.y2)],['net',original.net]];if(!mutable.has(original.net))wire.push(['type','fix']);wiring.push(wire);
 }
 for(const v of board.vias){
  if(mutable.has(v.net))continue;
  if(!routingNets.has(v.net)||(kelvin&&v.net===task.net)){for(const l of routingViaLayers(v,board.layers))structure.push(['keepout',['circle',layerName(l),String(v.diameter+2*extraGap(v.net)),String(v.x),String(v.y)]]);continue;}
  const name=stack(v),ref='flit_existing_via_'+v.id,net=v.net;if(!mutable.has(v.net)){image.push(['pin',name,ref,String(v.x),String(v.y)]);child(ensureNet(net),'pins').push(image[1]+'-'+ref);}const entry=['via',name,String(v.x),String(v.y),['net',net]];if(!mutable.has(v.net))entry.push(['type','fix']);wiring.push(entry);
 }
 const oldWiring=child(ast,'wiring');if(oldWiring)ast.splice(ast.indexOf(oldWiring),1,wiring);else ast.push(wiring);
 // Separate the selected network from shared classes before applying role rules.
 for(const c of children(network,'class'))for(let i=c.length-1;i>=2;i--)if(!Array.isArray(c[i])&&c[i]===task.net)c.splice(i,1);
 const taskVia={diameter:task.via.diameterMil,hole:task.via.holeMil},viaName=stack(taskVia);
 network.push(['class','FLIT_TASK',task.net,['rule',['width',String(task.width)],['clearance',String(task.clearance)]],['circuit',['use_via',viaName],['use_layer',...task.layers.map(layerName)]]]);
 for(const net of mutable)if(net!==task.net){const rule=policy.nets.find(n=>n.net===net),role=rule.roles[0],name=stack({diameter:rule.via?.diameterMil??24,hole:rule.via?.holeMil??12});for(const c of children(network,'class'))for(let i=c.length-1;i>=2;i--)if(c[i]===net)c.splice(i,1);network.push(['class','FLIT_REWORK_'+net,net,['rule',['width',String(role.widthMil??rule.defaultWireWidthMil)],['clearance',String(task.clearance)]],['circuit',['use_via',name],['use_layer',...(role.allowedLayers??rule.primaryAutoLayers).map(layerName)]]]);}
 if(task.sensitive){const gap=Math.max(task.noiseGap,relaxPreferences?0:task.noiseTarget);for(const c of children(network,'class'))if(c.slice(2).some(n=>!Array.isArray(n)&&task.noiseNets.includes(n))&&gap>task.clearance)network.push(['class_class',['classes','FLIT_TASK',c[1]],['rule',['clearance',String(gap)]]]);}
 const seedSegments=[],seedVias=[];
 if(task.role==='load_current_main'){
  const sourceLayer=task.viaTransition?.sourceLayer??(task.layers.length===1?task.layers[0]:undefined);
  if(sourceLayer===undefined)throw Error('LOAD_VIA_TRANSITION_RULE_REQUIRED:'+task.net);
  for(const seed of (escapes.seeds??[]).filter(s=>s.net===task.net&&required.has(s.padId))){const p=board.pads.find(p=>p.id===seed.padId),v={net:task.net,x:p.x+seed.offsetMil[0],y:p.y+seed.offsetMil[1],...taskVia,type:viaName,layers:board.layers};if(!p.shapes.some(shape=>shape.layers.includes(sourceLayer)))throw Error('LOAD_ESCAPE_SOURCE_LAYER_MISMATCH:'+seed.padId);seedSegments.push({net:task.net,layer:sourceLayer,width:seed.widthMil,x1:p.x,y1:p.y,x2:v.x,y2:v.y});seedVias.push(v);}
  for(const seed of (escapes.traceSeeds??[]).filter(s=>s.net===task.net&&required.has(s.padId))){const p=board.pads.find(p=>p.id===seed.padId);if(!p.shapes.some(shape=>shape.layers.includes(sourceLayer)))throw Error('LOAD_ESCAPE_SOURCE_LAYER_MISMATCH:'+seed.padId);for(let i=0;i<seed.widthsMil.length;i++){const a=seed.pathOffsetsMil[i],b=seed.pathOffsetsMil[i+1];seedSegments.push({net:task.net,layer:sourceLayer,width:seed.widthsMil[i],x1:p.x+a[0],y1:p.y+a[1],x2:p.x+b[0],y2:p.y+b[1]});}if(seed.viaType){const e=seed.pathOffsetsMil.at(-1);seedVias.push({net:task.net,x:p.x+e[0],y:p.y+e[1],...taskVia,type:viaName,layers:board.layers});}}
  const transitLayer=task.viaTransition?.targetLayer;
  const transitionWidth=escapes.transitionLayerWidthMil?.[task.net]??task.width;
  if(!Number.isFinite(transitionWidth)||transitionWidth<task.localWidth||transitionWidth>task.width)throw Error('INVALID_LOCAL_TRANSITION');
  if(transitLayer)for(const padId of required){
   const pad=board.pads.find(p=>p.id===padId);
   const offsets=[...(escapes.seeds??[]).filter(s=>s.net===task.net&&s.padId===padId).map(s=>s.offsetMil),...(escapes.traceSeeds??[]).filter(s=>s.net===task.net&&s.padId===padId&&s.viaType).map(s=>s.pathOffsetsMil.at(-1))];
   for(let i=1;i<offsets.length;i++)seedSegments.push({net:task.net,layer:transitLayer,width:transitionWidth,x1:pad.x+offsets[i-1][0],y1:pad.y+offsets[i-1][1],x2:pad.x+offsets[i][0],y2:pad.y+offsets[i][1]});
  }
  for(const bridge of (escapes.layerBridges??[]).filter(s=>s.net===task.net&&required.has(s.padId))){if(!task.layers.includes(bridge.layer)||!Number.isFinite(bridge.widthMil)||bridge.widthMil<task.localWidth||bridge.widthMil>task.width)throw Error('INVALID_LOCAL_TRANSITION');const p=board.pads.find(p=>p.id===bridge.padId);seedSegments.push({net:task.net,layer:bridge.layer,width:bridge.widthMil,x1:p.x+bridge.fromOffsetMil[0],y1:p.y+bridge.fromOffsetMil[1],x2:p.x+bridge.toOffsetMil[0],y2:p.y+bridge.toOffsetMil[1]});}
  for(const [i,anchor]of (escapes.routingAnchors??[]).filter(s=>s.net===task.net&&required.has(s.padId)).entries()){
   const p=board.pads.find(p=>p.id===anchor.padId),x=p.x+anchor.offsetMil[0],y=p.y+anchor.offsetMil[1],name='FLIT_ROUTING_ANCHOR_'+i,ref='flit_anchor_'+i;
   if(anchor.widthMil!==task.width||!task.layers.includes(anchor.layer))throw Error('INVALID_LOAD_ANCHOR');
   seedSegments.push({net:task.net,layer:anchor.layer,width:anchor.widthMil,x1:x-2,y1:y,x2:x+2,y2:y});
   library.push(['padstack',name,['shape',['circle',layerName(anchor.layer),String(anchor.widthMil)]]]);image.push(['pin',name,ref,String(x),String(y)]);child(ensureNet(task.net),'pins').push(image[1]+'-'+ref);
  }
 }
 for(const s of seedSegments)wiring.push(['wire',['path',layerName(s.layer),String(s.width),String(s.x1),String(s.y1),String(s.x2),String(s.y2)],['net',s.net],['type','fix']]);
 for(const v of seedVias)wiring.push(['via',viaName,String(v.x),String(v.y),['net',v.net],['type','fix']]);
 const viaTypes=Object.fromEntries([...board.vias,taskVia].map(v=>[stackName(v),{diameter:v.diameter,hole:v.hole}]));
 const reworkTasks=compileTasks(board,policy,{nets:reworkNets});
 const routingClasses=new Set(['FLIT_TASK',...reworkNets.filter(n=>n!==task.net).map(n=>'FLIT_REWORK_'+n)]);
 // Keep an exported empty class first: Java's CSV split preserves a leading
 // empty name but drops a trailing one.
 const ignoredClasses=[...new Set(['default',...children(network,'class').map(c=>c[1])])].filter(n=>!routingClasses.has(n)).sort();
 return{dsn:serializeSpecctra(ast)+'\n',task,viaTypes,seedSegments,seedVias,reworkNets,reworkTasks,ignoredClasses,relaxedPreferences:relaxPreferences,aliases:islands.aliases};
}

export function decodeSes(text,board,input){
 const ast=parseSpecctra(text),routes=child(ast,'routes'),resolution=child(routes??[],'resolution');
 if(!resolution||resolution[1]!=='mil'||!Number(resolution[2]))throw Error('SES_RESOLUTION_UNSUPPORTED');
 const scale=Number(resolution[2]),segments=[],vias=[];
 for(const n of children(child(routes,'network_out'),'net')){
  const net=input.aliases?.[n[1]]??n[1];
  for(const w of children(n,'wire')){const p=child(w,'path'),layer=board.layerMap[p[1]],width=Number(p[2])/scale,xy=p.slice(3).map(v=>Number(v)/scale);if(!layer||width<=0||!Number.isFinite(width)||xy.length<4||xy.length%2||xy.some(x=>!Number.isFinite(x)))throw Error('SES_GEOMETRY_INVALID');for(let i=2;i<xy.length;i+=2)segments.push({net,layer,width,x1:xy[i-2],y1:xy[i-1],x2:xy[i],y2:xy[i+1]});}
  for(const v of children(n,'via')){const spec=input.viaTypes[v[1]];if(!spec)throw Error('SES_VIA_UNMAPPED:'+v[1]);vias.push({net,x:Number(v[2])/scale,y:Number(v[3])/scale,...spec,layers:board.layers});}
 }
 const mutable=new Set(input.reworkNets),scope=new Set([input.task.net,...mutable]);
 const old=board.segments.filter(s=>!mutable.has(s.net)),oldVias=board.vias.filter(v=>!mutable.has(v.net));
 const sameVia=(a,b)=>a.net===b.net&&Math.hypot(a.x-b.x,a.y-b.y)<.12&&Math.abs(a.diameter-b.diameter)<.02&&Math.abs(a.hole-b.hole)<.02;
 const selectedSegments=segments.filter(s=>!traceCovered(s,[...old,...input.seedSegments],[],[]));
 const selectedVias=vias.filter(v=>![...oldVias,...input.seedVias].some(o=>sameVia(o,v)));
 if(selectedSegments.some(s=>!scope.has(s.net))||selectedVias.some(v=>!scope.has(v.net)))throw Error('SES_SCOPE_VIOLATION');
 const newSeeds=input.seedSegments.filter(s=>!traceCovered(s,old,[],[])),newVias=[...selectedVias,...input.seedVias].filter(v=>!oldVias.some(o=>sameVia(o,v)));
 return{segments:[...selectedSegments,...newSeeds],vias:newVias.filter((v,i)=>!newVias.slice(0,i).some(o=>sameVia(o,v)))};
}

export function validateCandidate(board,task,candidate,input){
 const issues=[],warnings=[];const mutable=new Set(input.reworkNets),old=board.segments.filter(s=>!mutable.has(s.net)),oldVias=board.vias.filter(v=>!mutable.has(v.net));
 if(candidate.segments.some(s=>![s.x1,s.y1,s.x2,s.y2,s.width,s.layer].every(Number.isFinite)||s.width<=0)||candidate.vias.some(v=>![v.x,v.y,v.hole,v.diameter].every(Number.isFinite)||v.hole<=0||v.diameter<=v.hole))return{passed:false,issues:[{code:'NONFINITE_OR_INVALID_GEOMETRY'}],warnings,connectivity:{connected:false}};
 const allSegments=[...old,...candidate.segments],allVias=[...oldVias,...candidate.vias];
 const rules=new Map([...(input.reworkTasks??[]),task].map(t=>[t.net,t]));
 for(const s of candidate.segments){const rule=rules.get(s.net);if(!rule){issues.push({code:'UNREVIEWED_NET',net:s.net});continue;}if(!rule.layers.includes(s.layer))issues.push({code:'DISALLOWED_LAYER',net:s.net});if(Math.abs(s.width-rule.width)>.02&&!input.seedSegments.some(e=>traceCovered(s,[e])))issues.push({code:'UNREVIEWED_WIDTH',net:s.net,width:s.width});}
 for(const v of candidate.vias){const rule=rules.get(v.net);if(!rule||Math.abs(v.diameter-rule.via.diameterMil)>.02||Math.abs(v.hole-rule.via.holeMil)>.02)issues.push({code:'UNREVIEWED_VIA',net:v.net});}
 const assigned=board.pads.map(p=>p.net===task.net&&!task.requiredPadIds.includes(p.id)?{...p,net:'FLIT_OBSTACLE_'+p.id}:p);
 const obstacles=[...assigned.flatMap(p=>p.shapes.map(g=>({...g,net:p.net}))),...old.map(s=>({...shapesFor(s),net:s.net})),...oldVias.map(v=>({...viaShape(v,board.layers),net:v.net}))];
 const additions=[...candidate.segments.map(s=>({...shapesFor(s),net:s.net})),...candidate.vias.map(v=>({...viaShape(v,board.layers),net:v.net}))];
 for(let i=0;i<additions.length;i++)for(const o of [...obstacles,...additions.slice(i+1)])if(o.net!==additions[i].net&&conductiveGap(additions[i],o)<task.clearance-.02){issues.push({code:'COPPER_CLEARANCE',net:additions[i].net,otherNet:o.net});break;}
 if(task.sensitive)for(const g of additions)for(const o of obstacles.filter(o=>task.noiseNets.includes(o.net))){const gap=conductiveGap(g,o);if(gap<task.noiseGap-.02)issues.push({code:'SENSITIVE_MINIMUM_CLEARANCE',net:g.net,otherNet:o.net});else if(gap<task.noiseTarget-.02)warnings.push({code:'SENSITIVE_TARGET_NOT_MET',net:g.net,otherNet:o.net,gap});}
 for(const v of candidate.vias)for(const p of board.pads)if(p.shapes.some(g=>conductiveGap({...viaShape(v,board.layers),radius:v.hole/2},g)<task.clearance-.02)){issues.push({code:'DRILL_TO_PAD',net:v.net,padId:p.id});break;}
 const connectivity=taskConnectivity(board,task,allSegments,allVias);if(!connectivity.connected)issues.push({code:'ENDPOINTS_NOT_CONNECTED',net:task.net});
 for(const rework of input.reworkTasks??[])if(!taskConnectivity(board,rework,allSegments,allVias).connected)issues.push({code:'REWORK_ENDPOINTS_NOT_CONNECTED',net:rework.net});
 if(task.role==='load_current_main'&&task.layers.length>1&&!task.viaTransition)issues.push({code:'LOAD_VIA_TRANSITION_RULE_REQUIRED'});
 if(task.role==='load_current_main'&&task.viaTransition&&allSegments.some(s=>s.net===task.net&&s.layer===task.viaTransition.targetLayer&&s.width>=task.width-.02)){
  const {sourceLayer,targetLayer,minParallelVias}=task.viaTransition;
  for(const id of task.requiredPadIds){const pad=board.pads.find(p=>p.id===id);if(pad.shapes.some(g=>g.layers.includes(targetLayer)))continue;
   const shapes=[...board.pads.filter(p=>task.requiredPadIds.includes(p.id)).flatMap(p=>p.shapes.filter(g=>g.layers.includes(sourceLayer)).map(g=>({...g,id:p.id}))),...allSegments.filter(s=>s.net===task.net&&s.layer===sourceLayer).map(shapesFor),...allVias.filter(v=>v.net===task.net).map(v=>({...viaShape(v,board.layers),v}))];
   const seen=new Set(shapes.flatMap((g,i)=>g.id===id?[i]:[])),queue=[...seen];while(queue.length){const i=queue.shift();for(let j=0;j<shapes.length;j++)if(!seen.has(j)&&conductiveContact(shapes[i],shapes[j])){seen.add(j);queue.push(j);}}
   const connected=[...seen].map(i=>shapes[i].v).filter(Boolean).filter(v=>allSegments.some(s=>s.net===task.net&&s.layer===targetLayer&&conductiveContact(viaShape(v,board.layers),shapesFor(s))));
   if(connected.length<minParallelVias)issues.push({code:'PARALLEL_LOAD_VIAS_REQUIRED',padId:id,actual:connected.length,required:minParallelVias,sourceLayer,targetLayer});
  }
 }
 if(task.role==='kelvin_sense'){
  const pad=board.pads.find(p=>p.id===task.sourcePadId),load=[...old.filter(s=>s.net===task.net).map(shapesFor),...oldVias.filter(v=>v.net===task.net).map(v=>viaShape(v,board.layers))];
  if(candidate.segments.some(s=>load.some(g=>contactOutsidePad(s,g,pad)))||candidate.vias.some(v=>load.some(g=>conductiveContact(viaShape(v,board.layers),g))))issues.push({code:'KELVIN_REATTACHED_OUTSIDE_SHUNT',net:task.net});
 }
 return{passed:!issues.length,issues,warnings,connectivity,segments:candidate.segments.length,vias:candidate.vias.length};
}

export function overlayBoard(board,candidate,reworkNets=[]){const excluded=new Set(reworkNets);return{...board,segments:[...board.segments.filter(s=>!excluded.has(s.net)),...candidate.segments.map((s,i)=>({...s,id:s.id??'preview-line-'+(board.segments.length+i)}))],vias:[...board.vias.filter(v=>!excluded.has(v.net)),...candidate.vias.map((v,i)=>({...v,id:v.id??'preview-via-'+(board.vias.length+i)}))]};}
