import assert from 'node:assert/strict';
export const rec=(type,id,payload)=>({head:{type,...(id?{id}:{})},payload});
export const encode=records=>records.map(r=>JSON.stringify(r.head)+'||'+JSON.stringify(r.payload)).join('|\n');
export const decode=source=>source.split(/\r?\n/).filter(Boolean).map(line=>{
  const i=line.indexOf('||');
  return {head:JSON.parse(line.slice(0,i)),payload:JSON.parse(line.slice(i+2).replace(/\|$/,''))};
});
export function fixture(count=2,{dropNoConnectOnImport=false}={}) {
  const definitions={A1:{pins:[[-20,0],[20,0]],name:'LONG_COMPONENT_VALUE'},B1:{pins:[[0,-20],[0,20]],name:'B'}};
  for(let i=2;i<count;i++)definitions['X'+i]={pins:i%2?[[0,-10-5*i],[0,10+5*i]]:[[-10-5*i,0],[10+5*i,0]],name:'VARIED_VALUE_'+i};
  const records=[rec('DOCHEAD',null,{docType:'SCH_PAGE',version:'1'}),rec('CANVAS',null,{grid:5})];
  for(const [i,[designator,def]] of Object.entries(definitions).entries()) {
    records.push(rec('COMPONENT',designator,{x:10+i*5,y:-(10+i*5),componentType:'component',rotation:0,mirror:false}));
    for(const [key,value] of [['Designator',designator],['Name',def.name]])records.push(rec('ATTR',designator+'-'+key,
      {parentId:designator,key,value,x:10+i*5,y:-(10+i*5),valueVisible:null,keyVisible:false,fontSize:8,rotation:0,align:'CENTER_MIDDLE'}));
  }
  records.push(rec('TEXT','unrelated-note',{x:-5000,y:100,value:'Preserve this user note'}));
  let source=encode(records),writes=0,saves=0,pinWrites=0,rejectWrites=false;
  const noConnects=new Set();
  const connectedPins=new Map();
  const all=()=>decode(source);
  const cRecord=id=>all().find(r=>r.head.type==='COMPONENT'&&r.head.id===id);
  const attrs=id=>all().filter(r=>r.head.type==='ATTR'&&r.payload.parentId===id);
  function component(id) {
    return {
      get x(){return cRecord(id).payload.x;},get y(){return -cRecord(id).payload.y;},
      getState_PrimitiveId:()=>id,getState_Designator:()=>definitions[id]?id:'',
      getState_ComponentType:()=>cRecord(id).payload.componentType,
      getState_Rotation:()=>cRecord(id).payload.rotation??0,
      getState_Mirror:()=>cRecord(id).payload.mirror??false,
      getState_Symbol:()=>cRecord(id).payload.symbol??{name:'Signal'},
      getState_Net:()=>attrs(id).find(r=>r.payload.key==='Name')?.payload.value,
      async getAllPins(){return (definitions[id]?.pins||[]).map(([x,y],i)=>({
        x:this.x+x,y:this.y+y,getState_PrimitiveId:()=>id+'-pin'+(i+1),
        getState_PinNumber:()=>String(i+1),getState_NoConnected:()=>noConnects.has(id+'-pin'+(i+1)),
      }));},
    };
  }
  function wire(id) {
    return {getState_PrimitiveId:()=>id,
      getState_Net:()=>attrs(id).find(r=>r.payload.key==='NET').payload.value,
      getState_Line:()=>{
        const lines=all().filter(r=>r.head.type==='LINE'&&r.payload.lineGroup===id)
          .map(r=>[r.payload.startX,-r.payload.startY,r.payload.endX,-r.payload.endY]);
        return lines.length===1?lines[0]:lines;
      }};
  }
  // Independent fixture geometry, not an echo of the layout plan: symbol
  // bodies are 40-unit squares, markers are rotating 8-by-4 rectangles,
  // and labels use a simple proportional test font.
  // Every read reflects the current source pose, rotation, value and font.
  function bounds(id) {
    const record=all().find(r=>r.head.id===id);
    if(!record)return undefined;
    const p=record.payload;
    if(record.head.type==='COMPONENT'){
      const c=component(id),width=definitions[id]?40:8,height=definitions[id]?40:4;
      const angle=(Number(p.rotation)||0)*Math.PI/180;
      const w=Math.abs(Math.cos(angle))*width+Math.abs(Math.sin(angle))*height;
      const h=Math.abs(Math.sin(angle))*width+Math.abs(Math.cos(angle))*height;
      return {minX:c.x-w/2,maxX:c.x+w/2,minY:c.y-h/2,maxY:c.y+h/2};
    }
    if(record.head.type!=='ATTR')return undefined;
    const value=String(p.value??'').replace(/=\{([^}]+)\}/g,(_match,key)=>
      String(attrs(p.parentId).find(r=>r.payload.key===key)?.payload.value??''));
    const font=Number(p.fontSize)>0?Number(p.fontSize):8;
    const width=Math.max(.6,[...value].reduce((sum,ch)=>sum+(ch.codePointAt(0)>127?1:.6),0))*font;
    const height=font,angle=(Number(p.rotation)||0)*Math.PI/180;
    const w=Math.abs(Math.cos(angle))*width+Math.abs(Math.sin(angle))*height;
    const h=Math.abs(Math.sin(angle))*width+Math.abs(Math.cos(angle))*height;
    const x=Number.isFinite(p.x)?p.x:component(p.parentId).x;
    const y=Number.isFinite(p.y)?-p.y:component(p.parentId).y;
    return {minX:x-w/2,maxX:x+w/2,minY:y-h/2,maxY:y+h/2};
  }
  const eda={
    dmt_Project:{getCurrentProjectInfo:async()=>({uuid:'project'})},
    dmt_SelectControl:{getCurrentDocumentInfo:async()=>({uuid:'sheet',documentType:1})},
    sys_FileManager:{getDocumentSource:async()=>source,setDocumentSource:async next=>{
      writes++;
      if(rejectWrites||next.trimEnd().endsWith('|'))return false;
      const parsed=decode(next);parsed[0].payload.version=String(writes+1);source=encode(parsed);
      if(dropNoConnectOnImport)noConnects.clear();
      return true;
    }},
    sch_PrimitiveComponent:{getAll:async()=>all().filter(r=>r.head.type==='COMPONENT').map(r=>component(r.head.id))},
    sch_PrimitiveWire:{getAll:async()=>all().filter(r=>r.head.type==='WIRE').map(r=>wire(r.head.id))},
    sch_Primitive:{getPrimitivesBBox:async ids=>{
      const rectangles=ids.map(id=>bounds(typeof id==='string'?id:id.getState_PrimitiveId()));
      if(!rectangles.length||rectangles.some(r=>!r))return undefined;
      return {minX:Math.min(...rectangles.map(r=>r.minX)),maxX:Math.max(...rectangles.map(r=>r.maxX)),
        minY:Math.min(...rectangles.map(r=>r.minY)),maxY:Math.max(...rectangles.map(r=>r.maxY))};
    }},
    sch_PrimitivePin:{modify:async(pin,patch)=>{
      assert.equal(typeof patch.noConnected,'boolean');
      const id=pin.getState_PrimitiveId();
      if(patch.noConnected)noConnects.add(id);else noConnects.delete(id);
      pinWrites++;return pin;
    }},
    sch_Document:{save:async()=>{saves++;return true;}},
  };
  return {eda,get source(){return source;},set source(v){source=v;},get writes(){return writes;},get saves(){return saves;},
    get pinWrites(){return pinWrites;},
    reject(){rejectWrites=true;},all,component,
    async setNoConnect(designator,number){
      const pin=(await component(designator).getAllPins())[number-1];
      assert.ok(pin,'fixture pin must exist');
      const id=pin.getState_PrimitiveId();noConnects.add(id);
      source=encode([...all(),rec('ATTR',id+'-nc',{parentId:id,key:'NO_CONNECT',
        value:'yes',x:pin.x,y:-pin.y,valueVisible:false})]);
    },
    async connect(){
      const rs=all();
      for(const id of Object.keys(definitions)) {
        const pins=await component(id).getAllPins();
        for(let i=0;i<pins.length;i++) {
          if(pins[i].getState_NoConnected())continue;
          const pin=pins[i],vertical=definitions[id].pins[0][0]===0,sign=i===0?-1:1;
          const end={x:pin.x+(vertical?0:20*sign),y:pin.y+(vertical?20*sign:0)};
          const wid=id+'-w'+i,fid=id+'-f'+i,net='NET_'+id+'_'+i;
          connectedPins.set(wid,pin.getState_PrimitiveId());
          rs.push(rec('WIRE',wid,{}),rec('LINE',wid+'-line',{lineGroup:wid,startX:pin.x,startY:-pin.y,endX:end.x,endY:-end.y}),
            rec('COMPONENT',fid,{x:end.x,y:-end.y,componentType:'netflag'}),
            rec('ATTR',wid+'-net',{parentId:wid,key:'NET',value:net,x:end.x,y:-end.y,valueVisible:true,fontSize:8,rotation:0,align:'CENTER_MIDDLE'}),
            rec('ATTR',fid+'-name',{parentId:fid,key:'Name',value:net,x:null,y:null,valueVisible:false,fontSize:null,rotation:null,align:null,keyVisible:false}));
        }
      }
      source=encode(rs);
    },
    async checkConnections(){
      for(const w of await eda.sch_PrimitiveWire.getAll()) {
        const id=w.getState_PrimitiveId().split('-w')[0],lines=w.getState_Line(),pins=await component(id).getAllPins();
        const segments=Array.isArray(lines[0])?lines:[lines];
        const key=(x,y)=>Math.round(x*1e6)+','+Math.round(y*1e6),graph=new Map();
        for(const [x1,y1,x2,y2]of segments){
          const a=key(x1,y1),b=key(x2,y2);
          if(!graph.has(a))graph.set(a,new Set());if(!graph.has(b))graph.set(b,new Set());
          graph.get(a).add(b);graph.get(b).add(a);
        }
        const pin=pins.find(p=>p.getState_PrimitiveId()===connectedPins.get(w.getState_PrimitiveId()));
        assert.ok(pin&&graph.has(key(pin.x,pin.y)),'wire must still touch its originally assigned pin');
        const flag=component(w.getState_PrimitiveId().replace('-w','-f'));
        const seen=new Set([key(pin.x,pin.y)]),pending=[...seen];
        while(pending.length)for(const next of graph.get(pending.shift())??[])if(!seen.has(next)){seen.add(next);pending.push(next);}
        assert.ok(seen.has(key(flag.x,flag.y)),'all wire segments must connect the pin to its marker');
        assert.equal(seen.size,graph.size,'wire must not contain a disconnected segment');
        assert.equal(w.getState_Net(),flag.getState_Net(),'wire and marker must keep the same network');
      }
    },
  };
}
