import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {EventEmitter} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
import {PassThrough} from 'node:stream';
import {test} from 'node:test';
import {runPythonJson} from '../../scripts/lib/pcb-python.mjs';

// Real streams make the byte boundaries deterministic without Python or sleeps.
function pythonProcess(t) {
  const child=new EventEmitter();
  child.stdout=new PassThrough();
  child.stderr=new PassThrough();
  child.stdin=new PassThrough();
  child.kill=()=>{child.killed=true;return true;};
  const stub=t.mock.method(cp,'spawn',()=>child);
  syncBuiltinESMExports();
  t.after(()=>{
    stub.mock.restore();
    syncBuiltinESMExports();
    child.stdout.destroy();child.stderr.destroy();child.stdin.destroy();
  });
  return child;
}

function writeBytes(stream,text) {
  for(const byte of Buffer.from(text,'utf8'))stream.write(Buffer.from([byte]));
}

function close(child,code=0) {
  child.stdout.end();child.stderr.end();child.emit('close',code);
}

test('Python JSON preserves split UTF-8 paths and progress across byte and line boundaries',async t=>{
  const child=pythonProcess(t),progress=[];
  const pending=runPythonJson('fixture.py',undefined,{python:'fixture-python',log:value=>progress.push(value)});
  const update={progress:1,message:'预走线中'};
  const result={resultFile:'项目/中文目录/结果😀.json'};
  writeBytes(child.stdout,JSON.stringify(update)+'\r\n'+JSON.stringify(result));
  close(child);
  assert.deepEqual(await pending,result);
  assert.deepEqual(progress,[update]);
});

test('Python errors preserve split UTF-8 diagnostics and the nonzero exit result',async t=>{
  const child=pythonProcess(t);
  const pending=runPythonJson('fixture.py',undefined,{python:'fixture-python'});
  const result={error:'读取结果失败'},diagnostic='无法读取中文目录中的结果😀';
  writeBytes(child.stdout,JSON.stringify(result)+'\n');
  writeBytes(child.stderr,diagnostic);
  close(child,7);
  await assert.rejects(pending,error=>{
    assert.equal(error.message,'PCB_PYTHON_FAILED: '+diagnostic);
    assert.equal(error.exitCode,7);
    assert.deepEqual(error.result,result);
    return true;
  });
});

test('Python output limits count UTF-8 bytes and accept the exact boundary',async t=>{
  const child=pythonProcess(t),result={path:'中😀'},output=JSON.stringify(result)+'\n';
  const pending=runPythonJson('fixture.py',undefined,{python:'fixture-python',maxOutputBytes:Buffer.byteLength(output)});
  writeBytes(child.stdout,output);
  close(child);
  assert.deepEqual(await pending,result);
  assert.notEqual(child.killed,true);
});

test('Python output still rejects UTF-8 output one byte over the limit',async t=>{
  const child=pythonProcess(t),output=JSON.stringify({path:'中😀'})+'\n';
  const pending=runPythonJson('fixture.py',undefined,{python:'fixture-python',maxOutputBytes:Buffer.byteLength(output)-1});
  writeBytes(child.stdout,output);
  close(child);
  await assert.rejects(pending,/PCB_PYTHON_OUTPUT_LIMIT/);
  assert.equal(child.killed,true);
});
