import { z } from 'zod';
import { idField } from '../../../shared/schemas.js';

export const blockFieldKind = z.enum([
  'text',
  'color',
  'rich_text',
  'account_file',
  'collection_list',
  'collection',
  'select',
  'checkbox',
  'product_field',
  'collection_field',
  'range',
  'number',
  'product',
  'link',
  'button_switch',
  'icon_group',
]);
const text = z.string().min(1).max(1000);
const name = z.record(z.string().min(1), text).refine((value) => Object.keys(value).length > 0);
export const blockTemplateField = z
  .object({
    id: idField().optional(),
    handle: text,
    name,
    kind: blockFieldKind,
    options: z.array(z.object({ key: text, value: text }).strict()).default([]),
  })
  .strict();
export const blockTemplateInput = z
  .object({
    handle: text.refine((value) => !value.startsWith('system-')),
    name,
    fields: z.array(blockTemplateField),
  })
  .strict();
export const blockTemplatePatch = blockTemplateInput.partial();
export type BlockTemplateInput = z.infer<typeof blockTemplateInput>;
export const blockTemplateFilters = {
  scope: z.enum(['all', 'custom', 'system']).default('all'),
  handle: text.optional(),
  fields: z.array(z.object({ handle: text, kind: blockFieldKind.optional() }).strict()).optional(),
  field_kinds: z.array(blockFieldKind).optional(),
  match: z.enum(['contains', 'exact']).default('contains'),
  page: z.number().int().positive().default(1),
  per_page: z.number().int().min(1).max(100).default(50),
};
