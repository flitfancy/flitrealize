import {nameFor} from './names.mjs';
// Fixed skill navigation. Source headings supply paragraphs, never workflow status.
const numbered = (nodes, number) => nodes.find(n => new RegExp('^'+number+'[.、]\\s').test(n.heading));
const topic = (node, ...titles) => (node?.children || []).find(n => titles.some(title => n.title === title || n.title.startsWith(title+'、')));
// Explicit PCB topic titles only: chapter numbers and prose do not identify an operation.
const descendants = nodes => nodes.flatMap(node => [node,...descendants(node.children || [])]);
const topics = (nodes, ...titles) => nodes.filter(n => titles.some(title => n.title === title || ['、','（',' ('].some(suffix => n.title.startsWith(title+suffix))));
const slot = (code, sources = [], kind = 'handoff') => ({
  id:'skill-'+code, code, ...nameFor(code), kind, sources:sources.filter(Boolean),
});
export function navigation(snapshot) {
  if (!snapshot) return [];
  const roots=snapshot.sections || [];
  const sources=descendants(roots);
  const unresolved=roots.find(n=>n.title==='当前未决事项');
  const networks=topics(sources,'网络规则');
  const legacyNetworks=topics(sources,'网络分类、线宽/过孔、布线优先级与配色','网络分类、线宽／过孔、布线优先级与配色',
    '布线规则与优先级','网络分类与布线优先级','线宽调整','指定线段改宽','网络配色','PCB 网络配色','网络与焊盘配色','PCB 网络与焊盘配色','网络/焊盘配色','网络与焊盘着色');
  const layouts=topics(sources,'布局与空间','布局与空间约束','粗布局状态','布局功能块、成员位号与布局理由');
  // Explicit operation titles own their facts, even in standalone historical
  // project chapters. Their source numbers never become fixed skill stage IDs.
  const operationOwners=new Set([...networks,...legacyNetworks,...layouts]);
  const stageRoots=roots.filter(n=>!operationOwners.has(n));
  const [handoff,requirements,schematic,pcb,manufacture,validation,release]=Array.from({length:7},(_,i)=>numbered(stageRoots,i));
  const group=(number,chapters,children)=>({
    id:'group-'+number,code:number+'.x',...nameFor(number+'.x'),children,
    current:chapters.some(n=>n && n.id===snapshot.currentId),
  });
  return [
    group(0,[],[
      slot('0.0',[],'overview'),
      slot('0.1',[handoff,unresolved]),
      slot('0.2',[],'mode'),
      slot('0.3',[],'bridge'),
      slot('0.4',[],'bridge'),
      slot('0.5'),
    ]),
    group(1,[requirements],[
      slot('1.1',[requirements]),
      slot('1.2',[topic(requirements,'器件选择')],'parts'),
    ]),
    group(2,[schematic],[
      slot('2.1',[schematic]),
      slot('2.2',[topic(schematic,'通用连接流程整合验证','当前原理图实现')]),
      slot('2.3'),
    ]),
    group(3,[pcb,...networks,...legacyNetworks,...layouts],[
      slot('3.1',[pcb]),
      slot('3.2',[topic(pcb,'板框、层叠与测试点','板框、层叠与机械约束')]),
      slot('3.3',[topic(pcb,'最终走线与接地状态','关键拓扑、功率环路与回流路径')]),
      {...slot('3.4',networks.length?networks:legacyNetworks,'networks'),...nameFor('pcb-networks'),
        references:['3.4','3.6','3.7'].map(code=>nameFor(code).reference)},
      slot('3.5',layouts),
    ]),
    group(4,[manufacture],[slot('4.1',[manufacture])]),
    group(5,[validation],[
      slot('5.1',[validation]),
    ]),
    group(6,[release],[
      slot('6.1',[release]),
    ]),
  ];
}
export function sourceUrl(root,node) {
  return './document.html?'+new URLSearchParams({projectRoot:root,heading:node?.heading || '',line:String(node?.line || '')});
}
