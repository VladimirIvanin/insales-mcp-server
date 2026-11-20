import { z } from 'zod';
import { text } from '../../../shared/schema-primitives.js';

export const fileName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\p{L}\p{N}_./-]+\.(liquid|html|css|scss|js|json)$/u)
  .refine(
    (s) => !s.startsWith('/') && !s.split('/').some((p) => p === '..' || p === '.' || !p),
    'Недопустимое имя файла',
  );
export const assetFields = z
  .object({
    content: text,
    type: z
      .enum(['Asset::Template', 'Asset::Snippet', 'Asset::Media', 'Asset::Configuration'])
      .optional(),
    inner_file_name: fileName.optional(),
  })
  .strict();
