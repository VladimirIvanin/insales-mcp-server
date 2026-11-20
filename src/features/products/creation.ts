import { decodeOperation } from '../../infrastructure/persistence/codecs.js';
import { randomUUID } from 'node:crypto';
import {
  Fault,
  definiteApiRejection,
  errorResult,
  isRecord,
  requiredItem,
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

export class ProductCreation extends ProductReader {
  async prepareCreate(store: string, input: unknown) {
    this.api.state.store(store);
    const parsed = productCreateInput.safeParse(input);
    if (!parsed.success)
      throw new Fault('validation_failed', 'Недопустимые поля карточки товара.', {
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    const plan = parsed.data;
    validatePlan(plan);
    const work = async () => {
      const local_files: Record<string, LocalFile> = {};
      for (const image of plan.images)
        if (image.local_path) local_files[image.key] = await localFile(image.local_path);
      for (const collectionId of plan.collection_ids) {
        const collection = await this.client(store).collections.get(collectionId);
        if (Number(collection?.id) !== collectionId || collection.is_smart === true)
          throw new Fault('validation_failed', 'Категория должна существовать и быть обычной.');
      }
      for (const relatedId of new Set([...plan.similar_ids, ...plan.supplementary_ids]))
        await this.client(store).products.get(relatedId);
      const prepared: ProductWrite = {
        kind: 'product_create',
        id: randomUUID(),
        store_id: store,

        plan,
        local_files,
      };
      return prepared;
    };
    return plan.images.some((image) => image.local_path)
      ? this.api.state.lock('maintenance:uploads', work)
      : work();
  }

  async validate(prepared: ProductWrite) {
    for (const [key, file] of Object.entries(prepared.local_files))
      await localFile(file.path, file).catch((error) => {
        throw new Fault('conflict', `Изображение ${key} больше недоступно или изменилось.`, {
          cause: errorResult(error),
        });
      });
    for (const collectionId of prepared.plan.collection_ids) {
      const collection = await this.client(prepared.store_id).collections.get(collectionId);
      if (Number(collection?.id) !== collectionId || collection.is_smart === true)
        throw new Fault('conflict', 'Категория изменилась перед записью.');
    }
    for (const relatedId of new Set([
      ...prepared.plan.similar_ids,
      ...prepared.plan.supplementary_ids,
    ]))
      await this.client(prepared.store_id).products.get(relatedId);
    return {
      change_id: prepared.id,
      valid: true,
      items: [{ conflict: false, errors: [], warnings: [] }],
    };
  }

  private steps(plan: ProductPlan): Step[] {
    const result: Step[] = [{ kind: 'product', status: 'pending' }];
    const update = omit(plan.product, CREATE_KEYS);
    delete update.is_hidden;
    if (Object.keys(update).length) result.push({ kind: 'product_details', status: 'pending' });
    for (let i = 0; i < plan.images.length; i++)
      result.push({ kind: 'image', index: i, status: 'pending' });
    for (let i = 1; i < plan.variants.length; i++)
      result.push({ kind: 'variant', index: i, status: 'pending' });
    for (let i = 0; i < plan.variants.length; i++) {
      const variant = requiredItem(plan.variants, i);
      const deferred = i === 0 ? omit(variant, FIRST_VARIANT_KEYS) : {};
      delete deferred.options;
      delete deferred.image_keys;
      delete deferred.image_ids;
      if (variant.image_keys?.length || Object.keys(deferred).length)
        result.push({ kind: 'variant_update', index: i, status: 'pending' });
    }
    for (let i = 0; i < plan.collection_ids.length; i++)
      result.push({ kind: 'membership', index: i, status: 'pending' });
    for (let i = 0; i < plan.similar_ids.length; i++)
      result.push({ kind: 'similar', index: i, status: 'pending' });
    for (let i = 0; i < plan.supplementary_ids.length; i++)
      result.push({ kind: 'supplementary', index: i, status: 'pending' });
    if (plan.product.is_hidden !== true) result.push({ kind: 'publish', status: 'pending' });
    return result;
  }

  private resultId(op: Operation, kind: string, index?: number) {
    return op.items.find((step) => step.kind === kind && step.index === index)?.result_id;
  }

  private async runStep(prepared: ProductWrite, op: Operation, step: Step) {
    const client = this.client(prepared.store_id),
      plan = prepared.plan;
    if (step.kind === 'product') {
      const firstVariant = requiredItem(plan.variants, 0);
      const fields: Json = {
        ...pick(plan.product, CREATE_KEYS),
        is_hidden: true,
        variants_attributes: [pick(firstVariant, FIRST_VARIANT_KEYS)],
      };
      if (firstVariant.options?.length) fields.options = firstVariant.options;
      const response = await client.products.create(fields);
      step.result_id = checkId(response?.id, 'товар');
      op.product_id = step.result_id;
      const created = await client.products.get(step.result_id);
      if (
        Number(created?.id) !== step.result_id ||
        !Array.isArray(created.variants) ||
        created.variants.length !== 1
      )
        throw new Fault('invalid_response', 'Не удалось подтвердить первый вариант нового товара.');
      const createdVariant: unknown = created.variants[0];
      if (!isRecord(createdVariant))
        throw new Fault('invalid_response', 'API вернул некорректный первый вариант.');
      op.first_variant_id = checkId(createdVariant.id, 'первый вариант');
      if (firstVariant.options?.length)
        verifyVariantOptions(createdVariant, created, firstVariant.options);
      if (
        plan.product.properties_attributes &&
        JSON.stringify(productProperties(created)) !==
          JSON.stringify(sortedPairs(plan.product.properties_attributes))
      ) {
        throw new Fault(
          'execution_unknown',
          'Параметры нового товара отличаются от подготовленного набора.',
        );
      }
    } else {
      const productId = checkId(op.product_id, 'товар');
      if (step.kind === 'product_details') {
        const fields = omit(plan.product, CREATE_KEYS);
        delete fields.is_hidden;
        await client.products.update(productId, fields);
        step.result_id = productId;
      } else if (step.kind === 'image') {
        const image = requiredItem(plan.images, step.index!);
        const fields: Json = { ...image };
        delete fields.key;
        delete fields.local_path;
        if (image.local_path) {
          const file = prepared.local_files[image.key];
          if (!file) throw new Fault('invalid_response', 'Не найдено локальное изображение.');
          fields.attachment = await attachment(file);
          fields.filename = image.filename ?? file.filename;
        }
        const response = await client.images(productId).create(fields);
        step.result_id = checkId(response?.id, 'изображение');
      } else if (step.kind === 'variant') {
        const variant = { ...requiredItem(plan.variants, step.index!) };
        delete variant.image_keys;
        delete variant.image_ids;
        const response = await client.variants(productId).create(variant);
        step.result_id = checkId(response?.id, 'вариант');
      } else if (step.kind === 'variant_update') {
        const variant = requiredItem(plan.variants, step.index!);
        let variantId = this.resultId(op, 'variant', step.index);
        if (step.index === 0) {
          variantId = op.first_variant_id;
        }
        const imageIds = this.variantImageIds(plan, op, variant);
        const fields: Json = step.index === 0 ? omit(variant, FIRST_VARIANT_KEYS) : {};
        delete fields.options;
        delete fields.image_keys;
        delete fields.image_ids;
        if (imageIds.length) fields.image_ids = imageIds;
        await client.variants(productId).update(checkId(variantId, 'вариант'), fields);
        step.result_id = variantId;
      } else if (step.kind === 'membership') {
        const response = await client.collects.create({
          product_id: productId,
          collection_id: plan.collection_ids[step.index!],
        });
        step.result_id = checkId(response?.id, 'связь с категорией');
      } else if (step.kind === 'similar' || step.kind === 'supplementary') {
        const relatedId =
          step.kind === 'similar'
            ? plan.similar_ids[step.index!]
            : plan.supplementary_ids[step.index!];
        const resource = step.kind === 'similar' ? 'similars' : 'supplementaries';
        const field = step.kind === 'similar' ? 'similar_ids' : 'supplementary_ids';
        await this.api.request(
          prepared.store_id,
          'POST',
          `/admin/products/${productId}/${resource}.json`,
          { [field]: [relatedId] },
        );
        step.result_id = relatedId;
      } else if (step.kind === 'publish') {
        await client.products.update(productId, { is_hidden: false });
        step.result_id = productId;
      }
    }
    // Read-after-write confirms that the generated ID belongs to this store and resource.
    if (step.kind === 'product' || step.kind === 'product_details' || step.kind === 'publish')
      await this.read(prepared.store_id, checkId(op.product_id, 'товар'));
    if (step.kind === 'image') await client.images(op.product_id!).get(step.result_id!);
    if (step.kind === 'variant' || step.kind === 'variant_update') {
      const after = await client.variants(op.product_id!).get(step.result_id!);
      const wanted = requiredItem(plan.variants, step.index!);
      if (step.kind === 'variant' && wanted.options?.length)
        verifyVariantOptions(after, await client.products.get(op.product_id!), wanted.options);
      if (step.kind === 'variant_update') {
        const imageIds = this.variantImageIds(plan, op, wanted);
        if (imageIds.length && !sameIdSet(after.image_ids, imageIds))
          throw new Fault(
            'execution_unknown',
            'Изображения варианта после записи отличаются от запрошенных.',
          );
      }
    }
    if (step.kind === 'membership') await client.collects.get(step.result_id!);
    if (step.kind === 'similar' || step.kind === 'supplementary') {
      const resource = step.kind === 'similar' ? 'similars' : 'supplementaries';
      const rows = await this.api.requestObjects(
        prepared.store_id,
        'GET',
        `/admin/products/${op.product_id}/${resource}.json`,
      );
      if (!Array.isArray(rows) || !rows.some((row) => Number(row.id) === step.result_id))
        throw new Fault('execution_unknown', 'Связь с товаром не подтверждена.');
    }
  }

  private variantImageIds(
    plan: ProductPlan,
    op: Operation,
    variant: ProductPlan['variants'][number],
  ) {
    const imageIds = [...(variant.image_ids ?? [])];
    for (const key of variant.image_keys ?? [])
      imageIds.push(
        checkId(
          this.resultId(
            op,
            'image',
            plan.images.findIndex((image) => image.key === key),
          ),
          'изображение варианта',
        ),
      );
    return [...new Set(imageIds)];
  }

  async apply(prepared: ProductWrite) {
    return this.api.state.lock(prepared.store_id, async () => {
      let op = this.api.state.get('operation', prepared.id, decodeOperation<Operation>);
      if (!op) {
        await this.validate(prepared);
        op = {
          id: prepared.id,
          store_id: prepared.store_id,
          status: 'running',
          items: this.steps(prepared.plan),
        };
        this.api.state.put('operation', prepared.id, op);
      }
      for (const step of op.items) {
        if (step.status === 'applied') continue;
        // A sent POST is never repeated after an interrupted response.
        if (step.status === 'sending' || step.status === 'execution_unknown') {
          op.status = 'execution_unknown';
          this.api.state.put('operation', prepared.id, op);
          return op;
        }
        step.status = 'sending';
        delete step.error;
        this.api.state.put('operation', prepared.id, op);
        try {
          await this.runStep(prepared, op, step);
          step.status = 'applied';
          this.api.state.put('operation', prepared.id, op);
        } catch (error) {
          const result = errorResult(error);
          step.status = definiteApiRejection(result.code) ? 'failed' : 'execution_unknown';
          step.error = result;
          op.status = step.status === 'failed' ? 'partial_failure' : 'execution_unknown';
          this.api.state.put('operation', prepared.id, op);
          return op;
        }
      }
      op.status = 'applied';
      this.api.state.put('operation', prepared.id, op);
      return op;
    });
  }
}
