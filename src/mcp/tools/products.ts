import { z } from 'zod';
import {
  idField,
  storeArgs,
  productCreateInput,
  productCardUpdate,
  productPropertiesChange,
  productOptionAdd,
  productVariantChange,
  productImageChange,
  productImagesBatchInput,
} from '../../shared/schemas.js';
import type { ToolContext } from '../tool-context.js';

export function registerProductsTools(context: ToolContext) {
  const { engine, tool } = context;
  tool(
    'read_product_card',
    'Полная карточка товара из публичного API: варианты, изображения, опции, свойства, видео и связи. Для точечного изменения текста используйте read_content и update_product.',
    {
      ...storeArgs,
      id: idField(),
    },
    (a) => engine.products.read(a.store_id, a.id),
  );
  tool(
    'read_product_item',
    'Прочитать вариант или изображение товара и получить revision для точечного изменения.',
    {
      ...storeArgs,
      product_id: idField(),
      kind: z.enum(['variant', 'image']),
      id: idField(),
    },
    (a) => engine.products.readItem(a.store_id, a.product_id, a.kind, a.id),
  );
  tool(
    'create_product',
    'Создать товара через публичный API: поля карточки, до 100 вариантов, изображения по публичным HTTPS URL или local_path из каталога загрузок (.uploads/ по умолчанию), привязка изображений к вариантам по image_keys и категории по collection_ids. Если контент берётся с официального сайта, проверьте официальный источник каждого фото товара; запрос на генерацию промо не разрешает подменять фото товара генерацией. Если официальные фото недоступны, сначала спросите пользователя. При сбое после начала записи операция сохраняет завершённые ID и не повторяет POST автоматически.',
    {
      ...storeArgs,
      operation_id: z.string().uuid().optional(),
      ...productCreateInput.shape,
    },
    (a) =>
      engine.runWrite('create_product', a, async (id) => {
        const prepared = await engine.products.prepareCreate(a.store_id, {
          product: a.product,
          variants: a.variants,
          images: a.images,
          collection_ids: a.collection_ids,
          similar_ids: a.similar_ids,
          supplementary_ids: a.supplementary_ids,
        });
        return engine.products.apply({ ...prepared, id });
      }),
    'write',
    false,
  );
  tool(
    'update_product_card',
    'Изменить разрешённые публичным API поля существующего товара: описание, SEO, видимость, категорию склада, видео, доптовары и поля комплекта. Параметры товара меняйте через update_product_properties. Прочитайте полную карточку через read_product_card и передайте revision.',
    {
      ...storeArgs,
      operation_id: z.string().uuid().optional(),
      id: idField(),
      fields: productCardUpdate,
      base_revision: z.string().regex(/^[a-f0-9]{64}$/),
    },
    (a) =>
      engine.runWrite('update_product_card', a, async (id) => {
        const prepared = await engine.products.prepareDetails(
          a.store_id,
          a.id,
          a.fields,
          a.base_revision,
        );
        return engine.products.applyDetails({ ...prepared, id });
      }),
    'write',
    false,
  );
  tool(
    'update_product_properties',
    'Точечно изменить параметры товара: set заменяет значения указанных названий, remove_titles удаляет выбранные параметры; остальные сохраняются. Передайте revision из read_product_card. Сервер отправляет полный список в properties_attributes и проверяет результат.',
    {
      ...storeArgs,
      operation_id: z.string().uuid().optional(),
      id: idField(),
      changes: productPropertiesChange,
      base_revision: z.string().regex(/^[a-f0-9]{64}$/),
    },
    (a) =>
      engine.runWrite('update_product_properties', a, async (id) => {
        const prepared = await engine.products.prepareProperties(
          a.store_id,
          a.id,
          a.changes,
          a.base_revision,
        );
        return engine.products.applyDetails({ ...prepared, id });
      }),
    'write',
    false,
  );
  tool(
    'add_product_option',
    'Добавить новое название опции товара с начальным значением для каждого существующего варианта. После этого значения отдельных вариантов меняйте через change_product_variant с полным набором options. Передайте revision из read_product_card.',
    {
      ...storeArgs,
      operation_id: z.string().uuid().optional(),
      id: idField(),
      option: productOptionAdd,
      base_revision: z.string().regex(/^[a-f0-9]{64}$/),
    },
    (a) =>
      engine.runWrite('add_product_option', a, async (id) => {
        const prepared = await engine.products.prepareOptionAdd(
          a.store_id,
          a.id,
          a.option,
          a.base_revision,
        );
        return engine.products.applyDetails({ ...prepared, id });
      }),
    'write',
    false,
  );
  tool(
    'change_product_variant',
    'Создать, изменить или удалить вариант товара через публичный API. Для update/delete получите base_revision через read_product_item. image_ids должны принадлежать тому же товару.',
    {
      ...storeArgs,
      operation_id: z.string().uuid().optional(),
      product_id: idField(),
      action: z.enum(['create', 'update', 'delete']),
      id: idField().optional(),
      fields: productVariantChange.optional(),
      base_revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    },
    (a) =>
      engine.runWrite('change_product_variant', a, async (id) => {
        const prepared = await engine.products.prepareItem(
          a.store_id,
          a.product_id,
          'variant',
          a.action,
          a.id,
          a.fields,
          a.base_revision,
        );
        return engine.products.applyItem({ ...prepared, id });
      }),
    'write',
    false,
  );
  tool(
    'change_product_image',
    'Создать, изменить или удалить изображение товара по публичной HTTPS-ссылке либо local_path из каталога загрузок (.uploads/ по умолчанию). Для update/delete получите base_revision через read_product_item.',
    {
      ...storeArgs,
      operation_id: z.string().uuid().optional(),
      product_id: idField(),
      action: z.enum(['create', 'update', 'delete']),
      id: idField().optional(),
      fields: productImageChange.optional(),
      base_revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    },
    (a) =>
      engine.runWrite('change_product_image', a, async (id) => {
        const prepared = await engine.products.prepareItem(
          a.store_id,
          a.product_id,
          'image',
          a.action,
          a.id,
          a.fields,
          a.base_revision,
        );
        return engine.products.applyItem({ ...prepared, id });
      }),
    'write',
    false,
  );
  tool(
    'create_product_images',
    'Создать пакет из 1–30 изображений существующих товаров. Каждый элемент содержит product_id и fields с публичным HTTPS src либо local_path. Результат содержит статус и ID каждого изображения.',
    {
      ...storeArgs,
      operation_id: z.string().uuid().optional(),
      items: productImagesBatchInput,
    },
    (a) =>
      engine.runWrite('create_product_images', a, async (id) => {
        const prepared = await engine.products.prepareImagesBatch(a.store_id, a.items);
        return engine.products.applyImagesBatch({ ...prepared, id });
      }),
    'write',
    false,
  );
}
