// EasyEDA native PCB source records and native rendering metadata only.
// This normalization is not the canonical form of the public routing model.
export const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).filter(k=>k!=='zIndex').sort().map(k=>[k,canonical(value[k])])):typeof value==='number'?Math.round(value*1e6)/1e6:value;
export const invariant=source=>{
  const records=[];for(const line of source.split(/\r?\n/).filter(Boolean)){
   const i=line.indexOf('||');if(i<0)throw Error('SOURCE_PARSE_FAILED');const h=JSON.parse(line.slice(0,i));let data=line.slice(i+2);if(data.endsWith('|'))data=data.slice(0,-1);const b=JSON.parse(data);
   if(['DOCHEAD','CANVAS'].includes(h.type))continue;
   if(h.type==='VIA'||h.type==='POURED'||(['LINE','ARC','POLY','POLYLINE'].includes(h.type)&&[1,2,15,16].includes(b.layerId)))continue;
   if(h.type==='LAYER')records.push([h.type,h.id,{layerId:b.layerId,layerType:b.layerType,layerName:b.layerName,use:b.use}]);else records.push([h.type,h.id,canonical(b)]);
  }
  return JSON.stringify(records.sort((a,b)=>(a[0]+a[1]).localeCompare(b[0]+b[1])));
 };
