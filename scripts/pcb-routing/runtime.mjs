import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
const exec=promisify(execFile);
export const FR_VERSION='2.4.1';
export const JAR_SHA256='251101c3eeac22d7e7dfcf6796603279e5d1000283eb82d8f093780f7afc6aa9';
export function runtimeCache({env=process.env,platform=process.platform,home=os.homedir()}={}){
 const root=env.FLITREALIZE_RUNTIME_DIR??(platform==='win32'?path.join(env.LOCALAPPDATA??path.join(home,'AppData','Local'),'FlitRealize','runtimes'):platform==='darwin'?path.join(home,'Library','Caches','FlitRealize'):path.join(env.XDG_CACHE_HOME??path.join(home,'.cache'),'flitrealize','runtimes'));
 return path.resolve(root,'freerouting',FR_VERSION);
}
export async function fileHash(file){const h=createHash('sha256');for await(const bytes of createReadStream(file))h.update(bytes);return h.digest('hex');}
export async function javaVersion(javaExe){const r=await exec(javaExe,['-version'],{windowsHide:true,timeout:10000});const text=r.stdout+r.stderr,major=Number(text.match(/version\s+"(\d+)/)?.[1]);if(major<25||!Number.isInteger(major))throw Error('JAVA_25_REQUIRED');return major;}
async function download(url,file,hash){
 const response=await fetch(url,{headers:{'User-Agent':'FlitRealize-routing'},signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error('DOWNLOAD_HTTP_'+response.status);
 const h=createHash('sha256'),meter=new Transform({transform(bytes,_encoding,done){h.update(bytes);done(null,bytes);}});
 await pipeline(Readable.fromWeb(response.body),meter,createWriteStream(file+'.part'));
 if(h.digest('hex')!==hash)throw Error('RUNTIME_CHECKSUM_MISMATCH');await fs.rename(file+'.part',file);
}
async function findJava(root,depth=0){if(depth>4)return null;const name=process.platform==='win32'?'java.exe':'java';try{const file=path.join(root,'bin',name);if((await fs.stat(file)).isFile())return file;}catch{}for(const entry of await fs.readdir(root,{withFileTypes:true}))if(entry.isDirectory()){const found=await findJava(path.join(root,entry.name),depth+1);if(found)return found;}return null;}
export async function ensureRuntime({runtimeFile=null,cache=runtimeCache(),install=false}={}){
 let configured;
 try{configured=JSON.parse(await fs.readFile(runtimeFile??path.join(cache,'runtime.json'),'utf8'));}catch(error){if(runtimeFile||error.code!=='ENOENT')throw error;}
 if(configured){if(configured.freeroutingVersion!==FR_VERSION||await fileHash(configured.jarPath)!==JAR_SHA256)throw Error('RUNTIME_CHECKSUM_MISMATCH');await javaVersion(configured.javaExe);return configured;}
 if(!install)throw Error('RUNTIME_SETUP_REQUIRED');
 await fs.mkdir(cache,{recursive:true});const jarPath=path.join(cache,'freerouting-'+FR_VERSION+'.jar');
 try{if(await fileHash(jarPath)!==JAR_SHA256)throw Error('CHECKSUM');}catch{await download('https://github.com/freerouting/freerouting/releases/download/v'+FR_VERSION+'/freerouting-'+FR_VERSION+'.jar',jarPath,JAR_SHA256);}
 let javaExe=process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java';
 try{await javaVersion(javaExe);}catch{
  const platform={win32:'windows',darwin:'mac',linux:'linux'}[process.platform],arch={x64:'x64',arm64:'aarch64'}[process.arch];if(!platform||!arch)throw Error('JRE_PLATFORM_UNSUPPORTED');
  const response=await fetch('https://api.adoptium.net/v3/assets/latest/25/hotspot?architecture='+arch+'&image_type=jre&jvm_impl=hotspot&os='+platform,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('JRE_METADATA_UNAVAILABLE');
  const pkg=(await response.json())[0]?.binary?.package;if(!pkg||!/^https:\/\/github\.com\/adoptium\/temurin25-binaries\//.test(pkg.link)||!/^\w[\w.+-]+\.(zip|tar\.gz)$/.test(pkg.name)||!/^[a-f0-9]{64}$/.test(pkg.checksum))throw Error('JRE_METADATA_INVALID');
  const archive=path.join(cache,pkg.name),destination=path.join(cache,'java25');await download(pkg.link,archive,pkg.checksum);await fs.mkdir(destination,{recursive:true});
  if(!(await fs.realpath(destination)).startsWith((await fs.realpath(cache))+path.sep))throw Error('EXTRACTION_OUTSIDE_CACHE');
  if(process.platform==='win32')await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:FLIT_ROUTING_ARCHIVE -DestinationPath $env:FLIT_ROUTING_EXTRACT -Force'],{env:{...process.env,FLIT_ROUTING_ARCHIVE:archive,FLIT_ROUTING_EXTRACT:destination},windowsHide:true,timeout:120000});
  else await exec('tar',['-xzf',archive,'-C',destination],{timeout:120000});
  javaExe=await findJava(destination);if(!javaExe)throw Error('EXTRACTED_JAVA_MISSING');await javaVersion(javaExe);
 }
 const result={freeroutingVersion:FR_VERSION,jarPath,jarSha256:JAR_SHA256,javaExe,localOnly:true};await fs.writeFile(path.join(cache,'runtime.json'),JSON.stringify(result,null,2)+'\n');return result;
}
export async function runRouter(runtime,{input,output,result,log,layers,layerOrder,ignoredClasses=[],maxPasses=5,optimize=true,fanout=false,heap='2g',timeoutMs=180000}){
 if(!/^\d+[mg]$/i.test(heap)||parseInt(heap)<=0)throw Error('INVALID_HEAP_LIMIT');
 if(!Number.isInteger(maxPasses)||maxPasses<1||!Number.isFinite(timeoutMs)||timeoutMs<=0)throw Error('INVALID_ROUTER_BUDGET');
 if(!Array.isArray(ignoredClasses)||ignoredClasses.some(n=>typeof n!=='string'||n.startsWith('-')||n.includes(',')))throw Error('INVALID_IGNORED_NET_CLASSES');
 const args=['-Xmx'+heap,'-Djava.awt.headless=true','-jar',runtime.jarPath,'-de',input,'-do',output,'-mp',String(maxPasses),'--gui.enabled=false','--api_server.enabled=false','--profile.allow_telemetry=false','--usage_and_diagnostic_data.disable_analytics=true','--user_data_path='+path.join(path.dirname(output),'fr-state'),'--router.result_json='+result,'--router.layers.routable='+layerOrder.map(l=>layers.includes(l)).join(','),'--router.optimizer.enabled='+optimize,'--router.fanout.enabled='+fanout,'--router.automatic_neckdown=false'];
 if(ignoredClasses.length)args.push('-inc',ignoredClasses.join(','));
 args.push('--router.strict_drc=true');
 const started=performance.now();try{const r=await exec(runtime.javaExe,args,{windowsHide:true,timeout:timeoutMs,maxBuffer:4*1024*1024});await fs.writeFile(log,r.stdout+r.stderr);}catch(error){await fs.writeFile(log,(error.stdout??'')+(error.stderr??''));throw error;}
 const report=JSON.parse(await fs.readFile(result,'utf8'));if(report.final_state!=='COMPLETED'||!report.output_written)throw Error('ROUTER_DID_NOT_COMPLETE');return{seconds:(performance.now()-started)/1000,report};
}
