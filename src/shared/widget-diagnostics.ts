import { parse } from 'acorn';
import { isRecord, type Json } from './common.js';
import { liquidSourceWarnings } from './liquid-diagnostics.js';

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function memberCall(node: Json, receiver: string, method: string): boolean {
  const callee = node.callee;
  if (node.type !== 'CallExpression' || !isRecord(callee) || callee.type !== 'MemberExpression')
    return false;
  const object = callee.object;
  const property = callee.property;
  return (
    isRecord(object) &&
    object.type === 'Identifier' &&
    object.name === receiver &&
    isRecord(property) &&
    property.type === 'Identifier' &&
    property.name === method
  );
}

function javascriptWarnings(source: string, libraries: unknown): string[] {
  if (source.includes('{{') || source.includes('{%')) return [];
  let tree: unknown;
  try {
    tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch {
    return [];
  }
  const initializerRanges: Array<{ start: number; end: number }> = [];
  let hasPerRootInitialization = false;
  const finds: number[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value) || typeof value.type !== 'string') return;
    const isEach = memberCall(value, '$widget', 'each');
    const isMount = memberCall(value, 'WidgetLifecycle', 'mount');
    if ((isEach || isMount) && Array.isArray(value.arguments)) {
      const callback: unknown = value.arguments[isEach ? 0 : 1];
      const body = isRecord(callback) ? callback.body : undefined;
      if (callback !== undefined) hasPerRootInitialization = true;
      if (isRecord(body) && typeof body.start === 'number' && typeof body.end === 'number')
        initializerRanges.push({ start: body.start, end: body.end });
    }
    if (memberCall(value, '$widget', 'find') && typeof value.start === 'number')
      finds.push(value.start);
    Object.values(value).forEach(visit);
  };
  visit(tree);
  const warnings: string[] = [];
  const inside = finds.find((offset) =>
    initializerRanges.some((range) => offset >= range.start && offset < range.end),
  );
  if (inside !== undefined)
    warnings.push(
      `widget_js_instance_scope: snippet.js:${lineAt(source, inside)} — ` +
        '$widget.find() затрагивает соседние экземпляры. Ищите элементы внутри текущего корня.',
    );
  const stateful =
    /\b(?:let|var|const)\s+(?:index|current(?:Index|Slide)?|slideIndex)\b|\bnew\s+(?:TvistV1|Splide)\b|\.eq\s*\(|\.on\s*\(\s*['"]click/.test(
      source,
    );
  if (
    finds.some(
      (offset) => !initializerRanges.some((range) => offset >= range.start && offset < range.end),
    ) &&
    stateful
  )
    warnings.push(
      `widget_js_shared_state: snippet.js:${lineAt(source, finds[0]!)} — $widget.find() ` +
        'объединяет экземпляры. Храните состояние внутри инициализации каждого корня.',
    );
  if (!hasPerRootInitialization && /\bnew\s+(?:TvistV1|Splide)\b/.test(source))
    warnings.push(
      'widget_js_single_slider: snippet.js — создайте слайдер для каждого корня ' +
        'через WidgetLifecycle.mount или $widget.each().',
    );
  if (
    /\.removeClass\(\s*['"]is-active['"]\s*\)/.test(source) &&
    /\.addClass\(\s*['"]is-active['"]\s*\)/.test(source) &&
    /(?:data-hero-next|data-slide-next|data-slider-next)/.test(source) &&
    !/\b(?:TvistV1|Splide)\b/.test(source)
  )
    warnings.push(
      'widget_js_manual_slider: snippet.js — переключение CSS-классов само по себе не подтверждает ' +
        'требуемые свайп и обновление в редакторе; проверьте поведение текущей реализации ' +
        'без смены библиотеки существующего виджета.',
    );
  const handles = Array.isArray(libraries) ? libraries : [];
  if (/\bnew\s+TvistV1\b/.test(source) && !handles.includes('tvist-v1'))
    warnings.push(
      'widget_js_missing_library: snippet.js — используется TvistV1 без libraries: tvist-v1; подключите библиотеку типа.',
    );
  if (
    /\bnew\s+Splide\b/.test(source) &&
    !handles.some((handle) => ['splide', 'splide3'].includes(String(handle)))
  )
    warnings.push(
      'widget_js_missing_library: snippet.js — используется Splide без соответствующей библиотеки типа.',
    );
  return warnings;
}

function settingsFields(source: unknown): Map<string, string> {
  if (typeof source !== 'string') return new Map();
  try {
    const fields = new Map<string, string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!isRecord(value)) return;
      if (typeof value.name === 'string' && typeof value.type === 'string')
        fields.set(value.name, value.type);
      Object.values(value).forEach(visit);
    };
    visit(JSON.parse(source));
    return fields;
  } catch {
    return new Map();
  }
}

type HtmlTag = { name: string; closing: boolean; attributes: Map<string, string>; offset: number };

function* htmlTags(source: string): Generator<HtmlTag> {
  for (let start = source.indexOf('<'); start >= 0; start = source.indexOf('<', start + 1)) {
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4);
      if (end < 0) return;
      start = end + 2;
      continue;
    }
    const head = /^<(\/)?([a-z][\w:-]*)\b/i.exec(source.slice(start));
    if (!head) continue;
    let end = start + head[0].length;
    let quote: string | null = null;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end >= source.length) return;
    const attributes = new Map<string, string>();
    const body = source.slice(start + head[0].length, end);
    for (const match of body.matchAll(
      /\s([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
    ))
      attributes.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
    const name = head[2]!.toLowerCase();
    yield { name, closing: !!head[1], attributes, offset: start };
    start = end;
    if (!head[1] && (name === 'script' || name === 'style')) {
      const close = source.toLowerCase().indexOf(`</${name}`, start + 1);
      if (close < 0) return;
      start = close - 1;
    }
  }
}

function productFormWarnings(source: string): string[] {
  const warnings: string[] = [];
  let form: {
    offset: number;
    productId: boolean;
    add: boolean;
    variant: boolean;
    quantity: boolean;
  } | null = null;
  const finish = () => {
    if (!form?.add) return;
    const line = lineAt(source, form.offset);
    if (!form.productId)
      warnings.push(
        `widget_product_form_id: snippet.liquid:${line} — форма с data-item-add не содержит data-product-id="{{ product.id }}"; Common.js не инициализирует товар в этой форме.`,
      );
    if (!form.variant)
      warnings.push(
        `widget_product_form_variant: snippet.liquid:${line} — форма с data-item-add не содержит поле name="variant_id" для Common.js.`,
      );
    if (!form.quantity)
      warnings.push(
        `widget_product_form_quantity: snippet.liquid:${line} — форма с data-item-add не содержит поле name="quantity"; Common.js ожидает явное количество.`,
      );
  };
  for (const tag of htmlTags(source)) {
    if (tag.name === 'form') {
      if (tag.closing) {
        finish();
        form = null;
      } else {
        finish();
        form = {
          offset: tag.offset,
          productId: tag.attributes.has('data-product-id'),
          add: false,
          variant: false,
          quantity: false,
        };
      }
      continue;
    }
    if (!form || tag.closing) continue;
    if (tag.attributes.has('data-item-add')) form.add = true;
    if (tag.name === 'input' || tag.name === 'select') {
      if (tag.attributes.get('name') === 'variant_id') form.variant = true;
      if (tag.attributes.get('name') === 'quantity') form.quantity = true;
    }
  }
  finish();
  return warnings;
}

function settingSourceWarnings(
  content: string,
  form: Map<string, string>,
  data: unknown,
): string[] {
  const warnings: string[] = [];
  for (const [source, type] of [
    ['linklists', 'navigation'],
    ['collections', 'collection'],
  ] as const) {
    const pattern = new RegExp(
      `\\b${source}\\s*\\[\\s*widget_settings(?:\\.([\\w-]+)|\\[\\s*['"]([^'"]+)['"]\\s*\\])\\s*\\]`,
      'g',
    );
    for (const match of content.matchAll(pattern)) {
      const name = match[1] ?? match[2];
      if (name && form.get(name) === 'text')
        warnings.push(
          `widget_setting_picker: settings_form.json — поле ${name} используется в ${source}[...]; выберите type="${type}" вместо ручного ввода.`,
        );
    }
  }
  if (typeof data === 'string') {
    try {
      const values: unknown = JSON.parse(data);
      if (isRecord(values))
        for (const [name, value] of Object.entries(values)) {
          if (
            form.get(name) === 'text' &&
            typeof value === 'string' &&
            /^\/collection\/[^/]/.test(value)
          )
            warnings.push(
              `widget_setting_collection_link: settings_form.json — ${name} содержит путь категории; используйте type="collection" и ссылку collections[widget_settings['${name}']].url.`,
            );
          const translations = isRecord(value) ? Object.values(value) : [value];
          if (
            form.get(name) === 'text' &&
            translations.some(
              (text) =>
                typeof text === 'string' && /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\s*\/?>/i.test(text),
            )
          )
            warnings.push(
              `widget_setting_rich_text: settings_form.json — поле ${name} содержит HTML в settings_data.json; выберите type="rich-text" вместо type="text".`,
            );
        }
    } catch {
      /* JSON validation reports malformed settings_data. */
    }
  }
  return [...new Set(warnings)];
}

function hasFullBlockLoop(content: string): boolean {
  return [...content.matchAll(/{%\s*for\s+\w+\s+in\s+data\.blocks\b([^%]*)%}/g)].some(
    (match) => !/\boffset\s*:\s*[1-9]/.test(match[1] ?? ''),
  );
}

export function widgetQualityWarnings(fields: Json, before: Json | null): string[] {
  const current = { ...(before ?? {}), ...fields };
  const warnings: string[] = [];
  if (before && (fields.libraries !== undefined || fields.snippet_js !== undefined)) {
    const previousLibraries = Array.isArray(before.libraries) ? before.libraries : [];
    const currentLibraries = Array.isArray(current.libraries) ? current.libraries : [];
    const previousJs = typeof before.snippet_js === 'string' ? before.snippet_js : '';
    const currentJs = typeof current.snippet_js === 'string' ? current.snippet_js : '';
    const hadSlider =
      previousLibraries.some((library) =>
        ['splide', 'splide3', 'tvist-v1'].includes(String(library)),
      ) ||
      /\b(?:Splide|TvistV1)\b|data-(?:hero|slide|slider)-(?:next|prev)|\.slide\b/.test(previousJs);
    const addsTvist =
      (!previousLibraries.includes('tvist-v1') && currentLibraries.includes('tvist-v1')) ||
      (!/\bTvistV1\b/.test(previousJs) && /\bTvistV1\b/.test(currentJs));
    if (hadSlider && addsTvist)
      warnings.push(
        'widget_js_library_migration: snippet.js/libraries — существующий слайдер переводится на TvistV1; ' +
          'сохраняйте текущую реализацию, если пользователь явно не попросил о миграции.',
      );
  }
  const javascript = current.snippet_js;
  if (typeof javascript === 'string' && (fields.snippet_js !== undefined || !before))
    warnings.push(...javascriptWarnings(javascript, current.libraries));
  const content = current.snippet_content;
  if (typeof content === 'string' && (fields.snippet_content !== undefined || !before)) {
    warnings.push(...liquidSourceWarnings('snippet.liquid', content, true, !before));
    warnings.push(...productFormWarnings(content));
    if (
      /{%\s*(?:case\s+(?:label|block\.title)|if\s+candidate\.title\s*==\s*label)/.test(content) &&
      /block\.title/.test(content)
    )
      warnings.push(
        'widget_content_title_key: snippet.liquid — данные выбираются по названию блока; ' +
          'храните ссылку, изображение или символ в редактируемом поле блока.',
      );
    if (current.type === 'SimpleWidgetType' && /\bdata\.blocks\b/.test(content))
      warnings.push(
        'widget_blocks_wrong_type: snippet.liquid — data.blocks требует BlockListWidgetType и шаблон блоков.',
      );
    if (
      current.type === 'SimpleWidgetType' &&
      !/{%\s*for\b/.test(content) &&
      ['details', 'blockquote', 'article'].some(
        (tag) => (content.match(new RegExp(`<${tag}\\b`, 'gi')) ?? []).length > 1,
      )
    )
      warnings.push(
        'widget_content_static_list: snippet.liquid — повторяющиеся карточки зашиты в разметку; проверьте редактируемые блоки.',
      );
  }
  if (
    typeof content === 'string' &&
    (fields.snippet_content !== undefined ||
      fields.snippet_js !== undefined ||
      fields.block_template_handle !== undefined ||
      !before) &&
    typeof current.block_template_handle === 'string' &&
    /slider/i.test(current.block_template_handle) &&
    /\bdata\.blocks\.first\b/.test(content) &&
    !hasFullBlockLoop(content)
  )
    warnings.push(
      'widget_slider_static_first: snippet.liquid — основной баннер взят из data.blocks.first без цикла по всем слайдам; проверьте переключение, свайп и счётчик.',
    );
  if (
    fields.settings_form !== undefined ||
    fields.settings_data !== undefined ||
    fields.snippet_content !== undefined ||
    !before
  ) {
    const form = settingsFields(current.settings_form);
    const names = new Set(form.keys());
    const missing = [
      'bg',
      'layout-wide-bg',
      'layout-wide-content',
      'layout-pt',
      'layout-pb',
      'layout-edge',
    ].filter(
      (name) =>
        !names.has(name) &&
        !(name === 'layout-pt' && names.has('layout-pt-desktop-px')) &&
        !(name === 'layout-pb' && names.has('layout-pb-desktop-px')),
    );
    if (missing.length)
      warnings.push(
        `widget_design_settings: settings_form.json — отсутствуют базовые настройки my-layout: ${missing.join(', ')}; ` +
          'добавьте применимые фон, ширину и отступы.',
      );
    if ([...names].some((name) => /^(?:title|image|link)[-_]?[12]$/.test(name)))
      warnings.push(
        'widget_content_numbered_fields: settings_form.json — нумерованные поля похожи на редакторский список; проверьте необходимость BlockListWidgetType.',
      );
    warnings.push(
      ...settingSourceWarnings(
        typeof content === 'string' ? content : '',
        form,
        current.settings_data,
      ),
    );
  }
  return warnings;
}
