import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bridgeState,readBridge} from '../lib/bridge.mjs';
const session={sessionId:'active'};
const health={service:'easyeda-bridge',protocolVersion:2,tokenRequired:true,sessionId:'active',edaConnected:true};

test('connected means matching live bridge protocol, session and EDA',()=>{
  assert.equal(bridgeState(session,health),'ready');
  assert.equal(bridgeState(session,{...health,edaConnected:false}),'bridge-ready');
  assert.equal(bridgeState(session,{...health,sessionId:'old'}),'session-mismatch');
  assert.equal(bridgeState(session,{...health,protocolVersion:1}),'incompatible');
  assert.equal(bridgeState(session,{...health,service:'other'}),'unknown');
  assert.equal(bridgeState(session,null),'unknown');
});
test('only health is requested; tokens never sent or returned; stale sessions are not connected',async t=>{
  const home=await mkdtemp(join(tmpdir(),'view-state-bridge-'));
  let received;
  const server=createServer((req,res)=>{received={path:req.url,auth:req.headers.authorization};res.setHeader('Content-Type','application/json');res.end(JSON.stringify(health));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});});
  assert.equal((await readBridge(home)).state,'unknown');
  const dir=join(home,'bridge','easyeda-pro');await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'session.json'),JSON.stringify({...session,port:server.address().port,token:'secret-sentinel'}));
  const result=await readBridge(home);
  assert.equal(result.state,'ready'); assert.deepEqual(received,{path:'/health',auth:undefined});
  assert.doesNotMatch(JSON.stringify(result),/secret-sentinel/);
  await new Promise(resolve=>server.close(resolve));
  assert.equal((await readBridge(home)).state,'unreachable');
});
