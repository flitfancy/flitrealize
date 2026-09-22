import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHandoff} from '../lib/handoff.mjs';
import {renderNetworkTable} from '../public/network-table.mjs';
import {navigation} from '../public/navigation.mjs';

const header='| 网络名称 | 线宽 (mil) | 颜色 |\n| --- | --- | --- |\n';
const rows='| `SYS` | 40 / 20 | #ff4040 |\n| I2C_SCL | 6 | — |\n';
const block='ViewStateTable: networks\n\n'+header+rows;
const doc=body=>'# P\n## 3. PCB 设计\n### 3.8 网络规则\nViewState: 历史规划，非当前实板。\n'+body;

test('explicit network table exposes rows, exact color and unknown values with its source',()=>{
  const snapshot=parseHandoff(doc(block));
  const source=navigation(snapshot)[3].children.at(-1).sources[0];
  assert.deepEqual(snapshot.issues,[]);
  assert.deepEqual(source.networkTable,{units:'mil',rows:[
    {net:'SYS',width:'40 / 20',color:'#FF4040'}, {net:'I2C_SCL',width:'6',color:null},
  ]});
  assert.equal(source.summary,'历史规划，非当前实板。');
  assert.equal(source.heading,'3.8 网络规则');
  assert.equal(source.status,undefined);
});

test('tables in unmarked prose, fences, quotes and generated facts do not create network rows',()=>{
  for(const body of [header+rows,'```md\n'+block+'```','<!--\n'+block+'-->','> '+block.replaceAll('\n','\n> '),
    '<!-- flitrealize:facts:start -->\n'+block+'<!-- flitrealize:facts:end -->']){
    const snapshot=parseHandoff(doc(body));
    assert.equal(snapshot.sections[0].children[0].networkTable,undefined);
    assert.deepEqual(snapshot.issues,[]);
  }
});

test('duplicate tables and duplicate nets are rejected instead of selecting a winner',()=>{
  const duplicated=parseHandoff(doc(block+'\n'+block));
  assert.equal(duplicated.sections[0].children[0].networkTable,null);
  assert.ok(duplicated.issues.some(i=>i.code==='DUPLICATE_NETWORK_TABLE'));
  const duplicateNet=parseHandoff(doc(block+'| SYS | 6 | #FFFFFF |\n'));
  assert.equal(duplicateNet.sections[0].children[0].networkTable,null);
  assert.ok(duplicateNet.issues.some(i=>i.code==='INVALID_NETWORK_TABLE'));
});

test('invalid color, malformed columns and empty tables are explicit errors',()=>{
  for(const table of [header,header+'| A | 6 | red |',header+'| A | 6 | #123456;display:none |',
    header+'| A | 6 | #123456 | extra |',header+'| A | | — |',rows]){
    const parsed=parseHandoff(doc('ViewStateTable: networks\n'+table));
    assert.equal(parsed.sections[0].children[0].networkTable,null);
    assert.ok(parsed.issues.some(i=>i.code==='INVALID_NETWORK_TABLE'));
  }
});

test('updating a table changes only its explicit rows without replacing another chapter',()=>{
  const text=doc(block)+'\n### 3.9 布局与空间\nViewState: 保持接口位置。';
  const before=parseHandoff(text),after=parseHandoff(text.replace('40 / 20','24 / 16'));
  assert.equal(after.sections[0].children[0].networkTable.rows[0].width,'24 / 16');
  assert.deepEqual(before.sections[0].children[1],after.sections[0].children[1]);
});

test('color dots use the supplied HEX and table labels cannot execute HTML or CSS',()=>{
  const table={rows:[{net:'A_<img src=x onerror=1>',width:'<script>x</script>',color:'#FF4040'},
    {net:'B',width:'—',color:null},{net:'C',width:'6',color:'red;background:url(x)'}]};
  const html=renderNetworkTable(table);
  assert.equal((html.match(/class="net-color-dot"/g)||[]).length,1);
  assert.match(html,/background-color:#FF4040/);
  assert.match(html,/aria-label="#FF4040"/);
  assert.match(html,/&lt;img/);assert.match(html,/&lt;script/);
  assert.doesNotMatch(html,/<img|<script|background:url/);
  assert.match(html,/<table/);assert.match(html,/网络名称/);
  assert.match(renderNetworkTable(table,'en'),/>Network</);
  assert.match(renderNetworkTable(null),/尚未提供网络规则表/);
});
