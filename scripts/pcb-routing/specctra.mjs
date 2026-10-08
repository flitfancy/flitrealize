export function parseSpecctra(text) {
 let i=0;
 function skip(){while(i<text.length){if(/\s/.test(text[i])){i++;continue;}if(text[i]===';'){while(i<text.length&&text[i]!=='\n')i++;continue;}break;}}
 function item(parent){
  skip();if(i>=text.length)throw Error('UNEXPECTED_EOF');
  if(text[i]==='('){i++;const result=[];while(true){skip();if(text[i]===')'){i++;return result;}if(i>=text.length)throw Error('UNCLOSED_LIST');result.push(item(result));}}
  if(text[i]===')')throw Error('UNEXPECTED_CLOSE');
  if(text[i]==='"'&&parent?.[0]==='string_quote'){i++;return '"';}
  if(text[i]==='"'||text[i]==="'"){
   const quote=text[i++];let result='';while(i<text.length){const c=text[i++];if(c===quote)return result;if(c==='\\'&&i<text.length)result+=text[i++];else result+=c;}throw Error('UNCLOSED_STRING');
  }
  const start=i;while(i<text.length&&!/[\s()]/.test(text[i]))i++;return text.slice(start,i);
 }
 const roots=[];while(true){skip();if(i>=text.length)break;roots.push(item());}if(roots.length!==1)throw Error('EXPECTED_ONE_ROOT');return roots[0];
}
export function serializeSpecctra(node,depth=0){
 if(!Array.isArray(node)){const s=String(node);return !s||/[\s()"'\\]/.test(s)?JSON.stringify(s):s;}
 if(node[0]==='string_quote')return '(string_quote ")';
 const indent='  '.repeat(depth),inner='  '.repeat(depth+1);
 if(node.every(x=>!Array.isArray(x)))return '('+node.map(x=>serializeSpecctra(x,depth+1)).join(' ')+')';
 let out='(';for(let k=0;k<node.length;k++){const n=node[k];out+=(k?(Array.isArray(n)?'\n'+inner:' '):'')+serializeSpecctra(n,depth+1);}return out+'\n'+indent+')';
}
export const children=(node,name)=>node.filter(x=>Array.isArray(x)&&String(x[0]).toLowerCase()===name.toLowerCase());
export const child=(node,name)=>children(node,name)[0];
