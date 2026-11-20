import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import type { Api } from '../../api.js';
import { DEFAULT_DOWNLOAD_DIRECTORY, Fault, downloadDirectory } from '../../shared/common.js';
import type { RawBody } from '../../infrastructure/http/transport.js';

const extensions: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'application/font-woff': '.woff',
  'text/css': '.css',
  'text/javascript': '.js',
  'application/javascript': '.js',
  'application/json': '.json',
  'text/plain': '.txt',
};

export function assetFileName(
  requested: string | undefined,
  contentType: string | undefined,
  fallback: string,
) {
  if (requested !== undefined) {
    if (
      !requested ||
      requested.length > 180 ||
      requested === '.' ||
      requested === '..' ||
      basename(requested) !== requested ||
      requested.includes('/') ||
      requested.includes('\\') ||
      requested.includes('\0')
    )
      throw new Fault('validation_failed', 'Некорректное имя файла.');
    return requested;
  }
  const extension = contentType ? (extensions[contentType] ?? '') : '';
  return `${fallback}${extension}`;
}

async function preparedRoot() {
  const configured = downloadDirectory();
  if (configured === DEFAULT_DOWNLOAD_DIRECTORY) {
    await mkdir(configured, { recursive: true, mode: 0o700 });
    if ((await lstat(configured)).isSymbolicLink())
      throw new Fault(
        'permission_denied',
        'Стандартный каталог скачивания не может быть символической ссылкой.',
      );
  }
  let root: string;
  try {
    root = await realpath(configured);
  } catch {
    throw new Fault('invalid_config', 'Каталог скачивания не найден.');
  }
  const info = await lstat(root);
  if (!info.isDirectory())
    throw new Fault('permission_denied', 'Каталог скачивания должен быть обычной директорией.');
  return root;
}

export async function saveAssetBytes(body: RawBody, name: string) {
  const root = await preparedRoot();
  const destination = join(root, name);
  const inside = relative(root, destination);
  if (inside !== name || inside.startsWith(`..${sep}`) || inside === '..')
    throw new Fault('permission_denied', 'Файл должен остаться внутри каталога скачивания.');
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink())
    throw new Fault('permission_denied', 'Нельзя перезаписать символическую ссылку.');
  const temporary = join(root, `.${name}.${randomUUID()}.part`);
  try {
    await writeFile(temporary, body.bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return {
    path: destination,
    size: body.bytes.length,
    sha256: createHash('sha256').update(body.bytes).digest('hex'),
    ...(body.contentType ? { content_type: body.contentType } : {}),
  };
}

export async function downloadThemeAsset(
  api: Api,
  storeId: string,
  themeId: number,
  id: number,
  filename?: string,
) {
  if (!Number.isSafeInteger(themeId) || themeId <= 0 || !Number.isSafeInteger(id) || id <= 0)
    throw new Fault('validation_failed', 'Нужны положительные theme_id и id.');
  const body = await api.requestUnknown(
    storeId,
    'GET',
    `/admin/theme_editor/v1/themes/${themeId}/assets/${id}/raw.json`,
    undefined,
    { raw: 'bytes' },
  );
  return saveAssetBytes(
    body,
    assetFileName(filename, body.contentType, `theme-${themeId}-asset-${id}`),
  );
}
