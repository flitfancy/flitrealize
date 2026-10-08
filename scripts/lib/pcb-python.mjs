import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {flitHome} from './state-paths.mjs';

/** The numerical runtime is host configuration, never a project or skill path. */
export function resolvePcbPython({python,env=process.env}={}) {
  const configured=python??env.FLITREALIZE_PCB_PYTHON;
  if(configured)return configured;
  const runtime=path.join(flitHome({env}),'runtimes','cpsat');
  const candidate=process.platform==='win32'?path.join(runtime,'Scripts','python.exe'):path.join(runtime,'bin','python');
  if(existsSync(candidate))return candidate;
  throw Error('PCB_PYTHON_RUNTIME_REQUIRED: pass --python or configure FLITREALIZE_PCB_PYTHON with numpy/ortools as required by the selected operation');
}

/** One offline job per process; importers do not start Python or change EDA. */
export async function runPythonJson(script,input,{python,args=[],timeoutMs=180000,log=()=>{},maxOutputBytes=64*1024*1024}={}) {
  if(!Number.isFinite(timeoutMs)||timeoutMs<1)throw Error('INVALID_PYTHON_TIMEOUT');
  const executable=resolvePcbPython({python});
  return await new Promise((resolve,reject)=>{
    const child=spawn(executable,['-X','utf8','-B',script,...args],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='',pending='',settled=false;
    const fail=error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);};
    const timer=setTimeout(()=>{child.kill();fail(Error('PCB_PYTHON_TIMEOUT'));},timeoutMs);
    child.on('error',fail);
    child.stdout.on('data',chunk=>{
      const text=chunk.toString();stdout+=text;pending+=text;
      if(Buffer.byteLength(stdout)>maxOutputBytes){child.kill();fail(Error('PCB_PYTHON_OUTPUT_LIMIT'));return;}
      const lines=pending.split(/\r?\n/);pending=lines.pop();
      for(const line of lines){try{const value=JSON.parse(line);if(value.progress||value.event)log(value);}catch{}}
    });
    child.stderr.on('data',chunk=>{stderr+=chunk.toString();if(stderr.length>65536)stderr=stderr.slice(-65536);});
    child.on('close',code=>{
      if(settled)return;clearTimeout(timer);settled=true;
      const values=[];for(const line of stdout.trim().split(/\r?\n/)){try{values.push(JSON.parse(line));}catch{}}
      if(code!==0){const error=Error('PCB_PYTHON_FAILED: '+(stderr.trim()||values.at(-1)?.error||'exit '+code));error.exitCode=code;error.result=values.at(-1);reject(error);return;}
      if(!values.length){reject(Error('PCB_PYTHON_JSON_RESULT_REQUIRED'));return;}
      resolve(values.at(-1));
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(input===undefined?'':JSON.stringify(input));
  });
}
