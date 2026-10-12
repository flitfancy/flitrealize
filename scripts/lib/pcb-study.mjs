/** Shared report paths and implementation fingerprints for offline PCB tools. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export async function studyOutputDirectory(root,requested,{category='pcb-study'}={}) {
  root=await fs.realpath(root);
  let dest=path.resolve(root,requested??path.join('evidence',category,new Date().toISOString().replace(/[:.]/g,'-')));
  const within=p=>{const relative=path.relative(root,p);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
  const requestedWithin=within(dest);
  let ancestor=dest;
  // Resolve the existing ancestor before appending new directories, so short
  // names and directory aliases use the same physical namespace as the root.
  while(true){
    try{
      const real=await fs.realpath(ancestor);
      dest=path.resolve(real,path.relative(ancestor,dest));
      if(!within(dest))throw Error(requestedWithin?'PREROUTE_OUTPUT_LINK_OUTSIDE_PROJECT':'PREROUTE_OUTPUT_OUTSIDE_PROJECT');
      break;
    }catch(error){
      const parent=path.dirname(ancestor);
      if(error.code!=='ENOENT'||parent===ancestor)throw error;
      ancestor=parent;
    }
  }
  await fs.mkdir(dest,{recursive:true});
  const real=await fs.realpath(dest);
  if(!within(real))throw Error('PREROUTE_OUTPUT_LINK_OUTSIDE_PROJECT');
  return real;
}

export async function pcbImplementationFingerprint(root,{directories=[],files=[]}={}) {
  const records=new Map();
  async function add(file){records.set(path.relative(root,file).replaceAll('\\','/'),createHash('sha256').update(await fs.readFile(file)).digest('hex'));}
  async function visit(dir){for(const item of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())await visit(file);else if(/\.(mjs|js|py|json)$/.test(item.name))await add(file);}}
  for(const dir of directories)await visit(path.resolve(root,dir));
  for(const file of files)await add(path.resolve(root,file));
  return createHash('sha256').update(JSON.stringify([...records].sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex');
}
