import { markdown, escapeHtml } from './format.mjs';
const plainText = value => String(value || '').replace(/[`*]/g,'').trim();
const params = new URLSearchParams(location.search);
const path = 'CURRENT_HANDOFF.md';
const projectRoot = params.get('projectRoot') || '';
document.getElementById('location').textContent = `${projectRoot} / ${path}`;
document.title = `${path.split(/[\\/]/).at(-1)} · 项目原文`;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(),15000);
try {
  const response = await fetch(`/api/document?${new URLSearchParams({projectRoot})}`,{signal:controller.signal});
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error || response.status);
  const target = document.getElementById('document');
  target.innerHTML = /\.md$/i.test(path) ? markdown(data.text) : `<pre>${escapeHtml(data.text)}</pre>`;
  const download = document.getElementById('download');
  const url = URL.createObjectURL(new Blob([data.text],{type:'text/plain;charset=utf-8'}));
  download.href = url; download.download = path.split(/[\\/]/).at(-1); download.hidden = false;
  const heading = params.get('heading');
  const headings = [...target.querySelectorAll('h2,h3,h4,h5,h6')];
  const normalized = value => plainText(value).replace(/^\d+(?:\.\d+)*[.、]?\s*/,'');
  const match = heading && (headings.find(el => el.dataset.sourceLine === params.get('line') && el.textContent === plainText(heading)) || headings.find(el => el.textContent === plainText(heading)) || headings.find(el => normalized(el.textContent) === normalized(heading)));
  if (match) { match.classList.add('source-target'); match.scrollIntoView({block:'start'}); }
  window.addEventListener('pagehide',() => URL.revokeObjectURL(url),{once:true});
} catch (error) {
  document.getElementById('document').textContent = `无法读取原文：${error.name === 'AbortError' ? '请求超时，请刷新重试' : error.message}`;
} finally { clearTimeout(timer); }
