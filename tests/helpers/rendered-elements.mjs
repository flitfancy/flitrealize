// Read generated double-quoted attributes without depending on their order.
// This is a test helper for our renderers, not an HTML parser or sanitizer.
export function renderedElements(markup, name) {
  return [...markup.matchAll(new RegExp('<'+name+'\\b([^>]*)>', 'g'))].map(match => ({
    attributes: Object.fromEntries([...match[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]])),
    offset: match.index, end: match.index+match[0].length,
  }));
}
