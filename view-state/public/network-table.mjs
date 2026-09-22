import {escapeHtml as esc} from './format.mjs';

export function renderNetworkTable(table,lang='zh') {
  const tr=(zh,en)=>lang==='en'?en:zh;
  if(!table?.rows?.length)return '<p class="empty">'+tr('尚未提供网络规则表，请查看原文记录。','No network table provided yet. See the source records.')+'</p>';
  return '<div class="network-table-wrap" tabindex="0" role="region" aria-label="'+tr('网络规则表，可滚动','Network rules table, scrollable')+'"><table class="network-table">'+
    '<colgroup><col class="net-name-col"><col class="net-width-col"><col class="net-color-col"></colgroup>'+
    '<thead><tr><th scope="col">'+tr('网络名称','Network')+'</th><th scope="col">'+tr('线宽','Width')+'<small>mil</small></th><th scope="col">'+tr('颜色','Color')+'</th></tr></thead><tbody>'+
    table.rows.map(row=>{
      const color=/^#[\da-f]{6}$/i.test(row.color||'')?row.color.toUpperCase():null;
      const swatch=color?'<span class="net-color-dot" role="img" aria-label="'+color+'" title="'+color+'" style="background-color:'+color+'"></span>':
        '<span class="net-color-unknown" title="'+tr('未记录颜色','Color not recorded')+'">—</span>';
      return '<tr><th scope="row" title="'+esc(row.net)+'">'+esc(row.net).replaceAll('_','_<wbr>')+'</th><td>'+esc(row.width)+'</td><td>'+swatch+'</td></tr>';
    }).join('')+'</tbody></table></div>';
}
