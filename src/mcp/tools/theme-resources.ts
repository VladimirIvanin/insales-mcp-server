import { createPatch } from 'diff';
import { isRecord, Fault } from '../../shared/common.js';
import { validateFields } from '../../shared/validation.js';
import {
  resolveWidgetSources,
  widgetSourceFiles,
} from '../../features/themes/widgets/source-files.js';
import { z } from 'zod';
import { idField, storeArgs } from '../../shared/schemas.js';
import { downloadThemeAsset } from '../../features/themes/download-asset.js';
import { DirectThemeResources } from '../../features/themes/direct.js';
import { themeResourceContract } from '../../features/themes/resource-contract.js';
import type { ToolContext } from '../tool-context.js';

export function registerThemeResourceTools(context: ToolContext) {
  const service = new DirectThemeResources(context.engine.api);
  for (const method of themeResourceContract) {
    const paths = [...method.path.matchAll(/:([a-z_]+)/g)].map((match) => match[1]!);
    const pathFields = Object.fromEntries(
      paths.map((name) => [
        name,
        name === 'job_id'
          ? z.string().uuid()
          : name === 'id' &&
              ['target-system-types-show', 'target-snippets-show'].includes(method.id)
            ? z.union([idField(), z.string().regex(/^[a-zA-Z0-9_-]+$/)])
            : idField(),
      ]),
    );
    const descriptions = method.request_fields
      .filter((field) => field.location !== 'path' && field.location !== 'header')
      .map((field) => `${field.name}: ${field.type}. ${field.description}`)
      .join('\n');
    context.tool(
      method.name,
      `${method.title}. ${method.rules}`,
      {
        ...storeArgs,
        ...pathFields,
        parameters: z
          .record(z.unknown())
          .default({})
          .describe(descriptions || 'Параметры запроса.'),
        operation_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'UUID локальной операции. Повтор записи после потери ответа поддерживает только duplicate_theme с тем же UUID в пределах часа; для остальных операций проверьте состояние чтением.',
          ),
      },
      (args) => service.execute(method, args.store_id, args, args.parameters, args.operation_id),
      method.read_only ? undefined : 'write',
      method.read_only,
    );
  }
  context.tool(
    'download_theme_asset',
    'Скачать файл темы на диск и вернуть путь, размер, sha256 и content_type без содержимого. Подходит для больших бинарных файлов, которые read_theme_asset_raw не вставляет в ответ.',
    {
      ...storeArgs,
      theme_id: idField(),
      id: idField(),
      filename: z
        .string()
        .min(1)
        .max(180)
        .optional()
        .describe('Имя файла внутри каталога скачивания, без пути.'),
    },
    (args) =>
      downloadThemeAsset(context.engine.api, args.store_id, args.theme_id, args.id, args.filename),
    'read',
  );
  context.tool(
    'retry_theme_operation',
    'Прочитать сохранённый результат операции. Повторная отправка разрешена только для копирования темы с прежним Idempotency-Key в пределах часа. Для остальных неизвестных записей прочитайте ресурс перед новым действием.',
    { operation_id: z.string().uuid() },
    (args) => service.retry(args.operation_id),
    'write',
    false,
  );
  context.tool(
    'read_widget_sources',
    'Прочитать локальные исходники под INSALES_MCP_WIDGET_SOURCE_ROOT. JSON-файлы возвращаются объектами; код строками. Сеть не используется.',
    { source_files: widgetSourceFiles.unwrap() },
    async (args) => {
      const result = await resolveWidgetSources({}, args.source_files);
      for (const key of [
        'settings_form',
        'settings_data',
        'setup',
        'messages',
        'block_settings_presets',
      ]) {
        const raw = result.fields[key];
        if (typeof raw === 'string') {
          const value: unknown = JSON.parse(raw);
          if (!isRecord(value))
            throw new Fault('validation_failed', `${key} должен быть JSON-объектом.`);
          result.fields[key] = value;
        }
      }
      return result;
    },
  );
  context.tool(
    'inspect_widget_source',
    'Локальная проверка исходников, settings_form и правил виджетов. Не создаёт черновик и не обращается к API.',
    { fields: z.record(z.unknown()) },
    async (args) => {
      const fields = { ...args.fields };
      for (const key of [
        'settings_form',
        'settings_data',
        'setup',
        'messages',
        'block_settings_presets',
      ]) {
        if (isRecord(fields[key])) fields[key] = JSON.stringify(fields[key]);
      }
      return validateFields({ kind: 'widget_type' }, fields, null);
    },
  );
  context.tool(
    'diff_theme_values',
    'Показать локальный diff двух значений без запросов и записи.',
    { before: z.record(z.unknown()), after: z.record(z.unknown()) },
    (args) => ({
      diff: createPatch(
        'theme-resource',
        JSON.stringify(args.before, null, 2),
        JSON.stringify(args.after, null, 2),
      ),
    }),
  );
}
