import { z } from 'zod';
import ipaddr from 'ipaddr.js';

export const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// Отдельный экземпляр схемы на каждое поле: переиспользование одного инстанса
// разворачивается в JSON-schema $ref, который часть MCP-клиентов сериализуют строкой.
export const idField = () => z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const text = z.string().max(1024 * 1024);
export const short = z.string().max(1000);
export const seo = {
  html_title: short.optional(),
  meta_description: short.optional(),
  meta_keywords: short.optional(),
};
export const decimal = z.union([z.number().finite(), z.string().regex(/^-?\d+(?:\.\d+)?$/)]);
export const nonnegative = z.union([
  z.number().finite().min(0),
  z.string().regex(/^\d+(?:\.\d+)?$/),
]);
export const publicImageUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host) &&
      (!ipaddr.isValid(host) || ipaddr.process(host).range() === 'unicast')
    );
  }, 'Нужен публичный HTTPS URL изображения.');
