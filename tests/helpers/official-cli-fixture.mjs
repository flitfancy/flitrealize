// Isolated CLI renderer fixture: no EDA, network or user profile access.
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1],file=process.env.CLI_FIXTURE_STATE;
const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{uploads:[],requests:[],executions:0,calls:[]};
const mode=process.env.CLI_FIXTURE_MODE??'normal';
state.calls.push({command:args[0],length:args.join(' ').length,session:get('--session')});
const emit=(value,error)=>{fs.writeFileSync(file,JSON.stringify(state));let text=JSON.stringify(error?{ok:false,error}:{ok:true,value});
 if(mode==='split-utf8'){const bytes=Buffer.from(text),index=bytes.findIndex(byte=>byte>127);if(index>=0)text=bytes.subarray(0,index+1).toString('utf8')+bytes.subarray(index+1).toString('utf8');}
 console.log(text);if(error)process.exitCode=1;};
if(args[0]==='doctor')emit({connected:mode!=='disconnected',endpoint:'fixture',versionMatch:mode!=='mismatch',bridgeVersion:'fixture-version',resultChannel:mode!=='no-result-channel'});
else if(args[0]==='session')emit((mode==='ambiguous'?['A','B']:['A']).map(sessionId=>({sessionId,status:'alive',origin:'user'})));
else if(args[0]==='invoke'){
 const codeFile=args.includes('--code-file')?get('--code-file'):null,code=codeFile?fs.readFileSync(codeFile,'utf8'):get('--code');
 state.calls.at(-1).codeFile=codeFile;state.calls.at(-1).codeBytes=Buffer.byteLength(code,'utf8');
 if(codeFile&&Buffer.byteLength(code,'utf8')>1024*1024)throw Error('Fixture code-file exceeds SDK limit');
 if(codeFile&&mode==='no-code-file')emit(null,{code:'CLI_CODE_FILE_UNSUPPORTED',message:'File invocation is not supported'});
 else if(mode==='fail-stage'&&code.includes('CLI_UPLOAD_IDENTITY_MISMATCH'))emit(null,{code:'RESULT_CHANNEL_TIMEOUT',message:'Lost staging reply'});
 else{
  const store={uploads:new Map(state.uploads),requests:new Map(state.requests)};
  const context=vm.createContext({Map,Uint8Array,TextDecoder,TextEncoder,DecompressionStream,atob,crypto:webcrypto,console,Date,setTimeout,__CLI__:{args:JSON.parse(get('--args'))},eda:{probe:()=>{state.executions++;return state.executions;},pcb_PrimitiveComponent:{modify:async()=>{state.applies=(state.applies??0)+1;return true;}},dmt_EditorControl:{saveDocument:async()=>{state.saves=(state.saves??0)+1;return true;}}}});
  context.__flitrealizeOfficialCliV1=store;
  try{const value=await new vm.Script(`(async function(){${code}\n})()`).runInContext(context);state.uploads=[...store.uploads];state.requests=[...store.requests];
   if(mode==='lose-stage'&&code.includes('CLI_UPLOAD_IDENTITY_MISMATCH'))emit(null,{code:'RESULT_CHANNEL_TIMEOUT',message:'Reply lost after staging'});
   else if(['lose-execute','wrong-query'].includes(mode)&&code.includes('actionStarted'))emit(null,{code:'RESULT_CHANNEL_TIMEOUT',message:'Reply lost after execution'});
   else if(mode==='wrong-query'&&code.includes('store.requests.get(a.requestId)??null'))emit({...value,requestId:'00000000-0000-4000-8000-000000000000'});
   else emit(value);
  }catch(error){state.uploads=[...store.uploads];state.requests=[...store.requests];emit(null,{code:'EXECUTION_ERROR',message:error.message});}
 }
}else emit(null,{code:'FIXTURE_COMMAND',message:args[0]});
