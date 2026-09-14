import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// Isolated fake adapter: never changes the real host profile or contacts EasyEDA.
const scratch=await mkdtemp(join(tmpdir(),'flitrealize-host-output-'));
try {
  const adapter=join(scratch,'adapter');
  await mkdir(join(adapter,'scripts'),{recursive:true});
  await writeFile(join(adapter,'package.json'),JSON.stringify({name:'test-adapter'}));
  await writeFile(join(adapter,'scripts','bridge-control.mjs'),
    'process.stdout.write(JSON.stringify({success:true,result:{source:"x".repeat(2*1024*1024)}})+"\\n");');
  const host=fileURLToPath(new URL('../scripts/eda-host.mjs',import.meta.url));
  const invoke=args=>spawnSync(process.execPath,[host,...args],{encoding:'utf8',windowsHide:true,
    env:{...process.env,FLITREALIZE_HOME:join(scratch,'profile')},maxBuffer:4*1024*1024});
  const registered=invoke(['register','--eda','easyeda-pro','--adapter-root',adapter]);
  assert.equal(registered.status,0,registered.stderr);
  const code=join(scratch,'action.js');
  await writeFile(code,'return {success:true};');
  const result=invoke(['execute','--eda','easyeda-pro','--code-file',code]);
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).result.source.length,2*1024*1024);
} finally {
  await rm(scratch,{recursive:true,force:true});
}
console.log('EDA host large-output tests passed');
