import { requiredItem } from '../../shared/common.js';
import { decodeOperation } from '../../infrastructure/persistence/codecs.js';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  Fault,
  canonical,
  definiteApiRejection,
  errorResult,
  isRecord,
  revision,
  type Json,
} from '../../shared/common.js';
import { collectionFields } from '../../shared/schemas.js';
import { CatalogReader, positive } from './reader.js';

type CollectionAction = 'create' | 'update' | 'delete';
type MembershipAction = 'add' | 'remove';
interface DraftBase {
  id: string;
  store_id: string;
}
export interface CollectionWrite extends DraftBase {
  kind: 'collection';
  action: CollectionAction;
  collection_id?: number | undefined;
  fields: z.infer<typeof collectionFields>;
  before: Json | null;
  base_revision?: string | undefined;
}
export interface MembershipWrite extends DraftBase {
  kind: 'membership';
  action: MembershipAction;
  collection_id: number;
  product_id: number;
  collect_id?: number | undefined;
}
export type CatalogWrite = CollectionWrite | MembershipWrite;
interface Operation {
  id: string;
  store_id: string;
  status: string;
  items: (Json & {
    status: string;
    result_id?: number | undefined;
    revision?: string | undefined;
  })[];
}

function isNotFound(error: unknown) {
  return error instanceof Fault && error.code === 'not_found';
}

export class Catalog extends CatalogReader {
  async prepareCollection(
    store: string,
    action: CollectionAction,
    id?: number,
    inputFields?: unknown,
    baseRevision?: string,
  ) {
    this.api.state.store(store);
    const parsed = collectionFields.safeParse(inputFields ?? {});
    if (!parsed.success)
      throw new Fault('validation_failed', 'Недопустимые поля категории.', {
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    const fields = parsed.data;
    if (action === 'create') {
      if (id || baseRevision || !fields.title || !fields.parent_id)
        throw new Fault(
          'validation_failed',
          'Для создания нужны title и parent_id, но не id/revision.',
        );
      await this.requireValidParent(store, fields.parent_id);
    } else {
      if (!id || !baseRevision)
        throw new Fault(
          'validation_failed',
          'Для изменения или удаления нужны id и base_revision.',
        );
      if (action === 'update' && !Object.keys(fields).length)
        throw new Fault('validation_failed', 'Пустое изменение.');
      if (action === 'delete' && Object.keys(fields).length)
        throw new Fault('validation_failed', 'При удалении поля передавать нельзя.');
    }
    const read = action === 'create' ? null : await this.readCollection(store, id!);
    if (read && read.revision !== baseRevision)
      throw new Fault('conflict', 'Категория изменилась после чтения.');
    if (action === 'update' && fields.parent_id !== undefined) {
      if (read!.data.parent_id === null)
        throw new Fault('validation_failed', 'Корневую категорию перемещать нельзя.');
      await this.requireValidParent(store, fields.parent_id, id);
    }
    if (action === 'delete') await this.requireEmpty(store, read!.data);
    const before = read?.data ?? null;
    const prepared: CollectionWrite = {
      kind: 'collection',
      id: randomUUID(),
      store_id: store,
      action,
      collection_id: id,
      fields,
      before,
      base_revision: baseRevision,
    };
    return prepared;
  }

  async prepareMembership(
    store: string,
    action: MembershipAction,
    collectionId: number,
    productId: number,
  ) {
    this.api.state.store(store);
    positive(collectionId, 'collection_id');
    positive(productId, 'product_id');
    const collection = (await this.readCollection(store, collectionId)).data;
    if (collection.is_smart === true)
      throw new Fault(
        'unsupported_capability',
        'Состав смарт-категории определяется фильтрами автоматически.',
      );
    await this.client(store).products.get(productId);
    const existing = await this.findCollect(store, collectionId, productId);
    if (action === 'add' && existing)
      throw new Fault('conflict', 'Товар уже находится в категории.');
    if (action === 'remove' && !existing)
      throw new Fault('not_found', 'Товара нет в выбранной категории.');
    const prepared: MembershipWrite = {
      kind: 'membership',
      id: randomUUID(),
      store_id: store,
      action,
      collection_id: collectionId,
      product_id: productId,
      collect_id: existing ? positive(Number(existing.id), 'collect id') : undefined,
    };
    return prepared;
  }

  async validate(prepared: CatalogWrite) {
    let conflict = false;
    let error: string | undefined;
    try {
      if (prepared.kind === 'collection') {
        if (prepared.action === 'create') {
          if (prepared.fields.parent_id === undefined)
            throw new Fault('invalid_response', 'У категории не указан parent_id.');
          await this.requireValidParent(prepared.store_id, prepared.fields.parent_id);
        } else {
          const current = await this.readCollection(prepared.store_id, prepared.collection_id!);
          conflict = current.revision !== prepared.base_revision;
          if (!conflict && prepared.action === 'update' && prepared.fields.parent_id !== undefined)
            await this.requireValidParent(
              prepared.store_id,
              prepared.fields.parent_id,
              prepared.collection_id,
            );
          if (!conflict && prepared.action === 'delete')
            await this.requireEmpty(prepared.store_id, current.data);
        }
      } else {
        const collection = (await this.readCollection(prepared.store_id, prepared.collection_id))
          .data;
        if (collection.is_smart === true)
          throw new Fault(
            'unsupported_capability',
            'Состав смарт-категории меняется автоматически.',
          );
        await this.client(prepared.store_id).products.get(prepared.product_id);
        const current = await this.findCollect(
          prepared.store_id,
          prepared.collection_id,
          prepared.product_id,
        );
        conflict =
          prepared.action === 'add' ? !!current : Number(current?.id) !== prepared.collect_id;
      }
    } catch (cause) {
      if (
        cause instanceof Fault &&
        ['validation_failed', 'not_found', 'unsupported_capability'].includes(cause.code)
      )
        error = cause.message;
      else throw cause;
    }
    return {
      change_id: prepared.id,
      valid: !conflict && !error,
      items: [{ conflict, errors: error ? [error] : [], warnings: [] }],
    };
  }
  private async matchesCollection(prepared: CollectionWrite, id: number) {
    const after = (await this.readCollection(prepared.store_id, id)).data;
    for (const [key, value] of Object.entries(prepared.fields)) {
      if (key === 'image_attributes') {
        const afterImage = isRecord(after.image) ? after.image : undefined;
        const beforeImage = isRecord(prepared.before?.image) ? prepared.before.image : undefined;
        const requestedImage = isRecord(value) ? value : undefined;
        if (!afterImage?.id || !afterImage.original_url) return false;
        if (
          beforeImage?.id === afterImage.id &&
          beforeImage.original_url === afterImage.original_url &&
          requestedImage?.src !== afterImage.original_url
        )
          return false;
      } else if (key === 'field_values_attributes') {
        if (!Array.isArray(value) || !value.every(isRecord)) return false;
        for (const field of value) {
          if (typeof field.handle === 'string') {
            const found = await this.api.requestObject(
              prepared.store_id,
              'GET',
              `/admin/collections/${id}/collection_field_values/${encodeURIComponent(field.handle)}.json`,
            );
            if (canonical(found.value) !== canonical(field.value)) return false;
          } else {
            const fieldValues = Array.isArray(after.field_values) ? after.field_values : [];
            const found = fieldValues.find(
              (item: unknown) =>
                isRecord(item) &&
                (field.id === undefined || Number(item.id) === Number(field.id)) &&
                (field.collection_field_id === undefined ||
                  Number(item.collection_field_id) === Number(field.collection_field_id)),
            ) as Json | undefined;
            if (!found || canonical(found.value) !== canonical(field.value)) return false;
          }
        }
      } else if (canonical(after[key]) !== canonical(value)) return false;
    }
    return after;
  }
  private async reconcile(prepared: CatalogWrite, op: Operation) {
    const step = requiredItem(op.items, 0);
    try {
      if (prepared.kind === 'collection') {
        if (prepared.action === 'delete') {
          try {
            await this.readCollection(prepared.store_id, prepared.collection_id!);
            return false;
          } catch (error) {
            if (!isNotFound(error)) throw error;
          }
          step.status = 'accepted_async';
          op.status = 'accepted_async';
          return true;
        }
        const id = prepared.collection_id ?? step.result_id;
        if (!id) return false;
        const after = await this.matchesCollection(prepared, id);
        if (!after) return false;
        step.status = 'applied';
        step.result_id = id;
        step.revision = revision(after);
        op.status = 'applied';
        return true;
      }
      let current;
      if (prepared.action === 'add') {
        current = step.result_id
          ? await this.client(prepared.store_id).collects.get(step.result_id)
          : await this.findCollect(prepared.store_id, prepared.collection_id, prepared.product_id);
      } else {
        try {
          current = await this.client(prepared.store_id).collects.get(prepared.collect_id!);
        } catch (error) {
          if (!isNotFound(error)) throw error;
          current = null;
        }
      }
      if (
        prepared.action === 'add' &&
        current &&
        (Number(current.collection_id) !== prepared.collection_id ||
          Number(current.product_id) !== prepared.product_id)
      )
        return false;
      if (prepared.action === 'add' ? !current : !!current) return false;
      step.status = 'applied';
      step.result_id = current && typeof current.id === 'number' ? current.id : prepared.collect_id;
      op.status = 'applied';
      return true;
    } catch {
      return false;
    }
  }
  async apply(prepared: CatalogWrite) {
    return this.api.state.lock(prepared.store_id, async () => {
      let op = this.api.state.get('operation', prepared.id, decodeOperation<Operation>);
      if (op) {
        if (op.status === 'execution_unknown' && (await this.reconcile(prepared, op)))
          this.api.state.put('operation', prepared.id, op);
        return op;
      }
      const check = await this.validate(prepared);
      if (!check.valid)
        throw new Fault(
          requiredItem(check.items, 0).conflict ? 'conflict' : 'validation_failed',
          'Проверка изменения не пройдена.',
          { validation: check },
        );
      op = {
        id: prepared.id,
        store_id: prepared.store_id,
        status: 'running',
        items: [
          {
            status: 'sending',
            target:
              prepared.kind === 'collection'
                ? { kind: 'collection', id: prepared.collection_id }
                : {
                    kind: 'membership',
                    collection_id: prepared.collection_id,
                    product_id: prepared.product_id,
                  },
          },
        ],
      };
      this.api.state.put('operation', prepared.id, op);
      const step = requiredItem(op.items, 0);
      try {
        if (prepared.kind === 'collection') {
          const resource = this.client(prepared.store_id).collections;
          if (prepared.action === 'create') {
            const response = await resource.create(prepared.fields);
            step.result_id = Number(response?.id);
          } else if (prepared.action === 'update') {
            await resource.update(prepared.collection_id!, prepared.fields);
            step.result_id = prepared.collection_id;
          } else await resource.remove(prepared.collection_id!);
        } else {
          const resource = this.client(prepared.store_id).collects;
          if (prepared.action === 'add') {
            const response = await resource.create({
              collection_id: prepared.collection_id,
              product_id: prepared.product_id,
            });
            step.result_id = Number(response?.id);
          } else await resource.remove(prepared.collect_id!);
        }
        this.api.state.put('operation', prepared.id, op);
        if (!(await this.reconcile(prepared, op)))
          throw new Fault('execution_unknown', 'Не удалось подтвердить результат записи.');
      } catch (error) {
        if (!(await this.reconcile(prepared, op))) {
          const err = errorResult(error);
          const rejected = definiteApiRejection(err.code) || err.code === 'conflict';
          step.status = rejected ? 'failed' : 'execution_unknown';
          step.error = err;
          op.status = rejected ? 'partial_failure' : 'execution_unknown';
        }
      }
      this.api.state.put('operation', prepared.id, op);
      return op;
    });
  }
}
