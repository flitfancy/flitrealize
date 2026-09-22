// Read only a table explicitly marked ViewStateTable: networks in the handoff.
const cells = line => {
  const text=line?.trim();
  if(!text?.startsWith('|')||!text.endsWith('|'))return null;
  return text.slice(1,-1).split(/(?<!\\)\|/).map(value=>value.trim().replace(/\\\|/g,'|').replace(/^`([^`]+)`$/,'$1'));
};
export function parseNetworkTable(lines,start) {
  let index=start;
  while(index<lines.length&&!lines[index].trim())index++;
  const header=cells(lines[index++]),divider=cells(lines[index++]);
  const accepted=[['网络名称','线宽 (mil)','颜色'],['Network','Width (mil)','Color']];
  if(!header||!accepted.some(names=>names.every((name,i)=>header[i]===name)&&header.length===3)||
    divider?.length!==3||!divider.every(value=>/^:?-{3,}:?$/.test(value)))return null;
  const rows=[],seen=new Set();
  while(index<lines.length&&lines[index].trim().startsWith('|')) {
    const row=cells(lines[index++]);
    if(row?.length!==3)return null;
    const [net,width,color]=row;
    if(!net||seen.has(net)||!width)return null;
    if(color&&!['—','-'].includes(color)&&!/^#[\da-f]{6}$/i.test(color))return null;
    seen.add(net); rows.push({net,width,color:/^#[\da-f]{6}$/i.test(color)?color.toUpperCase():null});
  }
  return rows.length?{units:'mil',rows}:null;
}
