import { requiredItem } from '../../shared/common.js';
import { decodeOperation } from '../../infrastructure/persistence/codecs.js';
import { randomUUID } from 'node:crypto';
import {
  Fault,
  definiteApiRejection,
  errorResult,
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
} from './shared.js';

export class ProductDetails extends ProductReader {
  async prepareDetails(
    store: string,
    productId: number,
    inputFields: unknown,
    baseRevision: string,
  ) {
    this.api.state.store(store);
    const parsed = productCardUpdate.safeParse(inputFields);
    if (!parsed.success)
      throw new Fault('validation_failed', 'Недопустимые поля карточки товара.', {
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    const fields = parsed.data as Json;
    if (!Object.keys(fields).length) throw new Fault('validation_failed', 'Пустое изменение.');
    const before = await this.read(store, productId);
    if (before.revision !== baseRevision)
      throw new Fault('conflict', 'Карточка изменилась после чтения.');
    const prepared: ProductDetailsWrite = {
      kind: 'product_details',
      id: randomUUID(),
      store_id: store,

      product_id: productId,
      fields,
      base_revision: baseRevision,
    };
    return prepared;
  }

  async prepareProperties(store: string, productId: number, input: unknown, baseRevision: string) {
    this.api.state.store(store);
    const parsed = productPropertiesChange.safeParse(input);
    if (!parsed.success)
      throw new Fault('validation_failed', 'Недопустимое изменение параметров товара.', {
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    const { set, remove_titles } = parsed.data;
    if (!set.length && !remove_titles.length)
      throw new Fault('validation_failed', 'Пустое изменение параметров.');
    const before = await this.read(store, productId);
    if (before.revision !== baseRevision)
      throw new Fault('conflict', 'Карточка изменилась после чтения.');
    const current = productProperties(before.data);
    const replacementTitles = new Set(set.map((pair) => pair.title.trim()));
    const removals = new Set(remove_titles.map((title) => title.trim()));
    if (
      replacementTitles.size + removals.size !==
        new Set([...replacementTitles, ...removals]).size ||
      removals.size !== remove_titles.length
    ) {
      throw new Fault(
        'validation_failed',
        'Название параметра не должно одновременно изменяться и удаляться.',
      );
    }
    for (const title of removals)
      if (!current.some((pair) => pair.title === title))
        throw new Fault('validation_failed', `Параметр ${title} отсутствует у товара.`);
    const additions = set.map((pair) => ({ title: pair.title.trim(), value: pair.value.trim() }));
    if (additions.some((pair) => !pair.title || !pair.value))
      throw new Fault('validation_failed', 'Название и значение параметра не должны быть пустыми.');
    const wanted = sortedPairs([
      ...current.filter((pair) => !replacementTitles.has(pair.title) && !removals.has(pair.title)),
      ...additions,
    ]);
    if (new Set(wanted.map((pair) => JSON.stringify(pair))).size !== wanted.length)
      throw new Fault('validation_failed', 'Параметр и его значение повторяются.');
    if (wanted.length > 100)
      throw new Fault('validation_failed', 'Не более 100 значений параметров за одно изменение.');
    if (JSON.stringify(wanted) === JSON.stringify(current))
      throw new Fault('validation_failed', 'Параметры не изменились.');
    const prepared: ProductDetailsWrite = {
      kind: 'product_details',
      id: randomUUID(),
      store_id: store,

      product_id: productId,
      fields: { properties_attributes: wanted },
      base_revision: baseRevision,
      expected_properties: wanted,
    };
    return prepared;
  }

  async prepareOptionAdd(store: string, productId: number, input: unknown, baseRevision: string) {
    this.api.state.store(store);
    const parsed = productOptionAdd.safeParse(input);
    if (!parsed.success)
      throw new Fault('validation_failed', 'Недопустимая опция товара.', {
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    const before = await this.read(store, productId);
    if (before.revision !== baseRevision)
      throw new Fault('conflict', 'Карточка изменилась после чтения.');
    const names = optionNames(before.data);
    if (names.length >= 16) throw new Fault('validation_failed', 'У товара уже 16 опций.');
    if (names.some((name) => String(name.title) === parsed.data.title))
      throw new Fault('validation_failed', 'Опция с таким названием уже есть у товара.');
    const expected = {
      title: parsed.data.title,
      value: parsed.data.default_value,
      existing_ids: names.map((name) => Number(name.id)),
    };
    const options = [
      ...names.map((name) => ({ option_name_id: Number(name.id) })),
      { title: expected.title, value: expected.value },
    ];
    const prepared: ProductDetailsWrite = {
      kind: 'product_details',
      id: randomUUID(),
      store_id: store,

      product_id: productId,
      fields: { options },
      base_revision: baseRevision,
      expected_option_add: expected,
    };
    return prepared;
  }

  async validateDetails(prepared: ProductDetailsWrite) {
    const before = await this.read(prepared.store_id, prepared.product_id);
    if (before.revision !== prepared.base_revision)
      throw new Fault('conflict', 'Карточка изменилась после чтения.');
    return {
      change_id: prepared.id,
      valid: true,
      items: [{ conflict: false, errors: [], warnings: [] }],
    };
  }

  async applyDetails(prepared: ProductDetailsWrite) {
    return this.api.state.lock(prepared.store_id, async () => {
      let op = this.api.state.get('operation', prepared.id, decodeOperation<Operation>);
      if (op) return op;
      await this.validateDetails(prepared);
      op = {
        id: prepared.id,
        store_id: prepared.store_id,
        product_id: prepared.product_id,
        status: 'running',
        items: [{ kind: 'product_details', status: 'sending' }],
      };
      this.api.state.put('operation', prepared.id, op);
      const step = requiredItem(op.items, 0);
      try {
        await this.client(prepared.store_id).products.update(prepared.product_id, prepared.fields);
        const after = await this.read(prepared.store_id, prepared.product_id);
        if (
          prepared.expected_properties &&
          JSON.stringify(productProperties(after.data)) !==
            JSON.stringify(prepared.expected_properties)
        ) {
          throw new Fault(
            'execution_unknown',
            'Параметры товара после записи отличаются от подготовленного набора.',
          );
        }
        if (prepared.expected_option_add) {
          const expected = prepared.expected_option_add;
          const names = optionNames(after.data);
          const added = names.find((name) => name.title === expected.title);
          if (
            !added ||
            names.length !== expected.existing_ids.length + 1 ||
            expected.existing_ids.some((id) => !names.some((name) => Number(name.id) === id)) ||
            (Array.isArray(after.data.variants) ? after.data.variants : []).some(
              (variant: Json) =>
                !variantOptionValues(variant, after.data).some(
                  (value: { title: string; value: string }) =>
                    value.title === expected.title && value.value === expected.value,
                ),
            )
          ) {
            throw new Fault(
              'execution_unknown',
              'Новая опция не появилась на каждом варианте товара.',
            );
          }
        }
        for (const [key, value] of Object.entries(prepared.fields)) {
          if (Array.isArray(value) || key.endsWith('_attributes') || !(key in after.data)) continue;
          if (JSON.stringify(after.data[key]) !== JSON.stringify(value))
            throw new Fault('execution_unknown', `Не удалось подтвердить поле ${key}.`);
        }
        step.status = 'applied';
        step.result_id = prepared.product_id;
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
