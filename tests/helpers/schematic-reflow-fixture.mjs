import assert from 'node:assert/strict';
export const rec=(type,id,payload)=>({head:{type,...(id?{id}:{})},payload});
export const encode=records=>records.map(r=>JSON.stringify(r.head)+'||'+JSON.stringify(r.payload)).join('|\n');
export const decode=source=>source.split(/\r?\n/).filter(Boolean).map(line=>{
  const i=line.indexOf('||');
  return {head:JSON.parse(line.slice(0,i)),payload:JSON.parse(line.slice(i+2).replace(/\|$/,''))};
});
export function fixture(count=2) {
  const definitions={A1:{pins:[[-20,0],[20,0]],name:'LONG_COMPONENT_VALUE'},B1:{pins:[[0,-20],[0,20]],name:'B'}};
  for(let i=2;i<count;i++)definitions['X'+i]={pins:i%2?[[0,-10-i],[0,10+i]]:[[-10-i,0],[10+i,0]],name:'VARIED_VALUE_'+i};
  const records=[rec('DOCHEAD',null,{docType:'SCH_PAGE',version:'1'}),rec('CANVAS',null,{grid:5})];
  for(const [i,[designator,def]] of Object.entries(definitions).entries()) {
    records.push(rec('COMPONENT',designator,{x:10+i*2,y:-(10+i*2),componentType:'component'}));
    for(const [key,value] of [['Designator',designator],['Name',def.name]])records.push(rec('ATTR',designator+'-'+key,
      {parentId:designator,key,value,x:10+i*2,y:-(10+i*2),valueVisible:null,keyVisible:false,fontSize:null,rotation:null,align:null}));
  }
  records.push(rec('TEXT','unrelated-note',{x:-5000,y:100,value:'Preserve this user note'}));
  let source=encode(records),writes=0,saves=0,rejectWrites=false;
  const all=()=>decode(source);
  const cRecord=id=>all().find(r=>r.head.type==='COMPONENT'&&r.head.id===id);
  const attrs=id=>all().filter(r=>r.head.type==='ATTR'&&r.payload.parentId===id);
  function component(id) {
    return {
      get x(){return cRecord(id).payload.x;},get y(){return -cRecord(id).payload.y;},
      getState_PrimitiveId:()=>id,getState_Designator:()=>definitions[id]?id:'',
      getState_ComponentType:()=>cRecord(id).payload.componentType,
      getState_Net:()=>attrs(id).find(r=>r.payload.key==='Name')?.payload.value,
      async getAllPins(){return (definitions[id]?.pins||[]).map(([x,y])=>({x:this.x+x,y:this.y+y}));},
    };
  }
  function wire(id) {
    return {getState_PrimitiveId:()=>id,
      getState_Net:()=>attrs(id).find(r=>r.payload.key==='NET').payload.value,
      getState_Line:()=>{const p=all().find(r=>r.head.type==='LINE'&&r.payload.lineGroup===id).payload;return [p.startX,-p.startY,p.endX,-p.endY];}};
  }
  const eda={
    dmt_Project:{getCurrentProjectInfo:async()=>({uuid:'project'})},
    dmt_SelectControl:{getCurrentDocumentInfo:async()=>({uuid:'sheet',documentType:1})},
    sys_FileManager:{getDocumentSource:async()=>source,setDocumentSource:async next=>{
      writes++;
      if(rejectWrites||next.trimEnd().endsWith('|'))return false;
      const parsed=decode(next);parsed[0].payload.version=String(writes+1);source=encode(parsed);return true;
    }},
    sch_PrimitiveComponent:{getAll:async()=>all().filter(r=>r.head.type==='COMPONENT').map(r=>component(r.head.id))},
    sch_PrimitiveWire:{getAll:async()=>all().filter(r=>r.head.type==='WIRE').map(r=>wire(r.head.id))},
    sch_Document:{save:async()=>{saves++;return true;}},
  };
  return {eda,get source(){return source;},set source(v){source=v;},get writes(){return writes;},get saves(){return saves;},
    reject(){rejectWrites=true;},all,component,
    async connect(){
      const rs=all();
      for(const id of Object.keys(definitions)) {
        const pins=await component(id).getAllPins();
        for(let i=0;i<pins.length;i++) {
          const pin=pins[i],vertical=definitions[id].pins[0][0]===0,sign=i===0?-1:1;
          const end={x:pin.x+(vertical?0:12*sign),y:pin.y+(vertical?12*sign:0)};
          const wid=id+'-w'+i,fid=id+'-f'+i,net='NET_'+id+'_'+i;
          rs.push(rec('WIRE',wid,{}),rec('LINE',wid+'-line',{lineGroup:wid,startX:pin.x,startY:-pin.y,endX:end.x,endY:-end.y}),
            rec('COMPONENT',fid,{x:end.x,y:-end.y,componentType:'netflag'}),
            rec('ATTR',wid+'-net',{parentId:wid,key:'NET',value:net,x:end.x,y:-end.y,valueVisible:true,fontSize:null,rotation:null,align:null}),
            rec('ATTR',fid+'-name',{parentId:fid,key:'Name',value:net,x:null,y:null,valueVisible:false,fontSize:null,rotation:null,align:null,keyVisible:false}));
        }
      }
      source=encode(rs);
    },
    async checkConnections(){
      for(const w of await eda.sch_PrimitiveWire.getAll()) {
        const id=w.getState_PrimitiveId().split('-')[0],line=w.getState_Line(),pins=await component(id).getAllPins();
        assert.ok(pins.some(p=>Math.abs(p.x-line[0])<0.02&&Math.abs(p.y-line[1])<0.02));
        const flag=component(w.getState_PrimitiveId().replace('-w','-f'));
        assert.ok(Math.abs(flag.x-line[2])<0.02&&Math.abs(flag.y-line[3])<0.02);
      }
    },
  };
}
