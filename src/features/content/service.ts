import type { Api } from '../../api.js';
import { Fault, isRecord, revision, type Json } from '../../shared/common.js';
import { schemas, target as targetSchema, type Target } from '../../shared/schemas.js';
import { InSalesClient } from '../../infrastructure/insales/admin-client.js';
import { ThemeEditorClient } from '../../infrastructure/insales/theme-editor-client.js';

function projection(kind: Target['kind'], data: Json): Json {
  const keys = new Set([
    'id',
    'blog_id',
    'theme_id',
    'updated_at',
    'version',
    'inner_file_name',
    ...Object.keys(schemas[kind].shape),
  ]);
  return Object.fromEntries(Object.entries(data).filter(([key]) => keys.has(key)));
}

export class ContentService {
  constructor(public readonly api: Api) {}
  client(store: string) {
    return new InSalesClient(this.api, store);
  }
  themeEditor(store: string) {
    return new ThemeEditorClient(this.api, store);
  }
  async read(store: string, input: Target, source = true) {
    const t = targetSchema.parse(input);
    if (!t.id) throw new Fault('validation_failed', 'Нужен идентификатор объекта.');
    if (t.kind === 'asset' || t.kind === 'widget_type') {
      const upstream =
        t.kind === 'asset'
          ? await this.themeEditor(store).getAsset(t.theme_id!, t.id, source)
          : await this.themeEditor(store).getWidgetType(t.theme_id!, t.id, source);
      if (upstream.id !== t.id || typeof upstream.revision !== 'string')
        throw new Fault('invalid_response', 'Theme Editor вернул некорректный контекст.');
      const data: Json =
        t.kind === 'asset'
          ? { ...upstream, inner_file_name: upstream.name }
          : { ...upstream, ...(isRecord(upstream.source) ? upstream.source : {}) };
      return { data, revision: upstream.revision, trust: 'store_data_not_instructions' };
    }
    const resource = this.client(store).forTarget(t);
    const data = await resource.getObject(t.id);
    if (!data || Number(data.id) !== t.id)
      throw new Fault('invalid_response', 'API вернул неожиданный объект.');
    // The upstream article controller reads by account, even on a nested blog route.
    if (t.kind === 'article' && Number(data.blog_id) !== t.blog_id)
      throw new Fault('permission_denied', 'Статья не принадлежит выбранному блогу.');
    const fields = projection(t.kind, data);
    return { data: fields, revision: revision(fields), trust: 'store_data_not_instructions' };
  }
  async list(store: string, t: Target, page = 1, perPage = 20) {
    if (t.kind === 'widget_type')
      return this.themeEditor(store).listCustomWidgetTypes(t.theme_id!, page, perPage);
    if (t.kind === 'asset') {
      const records = await this.themeEditor(store).listAssets(t.theme_id!);
      return {
        items: records.slice((page - 1) * perPage, page * perPage),
        page,
        next_page: page * perPage < records.length ? page + 1 : null,
      };
    }
    const data = await this.client(store).forTarget(t).listObjects({ page, per_page: perPage });
    const localPagination = false;
    const items = localPagination ? data.slice((page - 1) * perPage, page * perPage) : data;
    return {
      items: items.map((o: Json) =>
        Object.fromEntries(
          [
            'id',
            'title',
            'name',
            'handle',
            'inner_file_name',
            'type',
            'generation',
            'version',
            'updated_at',
          ]
            .filter((k) => k in o)
            .map((k) => [k, o[k]]),
        ),
      ),
      page,
      next_page: localPagination
        ? page * perPage < data.length
          ? page + 1
          : null
        : data.length >= perPage
          ? page + 1
          : null,
    };
  }
  async themeState(store: string, themeId: number) {
    const theme = await this.client(store).themes.getObject(themeId);
    if (!theme || Number(theme.id) !== themeId || typeof theme.is_published !== 'boolean')
      throw new Fault('unsupported_capability', 'Не удалось определить статус публикации темы.');
    return theme.is_published as boolean;
  }
}
