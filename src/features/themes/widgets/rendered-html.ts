export interface MarkupWarning {
  path: 'rendered_html';
  code: 'unexpected_closing_tag' | 'closing_order' | 'unclosed_tag';
  message: string;
  line: number;
  column: number;
}

// These elements require explicit closing tags. Restricting the check to them
// avoids warnings for HTML elements whose end tags may be omitted legitimately.
const CONTAINERS = new Set([
  'div',
  'section',
  'article',
  'nav',
  'form',
  'main',
  'header',
  'footer',
  'aside',
]);
const RAW_TEXT = new Set(['script', 'style', 'textarea']);

export function inspectRenderedHtml(html: string): MarkupWarning[] {
  const lowerHtml = html.toLowerCase();
  const stack: { name: string; offset: number }[] = [];
  const warnings: MarkupWarning[] = [];
  const location = (offset: number) => {
    const before = html.slice(0, offset);
    const line = before.split('\n').length;
    return { line, column: offset - before.lastIndexOf('\n') };
  };
  const warn = (code: MarkupWarning['code'], message: string, offset: number) => {
    if (warnings.length < 30)
      warnings.push({ path: 'rendered_html', code, message, ...location(offset) });
  };

  for (let i = 0; i < html.length;) {
    const open = html.indexOf('<', i);
    if (open < 0) break;
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    let cursor = open + 1;
    const closing = html[cursor] === '/';
    if (closing) cursor++;
    const match = /^[a-z][a-z0-9:-]*/i.exec(html.slice(cursor));
    if (!match) {
      i = open + 1;
      continue;
    }
    const name = match[0].toLowerCase();
    cursor += match[0].length;
    let quote: string | null = null;
    for (; cursor < html.length; cursor++) {
      const char = html[cursor];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (cursor === html.length) break;
    i = cursor + 1;
    if (CONTAINERS.has(name)) {
      if (closing) {
        let index = stack.length - 1;
        while (index >= 0 && stack[index]?.name !== name) index--;
        if (index < 0) warn('unexpected_closing_tag', `Лишний закрывающий </${name}>.`, open);
        else if (index !== stack.length - 1) {
          warn(
            'closing_order',
            `</${name}> закрывает контейнер раньше </${stack.at(-1)!.name}>.`,
            open,
          );
          stack.splice(index);
        } else stack.pop();
      } else stack.push({ name, offset: open });
    }
    if (!closing && RAW_TEXT.has(name)) {
      const end = lowerHtml.indexOf(`</${name}`, i);
      i = end < 0 ? html.length : end;
    }
  }
  for (const item of stack) warn('unclosed_tag', `Нет закрывающего </${item.name}>.`, item.offset);
  return warnings;
}
