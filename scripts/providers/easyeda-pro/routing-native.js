// Loaded by the routing Provider together with the shared geometry functions.
return await (async()=>{
 const input=flitrealizeInput,mode=input.mode,key='__flitrealizeRoutingTransaction';
 const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(canonical(value))))),b=>b.toString(16).padStart(2,'0')).join('');
 const fields=['PrimitiveId','Net','Layer','LineWidth','StartX','StartY','EndX','EndY','X','Y','Diameter','HoleDiameter','Rotation','PrimitiveLock'];
 const snap=o=>Object.fromEntries(fields.map(k=>[k,typeof o['getState_'+k]==='function'?o['getState_'+k]():null]));
 const assertTarget=async()=>{const d=await eda.dmt_SelectControl.getCurrentDocumentInfo(),p=await eda.dmt_Project.getCurrentProjectInfo();if(Number(d?.documentType)!==3||(input.target?.document&&d.uuid!==input.target.document)||(input.target?.project&&p?.uuid!==input.target.project))throw Error('TARGET_CHANGED');return{project:p.uuid,document:d.uuid};};
 const read=async()=>{
  const target=await assertTarget(),objects={};for(const [kind,api]of Object.entries({lines:eda.pcb_PrimitiveLine,arcs:eda.pcb_PrimitiveArc,polylines:eda.pcb_PrimitivePolyline,vias:eda.pcb_PrimitiveVia,pours:eda.pcb_PrimitivePour}))objects[kind]=(await api.getAll()).map(snap).sort((a,b)=>a.PrimitiveId.localeCompare(b.PrimitiveId));
  const source=await eda.sys_FileManager.getDocumentSource(),netNames=await eda.pcb_Net.getAllNetsName();
  const components=(await eda.pcb_PrimitiveComponent.getAll()).map(c=>({id:c.getState_PrimitiveId(),ref:c.getState_Designator(),footprint:c.getState_Footprint(),pads:c.getState_Pads()}));
  const refs=new Set(components.map(c=>c.footprint?.uuid));const footprintSources=(await eda.sys_FileManager.getDocumentFootprintSources()).filter(s=>refs.has(s.footprintUuid)).sort((a,b)=>a.footprintUuid.localeCompare(b.footprintUuid));
  return{target,project:target.project,document:target.document,objects,source,netNames,components,footprintSources,sourceInvariantHash:await hash(invariant(source)),footprintHash:await hash(footprintSources),counts:Object.fromEntries(Object.entries(objects).map(([k,v])=>[k,v.length]))};
 };
 const geometry=objects=>({segments:objects.lines.map(s=>({net:s.Net,layer:s.Layer,width:s.LineWidth,x1:s.StartX,y1:s.StartY,x2:s.EndX,y2:s.EndY})),vias:objects.vias.map(v=>({net:v.Net,x:v.X,y:v.Y,diameter:v.Diameter,hole:v.HoleDiameter,layers:input.layerIds}))});
 const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
 const unchanged=(before,after,mutable)=>{
  if(before.sourceInvariantHash!==after.sourceInvariantHash||before.footprintHash!==after.footprintHash||!same([...before.netNames].sort(),[...after.netNames].sort()))throw Error('PROTECTED_DESIGN_CHANGED');
  for(const [kind,rows]of Object.entries(before.objects)){const now=new Map(after.objects[kind].map(r=>[r.PrimitiveId,r]));for(const row of rows)if((!mutable.has(row.Net)||row.PrimitiveLock||!['lines','vias'].includes(kind))&&!same(row,now.get(row.PrimitiveId)))throw Error('PROTECTED_PRIMITIVE_CHANGED');}
 };
 if(mode==='capture'){
  const result=await read();const physical=await eda.pcb_Drc.check(true,false,true);if(!Array.isArray(physical))throw Error('DRC_RESULT_UNAVAILABLE');
  const dsn=await eda.pcb_ManufactureData.getDsnFile('FlitRealize-routing.dsn');if(!dsn)throw Error('DSN_EXPORT_UNAVAILABLE');
  const pads=(await eda.pcb_PrimitivePad.getAll()).map(o=>({id:o.getState_PrimitiveId(),net:String(o.getState_Net?.()??''),layer:o.getState_Layer(),x:o.getState_X(),y:o.getState_Y(),hole:o.getState_Hole?.()??null,metallization:o.getState_Metallization?.()??null}));
  return{status:'captured',readOnly:true,...result,pads,dsnText:await dsn.text(),physicalDrcCount:physical.length,activeTransaction:globalThis[key]?{status:globalThis[key].status,saved:globalThis[key].saved}:null};
 }
 if(mode==='inspect')return{status:'inspected',readOnly:true,...await read(),transaction:globalThis[key]?{status:globalThis[key].status,saved:globalThis[key].saved}:null};
 if(mode==='save'){
  const state=globalThis[key];if(!state||state.runId!==input.runId||state.status!=='applied-verified-unsaved')throw Error('SAVE_STATE_INVALID');
  const now=await read();if(!same(now.objects,state.after.objects)||now.sourceInvariantHash!==state.after.sourceInvariantHash||now.footprintHash!==state.after.footprintHash)throw Error('POST_APPLY_DESIGN_CHANGED');
  if(!await eda.pcb_Document.save())throw Error('SAVE_NOT_CONFIRMED');state.saved=true;state.status='saved';
  const after=await read();if(!same(after.objects,now.objects)||after.sourceInvariantHash!==now.sourceInvariantHash)throw Error('POST_SAVE_CHANGED');return{status:'saved',saved:true,...after};
 }
 if(mode!=='apply')throw Error('INVALID_ROUTING_NATIVE_MODE');
 if(globalThis[key]&&!globalThis[key].saved&&globalThis[key].status!=='rolled-back')throw Error('UNRESOLVED_ROUTING_TRANSACTION');
 if(globalThis.__natureCraftSesImport&&!globalThis.__natureCraftSesImport.saved)throw Error('OTHER_IMPORT_PENDING');
 if(globalThis.__natureCraftAutorouteTask?.status==='running'||globalThis.__flitrealizeBst2AutoRouteTrial?.status==='running')throw Error('OTHER_ROUTER_PENDING');
 const before=await read();if(!input.before||before.sourceInvariantHash!==input.before.sourceInvariantHash||before.footprintHash!==input.before.footprintHash||!same(before.objects,input.before.objects))throw Error('PCB_BASELINE_CHANGED');
 const mutable=new Set(input.mutableNets??[]),scope=new Set(input.selectedNets),baselineIds=new Set(Object.values(before.objects).flat().map(r=>r.PrimitiveId));
 if([...before.objects.lines,...before.objects.vias].some(r=>mutable.has(r.Net)&&r.PrimitiveLock))throw Error('LOCKED_REWORK_NET');
 if(input.expected.segments.some(s=>!scope.has(s.net)||!input.layerIds.includes(s.layer)||s.layer===15||!Number.isFinite(s.width)||s.width<=0)||input.expected.vias.some(v=>!scope.has(v.net)||v.hole<=0||v.diameter<=v.hole))throw Error('INVALID_ROUTING_WRITE_SCOPE');
 const state={runId:input.runId,status:'applying',saved:false,before,created:{lines:[],vias:[]},removed:{lines:[],vias:[]},uncertain:false};globalThis[key]=state;
 const createLine=async s=>{await assertTarget();state.uncertain=true;const o=await eda.pcb_PrimitiveLine.create(s.net,s.layer,s.x1,s.y1,s.x2,s.y2,s.width,false);if(!o)throw Error('LINE_CREATE_UNCONFIRMED');const row=snap(o);state.created.lines.push(row.PrimitiveId);state.uncertain=false;if(baselineIds.has(row.PrimitiveId))throw Error('CREATE_ID_IS_ORIGINAL');};
 const createVia=async v=>{await assertTarget();state.uncertain=true;const o=await eda.pcb_PrimitiveVia.create(v.net,v.x,v.y,v.hole,v.diameter);if(!o)throw Error('VIA_CREATE_UNCONFIRMED');const row=snap(o);state.created.vias.push(row.PrimitiveId);state.uncertain=false;if(baselineIds.has(row.PrimitiveId))throw Error('CREATE_ID_IS_ORIGINAL');};
 const rebuild=async()=>{for(const pour of await eda.pcb_PrimitivePour.getAll()){await assertTarget();if(!await pour.rebuildCopperRegion())throw Error('POUR_REBUILD_FAILED');}};
 try{
  for(const [kind,api]of Object.entries({lines:eda.pcb_PrimitiveLine,vias:eda.pcb_PrimitiveVia})){const rows=before.objects[kind].filter(r=>mutable.has(r.Net));if(rows.length){await assertTarget();state.uncertain=true;await api.delete(rows.map(r=>r.PrimitiveId));state.removed[kind]=rows;state.uncertain=false;}}
  for(const v of input.expected.vias)await createVia(v);for(const s of input.expected.segments)await createLine(s);
  await rebuild();const after=await read();unchanged(before,after,new Set([...scope,...mutable]));
  const base=geometry(before.objects),wanted={segments:[...base.segments.filter(s=>!mutable.has(s.net)),...input.expected.segments],vias:[...base.vias.filter(v=>!mutable.has(v.net)),...input.expected.vias]};
  const realization=verifyRealization({expected:wanted,actual:geometry(after.objects),pads:input.pads,layers:input.layerIds});if(!realization.passed)throw Error('COPPER_REALIZATION_MISMATCH');
  const actualGeometry=geometry(after.objects);
  for(const task of input.tasks??[]){const pads=input.pads.filter(p=>task.requiredPadIds.includes(p.id)),connected=checkConnectivity(task.net,pads,actualGeometry.segments,actualGeometry.vias,{layers:input.layerIds});if(connected.disconnected.some(o=>o.role==='pad'))throw Error('TASK_ENDPOINTS_NOT_CONNECTED');}
  const drc=await eda.pcb_Drc.check(true,false,true);if(!Array.isArray(drc)||drc.length){state.drc=drc?.slice(0,10);throw Error('NATIVE_DRC_FAILED');}
  state.status='applied-verified-unsaved';state.after=after;return{status:state.status,saved:false,...after,realization,physicalDrcCount:0};
 }catch(error){
  state.error=error.message;
  if(state.uncertain||/TARGET_|PROTECTED_|UNCONFIRMED|ORIGINAL/.test(error.message)){state.status='needs-attention';return{status:state.status,saved:false,error:state.error,created:state.created};}
  try{
   const current=await read();unchanged(before,current,new Set([...scope,...mutable]));
   for(const [kind,api]of Object.entries({lines:eda.pcb_PrimitiveLine,vias:eda.pcb_PrimitiveVia})){
    const owned=current.objects[kind].filter(r=>!baselineIds.has(r.PrimitiveId)&&scope.has(r.Net));
    if(current.objects[kind].some(r=>!baselineIds.has(r.PrimitiveId)&&!scope.has(r.Net)))throw Error('ROLLBACK_UNATTRIBUTED_OBJECT');
    if(owned.length){await assertTarget();await api.delete(owned.map(r=>r.PrimitiveId));}
   }
   const now=await read();
   for(const r of [...state.removed.vias])await createVia({net:r.Net,x:r.X,y:r.Y,hole:r.HoleDiameter,diameter:r.Diameter});
   for(const r of [...state.removed.lines])await createLine({net:r.Net,layer:r.Layer,width:r.LineWidth,x1:r.StartX,y1:r.StartY,x2:r.EndX,y2:r.EndY});
   // Non-destructive joins can split an old line. Restore only if all original
   // copper remains represented; otherwise stop rather than guessing deletion.
   const restored=await read();if(!verifyRealization({expected:geometry(before.objects),actual:geometry(restored.objects),pads:input.pads,layers:input.layerIds}).passed)throw Error('ROLLBACK_NOT_PROVEN');
   await rebuild();const drc=await eda.pcb_Drc.check(true,false,true);if(!Array.isArray(drc)||drc.length)throw Error('ROLLBACK_DRC_FAILED');
   state.status='rolled-back';return{status:state.status,saved:false,error:state.error,drc:state.drc??null,...await read()};
  }catch(recovery){state.status='needs-attention';state.recoveryError=recovery.message;return{status:state.status,saved:false,error:state.error,recoveryError:state.recoveryError,created:state.created};}
 }
})();
