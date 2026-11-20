import { z } from 'zod';
import { short, text } from '../../../shared/schema-primitives.js';

const translationsObject = z
  .object({
    ru: short.optional(),
    en: short.optional(),
    ua: short.optional(),
    es: short.optional(),
  })
  .strict()
  .refine((o) => Object.values(o).some(Boolean), 'Нужен хотя бы один перевод');

const translations = z.preprocess((val) => {
  if (typeof val === 'string') {
    try {
      const parsed: unknown = JSON.parse(val);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      return { ru: val };
    }
    return { ru: val };
  }
  return val;
}, translationsObject);
const pageKinds = z.enum([
  'all',
  'index',
  'collection',
  'product',
  'cart',
  'page',
  'search',
  'blog',
  'compare',
  'favorite',
  'article',
  'shared_cart',
]);
const listKinds = z.enum([
  'header',
  'before_content',
  'content',
  'sidebar',
  'after_content',
  'footer',
  'outside',
  'top_panel',
  'bottom_panel',
]);
export const widgetFields = z
  .object({
    type: z.enum(['SimpleWidgetType', 'BlockListWidgetType']).optional(),
    handle: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .max(100)
      .refine((s) => !s.startsWith('system_'), 'Создавать можно только пользовательские виджеты')
      .optional(),
    name: translations.optional(),
    description: translations.optional(),
    generation: z.enum(['2', '3', '4']).optional(),
    page_kinds: z.array(pageKinds).min(1).optional(),
    widget_list_kinds: z.array(listKinds).min(1).optional(),
    widget_category_handle: short.optional(),
    block_template_handle: short.optional(),
    libraries: z.array(short).max(50).optional(),
    snippet_content: text.optional(),
    snippet_scss: text.optional(),
    snippet_js: text.optional(),
    settings_form: text
      .describe(
        'Поколение 4: JSON-строка с двумя вкладками content и design; каждая — массив групп с items: массивом объектов полей.',
      )
      .optional(),
    settings_data: text.optional(),
    setup: text.optional(),
    messages: text.optional(),
  })
  .strict();
export const widgetCodeFields = z
  .object({
    snippet_content: text.optional(),
    snippet_scss: text.optional(),
    snippet_js: text.optional(),
    settings_form: text
      .describe(
        'Поколение 4: JSON-строка с двумя вкладками content и design; каждая — массив групп с items: массивом объектов полей.',
      )
      .optional(),
    settings_data: text.optional(),
    setup: text.optional(),
    messages: text.optional(),
    block_settings_presets: text.optional(),
    libraries: z.array(short).max(50).optional(),
  })
  .strict();
const settingName = z.string().min(1).max(200);
export const widgetSettingsFields = z
  .object({
    settings: z.record(settingName, z.unknown()).optional(),
    clear_settings: z.array(settingName).max(100).optional(),
    reset_settings: z.array(settingName).max(100).optional(),
  })
  .strict();
export const widgetCreateFields = z
  .object({
    name: short.optional(),
    settings: z.record(settingName, z.unknown()).optional(),
    html_id: short.optional(),
    visible: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict();
