import { randomUUID } from 'node:crypto';
import { Fault, canonical, requiredItem, type Json } from '../../shared/common.js';
import { changeInput, schemas, type ChangeInput } from '../../shared/schemas.js';
import { validateFields } from '../../shared/validation.js';
import type { ResourceWrite, ResourceItem } from '../../changes/types.js';
import type { ContentService } from './service.js';

export async function prepareResourceWrite(
  content: ContentService,
  inputs: ChangeInput[],
  operationId: string = randomUUID(),
) {
  if (!inputs.length || inputs.length > 20)
    throw new Fault('validation_failed', 'Изменение должно содержать от 1 до 20 объектов.');
  if (inputs.some((input) => ['asset', 'widget_type'].includes(input.target.kind)))
    throw new Fault('unsupported_capability', 'Для тем используйте прямые ресурсные инструменты.');
  const store = requiredItem(inputs, 0).store_id;
  content.api.state.store(store);
  const seen = new Set<string>();
  const items: ResourceItem[] = [];
  for (const input of inputs) {
    const parsed = changeInput.safeParse(input);
    if (!parsed.success) throw new Fault('validation_failed', 'Некорректная структура изменения.');
    const { target: t, action, base_revision } = parsed.data;
    if (input.store_id !== store)
      throw new Fault('validation_failed', 'Одна операция относится к одному магазину.');
    content.client(store).forTarget(t);
    const checked = schemas[t.kind].safeParse(input.fields);
    if (!checked.success)
      throw new Fault('validation_failed', 'Недопустимые поля изменения.', {
        fields: checked.error.issues.map((i) => i.path.join('.')),
      });
    const fields = checked.data as Json;
    if (!Object.keys(fields).length) throw new Fault('validation_failed', 'Пустое изменение.');
    if (action === 'update' && (!t.id || !base_revision))
      throw new Fault('validation_failed', 'Для изменения нужны id и base_revision из read tool.');
    if (action === 'create' && (t.id || base_revision || t.kind === 'product'))
      throw new Fault('unsupported_capability', 'Неподдерживаемое создание объекта.');
    if (action === 'create') {
      const required =
        t.kind === 'page' ? ['title', 'content'] : ['title', 'content', 'author', 'published_at'];
      if (required.some((k) => fields[k] === undefined))
        throw new Fault('validation_failed', 'Не заполнены обязательные поля.', {
          required_fields: required,
        });
    }
    const key =
      canonical(t) + (action === 'create' ? canonical(fields.permalink ?? fields.title) : '');
    if (seen.has(key))
      throw new Fault('validation_failed', 'Один объект встречается в операции дважды.');
    seen.add(key);
    const before = action === 'update' ? await content.read(store, t) : null;
    if (before && before.revision !== base_revision)
      throw new Fault('conflict', 'Объект изменился после чтения. Прочитайте его заново.');
    const validation = await validateFields(t, fields, before?.data ?? null);
    items.push({
      target: t,
      action,
      fields,
      before: before?.data ?? null,
      base_revision,
      validation,
    });
  }
  const prepared: ResourceWrite = {
    kind: 'resource',
    id: operationId,
    store_id: store,

    items,
  };
  return prepared;
}
