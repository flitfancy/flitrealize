import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
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
  assert.equal((await readBridge(home,{env:{}})).state,'unknown');
  const dir=join(home,'bridge','easyeda-pro');await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'session.json'),JSON.stringify({...session,port:server.address().port,token:'secret-sentinel'}));
  const result=await readBridge(home,{env:{}});
  assert.equal(result.state,'ready'); assert.deepEqual(received,{path:'/health',auth:undefined});
  assert.doesNotMatch(JSON.stringify(result),/secret-sentinel/);
  await new Promise(resolve=>server.close(resolve));
  assert.equal((await readBridge(home,{env:{}})).state,'unreachable');
});

function doctorRunner(value,calls) {
  return (executable,args)=>{calls.push({executable,args});return {status:0,stdout:JSON.stringify({ok:true,value}),stderr:''};};
}
test('CLI selection reads doctor only and returns no profile, executable or doctor secrets',async t=>{
  const home=await mkdtemp(join(tmpdir(),'view-state-cli-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await writeFile(join(home,'host.json'),JSON.stringify({schemaVersion:1,hostId:'private-host',token:'profile-secret',adapters:{'easyeda-pro':{channel:'cli',cliExecutable:process.execPath,selectedWindowId:'private-session',token:'adapter-secret'}}}));
  const before=await readFile(join(home,'host.json'),'utf8');
  const calls=[];
  const result=await readBridge(home,{env:{},runner:doctorRunner({connected:true,versionMatch:true,resultChannel:true,token:'doctor-secret',endpoint:'private-endpoint'},calls)});
  assert.deepEqual(calls,[{executable:process.execPath,args:['doctor']}]);
  assert.deepEqual(Object.keys(result).sort(),['channel','checkedAt','state']);
  assert.equal(result.channel,'cli');assert.equal(result.state,'ready');assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  assert.doesNotMatch(JSON.stringify(result),/profile-secret|adapter-secret|doctor-secret|private-host|private-session|private-endpoint/);
  assert.equal(await readFile(join(home,'host.json'),'utf8'),before);
});
test('CLI compatibility and disconnected status reflect doctor without selecting a session',async t=>{
  const home=await mkdtemp(join(tmpdir(),'view-state-cli-state-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await writeFile(join(home,'host.json'),JSON.stringify({adapters:{'easyeda-pro':{channel:'cli',cliExecutable:process.execPath}}}));
  for(const [doctor,state] of [[{connected:true,versionMatch:false,resultChannel:true},'incompatible'],[{connected:true,versionMatch:true,resultChannel:false},'incompatible'],[{connected:false,versionMatch:true,resultChannel:true},'stopped'],[{},'unknown']]){
    const calls=[],result=await readBridge(home,{env:{},runner:doctorRunner(doctor,calls)});
    assert.equal(result.state,state);assert.equal(calls.length,1);assert.deepEqual(calls[0].args,['doctor']);
  }
});
test('environment channel/executable precedence never switches a registered channel',async t=>{
  const home=await mkdtemp(join(tmpdir(),'view-state-channel-precedence-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await writeFile(join(home,'host.json'),JSON.stringify({adapters:{'easyeda-pro':{channel:'bridge',cliExecutable:'missing-profile-executable'}}}));
  const calls=[];
  const cli=await readBridge(undefined,{env:{FLITREALIZE_HOME:home,FLITREALIZE_EDA_CHANNEL:'cli',FLITREALIZE_EASYEDA_CLI:process.execPath},runner:doctorRunner({connected:true},calls)});
  assert.equal(cli.channel,'cli');assert.equal(cli.state,'ready');assert.equal(calls[0].executable,process.execPath);
  await writeFile(join(home,'host.json'),JSON.stringify({adapters:{'easyeda-pro':{channel:'cli',cliExecutable:process.execPath}}}));
  const bridge=await readBridge(home,{env:{FLITREALIZE_EDA_CHANNEL:'bridge'},runner:()=>{throw Error('DOCTOR_MUST_NOT_RUN');}});
  assert.equal(bridge.channel,'bridge');assert.equal(bridge.state,'unknown');
});
