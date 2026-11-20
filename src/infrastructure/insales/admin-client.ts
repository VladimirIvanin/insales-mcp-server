import { Fault, isRecord, sleep, type Json } from '../../shared/common.js';
import type { Api } from '../../api.js';
import type { Target } from '../../shared/schemas.js';
import { decodeAssetBody } from '../../features/themes/asset-body.js';

type QueryValue = string | number | boolean | undefined;
type Query = Record<string, QueryValue>;

function positiveId(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Fault('validation_failed', `Некорректный ${name}.`);
  return value;
}

function queryString(query: Query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  const value = params.toString();
  return value ? `?${value}` : '';
}

function object(value: unknown): Json {
  if (!isRecord(value)) throw new Fault('invalid_response', 'Ожидался объект.');
  return value;
}
function objects(value: unknown): Json[] {
  if (!Array.isArray(value) || !value.every(isRecord))
    throw new Fault('invalid_response', 'Ожидался список объектов.');
  return value;
}

export class ReadResource {
  constructor(
    protected api: Api,
    protected storeId: string,
    protected path: string,
  ) {}

  async list(query: Query = {}): Promise<Json[]> {
    return objects(
      await this.api.request(this.storeId, 'GET', `${this.path}.json${queryString(query)}`),
    );
  }

  async get(id: number): Promise<Json> {
    return object(
      await this.api.request(this.storeId, 'GET', `${this.path}/${positiveId(id, 'id')}.json`),
    );
  }

  async listObjects(query: Query = {}): Promise<Record<string, unknown>[]> {
    const value = await this.api.requestUnknown(
      this.storeId,
      'GET',
      `${this.path}.json${queryString(query)}`,
    );
    return objects(value);
  }

  async getObject(id: number): Promise<Record<string, unknown>> {
    const value = await this.api.requestUnknown(
      this.storeId,
      'GET',
      `${this.path}/${positiveId(id, 'id')}.json`,
    );
    return object(value);
  }
}

export class CrudResource extends ReadResource {
  constructor(
    api: Api,
    storeId: string,
    path: string,
    private wrapper: string | null,
  ) {
    super(api, storeId, path);
  }

  private body(fields: Json) {
    return this.wrapper ? { [this.wrapper]: fields } : fields;
  }

  async create(fields: Json): Promise<Json> {
    return object(
      await this.api.request(this.storeId, 'POST', `${this.path}.json`, this.body(fields)),
    );
  }

  async update(id: number, fields: Json): Promise<Json> {
    return object(
      await this.api.request(
        this.storeId,
        'PUT',
        `${this.path}/${positiveId(id, 'id')}.json`,
        this.body(fields),
      ),
    );
  }

  remove(id: number) {
    return this.api.request(this.storeId, 'DELETE', `${this.path}/${positiveId(id, 'id')}.json`);
  }
}

export class AssetResource extends CrudResource {
  async raw(id: number) {
    return decodeAssetBody(
      await this.api.requestUnknown(
        this.storeId,
        'GET',
        `${this.path}/${positiveId(id, 'asset id')}/raw`,
        undefined,
        { raw: 'bytes' },
      ),
    );
  }
}

export interface ThemeDuplicationOperation {
  id: string;
  type: 'theme.duplicate';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  stage: string | null;
  source_theme_id: number;
  result: { theme_id: number } | null;
  error: { code: string; message: string } | null;
}

function operation(value: unknown): ThemeDuplicationOperation {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    value.type !== 'theme.duplicate' ||
    !['queued', 'running', 'succeeded', 'failed'].includes(String(value.status)) ||
    !Number.isSafeInteger(value.source_theme_id) ||
    (value.status === 'succeeded' &&
      (!isRecord(value.result) || !Number.isSafeInteger(value.result.theme_id))) ||
    (value.status === 'failed' &&
      (!isRecord(value.error) ||
        typeof value.error.code !== 'string' ||
        typeof value.error.message !== 'string'))
  )
    throw new Fault('invalid_response', 'InSales вернул некорректную операцию копирования.');
  return value as unknown as ThemeDuplicationOperation;
}

export class ThemeResource extends ReadResource {
  async beginDuplicate(
    themeId: number,
    parameters: { title?: string; language_id?: number },
    idempotencyKey: string,
  ): Promise<ThemeDuplicationOperation> {
    if (
      !Number.isSafeInteger(themeId) ||
      themeId <= 0 ||
      !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)
    )
      throw new Fault(
        'validation_failed',
        'Нужны theme_id и ключ идемпотентности (1–128 ASCII-символов).',
      );
    return operation(
      await this.api.request(
        this.storeId,
        'POST',
        `${this.path}/${themeId}/duplicate.json`,
        parameters,
        { idempotencyKey },
      ),
    );
  }

  async getOperation(id: string): Promise<ThemeDuplicationOperation> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
      throw new Fault('validation_failed', 'Нужен UUID операции.');
    const result = operation(
      await this.api.request(
        this.storeId,
        'GET',
        `/admin/themes/duplicate_status.json?operation_id=${id}`,
      ),
    );
    if (result.id !== id) throw new Fault('invalid_response', 'Ответ относится к другой операции.');
    return result;
  }

  async duplicateAndWait(
    themeId: number,
    parameters: { title?: string; language_id?: number },
    idempotencyKey: string,
    timeoutMs = 60_000,
  ): Promise<ThemeDuplicationOperation> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000)
      throw new Fault('validation_failed', 'Время ожидания должно быть от 0 до 60000 мс.');
    const deadline = Date.now() + timeoutMs;
    let result = await this.beginDuplicate(themeId, parameters, idempotencyKey);
    while (result.status === 'queued' || result.status === 'running') {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Fault(
          'operation_wait_timeout',
          'Проверка завершена; копирование может продолжаться.',
          {
            operation_id: result.id,
            status: result.status,
            idempotency_key: idempotencyKey,
          },
        );
      await sleep(Math.min(3000, remaining));
      try {
        result = await this.getOperation(result.id);
      } catch (error) {
        const details = { operation_id: result.id, idempotency_key: idempotencyKey };
        if (error instanceof Fault)
          throw new Fault(error.code, error.message, { ...error.details, ...details });
        throw new Fault('operation_check_interrupted', 'Проверка копирования прервана.', details);
      }
    }
    return result;
  }
}

/**
 * Store-scoped InSales API client. HttpTransport owns auth/network policy;
 * this layer owns resource paths, JSON envelopes and nested scopes.
 */
export class InSalesClient {
  readonly pages: CrudResource;
  readonly products: CrudResource;
  readonly collections: CrudResource;
  readonly collects: CrudResource;
  readonly blogs: ReadResource;
  readonly themes: ThemeResource;

  constructor(
    private api: Api,
    readonly storeId: string,
  ) {
    this.pages = new CrudResource(api, storeId, '/admin/pages', 'page');
    this.products = new CrudResource(api, storeId, '/admin/products', 'product');
    this.collections = new CrudResource(api, storeId, '/admin/collections', 'collection');
    this.collects = new CrudResource(api, storeId, '/admin/collects', 'collect');
    this.blogs = new ReadResource(api, storeId, '/admin/blogs');
    this.themes = new ThemeResource(api, storeId, '/admin/themes');
  }

  articles(blogId: number) {
    return new CrudResource(
      this.api,
      this.storeId,
      `/admin/blogs/${positiveId(blogId, 'blog_id')}/articles`,
      'article',
    );
  }

  variants(productId: number) {
    return new CrudResource(
      this.api,
      this.storeId,
      `/admin/products/${positiveId(productId, 'product_id')}/variants`,
      'variant',
    );
  }

  images(productId: number) {
    return new CrudResource(
      this.api,
      this.storeId,
      `/admin/products/${positiveId(productId, 'product_id')}/images`,
      'image',
    );
  }

  assets(themeId: number) {
    return new AssetResource(
      this.api,
      this.storeId,
      `/admin/themes/${positiveId(themeId, 'theme_id')}/assets`,
      'asset',
    );
  }

  widgetTypes(themeId: number) {
    return new CrudResource(
      this.api,
      this.storeId,
      `/admin/themes/${positiveId(themeId, 'theme_id')}/widget_types`,
      null,
    );
  }

  forTarget(target: Target): CrudResource {
    if (target.kind === 'page') return this.pages;
    if (target.kind === 'product') return this.products;
    if (target.kind === 'article') return this.articles(positiveId(target.blog_id ?? 0, 'blog_id'));
    if (target.kind === 'asset') return this.assets(positiveId(target.theme_id ?? 0, 'theme_id'));
    return this.widgetTypes(positiveId(target.theme_id ?? 0, 'theme_id'));
  }
}
