import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve,isAbsolute,relative,sep} from 'node:path';
import {parseHandoff} from './handoff.mjs';

function fail(code,message,status) { throw Object.assign(new Error(message),{code,status}); }
export async function projectDirectory(root) {
  if (!root || !isAbsolute(root)) fail('INVALID_PROJECT_ROOT','请使用项目绝对路径',400);
  try {
    const path = await realpath(root);
    if (!(await stat(path)).isDirectory()) throw new Error();
    return path;
  } catch { fail('PROJECT_NOT_FOUND','项目目录不存在或无法读取',404); }
}
export async function readDocument(root) {
  const projectRoot = await projectDirectory(root);
  let path;
  try { path = await realpath(resolve(projectRoot,'CURRENT_HANDOFF.md')); }
  catch (e) { if(e.code === 'ENOENT') fail('HANDOFF_MISSING','项目尚无 CURRENT_HANDOFF.md',404); throw e; }
  const rel = relative(projectRoot,path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..'+sep)) fail('PATH_NOT_ALLOWED','主文稿不能指向项目外的文件',403);
  if (!(await stat(path)).isFile()) fail('NOT_A_FILE','主文稿路径不是文件',400);
  return {projectRoot,text:await readFile(path,'utf8')};
}
export async function readProject(root) {
  try {
    const doc = await readDocument(root);
    return {schemaVersion:2,projectRoot:doc.projectRoot,documentExists:true,...parseHandoff(doc.text)};
  } catch(e) {
    if(e.code !== 'HANDOFF_MISSING') throw e;
    return {schemaVersion:2,projectRoot:await projectDirectory(root),documentExists:false,...parseHandoff('')};
  }
}
