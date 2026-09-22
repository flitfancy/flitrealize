import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('read-only API reads only current handoff, reflects edits, rejects invalid roots and old APIs',async t=>{
  const root=await mkdtemp(join(tmpdir(),'view-state-http-'));
  const home=join(root,'home'),project=join(root,'project');
  await mkdir(home);await mkdir(project);
  const handoff=join(project,'CURRENT_HANDOFF.md');
  const serverRoot=process.env.FLITREALIZE_TEST_VIEW_STATE_ROOT || fileURLToPath(new URL('..',import.meta.url));
  const child=spawn(process.execPath,['server.mjs','--port','0','--home',home],{cwd:serverRoot,windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(async()=>{
    await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);child.kill();});
    await rm(root,{recursive:true,force:true});
  });
  const url=await new Promise((resolve,reject)=>{
    let output='';const timeout=setTimeout(()=>reject(new Error('Startup timeout')),10000);
    child.once('error',e=>{clearTimeout(timeout);reject(e);});
    child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timeout);resolve(JSON.parse(output.split('\n')[0]).url);}});
  });
  const get=(path,params={})=>fetch(new URL(path+'?'+new URLSearchParams(params),url));
  assert.deepEqual(await(await get('/api/health')).json(),{service:'flitrealize-view-state',schemaVersion:1,readOnly:true});
  assert.equal((await (await get('/api/status')).json()).error,'NO_PROJECT_ROOT');
  assert.equal((await get('/api/status',{projectRoot:join(root,'missing')})).status,404);
  assert.equal((await get('/api/status',{projectRoot:'relative/path'})).status,400);
  const empty=await(await get('/api/status',{projectRoot:project})).json();
  assert.equal(empty.documentExists,false);assert.deepEqual(empty.sections,[]);
  assert.equal((await get('/api/document',{projectRoot:project})).status,404);
  const text='# Project\n## 0. 当前交接\n当前阶段: PCB\nViewState: 局部间距不足，仍需复核。\n## 3. PCB\nViewState: 补线后检查。\n详细正文不得被提取。';
  await writeFile(handoff,text);
  await writeFile(join(project,'unrelated.json'),'{"status":"complete"}');
  const first=await(await get('/api/status',{projectRoot:project})).json();
  assert.equal(first.schemaVersion,2);assert.equal(first.sections[0].summary,'局部间距不足，仍需复核。');
  assert.equal(first.currentId,first.sections[1].id);assert.doesNotMatch(JSON.stringify(first),/详细正文|complete/);
  assert.equal((await(await get('/api/document',{projectRoot:project})).json()).text,text);
  const table='\n### 网络规则\nViewState: 规划宽度，历史颜色回读。\nViewStateTable: networks\n\n| 网络名称 | 线宽 (mil) | 颜色 |\n| --- | --- | --- |\n| SYS | 40 / 20 | #ff4040 |';
  await writeFile(handoff,text+table);
  const withTable=await(await get('/api/status',{projectRoot:project})).json();
  assert.deepEqual(withTable.sections[1].children[0].networkTable.rows,[{net:'SYS',width:'40 / 20',color:'#FF4040'}]);
  await writeFile(handoff,text+table.replace('40 / 20','32 / 16').replace('#ff4040','—'));
  const updatedTable=await(await get('/api/status',{projectRoot:project})).json();
  assert.deepEqual(updatedTable.sections[1].children[0].networkTable.rows,[{net:'SYS',width:'32 / 16',color:null}]);
  await writeFile(handoff,'# Project\n## 0. 当前交接\n已完成设计。');
  const refreshed=await(await get('/api/status',{projectRoot:project})).json();
  assert.equal(refreshed.currentStage,null);assert.equal(refreshed.sections[0].summary,null);
  assert.equal((await get('/api/evidence',{projectRoot:project,path:'CURRENT_HANDOFF.md'})).status,404);
  assert.equal((await get('/%2e%2e%5cserver.mjs')).status,403);
  assert.equal((await fetch(new URL('/api/status',url),{method:'POST'})).status,405);
  for(const asset of ['/', '/app.js', '/app.css', '/format.mjs', '/navigation.mjs', '/names.mjs', '/network-table.mjs', '/document.html', '/document.js', '/document.css']) {
    assert.equal((await get(asset)).status,200,asset);
  }
  assert.deepEqual((await readdir(project)).sort(),['CURRENT_HANDOFF.md','unrelated.json']);
});
