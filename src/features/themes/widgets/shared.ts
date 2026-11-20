import { isRecord, type Json } from '../../../shared/common.js';

const WIDGET_CODE_FIELDS = [
  'snippet_content',
  'snippet_scss',
  'snippet_js',
  'settings_form',
  'settings_data',
  'setup',
  'messages',
  'block_settings_presets',
  'libraries',
] as const;

const WIDGET_STABLE_FIELDS = [
  'name',
  'theme_id',
  'visible',
  'html_id',
  'settings',
  'block_list_id',
  'placements',
] as const;

const WIDGET_INSTANCE_FIELDS = [
  'name',
  'theme_id',
  'visible',
  'html_id',
  'block_list_id',
  'placements',
  'blocks',
] as const;

export function widgetTypeCode(widgetType: Json): Json {
  const source = isRecord(widgetType.source) ? widgetType.source : {};
  return Object.fromEntries(
    WIDGET_CODE_FIELDS.map((field) => [
      field,
      field === 'libraries' ? (widgetType?.libraries ?? []) : (source[field] ?? null),
    ]),
  );
}

export function widgetCode(widget: Json): Json {
  return widgetTypeCode(isRecord(widget.widget_type) ? widget.widget_type : {});
}

export function stableWidgetState(widget: Json): Json {
  return Object.fromEntries(WIDGET_STABLE_FIELDS.map((field) => [field, widget[field] ?? null]));
}

export function stableWidgetInstance(widget: Json): Json {
  return Object.fromEntries(WIDGET_INSTANCE_FIELDS.map((field) => [field, widget[field] ?? null]));
}
