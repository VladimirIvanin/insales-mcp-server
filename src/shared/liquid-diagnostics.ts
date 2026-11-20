function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function mask(source: string, pattern: RegExp): string {
  return source.replace(pattern, (match) => match.replace(/[^\r\n]/g, ' '));
}

function activeLiquid(source: string): string {
  let active = source;
  for (const pattern of [
    /<!--[^]*?-->/g,
    /{%-?\s*comment\b[^]*?\s*-?%}[^]*?{%-?\s*endcomment\s*-?%}/gi,
    /{%-?\s*raw\b[^]*?\s*-?%}[^]*?{%-?\s*endraw\s*-?%}/gi,
    /<(pre|textarea|script|style)\b[^>]*>[^]*?<\/\1\s*>/gi,
  ])
    active = mask(active, pattern);
  return active;
}

const tagLimit = 2000;

function tagNameEnd(source: string, start: number, limit: number) {
  let index = start + 1;
  if (index < limit && source[index] === '/') index++;
  if (index >= limit || !/[a-z]/i.test(source[index]!)) return -1;
  index++;
  while (index < limit && /[\w:-]/i.test(source[index]!)) index++;
  return index === limit ? -1 : index;
}

function htmlTagLines(source: string) {
  const counts = new Map<number, number>();
  let line = 1;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\n') {
      line++;
      continue;
    }
    if (char !== '<') continue;
    const limit = Math.min(source.length, index + tagLimit);
    const nameEnd = tagNameEnd(source, index, limit);
    if (nameEnd < 0) continue;
    let quote: string | null = null;
    let end = nameEnd;
    let closed = false;
    for (; end < limit; end++) {
      const next = source[end];
      if (next === '\n') line++;
      if (quote) {
        if (next === quote) quote = null;
      } else if (next === '"' || next === "'") quote = next;
      else if (next === '>') {
        closed = true;
        break;
      }
    }
    if (!closed) {
      index = limit - 1;
      continue;
    }
    counts.set(line, (counts.get(line) ?? 0) + 1);
    index = end;
  }
  return counts;
}

function formatWarnings(name: string, source: string): string[] {
  // Quoted HTML in a Liquid string is data, not markup to reformat.
  const visible = source.replace(/{[{%][^]*?[%}]}/g, (tag) =>
    mask(tag, /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g),
  );
  const htmlByLine = htmlTagLines(visible);
  const liquidByLine = new Map<number, number>();
  for (const match of visible.matchAll(/{[{%][^]*?[%}]}/g)) {
    const line = lineAt(visible, match.index);
    liquidByLine.set(line, (liquidByLine.get(line) ?? 0) + 1);
  }
  return source.split(/\r?\n/).flatMap((line, index) => {
    const number = index + 1;
    const html = htmlByLine.get(number) ?? 0;
    const liquid = liquidByLine.get(number) ?? 0;
    return line.length > 280 && (html >= 6 || liquid >= 5 || (html >= 4 && liquid >= 2))
      ? [
          `liquid_dense_source: ${name}:${number} — секция Liquid выглядит сжатой; оформите HTML и управляющие конструкции на отдельных строках.`,
        ]
      : [];
  });
}

function listWarnings(name: string, source: string): string[] {
  const warnings: string[] = [];
  const list = String.raw`widget_lists(?:\.[\w-]+|\[\s*['"][^'"]+['"]\s*\])?\.widgets`;
  for (const match of source.matchAll(/{%-?\s*for\s+\w+\s+in\s+([^]*?)\s*-?%}/gi)) {
    const expression = match[1] ?? '';
    if (!new RegExp(String.raw`\b${list}\b`).test(expression)) continue;
    if (!/\b(?:limit|offset)\s*:|\|\s*(?:first|slice)\b|\.first\b|\[\s*\d+\s*\]/i.test(expression))
      continue;
    warnings.push(
      `widget_list_truncated: ${name}:${lineAt(source, match.index)} — вывод виджетлиста ограничен; снимите старые размещения со списка и выводите все виджеты.`,
    );
  }
  for (const match of source.matchAll(
    new RegExp(String.raw`\b${list}(?:\s*\|\s*(?:first|slice)\b|\.first\b|\s*\[\s*\d+\s*\])`, 'gi'),
  ))
    warnings.push(
      `widget_list_truncated: ${name}:${lineAt(source, match.index)} — виджетлист обрезан до вывода; снимите старые размещения со списка.`,
    );
  return [...new Set(warnings)];
}

function hardcodedContentWarnings(name: string, source: string): string[] {
  const warnings: string[] = [];
  const checks = [
    {
      code: 'widget_fixed_catalog_link',
      pattern: /(["'])\/(?:product|collection|collections)\/[^\s"']+\1/gi,
      advice: 'ссылку на товар или категорию получите из каталога либо настройки виджета',
    },
    {
      code: 'widget_fixed_image',
      pattern: /<img\b[^>]*\bsrc\s*=\s*(["'])https?:\/\/[^"']+\1/gi,
      advice: 'контентное изображение вынесите в настройку или блок',
    },
    {
      code: 'widget_fixed_product_id',
      pattern: /\bdata-product-id\s*=\s*(["'])\d+\1/gi,
      advice: 'ID товара получите из объекта каталога',
    },
    {
      code: 'widget_fixed_variant_id',
      pattern:
        /<(?:input|option)\b[^>]*(?:name\s*=\s*["']variant_id["'][^>]*value\s*=\s*["']\d+["']|value\s*=\s*["']\d+["'][^>]*name\s*=\s*["']variant_id["'])/gi,
      advice: 'ID варианта получите из объекта товара',
    },
  ];
  for (const { code, pattern, advice } of checks)
    for (const match of source.matchAll(pattern))
      warnings.push(`${code}: ${name}:${lineAt(source, match.index)} — ${advice}.`);
  return warnings;
}

function staticContentWarnings(name: string, source: string, newWidget: boolean): string[] {
  const visibleTexts = [
    ...source.matchAll(/<(?:h[1-6]|p|a|button|strong|small)\b[^>]*>([^<>]*\S[^<>]*)<\//gi),
  ].filter((match) => !/{{|{%/.test(match[1] ?? ''));
  if (visibleTexts.length < (newWidget ? 1 : 3)) return [];
  return [
    `widget_content_static: ${name}:${lineAt(source, visibleTexts[0]!.index)} — видимый текст зашит в Liquid без источника из настроек, блоков или каталога; проверьте редактируемость.`,
  ];
}

export function liquidSourceWarnings(
  name: string,
  source: string,
  widgetContent = false,
  newWidget = false,
): string[] {
  const active = activeLiquid(source);
  return [
    ...formatWarnings(name, active),
    ...listWarnings(name, active),
    ...hardcodedContentWarnings(name, active),
    ...(widgetContent ? staticContentWarnings(name, active, newWidget) : []),
  ];
}
