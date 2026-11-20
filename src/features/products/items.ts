import { requiredItem } from '../../shared/common.js';
import { decodeOperation } from '../../infrastructure/persistence/codecs.js';
import { randomUUID } from 'node:crypto';
import {
  Fault,
  definiteApiRejection,
  errorResult,
  isRecord,
  revision,
  type Json,
} from '../../shared/common.js';
import { attachment, localFile, type LocalFile } from '../../infrastructure/uploads/image.js';
import {
  productCreateInput,
  productCardUpdate,
  productPropertiesChange,
  productOptionAdd,
  productVariantChange,
  productImageChange,
  productImagesBatchInput,
} from '../../shared/schemas.js';
import { ProductReader } from './reader.js';
import type {
  ProductPlan,
  ProductWrite,
  ProductItemWrite,
  ProductImagesBatchWrite,
  ProductDetailsWrite,
  Step,
  Operation,
} from './types.js';
import {
  CREATE_KEYS,
  FIRST_VARIANT_KEYS,
  pick,
  omit,
  checkId,
  validatePlan,
  sortedPairs,
  productProperties,
  optionNames,
  variantOptionValues,
  verifyVariantOptions,
  validateVariantOptions,
  sameIdSet,
} from './shared.js';

export class ProductItems extends ProductReader {
  async readItem(store: string, productId: number, itemKind: 'variant' | 'image', itemId: number) {
    this.api.state.store(store);
    const resource =
      itemKind === 'variant'
        ? this.client(store).variants(productId)
        : this.client(store).images(productId);
    const data = await resource.get(itemId);
    if (Number(data?.id) !== itemId || Number(data?.product_id) !== productId)
      throw new Fault('invalid_response', 'API вернул объект другого товара.');
    return { data, revision: revision(data), trust: 'store_data_not_instructions' };
  }

  async prepareItem(
    store: string,
    productId: number,
    itemKind: 'variant' | 'image',
    action: 'create' | 'update' | 'delete',
    itemId?: number,
    inputFields?: unknown,
    baseRevision?: string,
  ) {
    this.api.state.store(store);
    const schema = itemKind === 'variant' ? productVariantChange : productImageChange;
    const parsed = schema.safeParse(inputFields ?? {});
    if (!parsed.success)
      throw new Fault('validation_failed', 'Недопустимые поля варианта или изображения.', {
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    const fields = parsed.data as Json;
    const work = async () => {
      const product = (await this.read(store, productId)).data;
      if (itemKind === 'variant') validateVariantOptions(product, fields, action, itemId);
      if (action === 'create') {
        if (itemId || baseRevision)
          throw new Fault('validation_failed', 'При создании не передавайте id и base_revision.');
        if (itemKind === 'image' && !fields.src && !fields.local_path)
          throw new Fault('validation_failed', 'Для изображения нужен src или local_path.');
        if (itemKind === 'variant' && Array.isArray(fields.image_ids)) {
          for (const imageId of fields.image_ids)
            await this.readItem(store, productId, 'image', Number(imageId));
        }
      } else {
        if (!itemId || !baseRevision)
          throw new Fault(
            'validation_failed',
            'Для изменения или удаления нужны id и base_revision из read_product_item.',
          );
        if (
          (action === 'update' && !Object.keys(fields).length) ||
          (action === 'delete' && Object.keys(fields).length)
        )
          throw new Fault('validation_failed', 'Пустое изменение или поля при удалении.');
      }
      const before =
        action === 'create' ? null : await this.readItem(store, productId, itemKind, itemId!);
      if (before && before.revision !== baseRevision)
        throw new Fault('conflict', 'Объект изменился после чтения.');
      if (itemKind === 'variant' && Array.isArray(fields.image_ids))
        for (const imageId of fields.image_ids)
          await this.readItem(store, productId, 'image', Number(imageId));
      const local_file =
        typeof fields.local_path === 'string' ? await localFile(fields.local_path) : undefined;
      const prepared: ProductItemWrite = {
        kind: 'product_item',
        id: randomUUID(),
        store_id: store,

        product_id: productId,
        item_kind: itemKind,
        item_id: itemId,
        action,
        fields,
        base_revision: baseRevision,
        local_file,
      };
      return prepared;
    };
    return fields.local_path ? this.api.state.lock('maintenance:uploads', work) : work();
  }

  async prepareImagesBatch(store: string, input: unknown) {
    this.api.state.store(store);
    const parsed = productImagesBatchInput.safeParse(input);
    if (!parsed.success)
      throw new Fault('validation_failed', 'Недопустимый пакет изображений.', {
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    const seen = new Set<string>();
    for (const item of parsed.data) {
      if (!item.fields.src && !item.fields.local_path)
        throw new Fault('validation_failed', 'Для каждого изображения нужен src или local_path.');
      const source = item.fields.src ?? item.fields.local_path;
      const key = `${item.product_id}:${source}`;
      if (seen.has(key))
        throw new Fault('validation_failed', 'Одно изображение товара повторяется в пакете.');
      seen.add(key);
    }
    const items: ProductItemWrite[] = [];
    for (const item of parsed.data) {
      const prepared = await this.prepareItem(
        store,
        item.product_id,
        'image',
        'create',
        undefined,
        item.fields,
      );
      items.push(prepared);
    }
    const prepared: ProductImagesBatchWrite = {
      kind: 'product_images_batch',
      id: randomUUID(),
      store_id: store,

      items,
    };
    return prepared;
  }

  async validateImagesBatch(prepared: ProductImagesBatchWrite) {
    const items = [];
    for (const item of prepared.items) {
      try {
        await this.validateItem(item);
        items.push({
          target: { kind: 'image', product_id: item.product_id },
          conflict: false,
          errors: [],
          warnings: [],
        });
      } catch (error) {
        items.push({
          target: { kind: 'image', product_id: item.product_id },
          conflict: error instanceof Fault && error.code === 'conflict',
          errors: [errorResult(error)],
          warnings: [],
        });
      }
    }
    return {
      change_id: prepared.id,
      valid: items.every((item) => !item.conflict && !item.errors.length),
      items,
    };
  }

  async applyImagesBatch(prepared: ProductImagesBatchWrite) {
    return this.api.state.lock(`batch:${prepared.id}`, async () => {
      let op = this.api.state.get('operation', prepared.id, decodeOperation<Operation>);
      if (!op) {
        op = {
          id: prepared.id,
          store_id: prepared.store_id,
          status: 'running',
          items: prepared.items.map((item) => ({
            kind: 'image',
            product_id: item.product_id,
            change_id: item.id,
            status: 'pending',
          })),
        };
        this.api.state.put('operation', prepared.id, op);
      }
      for (let index = 0; index < prepared.items.length; index++) {
        const step = requiredItem(op.items, index);
        if (step.status !== 'pending' && step.status !== 'sending') continue;
        step.status = 'sending';
        this.api.state.put('operation', prepared.id, op);
        try {
          const child = await this.applyItem(requiredItem(prepared.items, index));
          const result = requiredItem(child.items, 0);
          if (child.status === 'applied') {
            step.status = 'applied';
            step.result_id = result.result_id;
          } else if (child.status === 'partial_failure') {
            step.status = 'failed';
            step.error = result.error;
          } else {
            step.status = 'execution_unknown';
            step.error = result.error;
          }
        } catch (error) {
          const result = errorResult(error);
          step.status =
            definiteApiRejection(result.code) ||
            ['conflict', 'expired', 'operation_busy'].includes(result.code)
              ? 'failed'
              : 'execution_unknown';
          step.error = result;
        }
        this.api.state.put('operation', prepared.id, op);
      }
      op.status = op.items.every((item) => item.status === 'applied')
        ? 'applied'
        : op.items.some((item) => item.status === 'execution_unknown')
          ? 'execution_unknown'
          : 'partial_failure';
      this.api.state.put('operation', prepared.id, op);
      return op;
    });
  }

  async validateItem(prepared: ProductItemWrite) {
    const product = (await this.read(prepared.store_id, prepared.product_id)).data;
    if (prepared.item_kind === 'variant')
      validateVariantOptions(product, prepared.fields, prepared.action, prepared.item_id);
    if (prepared.local_file) await localFile(prepared.local_file.path, prepared.local_file);
    if (prepared.action !== 'create') {
      const before = await this.readItem(
        prepared.store_id,
        prepared.product_id,
        prepared.item_kind,
        prepared.item_id!,
      );
      if (before.revision !== prepared.base_revision)
        throw new Fault('conflict', 'Объект изменился после чтения.');
    }
    return {
      change_id: prepared.id,
      valid: true,
      items: [{ conflict: false, errors: [], warnings: [] }],
    };
  }

  async applyItem(prepared: ProductItemWrite) {
    return this.api.state.lock(prepared.store_id, async () => {
      let op = this.api.state.get('operation', prepared.id, decodeOperation<Operation>);
      if (op) return op;
      await this.validateItem(prepared);
      op = {
        id: prepared.id,
        store_id: prepared.store_id,
        product_id: prepared.product_id,
        status: 'running',
        items: [{ kind: prepared.item_kind, status: 'sending' }],
      };
      this.api.state.put('operation', prepared.id, op);
      const step = requiredItem(op.items, 0);
      try {
        const client = this.client(prepared.store_id);
        const resource =
          prepared.item_kind === 'variant'
            ? client.variants(prepared.product_id)
            : client.images(prepared.product_id);
        const fields = { ...prepared.fields };
        if (prepared.local_file) {
          fields.attachment = await attachment(prepared.local_file);
          fields.filename = fields.filename ?? prepared.local_file.filename;
          delete fields.local_path;
        }
        if (prepared.action === 'create')
          step.result_id = checkId((await resource.create(fields))?.id, prepared.item_kind);
        else if (prepared.action === 'update') {
          await resource.update(prepared.item_id!, fields);
          step.result_id = prepared.item_id;
        } else {
          await resource.remove(prepared.item_id!);
          step.result_id = prepared.item_id;
        }
        this.api.state.put('operation', prepared.id, op);
        if (prepared.action === 'delete') {
          try {
            await this.readItem(
              prepared.store_id,
              prepared.product_id,
              prepared.item_kind,
              prepared.item_id!,
            );
            throw new Fault('execution_unknown', 'Удаление ещё не подтверждено.');
          } catch (error) {
            if (!(error instanceof Fault && error.code === 'not_found')) throw error;
          }
        } else {
          const after = await this.readItem(
            prepared.store_id,
            prepared.product_id,
            prepared.item_kind,
            step.result_id!,
          );
          if (prepared.item_kind === 'variant') {
            if (Array.isArray(prepared.fields.options) && prepared.fields.options.every(isRecord))
              verifyVariantOptions(
                after.data,
                (await this.read(prepared.store_id, prepared.product_id)).data,
                prepared.fields.options,
              );
            if (
              prepared.fields.image_ids &&
              !sameIdSet(after.data.image_ids, prepared.fields.image_ids)
            ) {
              throw new Fault(
                'execution_unknown',
                'Изображения варианта после записи отличаются от запрошенных.',
              );
            }
            if (
              prepared.fields.price !== undefined &&
              Number(after.data.price) !== Number(prepared.fields.price)
            ) {
              throw new Fault(
                'execution_unknown',
                'Цена варианта после записи отличается от запрошенной.',
              );
            }
          }
        }
        step.status = 'applied';
        op.status = 'applied';
      } catch (error) {
        const result = errorResult(error);
        step.error = result;
        step.status = definiteApiRejection(result.code) ? 'failed' : 'execution_unknown';
        op.status = step.status === 'failed' ? 'partial_failure' : 'execution_unknown';
      }
      this.api.state.put('operation', prepared.id, op);
      return op;
    });
  }
}
