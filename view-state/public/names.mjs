// Current reference filenames are stable English identifiers. Chinese labels
// are a display layer; docs/en-backup is historical, not a naming authority.
const reference = (path, zh) => ({path, zh});
const provider = 'providers/easyeda-pro/';
export const references = {
  '0.1': reference('0.1-continuation.md','项目续接'),
  '0.5': reference('0.5-handoff-record.md','续接记录'),
  '1.1': reference('1.1-requirements-and-architecture.md','需求与架构'),
  '1.2': reference('1.2-parts.md','器件'),
  '2.1': reference('2.1-schematic-contract.md','原理图契约'),
  '2.2': reference(provider+'2.2-schematic-workflow.md','原理图工作流'),
  '2.3': reference(provider+'2.3-component-batch.md','器件批量操作'),
  '3.1': reference('3.1-pcb-review.md','PCB 设计与检查'),
  '3.2': reference(provider+'3.2-pcb-foundation.md','PCB 基础'),
  '3.3': reference(provider+'3.3-pcb-grounding.md','PCB 接地'),
  '3.4': reference(provider+'3.4-pcb-placement.md','布局与空间'),
  '3.5': reference(provider+'3.5-pcb-routing-plan.md','布线规则与优先级'),
  '3.6': reference(provider+'3.6-pcb-trace-width.md','线宽调整'),
  '3.7': reference(provider+'3.7-pcb-net-color.md','网络配色'),
  '4.1': reference('4.1-production-handoff.md','制造交接'),
  '5.1': reference('5.1-prototype-validation.md','样机验证'),
  '6.1': reference('6.1-production-release.md','生产发布'),
};
// These are VS presentation groups/runtime fields, not reference-file aliases.
const uiNames = {
  'pcb-networks':['Network Rules','网络规则'],
  '0.x':['Project & Runtime','项目与运行'],
  '1.x':['Requirements & Parts','需求与器件'],
  '2.x':['Schematic','原理图'],
  '3.x':['PCB','PCB'],
  '4.x':['Manufacturing','制造'],
  '5.x':['Prototype Validation','样机验证'],
  '6.x':['Production & Release','生产与发布'],
  '0.0':['Project Overview','项目概况'],
  '0.2':['Current Mode','当前模式'],
  '0.3':['Bridge Status','桥接状态'],
  '0.4':['Environment & Connection','环境与连接'],
};
function referenceTitle(path) {
  return path.split('/').at(-1).replace(/^\d+\.\d+-|\.md$/g,'').split('-')
    .map(word=>word==='pcb'?'PCB':word==='and'?'&':word[0].toUpperCase()+word.slice(1)).join(' ');
}
export function nameFor(code) {
  const ref=references[code];
  if(ref)return {title:referenceTitle(ref.path),titleZh:ref.zh,reference:'references/'+ref.path};
  const ui=uiNames[code];
  return {title:ui?.[0]||code,titleZh:ui?.[1]||null,reference:null};
}
export const displayTitle=(node,lang)=>lang==='zh'?(node.titleZh||node.title):node.title;
