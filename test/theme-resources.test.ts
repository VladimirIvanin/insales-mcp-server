import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { State } from '../src/infrastructure/persistence/state.js';
import { Api, type RequestOptions, type Transport } from '../src/api.js';
import { Fault, isRecord, ROOT, type Json } from '../src/shared/common.js';
import { DirectThemeResources } from '../src/features/themes/direct.js';
import { themeResourceContract } from '../src/features/themes/resource-contract.js';

function method(id: string) {
  const result = themeResourceContract.find((entry) => entry.id === id);
  assert.ok(result);
  return result;
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'theme-resources-'));
  const state = new State(directory, { id: 'shop', name: 'Test', url: 'https://shop.example' });
  const calls: Array<{ method: string; path: string; body?: Json; options?: RequestOptions }> = [];
  let fail = false;
  const transport: Transport = {
    request: async (_store, _credentials, verb, path, body, options) => {
      calls.push({
        method: verb,
        path,
        ...(body ? { body } : {}),
        ...(options ? { options } : {}),
      });
      if (fail) {
        fail = false;
        throw new Fault('execution_unknown', 'Lost response');
      }
      return { id: 42, updated_at: '2026-11-11T12:00:00.123456Z' };
    },
  };
  const api = new Api(state, { key: 'id', password: 'password' }, transport);
  t.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    state,
    calls,
    service: new DirectThemeResources(api),
    loseResponse: () => {
      fail = true;
    },
  };
}

test('a widget PUT sends one request with the original timestamp and object settings', async (t) => {
  const { service, calls } = fixture(t);
  const body = {
    expected_updated_at: '2026-11-11T12:00:00.123456Z',
    settings: { title: { ru: 'Новое' } },
  };
  const result = await service.execute(
    method('target-widgets-update'),
    'shop',
    { theme_id: 7, id: 8 },
    body,
  );
  assert.ok(isRecord(result));
  assert.equal(result.status, 'applied');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    method: 'PUT',
    path: '/admin/theme_editor/v1/themes/7/widgets/8.json',
    body,
    options: {},
  });
});

test('theme duplication stores its key before HTTP and reuses it after lost response', async (t) => {
  const { service, calls, state, loseResponse } = fixture(t);
  const id = randomUUID();
  loseResponse();
  const result = await service.execute(
    method('target-themes-duplicate'),
    'shop',
    { theme_id: 7 },
    { title: 'Copy' },
    id,
  );
  assert.ok(isRecord(result));
  assert.equal(result.status, 'execution_unknown');
  assert.ok(state.get('operation', id));
  const recovered = await service.retry(id);
  assert.equal(recovered.status, 'applied');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.options?.idempotencyKey, id);
  assert.equal(calls[1]?.options?.idempotencyKey, id);
  await service.retry(id);
  assert.equal(calls.length, 2);
});

test('another payload cannot reuse an operation UUID', async (t) => {
  const { service, calls } = fixture(t);
  const id = randomUUID();
  await service.execute(
    method('target-types-create'),
    'shop',
    { theme_id: 7 },
    { name: { ru: 'A' } },
    id,
  );
  await assert.rejects(
    () =>
      service.execute(
        method('target-types-create'),
        'shop',
        { theme_id: 7 },
        { name: { ru: 'B' } },
        id,
      ),
    (error: unknown) => error instanceof Fault && error.code === 'idempotency_key_reused',
  );
  assert.equal(calls.length, 1);
});

test('an expired unknown creation is never resent', async (t) => {
  const { service, calls, state, loseResponse } = fixture(t);
  const id = randomUUID();
  loseResponse();
  await service.execute(method('target-themes-duplicate'), 'shop', { theme_id: 7 }, {}, id);
  const operation = state.get('operation', id);
  assert.ok(isRecord(operation));
  state.put('operation', id, { ...operation, expires_at: Date.now() - 1 });
  await assert.rejects(
    () => service.retry(id),
    (error: unknown) => error instanceof Fault && error.code === 'execution_unknown',
  );
  assert.equal(calls.length, 1);
});

test('an unknown PUT cannot be replayed as a fresh write', async (t) => {
  const { service, calls, loseResponse } = fixture(t);
  const id = randomUUID();
  loseResponse();
  await service.execute(method('target-widgets-update'), 'shop', { theme_id: 7, id: 8 }, {}, id);
  await assert.rejects(
    () => service.retry(id),
    (error: unknown) => error instanceof Fault && error.code === 'execution_unknown',
  );
  assert.equal(calls.length, 1);
});

test('panel listing uses the resource API without legacy scope', async (t) => {
  const { service, calls } = fixture(t);
  await service.execute(method('target-block-lists-index'), 'shop', {}, { page: 2 });
  assert.equal(calls[0]?.path, '/admin/theme_editor/v1/block_lists.json?page=2');
});

test('new WidgetType JSON strings are rejected before HTTP', async (t) => {
  const { service, calls } = fixture(t);
  await assert.rejects(
    () =>
      service.execute(
        method('target-types-create'),
        'shop',
        { theme_id: 7 },
        { settings_form: '{}' },
      ),
    (error: unknown) => error instanceof Fault && error.code === 'validation_failed',
  );
  assert.equal(calls.length, 0);
});

test('resource contract has explicit routes and no preparation, commands or receipt tool', () => {
  assert.equal(
    new Set(themeResourceContract.map((entry) => entry.name)).size,
    themeResourceContract.length,
  );
  for (const entry of themeResourceContract) {
    assert.doesNotMatch(entry.path, /preparation|commands|operation_receipt|validation/);
    assert.ok(entry.path.startsWith('/admin/'));
  }
});

const blockCreates = [
  { id: 'target-blocks-create', path: {}, extra: { block_template_id: 3 } },
  { id: 'target-widget-blocks-create', path: { theme_id: 7, id: 8 }, extra: {} },
  { id: 'target-block-items-add', path: { block_list_id: 9 }, extra: {} },
];

for (const endpoint of blockCreates) {
  test(`${endpoint.id}: string titles reach Rails as translations without changing fields`, async (t) => {
    const { service, calls } = fixture(t);
    const body = { ...endpoint.extra, title: 'Образ', fields: { title: 'Текст карточки' } };
    await service.execute(method(endpoint.id), 'shop', endpoint.path, body);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.body, { ...body, title: { ru: 'Образ' } });
    assert.equal(body.title, 'Образ');
  });

  test(`${endpoint.id}: missing and empty titles cannot create broken blocks`, async (t) => {
    const { service, calls, state } = fixture(t);
    for (const title of [undefined, null, '', '  ', {}, { ru: '  ' }, [], { ru: 12 }]) {
      const operationId = randomUUID();
      const body: Json = { ...endpoint.extra, fields: {} };
      if (title !== undefined) body.title = title;
      await assert.rejects(
        () => service.execute(method(endpoint.id), 'shop', endpoint.path, body, operationId),
        (error: unknown) => error instanceof Fault && error.code === 'validation_failed',
      );
      assert.equal(state.get('operation', operationId), undefined);
    }
    assert.equal(calls.length, 0);
  });
}

for (const endpoint of [
  { id: 'target-blocks-update', path: { id: 3 } },
  { id: 'target-widget-blocks-update', path: { theme_id: 7, id: 8, block_id: 3 } },
]) {
  test(`${endpoint.id}: updates may omit title but cannot clear it`, async (t) => {
    const { service, calls } = fixture(t);
    await service.execute(method(endpoint.id), 'shop', endpoint.path, {
      fields: { caption: 'Текст' },
    });
    assert.deepEqual(calls[0]?.body, { fields: { caption: 'Текст' } });
    await service.execute(method(endpoint.id), 'shop', endpoint.path, { title: 'Новое' });
    assert.deepEqual(calls[1]?.body, { title: { ru: 'Новое' } });
    await assert.rejects(
      () => service.execute(method(endpoint.id), 'shop', endpoint.path, { title: { ru: '' } }),
      (error: unknown) => error instanceof Fault && error.code === 'validation_failed',
    );
    assert.equal(calls.length, 2);
  });
}

for (const endpoint of [
  { id: 'target-widget-blocks-replace', path: { theme_id: 7, id: 8 }, key: 'blocks' },
  { id: 'target-block-lists-replace', path: { block_list_id: 9 }, key: 'items' },
]) {
  test(`${endpoint.id}: replacement preserves IDs and translations, normalizes new titles`, async (t) => {
    const { service, calls } = fixture(t);
    const entries = [
      { id: 3, title: { ru: 'Образ', en: 'Look' }, fields: {} },
      { title: 'Новый', fields: { caption: 'Подпись' } },
      { id: 4, fields: {} },
    ];
    await service.execute(method(endpoint.id), 'shop', endpoint.path, {
      [endpoint.key]: entries,
      expected_updated_at: '2026-11-11T12:00:00.123456Z',
    });
    assert.deepEqual(calls[0]?.body, {
      [endpoint.key]: [entries[0], { ...entries[1], title: { ru: 'Новый' } }, entries[2]],
      expected_updated_at: '2026-11-11T12:00:00.123456Z',
    });
    assert.equal(entries[1]?.title, 'Новый');
  });

  test(`${endpoint.id}: an unnamed new block rejects the entire request before HTTP`, async (t) => {
    const { service, calls } = fixture(t);
    await assert.rejects(
      () =>
        service.execute(method(endpoint.id), 'shop', endpoint.path, {
          [endpoint.key]: [
            { id: 3, title: 'Изменено' },
            { id: null, fields: {} },
          ],
        }),
      (error: unknown) => error instanceof Fault && error.code === 'validation_failed',
    );
    assert.equal(calls.length, 0);
    await service.execute(method(endpoint.id), 'shop', endpoint.path, { [endpoint.key]: [] });
    assert.deepEqual(calls[0]?.body, { [endpoint.key]: [] });
  });
}

for (const id of ['target-types-create', 'target-types-update', 'target-types-copy']) {
  test(`${id}: invalid widget handles are rejected before HTTP`, async (t) => {
    const { service, calls } = fixture(t);
    for (const handle of ['Промо слайдер - user', 'promo slider', '', 'promo\n', null, 42]) {
      await assert.rejects(
        () => service.execute(method(id), 'shop', { theme_id: 7, id: 8 }, { handle }),
        (error: unknown) => error instanceof Fault && error.code === 'validation_failed',
      );
    }
    assert.equal(calls.length, 0);
    await service.execute(method(id), 'shop', { theme_id: 7, id: 8 }, { handle: 'Promo_slider-3' });
    assert.deepEqual(calls[0]?.body, { handle: 'Promo_slider-3' });
  });
}

test('normalized block creation cannot be resent after a lost response', async (t) => {
  const { service, calls, loseResponse } = fixture(t);
  const operationId = randomUUID();
  loseResponse();
  await service.execute(
    method('target-blocks-create'),
    'shop',
    {},
    {
      block_template_id: 3,
      title: 'Образ',
      fields: {},
    },
    operationId,
  );
  await assert.rejects(
    () =>
      service.execute(
        method('target-blocks-create'),
        'shop',
        {},
        {
          block_template_id: 3,
          title: { ru: 'Образ' },
          fields: {},
        },
        operationId,
      ),
    (error: unknown) => error instanceof Fault && error.code === 'execution_unknown',
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.body, { block_template_id: 3, title: { ru: 'Образ' }, fields: {} });
  assert.equal(calls[0]?.options?.idempotencyKey, undefined);
});

const routeSnapshot = JSON.parse(
  readFileSync(join(ROOT, 'test/fixtures/theme-resource-routes.json'), 'utf8'),
);
test('resource routes and write parameters match the current API snapshot', () => {
  assert.deepEqual(
    themeResourceContract.map(({ id, method, path, read_only, idempotent, request_fields }) => ({
      id,
      method,
      path,
      read_only,
      idempotent,
      body_fields: request_fields
        .filter((field) => field.location === 'JSON' && !/[.[]/.test(field.name))
        .map((field) => field.name),
    })),
    routeSnapshot,
  );
  assert.ok(
    !themeResourceContract
      .map((entry) => String(entry.name))
      .includes('get_theme_editor_reference_data'),
  );
});

for (const endpoint of [
  { id: 'target-themes-duplicate-status', prefix: 'theme_duplications' },
  { id: 'target-backups-status', prefix: 'backup_operations' },
]) {
  test(`${endpoint.id}: job UUID is a path argument without a theme`, async (t) => {
    const { service, calls } = fixture(t);
    const job = randomUUID();
    await service.execute(method(endpoint.id), 'shop', { job_id: job });
    assert.equal(calls[0]?.path, `/admin/theme_editor/v1/${endpoint.prefix}/${job}.json`);
    for (const job_id of [42, '../themes', 'abc', '']) {
      await assert.rejects(
        () => service.execute(method(endpoint.id), 'shop', { job_id }),
        (error: unknown) => error instanceof Fault && error.code === 'validation_failed',
      );
    }
    assert.equal(calls.length, 1);
  });
}

for (const endpoint of [
  { id: 'target-profile', path: { theme_id: 7 }, body: { path: '/', detail: 'summary' } },
  { id: 'target-page-widgets', path: { theme_id: 7 }, body: { path: '/' } },
  { id: 'target-widget-render', path: { theme_id: 7, widget_id: 8 }, body: { path: '/' } },
]) {
  test(`${endpoint.id}: reading POST does not create a write operation`, async (t) => {
    const { service, calls, state } = fixture(t);
    const id = randomUUID();
    const result = await service.execute(
      method(endpoint.id),
      'shop',
      endpoint.path,
      endpoint.body,
      id,
    );
    assert.ok(isRecord(result));
    assert.equal(result.id, 42);
    assert.equal(state.get('operation', id), undefined);
    assert.equal(calls[0]?.method, 'POST');
    assert.equal(calls[0]?.options?.idempotencyKey, undefined);
    await assert.rejects(
      () =>
        service.execute(method(endpoint.id), 'shop', endpoint.path, {
          ...endpoint.body,
          draft_session_id: 3,
        }),
      (error: unknown) => error instanceof Fault && error.code === 'validation_failed',
    );
    assert.equal(calls.length, 1);
  });
}

for (const id of [
  'target-types-create',
  'target-widgets-create',
  'target-template-copy',
  'target-assets-create',
  'target-backups-create',
]) {
  test(`${id}: unknown non-idempotent creation is never resent, including old journal keys`, async (t) => {
    const { service, calls, state, loseResponse } = fixture(t);
    const operationId = randomUUID();
    loseResponse();
    await service.execute(method(id), 'shop', { theme_id: 7, id: 8 }, {}, operationId);
    assert.equal(calls[0]?.options?.idempotencyKey, undefined);
    const operation = state.get('operation', operationId);
    assert.ok(isRecord(operation));
    state.put('operation', operationId, { ...operation, idempotency_key: operationId });
    await assert.rejects(
      () => service.retry(operationId),
      (error: unknown) => error instanceof Fault && error.code === 'execution_unknown',
    );
    assert.equal(calls.length, 1);
  });
}

test('unsupported write parameters fail before HTTP or the operation journal', async (t) => {
  const { service, calls, state } = fixture(t);
  for (const endpoint of [
    { id: 'target-widgets-update', body: { expected_revision: 'a'.repeat(64) } },
    { id: 'target-assets-create', body: { src: 'https://example.com/image.png' } },
    { id: 'target-assets-create', body: { filename: 'image.png' } },
    { id: 'target-block-lists-create', body: { invisible: true } },
    { id: 'target-widgets-duplicate', body: { settings: {} } },
  ]) {
    const operationId = randomUUID();
    await assert.rejects(
      () =>
        service.execute(
          method(endpoint.id),
          'shop',
          { theme_id: 7, id: 8 },
          endpoint.body,
          operationId,
        ),
      (error: unknown) => error instanceof Fault && error.code === 'validation_failed',
    );
    assert.equal(state.get('operation', operationId), undefined);
  }
  assert.equal(calls.length, 0);
});

test('a timestamp conflict is final and never replaced with a fresh timestamp', async (t) => {
  const { state, calls } = fixture(t);
  const api = new Api(
    state,
    { key: 'id', password: 'password' },
    {
      request: async (_store, _credentials, verb, path, body) => {
        calls.push({ method: verb, path, ...(body ? { body } : {}) });
        throw new Fault('conflict', 'Stale timestamp');
      },
    },
  );
  const service = new DirectThemeResources(api);
  const id = randomUUID();
  const body = { expected_updated_at: '2026-11-11T12:00:00.123456Z', settings: { title: 'New' } };
  const result = await service.execute(
    method('target-widgets-update'),
    'shop',
    { theme_id: 7, id: 8 },
    body,
    id,
  );
  assert.ok(isRecord(result));
  assert.equal(result.status, 'failed');
  await service.retry(id);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.body, body);
});

for (const endpoint of [
  { id: 'target-system-types-show', prefix: 'system_widget_types' },
  { id: 'target-snippets-show', prefix: 'system_snippets' },
]) {
  test(`${endpoint.id}: system resources accept handles as well as numeric IDs`, async (t) => {
    const { service, calls } = fixture(t);
    await service.execute(method(endpoint.id), 'shop', { id: 'system_v4_fonts' });
    assert.equal(calls[0]?.path, `/admin/theme_editor/v1/${endpoint.prefix}/system_v4_fonts.json`);
    await assert.rejects(
      () => service.execute(method(endpoint.id), 'shop', { id: '../themes' }),
      (error: unknown) => error instanceof Fault && error.code === 'validation_failed',
    );
    assert.equal(calls.length, 1);
  });
}
