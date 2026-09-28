#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewFineLayout } from './pcb-layout/pcb-layout-fine-review.mjs';

const help = `Compare local PCB placement proposals against an observed board (no EDA writes).
node scripts/pcb-fine-review.mjs --snapshot snapshot.json --input-file fine-input.json
  --report-dir <new-directory> [--assembly-rules assembly-rules.json]
Outputs review.json, review.md, comparison.html and eligible pcb-edit plan inputs.
If the board is absent, outputs a board-outline plan request and requires a fresh snapshot after creation.`;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = v => Number.isFinite(v) ? v.toFixed(2) : '—';
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const md = v => String(v ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
function svg(components, pads, board, moved) {
  const width = board.maxX - board.minX, height = board.maxY - board.minY, font = Math.max(width, height) / 65;
  const y = value => board.maxY - value;
  const rectangle = (b, color) => `<rect x="${b.minX}" y="${y(b.maxY)}" width="${b.maxX-b.minX}" height="${b.maxY-b.minY}" fill="${color}" fill-opacity=".12" stroke="${color}" stroke-width="${font/12}"/>`;
  return `<svg viewBox="${board.minX-font} ${-font} ${width+font*2} ${height+font*2}" role="img" aria-label="PCB placement bounding boxes, Y up">${rectangle(board,'#34445a')}${components.map(c => rectangle(c.bbox,moved.has(c.ref)?'#1871c9':'#7b8593')+`<text x="${c.x}" y="${y(c.y)}" text-anchor="middle" dominant-baseline="middle" font-size="${font}" fill="#26364a">${esc(c.ref)}</text>`).join('')}${pads.filter(p=>!p.owner).map(p=>rectangle(p.bbox,'#ad7221')).join('')}</svg>`;
}
function metricRows(candidate) {
  return [...candidate.metrics.nets.map(r=>['net '+r.net,r.beforeMil,r.afterMil,r.deltaMil]), ...candidate.metrics.padPairs.map(r=>[r.id+' ('+r.metric+')',r.beforeMil,r.afterMil,r.deltaMil])];
}
export function renderFineReview(result, snapshot) {
  const intro = `板框：${result.board.sources.join(', ') || '未创建'}。装配检查：${result.coverage.assembly}。距离为布局代理指标，未执行 EDA 写入、布线或 DRC。`;
  const lines = ['# 细布局候选审阅', '', intro, '', `状态：${result.status}；来源 sourceHash：${result.sourceHash}。`, ''];
  const sections = [];
  for (const c of result.candidates) {
    lines.push(`## ${c.name}`, '', `变化器件 ${c.changes.length}；几何问题 ${c.issues.length}（新增 ${c.introducedIssues.length}、消除 ${c.resolvedIssues.length}）；执行能力问题 ${c.executionIssues.length}。`, '', '| 对象 | X (mil) | Y (mil) | 角度 |', '| --- | ---: | ---: | ---: |', ...c.changes.map(p=>`| ${md(p.designator)} | ${number(p.x)} | ${number(p.y)} | ${p.rotation} |`), '', '| 指标 | 原值 (mil) | 候选 (mil) | 变化 (mil) |', '| --- | ---: | ---: | ---: |', ...metricRows(c).map(r=>`| ${md(r[0])} | ${r.slice(1).map(number).join(' | ')} |`), '');
    lines.push(...[...c.issues,...c.executionIssues].map(i=>`- ${i.code}: ${md(i.ref ?? i.refs?.join(', ') ?? i.id ?? i.message ?? '')}`), '');
    const rows = metricRows(c).map(r=>`<tr><td>${esc(r[0])}</td>${r.slice(1).map(v=>`<td>${number(v)}</td>`).join('')}</tr>`).join('');
    const moved = new Set(c.changes.map(p=>p.designator));
    sections.push(`<section id="${esc(c.name)}"><h2>${esc(c.name)}</h2><p>移动 ${c.changes.length} 个器件 · 几何问题 ${c.issues.length}（新增 ${c.introducedIssues.length}，消除 ${c.resolvedIssues.length}）· 执行能力问题 ${c.executionIssues.length}</p><div class="views"><figure><figcaption>读取的基线</figcaption>${svg(snapshot.components,snapshot.pads,result.board.bounds,moved)}</figure><figure><figcaption>候选 · 蓝色为变化器件 · 橙色为独立测试焊盘</figcaption>${svg(c.geometry.components,c.geometry.pads,result.board.bounds,moved)}</figure></div><table><thead><tr><th>指标</th><th>原值 mil</th><th>候选 mil</th><th>变化 mil</th></tr></thead><tbody>${rows}</tbody></table><details><summary>检查问题（${c.issues.length+c.executionIssues.length}）</summary><pre>${esc(JSON.stringify([...c.issues,...c.executionIssues],null,2))}</pre></details></section>`);
  }
  if (result.next) lines.push(result.next);
  return { markdown: lines.join('\n')+'\n', html: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>细布局候选审阅</title><style>body{font:15px/1.6 system-ui,sans-serif;margin:24px auto;padding:0 24px;max-width:1280px;color:#233247;background:#f5f7fa}h1,h2{line-height:1.3}section{background:white;padding:20px;margin:22px 0;border:1px solid #d8dfe8;border-radius:8px}.views{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0}svg{width:100%;max-height:700px}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:6px 10px;border-bottom:1px solid #e0e5eb;text-align:right}th:first-child,td:first-child{text-align:left}pre{white-space:pre-wrap;font-size:12px}nav a{margin-right:16px}a{color:#1768ae}@media(max-width:700px){.views{grid-template-columns:1fr}}</style><h1>细布局候选审阅</h1><p>${esc(intro)}</p><p>状态 ${esc(result.status)} · sourceHash ${esc(result.sourceHash)}</p><nav>${result.candidates.map(c=>`<a href="#${esc(c.name)}">${esc(c.name)}</a>`).join('')}</nav>${result.next?`<p>${esc(result.next)}</p>`:''}${sections.join('')}</html>` };
}
export async function main(args = process.argv.slice(2), { log = value => console.log(JSON.stringify(value)) } = {}) {
  if (args.length === 1 && args[0] === '--help') { console.log(help); return; }
  const options = {};
  for (let i=0;i<args.length;i++) {
    const key=args[i];
    if (!['--snapshot','--input-file','--report-dir','--assembly-rules'].includes(key) || options[key] !== undefined) throw Error('INVALID_OPTION '+key);
    const value=args[++i];if(!value || value.startsWith('--')) throw Error('OPTION_VALUE_REQUIRED '+key);options[key]=resolve(value);
  }
  for (const key of ['--snapshot','--input-file','--report-dir']) if(!options[key])throw Error('OPTION_REQUIRED '+key);
  const raw=await json(options['--snapshot']),snapshot=raw.response?.result??raw.result??raw;
  const request=await json(options['--input-file']);
  const assembly=options['--assembly-rules']?await json(options['--assembly-rules']):null;
  const result=reviewFineLayout(snapshot,request,assembly);
  const dir=options['--report-dir'];await mkdir(dirname(dir),{recursive:true});await mkdir(dir);
  const write=(name,value)=>writeFile(join(dir,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  await write('inputs.json',{snapshotFile:options['--snapshot'],request,assemblyRules:assembly});
  await write('snapshot.json',snapshot);
  await write('review.json',result);
  const rendered=renderFineReview(result,snapshot);await write('review.md',rendered.markdown);await write('comparison.html',rendered.html);
  if(result.boardOutlineRequest)await write('board-outline-request.json',result.boardOutlineRequest);
  for(const c of result.candidates)if(c.placementPlanRequest)await write('placement-plan-'+c.name+'.json',c.placementPlanRequest);
  log({status:result.status,nativeWrites:0,report:dir,candidates:result.candidates.map(c=>({name:c.name,changed:c.changes.length,issues:c.issues.length,executionIssues:c.executionIssues.length,livePlanAvailable:!!c.placementPlanRequest}))});
  return result;
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error=>{console.error(JSON.stringify({status:'failed',error:error.message}));process.exitCode=1;});
}
