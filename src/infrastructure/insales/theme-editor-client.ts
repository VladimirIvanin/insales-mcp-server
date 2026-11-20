import type { Api } from '../../api.js';
import { Fault, isRecord } from '../../shared/common.js';

export class ThemeEditorClient {
  constructor(
    private readonly api: Api,
    readonly storeId: string,
  ) {}
  private path(themeId: number, suffix: string) {
    if (!Number.isSafeInteger(themeId) || themeId <= 0)
      throw new Fault('validation_failed', 'Некорректный theme_id.');
    return `/admin/theme_editor/v1/themes/${themeId}/${suffix}`;
  }
  getAsset(themeId: number, id: number, source = true) {
    return this.api.requestObject(
      this.storeId,
      'GET',
      this.path(themeId, `assets/${id}.json?include_content=${source}`),
    );
  }
  getWidgetType(themeId: number, id: number, source = true) {
    return this.api.requestObject(
      this.storeId,
      'GET',
      this.path(themeId, `widget_types/${id}.json?view=${source ? 'full' : 'context'}`),
    );
  }
  listCustomWidgetTypes(themeId: number, page = 1, perPage = 50) {
    return this.api.requestObject(
      this.storeId,
      'GET',
      this.path(themeId, `widget_types.json?scope=custom&page=${page}&per_page=${perPage}`),
    );
  }
  async listAssets(themeId: number) {
    const result = await this.api.requestObject(
      this.storeId,
      'GET',
      this.path(themeId, 'assets.json'),
    );
    if (!Array.isArray(result.items) || !result.items.every(isRecord))
      throw new Fault('invalid_response', 'Некорректный список файлов темы.');
    return result.items;
  }
}
