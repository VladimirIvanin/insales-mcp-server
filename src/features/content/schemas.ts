import { z } from 'zod';
import { short, text, seo } from '../../shared/schema-primitives.js';

export const pageFields = z
  .object({
    title: short.optional(),
    content: text.optional(),
    permalink: short.optional(),
    ...seo,
  })
  .strict();
export const articleFields = z
  .object({
    title: short.optional(),
    content: text.optional(),
    notice: text.optional(),
    permalink: short.optional(),
    author: short.optional(),
    published_at: z.string().datetime({ offset: true }).optional(),
    ...seo,
  })
  .strict();
export const productFields = z
  .object({
    title: short.optional(),
    description: text.optional(),
    short_description: text.optional(),
    ...seo,
  })
  .strict();
