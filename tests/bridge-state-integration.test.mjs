import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root=fileURLToPath(new URL('..',import.meta.url));
const adapter=join(root,'adapters','easyeda-pro');
const serverScript=join(adapter,'scripts','bridge-server.mjs');
const controlScript=join(adapter,'scripts','bridge-control.mjs');
const viewModule=pathToFileURL(join(root,'view-state','lib','bridge.mjs')).href;
const envKeys=['FLITREALIZE_HOME','FLITREALIZE_BRIDGE_STATE_DIR','FLITREALIZE_EDA_CHANNEL','FLITREALIZE_EASYEDA_CLI','LOCALAPPDATA','XDG_RUNTIME_DIR','XDG_STATE_HOME','XDG_CONFIG_HOME','NODE_OPTIONS'];

async function freePort() {
  const socket=createServer();
  await new Promise((done,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',done);});
  const port=socket.address().port;
  await new Promise(done=>socket.close(done));
  return port;
}

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'flitrealize-bridge-paths-'));
  const pidFile=join(dir,'test-server.pid');
  const preloader=join(dir,'linux-preload.mjs');
  // Exercise the Linux selection branch on every CI host. Filesystem and child
  // processes remain native; this is not a claim of a native Linux run.
  await writeFile(preloader,`import {writeFileSync} from 'node:fs';\nObject.defineProperty(process,'platform',{value:'linux'});\nif(process.argv[1]===${JSON.stringify(serverScript)})writeFileSync(${JSON.stringify(pidFile)},String(process.pid));\n`);
  const env={...process.env};
  for(const key of envKeys) delete env[key];
  const port=await freePort();
  Object.assign(env,{
    HOME:join(dir,'user'),USERPROFILE:join(dir,'user'),
    XDG_RUNTIME_DIR:join(dir,'runtime'),XDG_STATE_HOME:join(dir,'state'),XDG_CONFIG_HOME:join(dir,'config'),
    EASYEDA_BRIDGE_PORT_START:String(port),EASYEDA_BRIDGE_PORT_END:String(port),
    NODE_OPTIONS:'--import='+pathToFileURL(preloader).href,
  });
  const children=[];
  const cleanupDirs=[dir];
  t.after(async()=>{
    for(const child of children) {
      if(child.exitCode!==null||child.signalCode!==null) continue;
      await new Promise(done=>{child.once('exit',done);child.kill();});
    }
    // The preload writes only the PID of a Bridge launched by this fixture,
    // including control's detached child. Never discover or kill other Bridges.
    const pid=Number(await readFile(pidFile,'utf8').catch(()=>''));
    if(Number.isInteger(pid)&&pid>0&&!children.some(child=>child.pid===pid)) {
      try {process.kill(pid);} catch(error) {if(error.code!=='ESRCH')throw error;}
      for(let i=0;i<100;i++) {
        try {process.kill(pid,0);} catch(error) {if(error.code==='ESRCH')break;throw error;}
        await delay(20);
      }
    }
    for(const path of cleanupDirs) await rm(path,{recursive:true,force:true,maxRetries:10,retryDelay:50});
  });
  function child(args) {
    const process_=spawn(process.execPath,args,{cwd:dir,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    children.push(process_);
    return process_;
  }
  async function run(args) {
    const process_=child(args);
    let stdout='',stderr='';
    process_.stdout.on('data',chunk=>{stdout+=chunk;});
    process_.stderr.on('data',chunk=>{stderr+=chunk;});
    const code=await new Promise((done,reject)=>{
      const timer=setTimeout(()=>{process_.kill();reject(new Error('Test child timed out'));},15000);
      process_.once('error',error=>{clearTimeout(timer);reject(error);});
      process_.once('exit',code=>{clearTimeout(timer);done(code);});
    });
    return {code,stdout,stderr};
  }
  async function control(command='status') {
    const output=await run([controlScript,command,'--json']);
    assert.equal(output.code,0,output.stderr);
    return JSON.parse(output.stdout);
  }
  async function view(home) {
    const output=await run(['--input-type=module','--eval',`import {readBridge} from ${JSON.stringify(viewModule)};console.log(JSON.stringify(await readBridge(${home===undefined?'':JSON.stringify(home)})));`]);
    assert.equal(output.code,0,output.stderr);
    return JSON.parse(output.stdout);
  }
  async function start() {
    const process_=child([serverScript]);
    let output='',started;
    process_.stdout.on('data',chunk=>{
      output+=chunk;
      for(const line of output.split('\n')) {
        try {const data=JSON.parse(line);if(data.status==='started')started=data;} catch {}
      }
    });
    process_.stderr.resume();
    for(let i=0;i<100;i++) {
      if(started) {
        try {
          const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(300)});
          const health=await response.json();
          if(response.ok&&health.service==='easyeda-bridge'&&health.sessionId===started.sessionId)return;
        } catch {}
      }
      if(process_.exitCode!==null)throw new Error('Isolated Bridge failed to start (install adapter dependencies with npm ci --prefix adapters/easyeda-pro)');
      await delay(30);
    }
    throw new Error('Isolated Bridge startup timed out');
  }
  return {dir,env,port,cleanupDirs,child,run,control,view,start};
}

const cases=[
  ['Linux runtime directory',f=>join(f.env.XDG_RUNTIME_DIR,'flitrealize','bridge','easyeda-pro')],
  ['Linux XDG state directory',f=>{delete f.env.XDG_RUNTIME_DIR;return join(f.env.XDG_STATE_HOME,'flitrealize','bridge','easyeda-pro');}],
  ['FLITREALIZE_HOME before platform defaults',f=>{f.env.FLITREALIZE_HOME=join(f.dir,'home');return join(f.env.FLITREALIZE_HOME,'bridge','easyeda-pro');}],
  ['Bridge override before FLITREALIZE_HOME',f=>{f.env.FLITREALIZE_HOME=join(f.dir,'home');f.env.FLITREALIZE_BRIDGE_STATE_DIR=join(f.dir,'override');return f.env.FLITREALIZE_BRIDGE_STATE_DIR;}],
];
for(const [name,configure] of cases) {
  test(`${name}: real server, control and default View State share a session`,async t=>{
    const f=await fixture(t);
    const stateDir=configure(f);
    await f.start();
    const status=await f.control();
    assert.equal(status.status,'bridge-ready');
    const session=JSON.parse(await readFile(join(stateDir,'session.json'),'utf8'));
    assert.equal(status.bridge.sessionId,session.sessionId);
    assert.equal(status.bridge.port,f.port);
    const view=await f.view();
    assert.equal(view.state,'bridge-ready');
    assert.equal(view.port,f.port);
    assert.equal(JSON.stringify({status,view}).includes(session.token),false);
    // An explicit home must override the environment's live Bridge location.
    assert.equal((await f.view(join(f.dir,'explicit-empty-home'))).state,'unknown');
  });
}

for(const [entry,variable] of [
  ['control','FLITREALIZE_BRIDGE_STATE_DIR'],
  ['eda-host','FLITREALIZE_BRIDGE_STATE_DIR'],
  ['eda-host','FLITREALIZE_HOME'],
]) {
  test(`${entry} ensure keeps relative ${variable} anchored to its caller`,async t=>{
    const f=await fixture(t);
    const name=basename(f.dir)+'-relative';
    f.env[variable]=name;
    // Reserve both possible locations so a regression can be cleaned up safely.
    const misplaced=resolve(adapter,name);
    await mkdir(misplaced);
    f.cleanupDirs.unshift(misplaced);
    let status;
    if(entry==='control') status=await f.control('ensure');
    else {
      const hostScript=join(root,'scripts','eda-host.mjs');
      const registered=await f.run([hostScript,'register','--eda','easyeda-pro','--adapter-root',adapter]);
      assert.equal(registered.code,0,registered.stderr);
      const ensured=await f.run([hostScript,'ensure','--eda','easyeda-pro']);
      assert.equal(ensured.code,0,ensured.stderr);
      status=JSON.parse(ensured.stdout);
    }
    assert.equal(status.status,'bridge-ready');
    const stateDir=variable==='FLITREALIZE_HOME'?join(f.dir,name,'bridge','easyeda-pro'):join(f.dir,name);
    const session=JSON.parse(await readFile(join(stateDir,'session.json'),'utf8'));
    assert.equal(status.bridge.sessionId,session.sessionId);
    assert.equal((await f.view()).state,'bridge-ready');
  });
}

test('View State HTTP server uses the default shared Bridge path without --home',async t=>{
  const f=await fixture(t);
  await f.start();
  const view=f.child([join(root,'view-state','server.mjs'),'--port','0','--project-root',f.dir]);
  view.stderr.resume();
  const url=await new Promise((done,reject)=>{
    let output='';
    const timer=setTimeout(()=>reject(new Error('View State startup timed out')),10000);
    view.once('error',error=>{clearTimeout(timer);reject(error);});
    view.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);done(JSON.parse(output.split('\n')[0]).url);}});
  });
  const response=await fetch(new URL('/api/status',url));
  assert.equal(response.status,200);
  const status=await response.json();
  assert.equal(status.bridge.state,'bridge-ready');
  assert.equal(status.bridge.port,f.port);
});

test('action-runner preserves caller-relative paths through eda-host and its adapter',async t=>{
  const f=await fixture(t);
  f.env.FLITREALIZE_HOME='relative-home';
  f.env.FLITREALIZE_BRIDGE_STATE_DIR='relative-bridge';
  const fakeAdapter=join(f.dir,'adapter');
  await mkdir(join(fakeAdapter,'scripts'),{recursive:true});
  await writeFile(join(fakeAdapter,'package.json'),JSON.stringify({name:'test-state-path-adapter',version:'1.0.0'}));
  // Report only the two public directory settings, never the inherited env.
  await writeFile(join(fakeAdapter,'scripts','bridge-control.mjs'),`
    console.log(JSON.stringify({success:true,result:{status:'inspected',readOnly:true,
      home:process.env.FLITREALIZE_HOME,stateDir:process.env.FLITREALIZE_BRIDGE_STATE_DIR}}));
  `);
  const registered=await f.run([join(root,'scripts','eda-host.mjs'),'register','--eda','easyeda-pro','--adapter-root',fakeAdapter]);
  assert.equal(registered.code,0,registered.stderr);
  const reportFile=join(f.dir,'action-report.json');
  const action=await f.run([join(root,'scripts','action-runner.mjs'),'run','--action','eda-capabilities','--eda','easyeda-pro','--report-file',reportFile]);
  assert.equal(action.code,0,action.stderr);
  const report=JSON.parse(await readFile(reportFile,'utf8'));
  assert.equal(report.mutates,false);
  assert.equal(report.response.result.home,join(f.dir,'relative-home'));
  assert.equal(report.response.result.stateDir,join(f.dir,'relative-bridge'));
});
