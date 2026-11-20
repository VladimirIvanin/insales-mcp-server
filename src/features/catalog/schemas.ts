import { z } from 'zod';
import { short, text, idField, publicImageUrl } from '../../shared/schema-primitives.js';

export const collectionFields = z
  .object({
    title: short.optional(),
    parent_id: idField().optional(),
    position: z.number().int().min(0).optional(),
    sort_type: z.number().int().min(1).max(13).optional(),
    description: text.optional(),
    seo_description: text.optional(),
    html_title: short.optional(),
    meta_description: short.optional(),
    meta_keywords: short.optional(),
    permalink: short.optional(),
    is_hidden: z.boolean().optional(),
    recursive: z.boolean().optional(),
    custom_template: short.nullable().optional(),
    image_attributes: z.object({ src: publicImageUrl }).strict().optional(),
    field_values_attributes: z
      .array(
        z
          .object({
            id: idField().optional(),
            handle: z
              .string()
              .min(1)
              .max(100)
              .regex(/^[a-zA-Z0-9_-]+$/)
              .optional(),
            collection_field_id: idField().optional(),
            value: text,
          })
          .strict()
          .refine(
            (value) =>
              [value.id, value.handle, value.collection_field_id].filter(
                (item) => item !== undefined,
              ).length === 1,
            'Укажите ровно один из id, handle или collection_field_id.',
          ),
      )
      .max(100)
      .optional(),
  })
  .strict();
