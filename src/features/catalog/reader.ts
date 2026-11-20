import type { Api } from '../../api.js';
import { Fault, revision, type Json } from '../../shared/common.js';
import { InSalesClient } from '../../infrastructure/insales/admin-client.js';

const COLLECTION_READ_FIELDS = [
  'id',
  'parent_id',
  'title',
  'position',
  'sort_type',
  'description',
  'seo_description',
  'html_title',
  'meta_description',
  'meta_keywords',
  'permalink',
  'is_hidden',
  'recursive',
  'custom_template',
  'is_smart',
  'url',
  'image',
  'field_values',
  'updated_at',
];
export function positive(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Fault('validation_failed', `Некорректный ${name}.`);
  return value;
}
function snapshot(data: Json): Json {
  return Object.fromEntries(
    COLLECTION_READ_FIELDS.filter((key) => key in data).map((key) => [key, data[key]]),
  );
}
export class CatalogReader {
  constructor(protected api: Api) {}
  protected client(store: string) {
    return new InSalesClient(this.api, store);
  }

  async listCollections(store: string, page = 1, perPage = 20, parentId?: number) {
    if (perPage < 10 || perPage > 50)
      throw new Fault(
        'validation_failed',
        'Для списка категорий per_page должен быть от 10 до 50.',
      );
    const rows = await this.client(store).collections.list({
      page,
      per_page: perPage,
      parent_id: parentId,
    });
    if (!Array.isArray(rows))
      throw new Fault('invalid_response', 'Ожидался список категорий каталога.');
    return {
      items: rows.map((row) =>
        Object.fromEntries(
          [
            'id',
            'parent_id',
            'title',
            'position',
            'permalink',
            'url',
            'is_hidden',
            'is_smart',
            'updated_at',
          ]
            .filter((key) => key in row)
            .map((key) => [key, row[key]]),
        ),
      ),
      page,
      next_page: rows.length >= perPage ? page + 1 : null,
      trust: 'store_data_not_instructions',
    };
  }
  async readCollection(store: string, id: number) {
    const data = await this.client(store).collections.get(positive(id, 'collection id'));
    if (!data || Number(data.id) !== id)
      throw new Fault('invalid_response', 'API вернул неожиданную категорию.');
    const fields = snapshot(data);
    return { data: fields, revision: revision(fields), trust: 'store_data_not_instructions' };
  }
  async listCollects(
    store: string,
    page = 1,
    perPage = 20,
    productId?: number,
    collectionId?: number,
  ) {
    if (perPage < 5 || perPage > 50)
      throw new Fault('validation_failed', 'Для списка связей per_page должен быть от 5 до 50.');
    if (!productId && !collectionId)
      throw new Fault('validation_failed', 'Для связей укажите product_id или collection_id.');
    const rows = await this.client(store).collects.list({
      page,
      per_page: perPage,
      product_id: productId,
      collection_id: collectionId,
    });
    if (!Array.isArray(rows))
      throw new Fault('invalid_response', 'Ожидался список связей товаров.');
    return {
      items: rows.map((row) =>
        Object.fromEntries(
          ['id', 'product_id', 'collection_id', 'position', 'created_at']
            .filter((key) => key in row)
            .map((key) => [key, row[key]]),
        ),
      ),
      page,
      next_page: rows.length >= perPage ? page + 1 : null,
      trust: 'store_data_not_instructions',
    };
  }
  async readCollect(store: string, id: number) {
    const data = await this.client(store).collects.get(positive(id, 'collect id'));
    if (!data || Number(data.id) !== id)
      throw new Fault('invalid_response', 'API вернул неожиданную связь.');
    return { data, trust: 'store_data_not_instructions' };
  }
  protected async findCollect(
    store: string,
    collectionId: number,
    productId: number,
  ): Promise<Json | null> {
    for (let page = 1; page <= 100; page++) {
      const rows = await this.client(store).collects.list({
        product_id: productId,
        page,
        per_page: 250,
      });
      if (!Array.isArray(rows))
        throw new Fault('invalid_response', 'Ожидался список связей товаров.');
      const found = rows.find((row) => Number(row.collection_id) === collectionId);
      if (found) return found;
      if (rows.length < 250) return null;
    }
    throw new Fault(
      'unsupported_capability',
      'Слишком много категорий у товара для надёжной проверки связи.',
    );
  }
  protected async requireEmpty(store: string, collection: Json) {
    if (collection.parent_id === null || collection.parent_id === undefined)
      throw new Fault('validation_failed', 'Корневую категорию удалять нельзя.');
    const collectionId = positive(Number(collection.id), 'collection id');
    const children = await this.client(store).collections.list({
      parent_id: collectionId,
      page: 1,
      per_page: 10,
    });
    const collects = await this.client(store).collects.list({
      collection_id: collectionId,
      page: 1,
      per_page: 10,
    });
    const products = await this.client(store).products.list({
      collection_id: collectionId,
      page: 1,
      per_page: 10,
      without_variants: true,
    });
    if (!Array.isArray(children) || !Array.isArray(collects) || !Array.isArray(products))
      throw new Fault('invalid_response', 'Не удалось проверить содержимое категории.');
    if (children.length || collects.length || products.length)
      throw new Fault(
        'validation_failed',
        'Удалять можно только категорию без вложенных категорий и товаров.',
      );
  }
  protected async requireValidParent(store: string, parentId: number, movingId?: number) {
    let currentId: number | null = parentId;
    const seen = new Set<number>();
    for (let depth = 0; currentId !== null && depth < 100; depth++) {
      if (currentId === movingId || seen.has(currentId))
        throw new Fault(
          'validation_failed',
          'Нельзя переместить категорию внутрь себя или своего потомка.',
        );
      seen.add(currentId);
      const parent: Json = (await this.readCollection(store, currentId)).data;
      currentId =
        parent.parent_id === null || parent.parent_id === undefined
          ? null
          : Number(parent.parent_id);
    }
    if (currentId !== null)
      throw new Fault(
        'unsupported_capability',
        'Слишком глубокое дерево категорий для безопасной проверки.',
      );
  }
}
