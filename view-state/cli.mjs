#!/usr/bin/env node
import {readProject} from './lib/project.mjs';
const args=process.argv.slice(2);
if(args.includes('--help')) console.log('node cli.mjs --project-root ABSOLUTE_PATH');
else {
  try {
    if(args.length !== 2 || args[0] !== '--project-root') throw new Error('用法：node cli.mjs --project-root ABSOLUTE_PATH');
    console.log(JSON.stringify(await readProject(args[1]),null,2));
  }
  catch(e) { console.error(e.message);process.exitCode=1; }
}
