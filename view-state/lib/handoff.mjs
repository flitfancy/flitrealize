// Parse only the author's display contract; never summarize prose or infer progress.
export const titleText = value => value.replace(/^\d+(?:\.\d+)*[.、]?\s*/, '').trim();

export function parseHandoff(markdown) {
  const sections = [], stack = [], issues = [];
  let fence = null, comment = false, facts = false, metadata = true, currentStage = null, stageCount = 0, updatedAt = null, projectName = null;
  const counts = new Map();
  for (const [index, raw] of markdown.replace(/^\uFEFF/,'').split(/\r?\n/).entries()) {
    if (facts) { if (raw === '<!-- flitrealize:facts:end -->') facts = false; continue; }
    const marker = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (comment) { if (raw.includes('-->')) comment = false; continue; }
    // Generated facts belong to the full document, not the authored display tree.
    if (raw === '<!-- flitrealize:facts:start -->') { facts = true; continue; }
    if (/^\s*<!--/.test(raw)) { comment = !raw.includes('-->'); continue; }
    if (marker) { fence = {char:marker[1][0],length:marker[1].length}; continue; }
    const heading = raw.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) {
      const level = heading[1].length;
      if (level === 1) { if (!projectName) projectName = heading[2]; stack.length = 0; continue; }
      metadata = false;
      while (stack.length && stack.at(-1).level >= level) stack.pop();
      const parent = stack.at(-1);
      const key = (parent?.id || '') + '/' + heading[2];
      const occurrence = (counts.get(key) || 0) + 1; counts.set(key,occurrence);
      const node = {id:key + (occurrence > 1 ? '#' + occurrence : ''),heading:heading[2],title:titleText(heading[2]),line:index+1,level,summary:null,children:[]};
      (parent ? parent.children : sections).push(node); stack.push(node);
      continue;
    }
    if (metadata && /^Updated:\s*/.test(raw)) updatedAt = raw.slice(raw.indexOf(':')+1).trim();
    const owner = stack.at(-1);
    if (!owner) continue;
    if (owner.level === 2 && owner.title === '当前交接' && /^当前阶段:/.test(raw)) {
      stageCount++; currentStage = raw.slice(raw.indexOf(':')+1).trim();
    }
    if (raw.startsWith('ViewState:')) {
      owner.markerCount = (owner.markerCount || 0) + 1;
      owner.summary = raw.slice('ViewState:'.length).trim() || null;
      if (owner.markerCount > 1) { owner.summary = null; issues.push({line:index+1,code:'DUPLICATE_SUMMARY'}); }
    }
  }
  function finish(nodes) {
    for (const n of nodes) { if (n.markerCount > 1) n.summary = null; delete n.markerCount; finish(n.children); }
  }
  finish(sections);
  if (stageCount > 1) { currentStage = null; issues.push({code:'DUPLICATE_CURRENT_STAGE'}); }
  const matches = sections.filter(n=>n.title === currentStage && n.title !== '当前交接');
  const currentId = matches.length === 1 ? matches[0].id : null;
  if (currentStage && currentStage !== '待明确' && !currentId) issues.push({code:'CURRENT_STAGE_NOT_FOUND'});
  return {projectName,updatedAt,currentStage,currentId,sections:sections.filter(n=>n.title !== '目录'),issues};
}
