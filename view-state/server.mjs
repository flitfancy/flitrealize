#!/usr/bin/env node
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULT_PORT,LISTEN_HOST} from './config.mjs';
import {readProject,readDocument} from './lib/project.mjs';
import {flitHome,readBridge} from './lib/bridge.mjs';

const PUBLIC = fileURLToPath(new URL('./public/',import.meta.url));
const MIME = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript'};
const args = {port:DEFAULT_PORT,home:flitHome(),projectRoot:null};
for(let i=2;i<process.argv.length;i++) {
  const flag=process.argv[i];
  if(flag==='--port') args.port=Number(process.argv[++i]);
  else if(flag==='--home') args.home=process.argv[++i];
  else if(flag==='--project-root') args.projectRoot=process.argv[++i];
  else if(flag==='--help') { console.log('node server.mjs [--project-root PATH] [--port 49700] [--home PATH]'); process.exit(0); }
  else throw new Error('Unknown argument: '+flag);
}
function json(res,status,data) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(data));
}
const server=createServer(async(req,res)=>{
  try {
    if(req.method!=='GET') return json(res,405,{error:'READ_ONLY',message:'只支持读取'});
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/api/health') return json(res,200,{service:'flitrealize-view-state',schemaVersion:1,readOnly:true});
    const root=url.searchParams.get('projectRoot') || args.projectRoot;
    if(url.pathname==='/api/status') {
      if(!root) return json(res,200,{error:'NO_PROJECT_ROOT'});
      const [project,bridge]=await Promise.all([readProject(root),readBridge(args.home)]);
      return json(res,200,{...project,bridge,readAt:new Date().toISOString()});
    }
    if(url.pathname==='/api/document') return json(res,200,await readDocument(root));
    const pathname=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);
    if(pathname.includes('\\')) return json(res,403,{error:'PATH_NOT_ALLOWED'});
    const file=resolve(PUBLIC,'.'+pathname);
    const rel=relative(PUBLIC,file);
    if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep)) return json(res,403,{error:'PATH_NOT_ALLOWED'});
    const data=await readFile(file);
    res.writeHead(200,{'Content-Type':(MIME[extname(file)]||'application/octet-stream')+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(data);
  } catch(error) {
    json(res,error.status || (error.code==='ENOENT'?404:500),{error:error.code||'READ_FAILED',message:error.message});
  }
});
server.listen(args.port,LISTEN_HOST,()=>console.log(JSON.stringify({url:'http://'+LISTEN_HOST+':'+server.address().port+'/',readOnly:true})));
server.on('error',e=>{console.error(e.message);process.exitCode=1;});
