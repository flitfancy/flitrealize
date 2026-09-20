export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
// Project text cannot supply executable HTML or links.
export function prose(value) {
  return escapeHtml(value).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
}
export function markdown(value) {
  const lines = String(value || '').split(/\r?\n/), out = [];
  const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const code = [];
      while (++i < lines.length) {
        const end = lines[i].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (end && end[1][0] === fence[1][0] && end[1].length >= fence[1].length) break;
        code.push(lines[i]);
      }
      out.push('<pre class="source-pre">'+escapeHtml(code.join('\n'))+'</pre>'); continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) { const level=Math.min(heading[1].length+1,6); out.push('<h'+level+' data-source-line="'+(i+1)+'">'+prose(heading[2])+'</h'+level+'>'); continue; }
    if (line.trim().startsWith('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i+1] || '')) {
      out.push('<div class="table-wrap"><table><thead><tr>'+cells(line).map(c=>'<th>'+prose(c)+'</th>').join('')+'</tr></thead><tbody>');
      i++;
      while (i+1<lines.length && lines[i+1].trim().startsWith('|')) out.push('<tr>'+cells(lines[++i]).map(c=>'<td>'+prose(c)+'</td>').join('')+'</tr>');
      out.push('</tbody></table></div>'); continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items=[line];
      while (/^\s*[-*]\s+/.test(lines[i+1]||'')) items.push(lines[++i]);
      out.push('<ul>'+items.map(s=>'<li>'+prose(s.replace(/^\s*[-*]\s+/,''))+'</li>').join('')+'</ul>'); continue;
    }
    out.push('<p>'+prose(line)+'</p>');
  }
  return out.join('');
}
