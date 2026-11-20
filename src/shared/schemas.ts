import { z } from 'zod';
import { idField } from './schema-primitives.js';
import { pageFields, articleFields, productFields } from '../features/content/schemas.js';
import { assetFields } from '../features/themes/assets/schemas.js';
import { widgetFields } from '../features/themes/widgets/schemas.js';

export * from './schema-primitives.js';
export * from '../features/content/schemas.js';
export * from '../features/products/schemas.js';
export * from '../features/catalog/schemas.js';
export * from '../features/themes/assets/schemas.js';
export * from '../features/themes/widgets/schemas.js';

export const target = z
  .object({
    kind: z.enum(['page', 'article', 'product', 'asset', 'widget_type']),
    id: idField().optional(),
    blog_id: idField().optional(),
    theme_id: idField().optional(),
  })
  .strict();
export type Target = z.infer<typeof target>;
export const changeInput = z.object({
  store_id: z.string().min(1).max(100),
  target,
  action: z.enum(['create', 'update']),
  fields: z.record(z.unknown()),
  base_revision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type ChangeInput = z.infer<typeof changeInput>;
export const schemas = {
  page: pageFields,
  article: articleFields,
  product: productFields,
  asset: assetFields,
  widget_type: widgetFields,
};
export const storeArgs = { store_id: z.string().min(1).max(100) };
export const pagination = {
  page: z.number().int().min(1).max(100000).default(1),
  per_page: z.number().int().min(1).max(50).default(20),
};
