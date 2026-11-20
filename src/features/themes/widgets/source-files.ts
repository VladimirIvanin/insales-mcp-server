import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { Fault, type Json } from '../../../shared/common.js';

const names = [
  'snippet_content',
  'snippet_js',
  'snippet_scss',
  'settings_form',
  'settings_data',
  'setup',
  'messages',
  'block_settings_presets',
] as const;
export const widgetSourceFiles = z.record(z.enum(names), z.string().min(1).max(4096)).optional();
export type WidgetSourceFiles = Partial<Record<(typeof names)[number], string>>;
export interface WidgetSourceDigest {
  path: string;
  sha256: string;
  bytes: number;
}
export type WidgetSourceDigests = Record<string, WidgetSourceDigest>;

async function load(path: string): Promise<{ content: string; sha256: string; bytes: number }> {
  const configured = process.env.INSALES_MCP_WIDGET_SOURCE_ROOT;
  if (!configured || !isAbsolute(configured))
    throw new Fault(
      'invalid_config',
      'Для source_files задайте абсолютный INSALES_MCP_WIDGET_SOURCE_ROOT.',
    );
  if (
    isAbsolute(path) ||
    path.split(/[\\/]/).includes('..') ||
    path.includes('\\') ||
    path.includes('\0')
  )
    throw new Fault(
      'permission_denied',
      'Укажите относительный путь внутри каталога исходников виджетов.',
    );
  const root = resolve(configured);
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch {
    throw new Fault('invalid_config', 'Каталог исходников виджетов не найден.');
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Fault('permission_denied', 'Корень исходников должен быть обычным каталогом.');
  let current = root;
  for (const part of path.split('/').filter(Boolean)) {
    current = resolve(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch {
      throw new Fault('file_not_found', 'Исходник виджета не найден.', { path });
    }
    if (info.isSymbolicLink())
      throw new Fault('permission_denied', 'Символические ссылки в source_files запрещены.');
  }
  const actualRoot = await realpath(root);
  const actual = await realpath(current);
  const inside = relative(actualRoot, actual);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new Fault('permission_denied', 'Исходник находится вне разрешённого каталога.');
  const info = await lstat(actual);
  if (!info.isFile() || info.size > 1024 * 1024)
    throw new Fault('validation_failed', 'Исходник должен быть обычным файлом до 1 МБ.');
  const bytes = await readFile(actual);
  if (bytes.length > 1024 * 1024)
    throw new Fault('validation_failed', 'Исходник должен быть до 1 МБ.');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Fault('validation_failed', 'Исходник должен быть текстом UTF-8.');
  }
  return { content, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

export async function resolveWidgetSources(fields: Json, files?: WidgetSourceFiles) {
  const merged = { ...fields };
  const digests: WidgetSourceDigests = {};
  for (const [name, path] of Object.entries(files ?? {})) {
    if (!names.includes(name as (typeof names)[number]))
      throw new Fault('validation_failed', `Недопустимое поле source_files: ${name}.`);
    if (Object.hasOwn(fields, name))
      throw new Fault(
        'validation_failed',
        `Поле ${name} передано и текстом, и через source_files.`,
      );
    const source = await load(path);
    merged[name] = source.content;
    digests[name] = { path, sha256: source.sha256, bytes: source.bytes };
  }
  return { fields: merged, digests };
}

export async function verifyWidgetSources(digests?: WidgetSourceDigests) {
  for (const [name, expected] of Object.entries(digests ?? {})) {
    const current = await load(expected.path);
    if (current.sha256 !== expected.sha256 || current.bytes !== expected.bytes)
      throw new Fault('conflict', `Исходник ${name} изменился после создания черновика.`);
  }
}

export function summarizeWidgetSources(fields: Json, digests: WidgetSourceDigests): Json {
  const summary = { ...fields };
  for (const [name, source] of Object.entries(digests))
    summary[name] = `source_files:${source.path} (SHA-256 ${source.sha256}, ${source.bytes} bytes)`;
  return summary;
}
