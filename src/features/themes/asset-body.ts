import { createHash } from 'node:crypto';
import { Fault, isRecord } from '../../shared/common.js';
import type { RawBody } from '../../infrastructure/http/transport.js';

const DEFAULT_INLINE_BINARY_KB = 256;

export function inlineBinaryLimitBytes() {
  const raw = process.env.INSALES_MCP_MAX_INLINE_BINARY_KB;
  if (raw === undefined || raw === '') return DEFAULT_INLINE_BINARY_KB * 1024;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1)
    throw new Fault(
      'invalid_config',
      'INSALES_MCP_MAX_INLINE_BINARY_KB должен быть положительным целым числом.',
    );
  return value * 1024;
}

export function textualContentType(contentType: string | undefined) {
  if (!contentType) return false;
  const type = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (!type) return false;
  return (
    type.startsWith('text/') ||
    type === 'application/javascript' ||
    type === 'application/json' ||
    type === 'application/xml' ||
    type === 'image/svg+xml' ||
    type.endsWith('+json') ||
    type.endsWith('+xml')
  );
}

function utf8(bytes: Buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export interface BinaryAsset {
  encoding: 'base64';
  content_type?: string;
  size: number;
  sha256: string;
  data?: string;
  truncated?: true;
  hint?: string;
}

export function decodeAssetBody(body: RawBody): string | BinaryAsset {
  const text = utf8(body.bytes);
  const textual = body.contentType
    ? textualContentType(body.contentType) && text !== undefined
    : text !== undefined && !body.bytes.includes(0);
  if (textual && text !== undefined) return text;
  const asset: BinaryAsset = {
    encoding: 'base64',
    ...(body.contentType ? { content_type: body.contentType } : {}),
    size: body.bytes.length,
    sha256: createHash('sha256').update(body.bytes).digest('hex'),
  };
  if (body.bytes.length > inlineBinaryLimitBytes()) {
    return {
      ...asset,
      truncated: true,
      hint: 'Файл больше лимита ответа. Скачайте его через download_theme_asset.',
    };
  }
  return { ...asset, data: body.bytes.toString('base64') };
}

export function presentThemeAsset(data: unknown) {
  if (!isRecord(data) || typeof data.content_type !== 'string') return data;
  if (textualContentType(data.content_type) || !('content' in data)) return data;
  const rest = { ...data };
  delete rest.content;
  return {
    ...rest,
    content_omitted: 'binary',
    hint: 'Бинарное содержимое читайте через read_theme_asset_raw или download_theme_asset.',
  };
}
