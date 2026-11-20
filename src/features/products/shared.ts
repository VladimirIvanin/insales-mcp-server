import { Fault, requiredItem, type Json } from '../../shared/common.js';
import type { ProductPlan } from './types.js';

export const CREATE_KEYS = new Set([
  'title',
  'category_id',
  'description',
  'short_description',
  'sort_weight',
  'ignore_discounts',
  'vat',
  'is_hidden',
  'bundle',
  'properties_attributes',
]);

export const FIRST_VARIANT_KEYS = new Set([
  'sku',
  'cost_price',
  'old_price',
  'price',
  'quantity',
  'weight',
  'dimensions',
  'prices_array',
  'quantity_at_warehouses',
  'quantity_by_warehouses',
  'barcode',
  'variant_field_values_attributes',
]);

export function pick(source: Json, keys: Set<string>) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => keys.has(key)));
}

export function omit(source: Json, keys: Set<string>) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.has(key)));
}

export function sameIdSet(actual: unknown, wanted: unknown) {
  const ids = (value: unknown) =>
    [...new Set((Array.isArray(value) ? value : []).map((item) => Number(item)))].sort(
      (left, right) => left - right,
    );
  const left = ids(actual);
  const right = ids(wanted);
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function checkId(value: unknown, what: string) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new Fault('invalid_response', `API не вернул ID: ${what}.`);
  return n;
}

export function validatePlan(plan: ProductPlan) {
  const imageKeys = new Set<string>();
  for (const image of plan.images) {
    if (imageKeys.has(image.key))
      throw new Fault('validation_failed', `Повторяется ключ изображения ${image.key}.`);
    imageKeys.add(image.key);
  }
  const options = requiredItem(plan.variants, 0).options?.map((o) => o.title) ?? [];
  if (new Set(options).size !== options.length)
    throw new Fault('validation_failed', 'Названия опций первого варианта должны быть уникальны.');
  const combinations = new Set<string>();
  for (const variant of plan.variants) {
    if (variant.image_ids?.length)
      throw new Fault(
        'validation_failed',
        'Для нового товара используйте image_keys: ID изображений другого товара не подходят.',
      );
    for (const key of variant.image_keys ?? [])
      if (!imageKeys.has(key))
        throw new Fault('validation_failed', `Неизвестный ключ изображения ${key}.`);
    const titles = variant.options?.map((o) => o.title) ?? [];
    if (titles.length !== options.length || titles.some((title, i) => title !== options[i]))
      throw new Fault(
        'validation_failed',
        'У всех вариантов должны быть одни и те же названия опций в одинаковом порядке.',
      );
    const combination = JSON.stringify(variant.options?.map((o) => o.value) ?? []);
    if (combinations.has(combination))
      throw new Fault('validation_failed', 'Комбинация опций варианта повторяется.');
    combinations.add(combination);
  }
  if (new Set(plan.collection_ids).size !== plan.collection_ids.length)
    throw new Fault('validation_failed', 'ID категорий повторяются.');
  if (
    new Set(plan.similar_ids).size !== plan.similar_ids.length ||
    new Set(plan.supplementary_ids).size !== plan.supplementary_ids.length
  )
    throw new Fault('validation_failed', 'ID связанных товаров повторяются.');
  if (plan.product.product_bundle_components_attributes?.length && !plan.product.bundle)
    throw new Fault('validation_failed', 'Компоненты можно указать только для комплекта.');
}

export function sortedPairs(pairs: { title: string; value: string }[]) {
  return [...pairs].sort(
    (a, b) => a.title.localeCompare(b.title) || a.value.localeCompare(b.value),
  );
}

export function productProperties(product: Json): { title: string; value: string }[] {
  if (!Array.isArray(product.properties) || !Array.isArray(product.characteristics))
    throw new Fault('invalid_response', 'Product API не вернул параметры товара.');
  const names = new Map(
    product.properties.map((property: Json) => [Number(property.id), String(property.title)]),
  );
  return sortedPairs(
    product.characteristics.map((characteristic: Json) => {
      const title = names.get(Number(characteristic.property_id));
      if (!title || typeof characteristic.title !== 'string')
        throw new Fault('invalid_response', 'Не удалось сопоставить параметр и значение товара.');
      return { title, value: characteristic.title };
    }),
  );
}

export function optionNames(product: Json) {
  if (!Array.isArray(product.option_names) || !Array.isArray(product.variants))
    throw new Fault('invalid_response', 'Product API не вернул опции и варианты.');
  return product.option_names as Json[];
}

export function variantOptionValues(variant: Json, product: Json) {
  const names = optionNames(product);
  const byId = new Map(names.map((name) => [Number(name.id), String(name.title)]));
  if (!Array.isArray(variant.option_values))
    throw new Fault('invalid_response', 'Variant API не вернул значения опций.');
  return variant.option_values
    .map((item: Json) => {
      const title = byId.get(Number(item.option_name_id));
      if (!title || typeof item.title !== 'string')
        throw new Fault('invalid_response', 'Не удалось сопоставить опцию варианта.');
      return { title, value: item.title };
    })
    .sort((a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title));
}

export function verifyVariantOptions(variant: Json, product: Json, wanted: Json[]) {
  const actual = variantOptionValues(variant, product);
  const expected = [...wanted]
    .map((value) => ({ title: String(value.title), value: String(value.value) }))
    .sort((a, b) => a.title.localeCompare(b.title));
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Fault('execution_unknown', 'Сохранённые опции варианта отличаются от запрошенных.');
}

export function validateVariantOptions(
  product: Json,
  fields: Json,
  action: 'create' | 'update' | 'delete',
  itemId?: number,
) {
  const names = optionNames(product);
  if (action === 'delete' || (action === 'update' && fields.options === undefined)) return;
  const values = fields.options as Json[] | undefined;
  if (!names.length) {
    if (
      (action === 'create' && Array.isArray(product.variants) && product.variants.length) ||
      values?.length
    )
      throw new Fault('validation_failed', 'Для второго варианта сначала задайте опции товара.');
    return;
  }
  if (!values || values.length !== names.length)
    throw new Fault('validation_failed', 'Вариант должен содержать полный набор опций товара.');
  const namesById = new Map(names.map((name) => [Number(name.id), String(name.title)]));
  const expectedNames = new Set(names.map((name) => String(name.title)));
  const supplied = new Set<string>();
  for (const value of values) {
    const title = String(value.title).trim();
    if (
      !expectedNames.has(title) ||
      (value.option_name_id !== undefined &&
        namesById.get(Number(value.option_name_id)) !== title) ||
      !String(value.value).trim() ||
      supplied.has(title)
    ) {
      throw new Fault('validation_failed', 'Опция варианта не соответствует опциям товара.');
    }
    supplied.add(title);
  }
  const requested = new Map(
    values.map((value) => [String(value.title), String(value.value).trim().toLocaleLowerCase()]),
  );
  for (const variant of product.variants as Json[]) {
    if (Number(variant.id) === itemId) continue;
    const current = variantOptionValues(variant, product);
    if (
      current.length === values.length &&
      current.every(
        (value) => requested.get(value.title) === value.value.trim().toLocaleLowerCase(),
      )
    ) {
      throw new Fault(
        'validation_failed',
        'Комбинация значений опций уже есть у другого варианта.',
      );
    }
  }
}
