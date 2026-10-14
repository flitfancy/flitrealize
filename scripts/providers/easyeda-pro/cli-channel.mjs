/** Official desktop transport. Algorithms and native Action bodies stay unchanged. */
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {link,mkdir,readFile,realpath,stat,unlink,writeFile} from 'node:fs/promises';
import {delimiter,dirname,join,resolve} from 'node:path';
import {gzipSync} from 'node:zlib';

const digest=s=>createHash('sha256').update(s).digest('hex');
const shelf='__flitrealizeOfficialCliV1';
const storeCode=`const key=${JSON.stringify(shelf)};const store=globalThis[key]??= {uploads:new Map(),requests:new Map()};`;
const registry=storeCode+'const a=__CLI__.args;';
const uploadBody=`let u=store.uploads.get(a.requestId);if(!u){u={hash:a.hash,total:a.total,chunks:[]};store.uploads.set(a.requestId,u);}if(u.hash!==a.hash||u.total!==a.total)throw Error('CLI_UPLOAD_IDENTITY_MISMATCH');if(u.chunks[a.index]!==undefined&&u.chunks[a.index]!==a.chunk)throw Error('CLI_UPLOAD_CHUNK_MISMATCH');u.chunks[a.index]=a.chunk;return {staged:a.index};`;
function makeStageCode(chunk){
  const args=chunk===undefined?'__CLI__.args':`{...__CLI__.args,chunk:${JSON.stringify(chunk)}}`;
  return storeCode+`const a=${args};`+uploadBody;
}
const stageCode=makeStageCode();
const queryCode=registry+`return store.requests.get(a.requestId)??null;`;
const executeCode=registry+`
if(store.requests.has(a.requestId))return store.requests.get(a.requestId);
const u=store.uploads.get(a.requestId);if(!u||u.hash!==a.hash||u.chunks.filter(c=>typeof c==='string').length!==u.total)throw Error('CLI_UPLOAD_INCOMPLETE');
const record={requestId:a.requestId,sessionId:a.sessionId,windowId:a.sessionId,codeSha256:a.hash,status:'preparing',submittedAt:a.submittedAt,actionStarted:false};store.requests.set(a.requestId,record);
try{
const packed=Uint8Array.from(atob(u.chunks.join('')),c=>c.charCodeAt(0));const stream=new DecompressionStream('gzip'),reader=stream.readable.getReader(),writer=stream.writable.getWriter();
const decoded=(async()=>{const decoder=new TextDecoder('utf-8',{ignoreBOM:true});let text='';while(true){const item=await reader.read();if(item.done)break;text+=decoder.decode(item.value,{stream:true});}return text+decoder.decode();})();
await writer.write(packed);await writer.close();const code=await decoded;
const actual=Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(code))),v=>v.toString(16).padStart(2,'0')).join('');if(actual!==a.hash)throw Error('CLI_CODE_HASH_MISMATCH');
store.uploads.delete(a.requestId);record.status='running';record.actionStarted=true;const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;const result=await new AsyncFunction('eda','__CLI__',code)(eda,__CLI__);record.result=result??null;record.status='succeeded';}
catch(error){record.status='failed';record.error={code:error.code??'CLI_SCRIPT_ERROR',message:String(error.message??error)};}
record.completedAt=new Date().toISOString();return record;`;

export function resolveOfficialCli(explicit,{env=process.env,platform=process.platform}={}){
  const specified=explicit??env.FLITREALIZE_EASYEDA_CLI;
  if(specified){if(!/[\\/]/.test(specified))return specified;const file=resolve(specified);if(!existsSync(file))throw Object.assign(Error('Official EDA CLI executable does not exist: '+file),{code:'CLI_EXECUTABLE_MISSING'});return file;}
  const names=platform==='win32'?['lceda-pro.exe','easyeda-pro.exe']:['lceda-pro','easyeda-pro'];
  const directories=(env.PATH??env.Path??'').split(delimiter).filter(Boolean);
  if(platform==='win32')for(const base of [env.ProgramFiles,env.LOCALAPPDATA&&join(env.LOCALAPPDATA,'Programs')].filter(Boolean))for(const name of ['lceda-pro','EasyEDA-Pro'])directories.push(join(base,name));
  for(const directory of directories)for(const name of names){const file=join(directory,name);if(existsSync(file))return file;}
  throw Object.assign(Error('Specify --cli-executable or FLITREALIZE_EASYEDA_CLI for the installed desktop client.'),{code:'CLI_EXECUTABLE_MISSING'});
}

function parseEnvelope(text){
  const lines=(text??'').replace(/^\uFEFF/,'').trim().split(/\r?\n/);
  for(const line of lines.reverse())try{const result=JSON.parse(line);if(typeof result?.ok==='boolean')return result;}catch{}
  throw Object.assign(Error('Official CLI returned no JSON envelope.'),{code:'CLI_INVALID_RESULT'});
}
export function callOfficialCli(executable,args,{timeoutMs=45000,runner=spawnSync}={}){
  const completed=runner(executable,args,{encoding:'utf8',windowsHide:true,timeout:timeoutMs+2000,maxBuffer:32*1024*1024});
  let response;try{response=parseEnvelope(completed.stdout||completed.stderr);}catch(error){throw Object.assign(error,{cause:completed.error,transportUnknown:!completed.error||completed.error.code!=='ENOENT'});}
  if(completed.error)throw Object.assign(Error(completed.error.message),{code:completed.error.code??'CLI_TRANSPORT_ERROR',transportUnknown:completed.error.code!=='ENOENT',cause:completed.error});
  if(completed.status!==0||!response.ok){const detail=response.error??{};throw Object.assign(Error(detail.message??'Official CLI command failed.'),{code:detail.code??'CLI_COMMAND_FAILED',transportUnknown:/TIMEOUT|TIMEDOUT|TRANSPORT|BRIDGE|DISCONNECT|ENDPOINT|RESULT_CHANNEL/i.test(detail.code??'')});}
  return response;
}

async function requestPath(home,sessionId,requestId){
  if(typeof sessionId!=='string'||!sessionId||sessionId.length>512)throw Error('CLI_SESSION_ID_REQUIRED');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))throw Error('CLI_REQUEST_ID_MUST_BE_UUID');
  return join(home,'cli','easyeda-pro','requests',digest(sessionId),requestId+'.json');
}
const readOptional=async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
function stagePath(file,status){if(!['submitted','unknown','not-dispatched','succeeded','failed'].includes(status))throw Error('CLI_RECEIPT_STAGE_INVALID');return file.slice(0,-5)+'.'+status+'.json';}
async function readReceipt(file){
  const claim=await readOptional(file);if(!claim)return null;
  for(const status of ['succeeded','failed','not-dispatched','unknown','submitted']){
    const record=await readOptional(stagePath(file,status));
    if(record){if(record.requestId!==claim.requestId||record.sessionId!==claim.sessionId||record.codeSha256!==claim.codeSha256||record.status!==status)throw Error('CLI_RECEIPT_IDENTITY_MISMATCH');return record;}
  }
  return claim;
}
async function saveRecord(file,value,{exclusive=false}={}){
  const target=exclusive?file:stagePath(file,value.status);
  await mkdir(dirname(target),{recursive:true,mode:0o700});const temporary=target+'.'+randomUUID()+'.tmp';
  try{
    await writeFile(temporary,JSON.stringify(value)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
    try{await link(temporary,target);}catch(error){if(exclusive||error.code!=='EEXIST')throw error;const existing=await readOptional(target);if(existing?.requestId!==value.requestId||existing?.sessionId!==value.sessionId||existing?.codeSha256!==value.codeSha256||existing?.status!==value.status)throw Error('CLI_RECEIPT_IDENTITY_MISMATCH');}
  }
  finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  return target;
}
function invoke(executable,sessionId,code,args,options){return callOfficialCli(executable,['invoke','--session',sessionId,'--ext-uuid','eda','--code',code,'--args',JSON.stringify(args),'--timeout',String(options.timeoutMs)],options);}

/** Cheap identity of the selected client and its installed command implementation. */
export async function officialCliIdentity(executable){
  const file=await realpath(executable),stamp=async path=>{const s=await stat(path);return {path:await realpath(path),size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs};};
  const s=await stat(file),resources=[];
  for(const relative of ['resources/app.asar','resources/app/app.js','resources/app/package.json','resources/app/version.txt']){
    try{resources.push(await stamp(join(dirname(file),relative)));}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return {executable:file,size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,resources};
}
/** Confirm file support with inert UTF-8 source; never call an EDA API. */
export async function probeOfficialCliCodeFile(executable,{home,windowId,timeoutMs=45000,runner=spawnSync}={}){
  const options={timeoutMs,runner},base={schemaVersion:1,supported:false,status:'unconfirmed'};
  let temporary,owned=false;
  try{
    const identity=await officialCliIdentity(executable);base.identity=identity;
    const doctor=callOfficialCli(executable,['doctor'],options).value;
    base.bridgeVersion=doctor.bridgeVersion;
    if(doctor.versionMatch!==true)return{...base,reason:'CLI_VERSION_UNCONFIRMED'};
    if(!doctor.connected||doctor.resultChannel!==true)return{...base,reason:'CLI_RESULT_CHANNEL_UNAVAILABLE'};
    const sessions=callOfficialCli(executable,['session','list'],options).value;
    const alive=Array.isArray(sessions)?sessions.filter(s=>s.status==='alive'):[];
    const chosen=windowId??(alive.length===1?alive[0].sessionId:null);
    if(!chosen||!alive.some(s=>String(s.sessionId)===String(chosen)))return{...base,reason:'CLI_TARGET_SESSION_REQUIRED'};
    const marker={token:randomUUID(),unicode:'汉字α'},prefix='const marker='+JSON.stringify(marker)+';\n/*',suffix='*/\nreturn marker;';
    const code=prefix+'x'.repeat(512*1024-Buffer.byteLength(prefix+suffix,'utf8'))+suffix;
    temporary=join(home,'cli','easyeda-pro','probes','code-file-'+marker.token+'.js');
    await mkdir(dirname(temporary),{recursive:true,mode:0o700});
    await writeFile(temporary,code,{encoding:'utf8',mode:0o600,flag:'wx'});owned=true;
    const response=callOfficialCli(executable,['invoke','--session',String(chosen),'--ext-uuid','eda','--code-file',temporary,'--args','{}','--timeout',String(timeoutMs)],options).value;
    if(response?.token!==marker.token||response?.unicode!==marker.unicode)return{...base,reason:'CLI_CODE_FILE_PROBE_MISMATCH'};
    if(JSON.stringify(await officialCliIdentity(executable))!==JSON.stringify(identity))return{...base,reason:'CLI_IDENTITY_CHANGED'};
    return{...base,supported:true,status:'confirmed',maxCodeBytes:Buffer.byteLength(code,'utf8'),confirmedAt:new Date().toISOString(),probe:{sessionId:String(chosen),codeSha256:digest(code),utf8Matched:true,sdkCalls:0}};
  }catch(error){return{...base,reason:error.code??'CLI_CODE_FILE_PROBE_FAILED',message:String(error.message??error)};}
  finally{if(owned)await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')console.warn('CLI_PROBE_TEMP_CLEANUP_FAILED',temporary,error.code);});}
}

export async function confirmedFileBudget(executable,doctor,capability){
  if(capability?.schemaVersion!==1||capability.supported!==true||doctor.versionMatch!==true||capability.bridgeVersion!==doctor.bridgeVersion||!Number.isSafeInteger(capability.maxCodeBytes)||capability.maxCodeBytes<=0)return null;
  try{if(JSON.stringify(await officialCliIdentity(executable))!==JSON.stringify(capability.identity))return null;}catch{return null;}
  return Math.floor(Math.min(capability.maxCodeBytes,1024*1024)*.99);
}
async function uploadFile(executable,sessionId,chunk,metadata,claimFile,budget,remaining){
  const code=makeStageCode(chunk),temporary=claimFile.slice(0,-5)+'.upload-'+metadata.index+'.js';
  if(Buffer.byteLength(code,'utf8')>budget)throw Object.assign(Error('Upload script exceeds confirmed UTF-8 budget.'),{code:'CLI_UPLOAD_FILE_TOO_LARGE'});
  let owned=false;
  try{
    await writeFile(temporary,code,{encoding:'utf8',mode:0o600,flag:'wx'});owned=true;
    const options=remaining();
    return callOfficialCli(executable,['invoke','--session',sessionId,'--ext-uuid','eda','--code-file',temporary,'--args',JSON.stringify(metadata),'--timeout',String(options.timeoutMs)],options);
  }finally{
    if(owned)await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')console.warn('CLI_UPLOAD_TEMP_CLEANUP_FAILED',temporary,error.code);});
  }
}

export async function officialCliControl(args,{executable,home,selectedWindowId,timeoutMs=45000,runner=spawnSync,codeFileCapability}={}){
  const options={timeoutMs,runner};
  if(args.command==='request'){
    const file=await requestPath(home,args.sessionId,args.requestId),saved=await readReceipt(file);
    if(!saved)throw Object.assign(Error('No official CLI request receipt for this session and request.'),{code:'CLI_REQUEST_NOT_FOUND'});
    if(saved.status==='staging')return{success:true,channel:'cli',request:{...saved,status:'not-dispatched'},executionOutcome:'not-dispatched'};
    if(['succeeded','failed','not-dispatched'].includes(saved.status))return{success:true,channel:'cli',request:saved};
    try{const response=invoke(executable,args.sessionId,queryCode,{requestId:args.requestId},options);const current=response.value;
      if(current){if(current.requestId!==args.requestId||current.codeSha256!==saved.codeSha256||current.sessionId!==saved.sessionId)throw Error('CLI_REQUEST_IDENTITY_MISMATCH');if(['succeeded','failed'].includes(current.status))await saveRecord(file,current);return{success:true,channel:'cli',request:current};}
    }catch(error){if(error.message==='CLI_REQUEST_IDENTITY_MISMATCH')throw error;}
    return{success:true,channel:'cli',request:{...saved,status:'unknown'},executionOutcome:'unknown'};
  }
  const doctor=callOfficialCli(executable,['doctor'],options).value;
  if(doctor.versionMatch===false)throw Object.assign(Error('Official CLI and editor bridge versions differ.'),{code:'CLI_VERSION_MISMATCH'});
  const sessions=doctor.connected?callOfficialCli(executable,['session','list'],options).value:[];
  if(!Array.isArray(sessions))throw Error('CLI_SESSIONS_INVALID');
  const alive=sessions.filter(s=>s.status==='alive'),windows=alive.map(s=>({...s,windowId:String(s.sessionId)}));
  const chosen=args.windowId??selectedWindowId??(windows.length===1?windows[0].windowId:null);
  const status={status:doctor.connected?(doctor.resultChannel===false?'incompatible':'ready'):'stopped',channel:'cli',adapterId:'easyeda-pro',bridge:{service:'official-desktop-cli',endpoint:doctor.endpoint,version:doctor.bridgeVersion,versionMatch:doctor.versionMatch,resultChannel:doctor.resultChannel},eda:{id:'easyeda-pro',connected:Boolean(doctor.connected),windowCount:windows.length,activeWindowId:chosen,windows}};
  if(['status','windows','ensure'].includes(args.command)){
    if(args.command==='ensure'&&args.requireEda&&doctor.resultChannel===false)throw Object.assign(Error('Official CLI result channel is unavailable.'),{code:'CLI_RESULT_CHANNEL_UNAVAILABLE'});
    if(args.requireEda&&(!doctor.connected||!windows.length))throw Object.assign(Error('Open the target project in the desktop client, then reuse its session.'),{code:'CLI_EDITOR_NOT_CONNECTED'});
    return status;
  }
  if(!chosen||!windows.some(w=>w.windowId===String(chosen)))throw Object.assign(Error('Choose an existing official CLI session using --window-id.'),{code:'CLI_TARGET_SESSION_REQUIRED'});
  if(args.command==='select')return{...status,windowId:String(chosen),selectedWindowId:String(chosen)};
  if(args.command!=='execute')throw Error('CLI_COMMAND_UNSUPPORTED');
  if(doctor.resultChannel===false)throw Object.assign(Error('Official CLI result channel is unavailable.'),{code:'CLI_RESULT_CHANNEL_UNAVAILABLE'});
  const code=await readFile(args.codeFile,'utf8'),sessionId=String(chosen),requestId=args.requestId??randomUUID(),file=await requestPath(home,sessionId,requestId);
  const previous=await readReceipt(file);
  if(previous)throw Object.assign(Error('This request already has a receipt. Query it before submitting another execution.'),{code:'CLI_REQUEST_ALREADY_SUBMITTED',request:previous,executionOutcome:previous.status==='succeeded'||previous.status==='failed'?'known':'unknown',submissionReceipt:file});
  const record={requestId,sessionId,windowId:sessionId,codeSha256:digest(code),status:'staging',submittedAt:new Date().toISOString()};
  try{await saveRecord(file,record,{exclusive:true});}catch(error){if(error.code==='EEXIST')throw Object.assign(Error('This request already has a receipt. Query it before submitting another execution.'),{code:'CLI_REQUEST_ALREADY_SUBMITTED',request:await readReceipt(file),executionOutcome:'unknown',submissionReceipt:file});throw error;}
  const packed=gzipSync(Buffer.from(code,'utf8')).toString('base64'),budget=await confirmedFileBudget(executable,doctor,codeFileCapability);
  const width=budget===null?0:budget-Buffer.byteLength(makeStageCode(''),'utf8');
  let fileDelivery=width>0,chunks=fileDelivery?(packed.match(new RegExp('.{1,'+width+'}','g'))??['']):(packed.match(/.{1,6000}/g)??['']);
  if(fileDelivery&&chunks.some(chunk=>Buffer.byteLength(makeStageCode(chunk),'utf8')>budget)){fileDelivery=false;chunks=packed.match(/.{1,6000}/g)??[''];}
  const transport={delivery:fileDelivery?'code-file':'argument-chunks',uploadCount:chunks.length,sourceBytes:Buffer.byteLength(code,'utf8'),compressedBase64Chars:packed.length,capability:fileDelivery?'confirmed':(codeFileCapability?.reason??'unconfirmed-or-stale')};
  const deadline=Date.now()+timeoutMs;
  const remaining=()=>{const left=deadline-Date.now();if(left<=0)throw Object.assign(Error('Official CLI staging/execution budget exhausted.'),{code:'CLI_TASK_BUDGET_EXHAUSTED'});return{...options,timeoutMs:left};};
  let dispatched=false;
  try{
    for(let index=0;index<chunks.length;index++){
      const metadata={requestId,hash:record.codeSha256,total:chunks.length,index};
      if(fileDelivery)await uploadFile(executable,sessionId,chunks[index],metadata,file,budget,remaining);
      else invoke(executable,sessionId,stageCode,{...metadata,chunk:chunks[index]},remaining());
    }
    remaining();record.status='submitted';await saveRecord(file,record);const executionOptions=remaining();dispatched=true;
    const response=invoke(executable,sessionId,executeCode,{requestId,hash:record.codeSha256,sessionId,submittedAt:record.submittedAt},executionOptions),current=response.value;
    if(!current||current.codeSha256!==record.codeSha256||current.sessionId!==sessionId||current.requestId!==requestId)throw Object.assign(Error('Official CLI execution identity mismatch.'),{code:'CLI_REQUEST_IDENTITY_MISMATCH',transportUnknown:true});
    const receipt=await saveRecord(file,current);
    if(current.status==='failed')throw Object.assign(Error(current.error.message),{code:current.error.code,request:current,executionOutcome:'known',submissionReceipt:receipt});
    if(current.status!=='succeeded')throw Object.assign(Error('Official CLI execution is still unresolved.'),{code:'CLI_EXECUTION_UNKNOWN',transportUnknown:true});
    return{success:true,status:'executed',channel:'cli',sessionId,windowId:sessionId,result:current.result,request:current,submissionReceipt:receipt,claimReceipt:file,transport,logs:response.logs??[]};
  }catch(error){
    if(error.executionOutcome==='known')throw error;
    record.status=dispatched?'unknown':'not-dispatched';record.error={code:error.code??'CLI_CHANNEL_ERROR',message:error.message};const receipt=await saveRecord(file,record);
    throw Object.assign(error,{request:record,executionOutcome:dispatched?'unknown':'not-dispatched',submissionReceipt:receipt,claimReceipt:file,requestPersisted:true});
  }
}
