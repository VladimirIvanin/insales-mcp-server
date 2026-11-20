import { createHash } from 'node:crypto';
import { mkdir, lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, basename, resolve, sep } from 'node:path';
import { DEFAULT_UPLOAD_DIRECTORY, Fault, uploadDirectory } from '../../shared/common.js';
import { assertUploadBudget } from './budget.js';

export interface LocalFile {
  path: string;
  digest: string;
  bytes: number;
  filename: string;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function imageFormat(bytes: Buffer) {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return '.jpg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (bytes.subarray(0, 6).toString() === 'GIF87a' || bytes.subarray(0, 6).toString() === 'GIF89a')
    return '.gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return '.webp';
  throw new Fault('validation_failed', 'Локальный файл должен быть JPEG, PNG, GIF или WebP.');
}

async function readLocalImage(path: string, previous?: LocalFile) {
  const configured = uploadDirectory();
  if (configured === DEFAULT_UPLOAD_DIRECTORY) {
    await mkdir(configured, { recursive: true, mode: 0o700 });
    if ((await lstat(configured)).isSymbolicLink())
      throw new Fault(
        'permission_denied',
        'Стандартный каталог изображений не может быть символической ссылкой.',
      );
  }
  const root = await realpath(configured);
  const candidate = isAbsolute(path) ? path : resolve(root, path);
  let actual: string;
  try {
    actual = await realpath(candidate);
  } catch (error) {
    if (isAbsolute(candidate) && relative(root, candidate).startsWith('..'))
      throw new Fault(
        'permission_denied',
        'Изображение должно находиться внутри каталога загрузок.',
      );
    if (isRecordError(error) && error.code === 'ENOENT')
      throw new Fault('file_not_found', 'Файл не найден в каталоге загрузок.');
    throw error;
  }
  const inside = relative(root, actual);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new Fault('permission_denied', 'Изображение должно находиться внутри каталога загрузок.');
  if (configured === DEFAULT_UPLOAD_DIRECTORY) await assertUploadBudget(root);
  const info = await stat(actual);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES)
    throw new Fault('validation_failed', 'Нужен обычный файл изображения размером до 20 МБ.');
  const bytes = await readFile(actual);
  if (bytes.length > MAX_IMAGE_BYTES)
    throw new Fault('validation_failed', 'Изображение превышает 20 МБ.');
  const extension = imageFormat(bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (previous && (previous.digest !== digest || previous.bytes !== bytes.length))
    throw new Fault('conflict', 'Локальное изображение изменилось после создания черновика.');
  const stem =
    basename(actual)
      .replace(/\.[^.]*$/, '')
      .replace(/[^\p{L}\p{N}_-]/gu, '_')
      .slice(0, 100) || 'image';
  const file: LocalFile = {
    path: actual,
    digest,
    bytes: bytes.length,
    filename: `${stem}${extension}`,
  };
  return { file, bytes };
}

export async function localFile(path: string, previous?: LocalFile): Promise<LocalFile> {
  return (await readLocalImage(path, previous)).file;
}

function isRecordError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export async function attachment(file: LocalFile) {
  const { bytes } = await readLocalImage(file.path, file);
  return bytes.toString('base64');
}
