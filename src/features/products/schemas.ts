import { z } from 'zod';
import {
  short,
  text,
  seo,
  decimal,
  nonnegative,
  idField,
  publicImageUrl,
} from '../../shared/schema-primitives.js';

export const productOption = z
  .object({
    title: z.string().trim().min(1).max(1000),
    value: z.string().trim().min(1).max(1000),
    option_name_id: idField().optional(),
  })
  .strict();
export const productVariant = z
  .object({
    sku: short.optional(),
    barcode: short.optional(),
    external_id: short.optional(),
    price: nonnegative.optional(),
    old_price: nonnegative.optional(),
    cost_price: nonnegative.optional(),
    quantity: nonnegative.optional(),
    weight: nonnegative.optional(),
    dimensions: short.optional(),
    width: nonnegative.optional(),
    height: nonnegative.optional(),
    depth: nonnegative.optional(),
    prices_array: z.array(nonnegative.nullable()).max(100).optional(),
    quantity_at_warehouses: z.array(nonnegative).max(100).optional(),
    quantity_by_warehouses: z.record(z.string().regex(/^\d+$/), nonnegative).optional(),
    options: z.array(productOption).max(16).optional(),
    image_keys: z.array(z.string().min(1).max(100)).max(50).optional(),
    image_ids: z.array(idField()).max(50).optional(),
    variant_field_values_attributes: z
      .array(
        z
          .object({
            id: idField().optional(),
            handle: short.optional(),
            variant_field_id: idField().optional(),
            variant_field_handle: short.optional(),
            value: text,
            _destroy: z.boolean().optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
export const productVariantChange = productVariant.omit({ image_keys: true });
export const productImage = z
  .object({
    key: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9_-]+$/),
    src: publicImageUrl.optional(),
    local_path: z.string().min(1).max(4096).optional(),
    filename: short.optional(),
    title: short.optional(),
    position: z.number().int().min(0).optional(),
    external_id: short.optional(),
  })
  .strict()
  .refine(
    (v) => (v.src === undefined) !== (v.local_path === undefined),
    'Укажите ровно один источник изображения: src или local_path.',
  );
export const productImageChange = z
  .object({
    src: publicImageUrl.optional(),
    local_path: z.string().min(1).max(4096).optional(),
    filename: short.optional(),
    title: short.optional(),
    position: z.number().int().min(0).optional(),
    external_id: short.optional(),
  })
  .strict()
  .refine((v) => !(v.src && v.local_path), 'Укажите один источник изображения.');
export const productImagesBatchInput = z
  .array(
    z
      .object({
        product_id: idField(),
        fields: productImageChange,
      })
      .strict(),
  )
  .min(1)
  .max(30);
export const productCard = z
  .object({
    title: z.string().min(1).max(1000),
    description: text.optional(),
    short_description: text.optional(),
    ...seo,
    category_id: idField().optional(),
    canonical_url_collection_id: idField().optional(),
    permalink: short.optional(),
    is_hidden: z.boolean().optional(),
    ignore_discounts: z.boolean().optional(),
    allow_discounts: z.boolean().optional(),
    sort_weight: decimal.optional(),
    vat: decimal.optional(),
    unit: short.optional(),
    dimensions: short.optional(),
    fiscal_product_type: short.optional(),
    currency_code: short.optional(),
    stock_currency_id: idField().optional(),
    custom_template: short.optional(),
    custom_layout: short.optional(),
    properties_attributes: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(1000),
            value: z.string().trim().min(1).max(1000),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    product_field_values_attributes: z
      .array(
        z
          .object({
            id: idField().optional(),
            handle: short.optional(),
            product_field_id: idField().optional(),
            value: text,
          })
          .strict(),
      )
      .max(100)
      .optional(),
    video_links_attributes: z
      .array(z.object({ url: z.string().url().max(2048) }).strict())
      .max(50)
      .optional(),
    product_accessory_links_attributes: z
      .array(z.object({ accessory_id: idField() }).strict())
      .max(100)
      .optional(),
    product_characteristics_attributes: z
      .array(z.object({ characteristic_id: idField(), property_id: idField() }).strict())
      .max(100)
      .optional(),
    bundle: z.boolean().optional(),
    auto_assign_bundle_price: z.boolean().optional(),
    product_bundle_components_attributes: z
      .array(
        z
          .object({
            variant_id: idField(),
            quantity: nonnegative.optional(),
            discount_amount: nonnegative.optional(),
            discount_type: short.optional(),
            free: z.boolean().optional(),
            position: z.number().int().min(0).optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
export const productCardUpdate = productCard
  .omit({ bundle: true, properties_attributes: true, product_characteristics_attributes: true })
  .partial();
export const productPropertiesChange = z
  .object({
    set: z
      .array(
        z
          .object({ title: z.string().min(1).max(1000), value: z.string().min(1).max(1000) })
          .strict(),
      )
      .max(100)
      .default([]),
    remove_titles: z.array(z.string().min(1).max(1000)).max(100).default([]),
  })
  .strict();
export const productOptionAdd = z
  .object({
    title: z.string().trim().min(1).max(1000),
    default_value: z.string().trim().min(1).max(1000),
  })
  .strict();
export const productCreateInput = z
  .object({
    product: productCard,
    variants: z.array(productVariant).min(1).max(100),
    images: z.array(productImage).max(100).default([]),
    collection_ids: z.array(idField()).max(100).default([]),
    similar_ids: z.array(idField()).max(100).default([]),
    supplementary_ids: z.array(idField()).max(100).default([]),
  })
  .strict();
