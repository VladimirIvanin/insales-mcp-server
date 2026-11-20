import { parse as parseJs } from 'acorn';
import postcss from 'postcss';
import scss from 'postcss-scss';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ROOT, Fault, isRecord, type Json } from './common.js';
import type { Target } from './schemas.js';
import { widgetQualityWarnings } from './widget-diagnostics.js';
import { liquidSourceWarnings } from './liquid-diagnostics.js';

export interface Validation {
  errors: string[];
  warnings: string[];
}
const JSON_WIDGET_FIELDS = [
  'settings_form',
  'settings_data',
  'setup',
  'messages',
  'block_settings_presets',
] as const;
const LEGACY_VERTICAL_LAYOUT_NAMES = new Set(['layout-pt', 'layout-pb', 'layout-mt', 'layout-mb']);
const MOBILE_INDENT_FACTOR = '--layout-adaptive-vertical-indents-factor-decrease';

function formWithAbsoluteVerticalLayout(source: unknown): string[] {
  if (typeof source !== 'string') return [];
  try {
    const names = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!isRecord(value)) return;
      if (
        typeof value.name === 'string' &&
        LEGACY_VERTICAL_LAYOUT_NAMES.has(value.name) &&
        (value.unit === 'rem' || value.unit === 'px')
      )
        names.add(value.name);
      Object.values(value).forEach(visit);
    };
    visit(JSON.parse(source));
    return [...names];
  } catch {
    return [];
  }
}

function dataWithAbsoluteVerticalLayout(source: unknown): string[] {
  if (typeof source !== 'string') return [];
  try {
    const data: unknown = JSON.parse(source);
    if (!isRecord(data)) return [];
    return [...LEGACY_VERTICAL_LAYOUT_NAMES].filter(
      (name) =>
        typeof data[name] === 'string' &&
        /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:rem|px)$/i.test(data[name].trim()),
    );
  } catch {
    return [];
  }
}

function mediaCoversMobile(params: string): boolean {
  const query = params.trim().toLowerCase();
  if (query === 'screen' || query === 'all') return true;
  const match =
    /^(?:(?:only\s+)?(?:screen|all)\s+and\s+)?\(\s*max-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(
      query,
    );
  return match !== null && Number(match[1]) >= 767;
}

function scssVerticalLayout(source: unknown): { names: string[]; safeFactor: boolean } {
  if (typeof source !== 'string') return { names: [], safeFactor: false };
  try {
    const root = scss.parse(source);
    const names = new Set<string>();
    const factors: number[] = [];
    root.walkDecls((decl) => {
      if (
        decl.prop.startsWith('--') &&
        LEGACY_VERTICAL_LAYOUT_NAMES.has(decl.prop.slice(2)) &&
        /(?:^|[^\w-])-?(?:\d+(?:\.\d+)?|\.\d+)(?:rem|px)\b/i.test(decl.value)
      )
        names.add(decl.prop.slice(2));
      if (decl.prop !== MOBILE_INDENT_FACTOR) return;
      const rules: string[] = [];
      let coversMobile = true;
      for (let parent: postcss.Node | undefined = decl.parent; parent; parent = parent.parent) {
        if (parent.type === 'rule') rules.push((parent as postcss.Rule).selector.trim());
        if (parent.type === 'atrule' && (parent as postcss.AtRule).name.toLowerCase() === 'media')
          coversMobile &&= mediaCoversMobile((parent as postcss.AtRule).params);
      }
      if (coversMobile && rules.length === 1 && rules[0] === '&') {
        const factor = Number(decl.value);
        factors.push(factor);
      }
    });
    return {
      names: [...names],
      safeFactor: factors.length > 0 && factors.every((n) => n > 0 && n <= 1),
    };
  } catch {
    return { names: [], safeFactor: false };
  }
}

function absoluteVerticalLayout(fields: Json, before: Json | null, result: Validation) {
  if (
    before &&
    fields.settings_form === undefined &&
    fields.settings_data === undefined &&
    fields.snippet_scss === undefined
  )
    return;
  const current = { ...(before ?? {}), ...fields };
  const handle = typeof current.handle === 'string' ? current.handle : '';
  if (current.system === true || /^system_/i.test(handle)) return;
  const scssLayout = scssVerticalLayout(current.snippet_scss);
  const names = new Set([
    ...formWithAbsoluteVerticalLayout(current.settings_form),
    ...dataWithAbsoluteVerticalLayout(current.settings_data),
    ...scssLayout.names,
  ]);
  if (names.size && !scssLayout.safeFactor)
    result.errors.push(
      `widget_layout_legacy_absolute: ${[...names].join(', ')} используют rem/px; на мобильном my-layout умножает их на 4. ` +
        'Для padding используйте layout-pt-desktop-px, layout-pb-desktop-px и соответствующие mobile-px настройки; ' +
        'для старых переменных задайте на корне snippet.scss коэффициент ' +
        '--layout-adaptive-vertical-indents-factor-decrease в диапазоне (0, 1].',
    );
}

export function formatWidgetJsonFields<T extends Json>(fields: T): T {
  const formatted: Json = { ...fields };
  for (const field of JSON_WIDGET_FIELDS) {
    const value = fields[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    try {
      formatted[field] = `${JSON.stringify(JSON.parse(value), null, 2)}\n`;
    } catch {
      /* The validator reports malformed JSON without rewriting it. */
    }
  }
  return formatted as T;
}

function settingsForm(source: string, result: Validation) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    result.errors.push(
      'settings_form: корень JSON должен быть объектом с вкладками content и design.',
    );
    return;
  }
  const form = parsed as Record<string, unknown>;
  for (const key of Object.keys(form)) {
    if (key !== 'content' && key !== 'design')
      result.errors.push(
        `settings_form.${key}: лишний ключ; разрешены только вкладки content и design.`,
      );
  }
  for (const tab of ['content', 'design'] as const) {
    const groups = form[tab];
    if (!Array.isArray(groups)) {
      result.errors.push(`settings_form.${tab}: требуется массив групп (в том числе пустой).`);
      continue;
    }
    groups.forEach((group, groupIndex) => {
      const path = `settings_form.${tab}[${groupIndex}]`;
      if (!group || typeof group !== 'object' || Array.isArray(group)) {
        result.errors.push(`${path}: требуется объект группы с массивом items.`);
        return;
      }
      const items = (group as Record<string, unknown>).items;
      if (!Array.isArray(items)) {
        result.errors.push(`${path}.items: требуется массив полей (в том числе пустой).`);
        return;
      }
      items.forEach((item, itemIndex) => {
        const itemPath = `${path}.items[${itemIndex}]`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          result.errors.push(`${itemPath}: требуется объект поля с непустым строковым type.`);
        } else {
          const type = (item as Record<string, unknown>).type;
          if (typeof type !== 'string' || !type.trim())
            result.errors.push(`${itemPath}.type: требуется непустая строка.`);
        }
      });
    });
  }
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (
      typeof item.type === 'string' &&
      typeof item.name === 'string' &&
      !['info', 'current-page-description', 'link-to-widget'].includes(item.type) &&
      (typeof item.label !== 'string' || !item.label.trim())
    ) {
      result.warnings.push(`settings_form.json: у настройки ${item.name} не указан label.`);
    }
    Object.values(item).forEach(visit);
  };
  visit(parsed);
}

function checkJavascript(name: string, content: string, result: Validation) {
  if (content.includes('{{') || content.includes('{%')) {
    result.warnings.push(`${name}: JS с Liquid не проверен до рендеринга в InSales.`);
    return;
  }
  try {
    if (name === 'snippet.js') {
      parseJs(
        `try { let widget = '.widget-type_preview'; let $widget = null;\n${content}\n} catch(error) { console.error(error); }`,
        { ecmaVersion: 'latest', sourceType: 'script' },
      );
    } else {
      try {
        parseJs(content, { ecmaVersion: 'latest', sourceType: 'module' });
      } catch {
        parseJs(content, { ecmaVersion: 'latest', sourceType: 'script' });
      }
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.replace(/\s*\(\d+:\d+\)$/, '')
        : 'синтаксическая ошибка';
    result.warnings.push(`${name}: возможная синтаксическая ошибка JS: ${message}.`);
  }
}

function cssVariables(source: string, result: Validation, name: string) {
  if (/var\(\s*--color-btn-text\s*(?:,|\))/.test(source)) {
    result.warnings.push(
      `${name}: --color-btn-text отсутствует в my-layout; используйте --color-btn-color.`,
    );
  }
}
function widgetMarkup(source: string, result: Validation) {
  if (/<[\w:-]+\b[^>]*\bclass\s*=\s*(["'])[^"']*\blayout__content\b[^"']*\1/i.test(source)) {
    result.warnings.push(
      'snippet.liquid: layout__content уже создаётся платформой; уберите вложенную обёртку.',
    );
  }
  if (
    /\bhref\s*=\s*(["'])\/collection\/[^"']+\1/i.test(source) ||
    /\bcollections(?:\.[a-z][\w-]*|\[\s*['"][^'"]+['"]\s*\])/i.test(source)
  ) {
    result.warnings.push(
      'snippet.liquid: ссылку или категорию вынесите в настройки виджета либо используйте выбранное меню.',
    );
  }
  if (/\bstyle\s*=\s*(["'])[^"']*\bpadding(?:-(?:top|right|bottom|left))?\s*:/i.test(source)) {
    result.warnings.push(
      'snippet.liquid: отступы секции задавайте настройками layout-pt/layout-pb, а не inline padding.',
    );
  }
  if (/<link\b[^>]*\brel\s*=\s*(["'])stylesheet\1/i.test(source)) {
    result.warnings.push(
      'snippet.liquid: уберите подключение общего CSS из виджета. ' +
        'Шрифты для всей темы подключайте через настройки system_v4_fonts. ' +
        'См. search_knowledge(query="system_v4_fonts").',
    );
  }
}
function globalLayoutCss(source: string, result: Validation, name: string) {
  const root = name.endsWith('.scss') ? scss.parse(source) : postcss.parse(source);
  root.walkRules((rule) => {
    if (!/(?:^|[\s>+~,])\.layout(?:__content)?(?=$|[\s>+~,#.:[(])/.test(rule.selector)) return;
    let overrides = false;
    rule.walkDecls((decl) => {
      if (/^(?:width|max-width|padding(?:-.+)?|margin(?:-.+)?|background(?:-.+)?)$/.test(decl.prop))
        overrides = true;
    });
    if (overrides)
      result.warnings.push(
        `CSS темы: ${rule.selector} переопределяет геометрию my-layout; используйте настройки виджета.`,
      );
  });
}
function fileCheck(name: string, content: string, result: Validation, checkLiquidSource = true) {
  try {
    if (name.endsWith('.json')) JSON.parse(content);
    else if (name.endsWith('.js')) checkJavascript(name, content, result);
    else if (name.endsWith('.liquid') || content.includes('{{') || content.includes('{%')) {
      if (name.endsWith('.liquid') && checkLiquidSource)
        result.warnings.push(...liquidSourceWarnings(name, content));
      result.warnings.push(
        `${name}: Liquid требует проверки рендеринга в InSales; содержимое не исполнялось.`,
      );
    } else if (name.endsWith('.scss')) {
      scss.parse(content);
      result.warnings.push(
        `${name}: проверен синтаксис; компиляция LibSass и импорты проверяются InSales.`,
      );
    } else if (name.endsWith('.css')) postcss.parse(content);
  } catch {
    result.errors.push(`${name}: синтаксическая ошибка.`);
  }
}
export async function validateFields(
  target: Target,
  fields: Json,
  before: Json | null,
): Promise<Validation> {
  const result: Validation = { errors: [], warnings: [] };
  const assetName =
    typeof fields.inner_file_name === 'string'
      ? fields.inner_file_name
      : typeof before?.inner_file_name === 'string'
        ? before.inner_file_name
        : '';
  if (target.kind === 'asset') {
    if (typeof fields.content !== 'string')
      throw new Fault('validation_failed', 'Не указан текстовый контент файла темы.');
    fileCheck(assetName, fields.content, result);
  }
  if (
    target.kind === 'asset' &&
    /\.(?:css|scss)$/.test(assetName) &&
    typeof fields.content === 'string'
  ) {
    cssVariables(fields.content, result, assetName || 'CSS');
  }
  if (
    target.kind === 'asset' &&
    /\.(?:css|scss)$/.test(assetName) &&
    typeof fields.content === 'string'
  ) {
    try {
      globalLayoutCss(fields.content, result, assetName);
    } catch {
      /* fileCheck reports syntax errors */
    }
    if (
      !/^theme\.(?:css|scss)$/.test(assetName) &&
      /\{[^}]*\b(?:color|font|background|margin|padding|display)\s*:/i.test(fields.content)
    ) {
      result.warnings.push(
        'CSS темы: стили секций храните в snippet.scss соответствующего типа виджета.',
      );
    }
  }
  if (target.kind === 'widget_type') {
    absoluteVerticalLayout(fields, before, result);
    for (const field of ['snippet_js', 'snippet_scss'] as const) {
      const value = fields[field];
      if (typeof value !== 'string') continue;
      const dense = value.split(/\r?\n/).some((line) => {
        const operators = (line.match(/;/g) ?? []).length;
        return line.length > (field === 'snippet_js' ? 450 : 350) && operators >= 7;
      });
      if (dense)
        throw new Fault(
          'unformatted_widget_source',
          `${field}: исходник выглядит сжатым; форматируйте его до создания черновика.`,
          { field },
        );
    }
    result.warnings.push(...widgetQualityWarnings(fields, before));
    for (const [field, name] of Object.entries({
      snippet_content: 'snippet.liquid',
      snippet_js: 'snippet.js',
      snippet_scss: 'snippet.scss',
      settings_form: 'settings_form.json',
      settings_data: 'settings_data.json',
      setup: 'setup.json',
      messages: 'messages.json',
      block_settings_presets: 'block_settings_presets.json',
    })) {
      if (typeof fields[field] === 'string' && fields[field].trim())
        fileCheck(name, fields[field], result, name !== 'snippet.liquid');
    }
    const generation =
      fields.generation ?? before?.generation ?? (target.theme_id ? '4' : undefined);
    if (Number(generation) === 4) {
      if (
        before === null &&
        (typeof fields.settings_form !== 'string' || !fields.settings_form.trim())
      )
        result.errors.push(
          'settings_form: для нового виджета поколения 4 обязательна форма с вкладками content и design.',
        );
      if (typeof fields.settings_form === 'string') {
        if (!fields.settings_form.trim())
          result.errors.push('settings_form: требуется JSON-объект с вкладками content и design.');
        else settingsForm(fields.settings_form, result);
      }
    }
    if (typeof fields.snippet_scss === 'string')
      cssVariables(fields.snippet_scss, result, 'snippet.scss');
    const content =
      typeof fields.snippet_content === 'string' ? fields.snippet_content : before?.snippet_content;
    const styles =
      typeof fields.snippet_scss === 'string' ? fields.snippet_scss : before?.snippet_scss;
    if (typeof content === 'string') widgetMarkup(content, result);
    if (
      typeof content === 'string' &&
      !content.trim() &&
      typeof styles === 'string' &&
      /&\s*\{[^}]*display\s*:\s*none\s*!important/i.test(styles)
    ) {
      result.warnings.push(
        'Виджет: пустой Liquid и display:none скрывают лишнее размещение; снимите виджет с виджетлиста.',
      );
    }
    if (typeof fields.handle === 'string' && /^api[-_]/i.test(fields.handle))
      result.warnings.push('Тип виджета: замените технический handle на имя секции.');
    if (!before) {
      const validatorModule: unknown = await import(
        pathToFileURL(
          join(ROOT, 'vendor/insales-coder/skills/insales-coder/scripts/validate-info-json.mjs'),
        ).href
      );
      if (!isRecord(validatorModule) || typeof validatorModule.validateInfoJson !== 'function')
        throw new Fault('invalid_response', 'Валидатор типов виджетов недоступен.');
      const infoKeys = [
        'type',
        'name',
        'description',
        'handle',
        'generation',
        'page_kinds',
        'widget_list_kinds',
        'widget_category_handle',
        'block_template_handle',
        'libraries',
      ];
      const info = Object.fromEntries(
        infoKeys.filter((k) => k in fields).map((k) => [k, fields[k]]),
      );
      // File metadata uses a number; the InSales strict API contract uses a string.
      info.generation = Number(info.generation);
      const validateInfoJson = validatorModule.validateInfoJson as (input: Json) => unknown;
      const checkedValue = validateInfoJson(info);
      if (
        !isRecord(checkedValue) ||
        !Array.isArray(checkedValue.errors) ||
        !Array.isArray(checkedValue.warnings)
      )
        throw new Fault('invalid_response', 'Валидатор типов виджетов вернул некорректный ответ.');
      const checked: Validation = {
        errors: checkedValue.errors as string[],
        warnings: checkedValue.warnings as string[],
      };
      result.errors.push(...checked.errors);
      result.warnings.push(...checked.warnings);
    }
  }
  return result;
}
