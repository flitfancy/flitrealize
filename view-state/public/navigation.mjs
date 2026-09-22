import {nameFor} from './names.mjs';
// Fixed skill navigation. Source headings supply paragraphs, never workflow status.
const numbered = (nodes, number) => nodes.find(n => new RegExp('^'+number+'[.、]\\s').test(n.heading));
const topic = (node, ...titles) => (node?.children || []).find(n => titles.some(title => n.title === title || n.title.startsWith(title+'、')));
// Explicit PCB topic titles only: chapter numbers and prose do not identify an operation.
const topics = (node, ...titles) => (node?.children || []).filter(n => titles.includes(n.title));
const slot = (code, sources = [], kind = 'handoff') => ({
  id:'skill-'+code, code, ...nameFor(code), kind, sources:sources.filter(Boolean),
});
export function navigation(snapshot) {
  if (!snapshot) return [];
  const roots=snapshot.sections || [];
  const [handoff,requirements,schematic,pcb,manufacture,validation,release]=Array.from({length:7},(_,i)=>numbered(roots,i));
  const unresolved=roots.find(n=>n.title==='当前未决事项');
  const networks=topics(pcb,'网络规则');
  const legacyNetworks=topics(pcb,'网络分类、线宽/过孔、布线优先级与配色','网络分类、线宽／过孔、布线优先级与配色',
    '布线规则与优先级','网络分类与布线优先级','线宽调整','指定线段改宽','网络配色','PCB 网络配色');
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
    group(3,[pcb],[
      slot('3.1',[pcb]),
      slot('3.2',[topic(pcb,'板框、层叠与测试点','板框、层叠与机械约束')]),
      slot('3.3',[topic(pcb,'最终走线与接地状态','关键拓扑、功率环路与回流路径')]),
      slot('3.4',topics(pcb,'布局与空间','布局与空间约束','粗布局状态','布局功能块、成员位号与布局理由')),
      {...slot('3.5',networks.length?networks:legacyNetworks,'networks'),...nameFor('pcb-networks'),
        references:['3.5','3.6','3.7'].map(code=>nameFor(code).reference)},
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
