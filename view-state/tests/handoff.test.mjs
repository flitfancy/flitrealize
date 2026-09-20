import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHandoff} from '../lib/handoff.mjs';
import {navigation,sourceUrl} from '../public/navigation.mjs';
import {markdown} from '../public/format.mjs';

const fixture = '# 电源板\nUpdated: 2026-09-20\n\n## 0. 当前交接\n当前阶段: PCB 设计\n\nViewState: 局部布局待调整，尚未完成复核。\n\n## 1. 需求与方案\n\nViewState: 输入范围已明确，保护阈值待确认。\n\n### 1.1 输入保护\n\nViewState: 已选候选器件，但尚未验证。\n\n详细正文不应出现在梗概。\n\n## 3. PCB 设计\n\nViewState: 电感间距不足，补线后还需检查。\n';

test('fixed markers preserve qualifiers and chapter ownership, with explicit current stage',()=>{
  const s=parseHandoff(fixture);
  assert.equal(s.currentId,s.sections[2].id);
  assert.equal(s.sections[1].summary,'输入范围已明确，保护阈值待确认。');
  assert.equal(s.sections[1].children[0].summary,'已选候选器件，但尚未验证。');
  assert.equal(s.projectName,'电源板'); assert.equal(s.updatedAt,'2026-09-20'); assert.deepEqual(s.issues,[]);
  const shifted=parseHandoff('\n\n'+fixture);
  assert.equal(s.sections[1].id,shifted.sections[1].id);
  assert.equal(s.sections[1].line+2,shifted.sections[1].line);
  assert.equal(new URL(sourceUrl('/projects/example',s.sections[1]),'http://localhost').searchParams.get('heading'),'1. 需求与方案');
});
test('missing markers never infer state or summary from prose',()=>{
  const s=parseHandoff('# Project\n## 0. 当前交接\n已完成 PCB，下一步上电。\n## 3. PCB 设计\n已完成所有检查。');
  assert.equal(s.currentStage,null); assert.equal(s.currentId,null);
  assert.ok(s.sections.every(n=>n.summary===null));
});

test('generated facts remain in the source without becoming navigation or overriding summaries',()=>{
  const s=parseHandoff('# P\n## 2. 原理图\n### 2.2 器件表\nViewState: 查看原文中的完整引脚表。\n<!-- flitrealize:facts:start -->\n### 自动明细\nViewState: 不应显示\n当前阶段: 假阶段\n<!-- flitrealize:facts:end -->\n## 3. PCB\nViewState: 尚待复核。');
  assert.equal(s.sections.length,2);
  assert.equal(s.sections[0].children.length,1);
  assert.equal(s.sections[0].children[0].summary,'查看原文中的完整引脚表。');
  assert.equal(s.sections[1].summary,'尚待复核。');
  assert.equal(s.currentStage,null);
});
test('code, comments, lists, blockquotes and indented examples are not markers',()=>{
  const ticks=String.fromCharCode(96).repeat(3);
  const lines=['# Project','## 0. 当前交接',ticks+'md','<!--','ViewState: false','## false',ticks,'<!--','~~~','ViewState: false','-->','~~~md','ViewState: false','~~~','> ViewState: false','- ViewState: false','    ViewState: false','当前阶段: 待明确','ViewState: 真实说明'];
  const s=parseHandoff(lines.join('\n'));
  assert.equal(s.sections.length,1);assert.equal(s.sections[0].summary,'真实说明');
  assert.equal(s.currentStage,'待明确'); assert.deepEqual(s.issues,[]);
});
test('duplicate fields are ambiguous and unknown stages do not get guessed',()=>{
  const s=parseHandoff('# P\n## 0. 当前交接\n当前阶段: PCB\n当前阶段: PCB\nViewState: A\nViewState: B\nViewState: C\n## 3. PCB\n');
  assert.equal(s.sections[0].summary,null); assert.equal(s.currentStage,null);
  assert.ok(s.issues.some(i=>i.code==='DUPLICATE_SUMMARY'));
  assert.ok(s.issues.some(i=>i.code==='DUPLICATE_CURRENT_STAGE'));
  const unmatched=parseHandoff('# P\n## 0. 当前交接\n当前阶段: 布线\n## 3. PCB');
  assert.equal(unmatched.currentId,null); assert.equal(unmatched.issues[0].code,'CURRENT_STAGE_NOT_FOUND');
});
test('skill groups remain complete and numbered independently of project chapters',()=>{
  const roots=navigation(parseHandoff(fixture));
  assert.deepEqual(roots.map(n=>n.code),['0.x','1.x','2.x','3.x','4.x','5.x','6.x']);
  assert.deepEqual(roots[1].children.map(n=>n.code),['1.1','1.2']);
  assert.deepEqual(roots[3].children.map(n=>n.code),['3.1','3.2','3.3','3.4']);
  assert.equal(roots[3].current,true);
  assert.equal(roots[4].current,false);
  assert.deepEqual(roots[4].children[0].sources,[]);
  assert.equal(roots[1].children[0].sources[0].summary,'输入范围已明确，保护阈值待确认。');
  assert.equal(roots[1].children[0].status,undefined);
  assert.equal(navigation(parseHandoff('')).length,7);
  assert.equal(navigation(null).length,0);
});

test('semantic topic mapping retains actual source locations without fabricating counts',()=>{
  const s=parseHandoff(fixture+'## 5. 样机验证\nViewState: 尚未上电。\n## 6. 产品化\nViewState: 尚未发布。');
  s.sections[1].children.push({id:'parts',title:'器件选择、库存复用',heading:'1.5 器件选择、库存复用',line:99,summary:'仅是选择记录。',children:[]});
  s.currentId=s.sections.at(-1).id;
  const roots=navigation(s),parts=roots[1].children[1];
  assert.equal(parts.code,'1.2');
  assert.equal(parts.sources[0].heading,'1.5 器件选择、库存复用');
  assert.equal(parts.sources[0].line,99);
  assert.equal(parts.inventoryMatch,undefined);
  assert.equal(roots[5].children[0].sources[0].summary,'尚未上电。');
  assert.equal(roots[6].children[0].sources[0].summary,'尚未发布。');
  assert.equal(roots[6].current,true);
  assert.equal(roots[5].current,false);
});
test('reader escapes executable HTML and preserves source heading lines after fences and tables',()=>{
  const rendered=markdown('# P\n~~~\n<script>alert(1)</script>\n~~~\n## Target\n| A | B |\n| --- | --- |\n| x | y |');
  assert.doesNotMatch(rendered,/<script>/); assert.match(rendered,/&lt;script&gt;/);
  assert.match(rendered,/<h3 data-source-line="5">Target<\/h3>/); assert.match(rendered,/<td>x<\/td>/);
});
