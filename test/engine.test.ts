import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { State, type Store } from '../src/infrastructure/persistence/state.js';
import {
  Api,
  HttpTransport,
  type Transport,
  type RequestOptions,
  publicAddress,
  normalizeUrl,
  validatedLookup,
} from '../src/api.js';
import { createPreparedWriteFixture } from './prepared-write-fixture.js';
import { Fault } from '../src/shared/common.js';

type Json = Record<string, any>;
import type { Credentials } from '../src/app/config.js';
import { InSalesClient } from '../src/infrastructure/insales/admin-client.js';
import { Response, fetch as undiciFetch } from 'undici';

class FakeTransport implements Transport {
  objects = new Map<string, Json>([
    [
      '/admin/pages/1.json',
      { id: 1, title: 'Доставка', content: 'Старый текст', updated_at: '2026-01-01' },
    ],
    ['/admin/blogs/1/articles/2.json', { id: 2, blog_id: 1, title: 'Статья', content: 'Текст' }],
    ['/admin/themes/10.json', { id: 10, is_published: false }],
    [
      '/admin/themes/10/assets/1.json',
      {
        id: 1,
        type: 'Asset::Media',
        inner_file_name: 'theme.css',
        version: 123,
        content: '.x { color: red; }',
      },
    ],
    [
      '/admin/themes/10/assets/2.json',
      {
        id: 2,
        type: 'Asset::Media',
        inner_file_name: 'theme.js',
        version: 123,
        content: 'var x = 1;',
      },
    ],
  ]);
  calls: { method: string; path: string; body?: Json | undefined }[] = [];
  failPutPath?: string;
  loseResponse = false;
  lostReadAfterWrite = false;
  async request(
    _store: Store,
    _credentials: Credentials,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: Json,
    _options?: RequestOptions,
  ) {
    this.calls.push({ method, path, body });
    if (path.endsWith('/preparation.json'))
      return {
        valid: true,
        commands: body!.commands,
        request_digest: 'e'.repeat(64),
        normalized: {},
        effects: [],
        warnings: [],
        errors: [],
      };
    if (path.endsWith('/commands.json')) {
      const command = body!.commands[0];
      const collection = command.type.startsWith('asset.') ? 'assets' : 'widget_types';
      const id = command.target?.id ?? 99;
      const target = `/admin/themes/10/${collection}/${id}.json`;
      const attrs = command.attributes;
      const record = {
        ...this.objects.get(target),
        ...attrs,
        id,
        ...(collection === 'assets'
          ? { inner_file_name: attrs.name ?? this.objects.get(target)?.inner_file_name }
          : {}),
      };
      this.objects.set(target, record);
      return {
        outcome: 'applied',
        request_digest: body!.request_digest,
        results: [{ id, revision: 'b'.repeat(64) }],
        references: {},
      };
    }
    if (method === 'GET' && path.includes('/theme_editor/v1/themes/10/')) {
      const original = path.replace('/theme_editor/v1', '').split('?')[0]!;
      const value = this.objects.get(original);
      if (!value) throw new Fault('not_found', 'No fixture');
      return { ...structuredClone(value), name: value.inner_file_name, revision: 'a'.repeat(64) };
    }
    if (method === 'GET') {
      if (this.lostReadAfterWrite && this.calls.some((c) => c.method === 'PUT'))
        throw new Fault('permission_denied', 'Forbidden on verification');
      if (path.endsWith('/raw'))
        return this.objects.get(path.replace('/raw', '.json'))?.content ?? '';
      const normalized = path.split('?')[0] ?? '';
      if (
        normalized.endsWith('/assets.json') ||
        normalized.endsWith('/widget_types.json') ||
        normalized.endsWith('/collections.json') ||
        normalized.endsWith('/collects.json')
      )
        return [...this.objects.entries()]
          .filter(([key]) => key.startsWith(normalized.replace('.json', '/')))
          .map(([, value]) => structuredClone(value));
      const value = this.objects.get(normalized);
      if (!value) throw new Fault('not_found', 'No fixture');
      return structuredClone(value);
    }
    if (this.failPutPath === path) throw new Fault('validation_failed', 'Rejected');
    if (method === 'DELETE') {
      this.objects.delete(path);
      return { status: 'ok' };
    }
    const fields = body?.page ?? body?.article ?? body?.product ?? body?.asset ?? body!;
    if (method === 'PUT') {
      this.objects.set(path, { ...this.objects.get(path), ...fields });
      if (this.loseResponse) throw new Fault('execution_unknown', 'Lost reply');
      return { status: 'ok' };
    }
    const target = path.replace('.json', '/99.json');
    this.objects.set(target, {
      id: 99,
      ...fields,
      ...(fields.name && fields.type?.startsWith('Asset::')
        ? { inner_file_name: fields.name, version: 123 }
        : {}),
    });
    if (this.loseResponse) throw new Fault('execution_unknown', 'Lost reply');
    return { id: 99, ...fields };
  }
}
const credentials: Credentials = { key: 'test-key', password: 'never-print-password' };
function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'insales-engine-'));
  const state = new State(directory, {
    id: 'one',
    name: 'Test',
    url: 'https://test.myinsales.ru',
  });
  state.rateSlot = () => 0;
  const transport = new FakeTransport();
  const engine = createPreparedWriteFixture(new Api(state, credentials, transport));
  t.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { state, transport, engine };
}

test('update only requested fields, verify and never repeat successful mutation', async (t) => {
  const { engine, transport } = fixture(t);
  const before = await engine.read('one', { kind: 'page', id: 1 });
  const draft = await engine.propose([
    {
      store_id: 'one',
      target: { kind: 'page', id: 1 },
      action: 'update',
      base_revision: before.revision,
      fields: { content: 'Новый текст' },
    },
  ]);
  assert.equal((await engine.apply(draft.change_id)).status, 'applied');
  await engine.apply(draft.change_id);
  assert.deepEqual(
    transport.calls.filter((c) => c.method === 'PUT').map((c) => c.body),
    [{ page: { content: 'Новый текст' } }],
  );
});
test('concurrent content edit prevents write', async (t) => {
  const { engine, transport } = fixture(t);
  const before = await engine.read('one', { kind: 'page', id: 1 });
  const draft = await engine.propose([
    {
      store_id: 'one',
      target: { kind: 'page', id: 1 },
      action: 'update',
      base_revision: before.revision,
      fields: { content: 'Wanted' },
    },
  ]);
  transport.objects.get('/admin/pages/1.json')!.content = 'Other editor';
  await assert.rejects(engine.apply(draft.change_id), (e: any) => e.code === 'conflict');
  assert.equal(
    transport.calls.some((c) => c.method === 'PUT'),
    false,
  );
});
test('article cannot escape blog scope and unknown store cannot fetch credentials', async (t) => {
  const { engine, transport } = fixture(t);
  transport.objects.set('/admin/blogs/2/articles/2.json', { id: 2, blog_id: 1, title: 'Private' });
  await assert.rejects(
    engine.read('one', { kind: 'article', id: 2, blog_id: 2 }),
    (e: any) => e.code === 'permission_denied',
  );
  const count = transport.calls.length;
  await assert.rejects(
    engine.read('unknown', { kind: 'page', id: 1 }),
    (e: any) => e.code === 'permission_denied',
  );
  assert.equal(transport.calls.length, count);
});
test('lost create response remains unknown and cannot create a duplicate', async (t) => {
  const { engine, transport } = fixture(t);
  transport.loseResponse = true;
  const draft = await engine.propose([
    {
      store_id: 'one',
      target: { kind: 'page' },
      action: 'create',
      fields: { title: 'New', content: 'Content' },
    },
  ]);
  assert.equal((await engine.apply(draft.change_id)).status, 'execution_unknown');
  assert.equal((await engine.apply(draft.change_id)).status, 'execution_unknown');
  assert.equal(transport.calls.filter((c) => c.method === 'POST').length, 1);
});
test('article creation requires fields validated by the live API', async (t) => {
  const { engine } = fixture(t);
  const base = {
    store_id: 'one',
    target: { kind: 'article' as const, blog_id: 1 },
    action: 'create' as const,
  };
  await assert.rejects(
    engine.propose([{ ...base, fields: { title: 'New', content: 'Content' } }]),
    (e: any) =>
      e.code === 'validation_failed' &&
      e.details.required_fields.includes('author') &&
      e.details.required_fields.includes('published_at'),
  );
  const draft = await engine.propose([
    {
      ...base,
      fields: {
        title: 'New',
        content: 'Content',
        author: 'Editor',
        published_at: '2026-09-21T10:00:00.000Z',
      },
    },
  ]);
  assert.equal(draft.items[0]!.action, 'create');
});
test('lost update response reconciles with read, no second PUT', async (t) => {
  const { engine, transport } = fixture(t);
  transport.loseResponse = true;
  const before = await engine.read('one', { kind: 'page', id: 1 });
  const draft = await engine.propose([
    {
      store_id: 'one',
      target: { kind: 'page', id: 1 },
      action: 'update',
      base_revision: before.revision,
      fields: { content: 'Saved' },
    },
  ]);
  assert.equal((await engine.apply(draft.change_id)).status, 'execution_unknown');
  assert.equal((await engine.apply(draft.change_id)).status, 'applied');
  assert.equal(transport.calls.filter((c) => c.method === 'PUT').length, 1);
});
test('verification read failing after accepted write is unknown, not rejected', async (t) => {
  const { engine, transport } = fixture(t);
  transport.lostReadAfterWrite = true;
  const before = await engine.read('one', { kind: 'page', id: 1 });
  const draft = await engine.propose([
    {
      store_id: 'one',
      target: { kind: 'page', id: 1 },
      action: 'update',
      base_revision: before.revision,
      fields: { content: 'Saved' },
    },
  ]);
  assert.equal((await engine.apply(draft.change_id)).status, 'execution_unknown');
});
test('mixed or multiple asset operations reject before reading or writing', async (t) => {
  const { engine, transport } = fixture(t);
  await assert.rejects(
    engine.propose(
      [1, 2].map((id) => ({
        store_id: 'one',
        target: { kind: 'asset' as const, id, theme_id: 10 },
        action: 'update' as const,
        base_revision: 'a'.repeat(64),
        fields: { content: 'Rejected' },
      })),
    ),
    { code: 'unsupported_capability' },
  );
  assert.deepEqual(transport.calls, []);
});
test('disallowed catalog fields are rejected before write', async (t) => {
  const { engine } = fixture(t);
  await assert.rejects(
    engine.propose([
      {
        store_id: 'one',
        target: { kind: 'product', id: 1 },
        action: 'update',
        base_revision: 'a'.repeat(64),
        fields: { price: 1 },
      },
    ]),
    (e: any) => e.code === 'validation_failed',
  );
});
test('asset reads use server revision and content without a legacy raw request', async (t) => {
  const { engine, transport } = fixture(t);
  const response = await engine.read('one', { kind: 'asset', id: 1, theme_id: 10 });
  assert.equal(response.revision, 'a'.repeat(64));
  assert.equal(response.data.content, '.x { color: red; }');
  assert.deepEqual(
    transport.calls.map((call) => call.path),
    ['/admin/theme_editor/v1/themes/10/assets/1.json?include_content=true'],
  );
});
test('authentication errors are reported and 429 persists backoff without mutation retry', async (t) => {
  const { state } = fixture(t);
  const bad: Transport = {
    request: async () => {
      throw new Fault('authentication_required', '401');
    },
  };
  await assert.rejects(new Api(state, credentials, bad).request('one', 'GET', '/admin/pages.json'));
  assert.equal(state.stores()[0]!.id, 'one');
  const limited: Transport = {
    request: async () => {
      throw new Fault('rate_limited', '429', { retry_after_seconds: 3 });
    },
  };
  await assert.rejects(
    new Api(state, credentials, limited).request('one', 'GET', '/admin/pages.json'),
  );
  assert.ok(Number(state.db.prepare('SELECT next_ms FROM rates').get()!.next_ms) > Date.now());
});
test('HTTP 422 exposes bounded validation errors without URLs or credentials', async () => {
  const body = JSON.stringify({
    src: [
      'Не удалось загрузить https://cdn.example.com/a.jpg?token=top-secret&key=another',
      'Authorization: Basic c2VjcmV0',
    ],
    filename: ['Неверное имя'],
    'unsafe field': 'ignored',
  });
  const fetcher = (async () =>
    new Response(body, {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof undiciFetch;
  const transport = new HttpTransport(undefined, fetcher);
  const store: Store = { id: 'one', name: 'Test', url: 'https://test.myinsales.ru' };
  await assert.rejects(
    transport.request(store, credentials, 'POST', '/admin/products/40/images.json', {
      image: { src: 'https://cdn.example.com/a.jpg' },
    }),
    (error: any) => {
      assert.equal(error.code, 'validation_failed');
      assert.equal(error.details.http_status, 422);
      assert.deepEqual(error.details.validation_errors, [
        { field: 'src', message: 'Не удалось загрузить [URL]' },
        { field: 'src', message: '[credential]' },
        { field: 'filename', message: 'Неверное имя' },
      ]);
      assert.doesNotMatch(
        JSON.stringify(error.details),
        /top-secret|another|c2VjcmV0|cdn\.example\.com/,
      );
      return true;
    },
  );
  const listed = new HttpTransport(
    undefined,
    (async () =>
      new Response(
        JSON.stringify({
          errors: [
            { path: 'src', message: 'See https://evil.example/a Bearer abcdef\nnext' },
            { field: 'title', message: 'token=secret-value' },
            { path: 'src', message: 'ok\u0000line' },
          ],
        }),
        { status: 422 },
      )) as typeof undiciFetch,
  );
  await assert.rejects(
    listed.request(store, credentials, 'POST', '/admin/products.json'),
    (error: any) => {
      assert.deepEqual(error.details.validation_errors, [
        { field: 'src', message: 'See [URL] [credential] next' },
        { field: 'title', message: '[credential]' },
        { field: 'src', message: 'ok line' },
      ]);
      assert.doesNotMatch(JSON.stringify(error.details), /evil\.example|abcdef|secret-value/);
      return true;
    },
  );
  const large = new HttpTransport(
    undefined,
    (async () =>
      new Response(JSON.stringify({ src: ['x'.repeat(17000)] }), {
        status: 422,
      })) as typeof undiciFetch,
  );
  await assert.rejects(
    large.request(store, credentials, 'POST', '/admin/products/40/images.json'),
    (error: any) => error.details.http_status === 422 && !('validation_errors' in error.details),
  );
  const themeErrors = new HttpTransport(
    undefined,
    (async () =>
      new Response(
        JSON.stringify({
          errors: [
            {
              path: 'commands[0].attributes.preview_base64',
              code: 'invalid_image',
              message: 'Нужна картинка',
            },
            {
              path: 'commands[1].attributes.widget_type_id',
              code: 'not_found',
              message: 'Неизвестный тип',
            },
          ],
        }),
        { status: 422 },
      )) as typeof undiciFetch,
  );
  await assert.rejects(
    themeErrors.request(
      store,
      credentials,
      'POST',
      '/admin/theme_editor/v1/themes/10/commands.json',
    ),
    (error: any) => {
      assert.deepEqual(error.details.validation_errors, [
        { field: 'commands[0].attributes.preview_base64', message: 'Нужна картинка' },
        { field: 'commands[1].attributes.widget_type_id', message: 'Неизвестный тип' },
      ]);
      return true;
    },
  );
});
test('URL restrictions and public IP validation', () => {
  assert.equal(normalizeUrl('shop.myinsales.ru'), 'https://shop.myinsales.ru');
  for (const url of [
    'http://shop.test',
    'https://user:pass@shop.test',
    'https://shop.test/?key=secret',
    'https://127.0.0.1',
    'https://[::1]',
    'https://shop.test/admin',
    'https://shop.test:444',
  ])
    assert.throws(() => normalizeUrl(url));
  for (const ip of [
    '127.0.0.1',
    '10.1.1.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    '100.64.0.1',
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
});
test('outbound transport preserves HTTPS URL and rejects redirects', async () => {
  const store: Store = {
    id: 'one',
    name: 'Example',
    url: 'https://shop.myinsales.ru',
  };
  const transport = new HttpTransport(undefined, (async (url, init) => {
    const requestUrl = typeof url === 'string' ? url : 'href' in url ? url.href : url.url;
    assert.equal(requestUrl, 'https://shop.myinsales.ru/admin/themes.json');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.dispatcher);
    return new Response('', { status: 302, headers: { location: 'https://example.com/' } });
  }) as typeof undiciFetch);
  await assert.rejects(
    transport.request(store, { key: 'key', password: 'secret' }, 'GET', '/admin/themes.json'),
    (error: any) => error.code === 'api_error' && error.details.http_status === 302,
  );
});
test('resource client owns nested paths, envelopes and delete calls', async (t) => {
  const { engine, transport } = fixture(t);
  const client = new InSalesClient(engine.api, 'one');
  transport.objects.set('/admin/blogs.json', [{ id: 7, title: 'Blog' }] as any);
  await client.blogs.list({ page: 2, per_page: 10 });
  await client.articles(7).create({ title: 'Article', content: 'Body' });
  await client
    .variants(12)
    .create({ sku: 'SKU-M', price: 20, options: [{ title: 'Размер', value: 'M' }] });
  await client.products.remove(12);
  assert.deepEqual(transport.calls.slice(-4), [
    { method: 'GET', path: '/admin/blogs.json?page=2&per_page=10', body: undefined },
    {
      method: 'POST',
      path: '/admin/blogs/7/articles.json',
      body: { article: { title: 'Article', content: 'Body' } },
    },
    {
      method: 'POST',
      path: '/admin/products/12/variants.json',
      body: { variant: { sku: 'SKU-M', price: 20, options: [{ title: 'Размер', value: 'M' }] } },
    },
    { method: 'DELETE', path: '/admin/products/12.json', body: undefined },
  ]);
  assert.throws(
    () => client.articles(0),
    (error: any) => error.code === 'validation_failed',
  );
});
test('catalog client uses collection and collect envelopes with scoped list queries', async (t) => {
  const { engine, transport } = fixture(t);
  const client = new InSalesClient(engine.api, 'one');
  transport.objects.set('/admin/collections/2.json', { id: 2, parent_id: 1, title: 'Обувь' });
  transport.objects.set('/admin/collects/9.json', { id: 9, collection_id: 2, product_id: 7 });
  await client.collections.list({ parent_id: 1, page: 2, per_page: 20 });
  await client.collections.get(2);
  await client.collections.update(2, { title: 'Обувь и сумки' });
  await client.collects.list({ product_id: 7, per_page: 10 });
  await client.collects.remove(9);
  assert.deepEqual(transport.calls.slice(-5), [
    {
      method: 'GET',
      path: '/admin/collections.json?parent_id=1&page=2&per_page=20',
      body: undefined,
    },
    { method: 'GET', path: '/admin/collections/2.json', body: undefined },
    {
      method: 'PUT',
      path: '/admin/collections/2.json',
      body: { collection: { title: 'Обувь и сумки' } },
    },
    { method: 'GET', path: '/admin/collects.json?product_id=7&per_page=10', body: undefined },
    { method: 'DELETE', path: '/admin/collects/9.json', body: undefined },
  ]);
});
test('API paths keep dots inside a name and reject traversal outside /admin', async () => {
  const seen: string[] = [];
  const transport = new HttpTransport(undefined, (async (url) => {
    seen.push(typeof url === 'string' ? url : 'href' in url ? url.href : url.url);
    return new Response('{}', { status: 200 });
  }) as typeof undiciFetch);
  const store: Store = { id: 'one', name: 'Test', url: 'https://shop.myinsales.ru' };
  await transport.request(store, credentials, 'GET', '/admin/files/a..b.json');
  await transport.request(store, credentials, 'GET', '/admin/products.json?q=a..b');
  await transport.request(store, credentials, 'GET', '/admin/foo/../files/a..b.json');
  assert.deepEqual(seen, [
    'https://shop.myinsales.ru/admin/files/a..b.json',
    'https://shop.myinsales.ru/admin/products.json?q=a..b',
    'https://shop.myinsales.ru/admin/files/a..b.json',
  ]);
  for (const path of [
    '/admin/../secret',
    '/admin/%2e%2e/secret',
    'https://evil.example/admin/x.json',
    '//evil.example/admin/x.json',
    '/admin/x.json#fragment',
    '/secret',
  ])
    await assert.rejects(transport.request(store, credentials, 'GET', path), (error: any) => {
      assert.equal(error.code, 'validation_failed');
      return true;
    });
});
test('connection lookup rejects a DNS answer that is not entirely allowed', async (t) => {
  let answer: dns.LookupAddress[] | NodeJS.ErrnoException = [];
  let lookups = 0;
  t.mock.method(dns, 'lookup', ((
    _hostname: string,
    _options: dns.LookupOptions,
    callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
  ) => {
    lookups += 1;
    if (answer instanceof Error) callback(answer, []);
    else callback(null, answer);
  }) as typeof dns.lookup);
  const lookup = validatedLookup(publicAddress);
  const ask = (next: dns.LookupAddress[] | NodeJS.ErrnoException, all = false) =>
    new Promise<{ error: Error | null; address?: string | dns.LookupAddress[]; family?: number }>(
      (resolve) => {
        answer = next;
        lookup('shop.example', { all }, (error, address, family) =>
          resolve({
            error,
            address,
            ...(family === undefined ? {} : { family }),
          }),
        );
      },
    );
  const mixed = await ask([
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  assert.equal(mixed.error?.message, 'Rejected address');
  assert.equal((await ask([])).error?.message, 'Rejected address');
  const failure = Object.assign(new Error('dns down'), { code: 'EAI_AGAIN' });
  assert.equal((await ask(failure)).error?.message, 'dns down');
  const single = await ask([{ address: '8.8.8.8', family: 4 }]);
  assert.equal(single.error, null);
  assert.equal(single.address, '8.8.8.8');
  assert.equal(single.family, 4);
  const all = await ask(
    [
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ],
    true,
  );
  assert.deepEqual(all.address, [
    { address: '8.8.8.8', family: 4 },
    { address: '1.1.1.1', family: 4 },
  ]);

  answer = [
    { address: '8.8.8.8', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ];
  const before = lookups;
  const transport = new HttpTransport();
  t.after(() => transport.close());
  await assert.rejects(
    transport.request(
      { id: 'one', name: 'Test', url: 'https://rebinding.invalid' },
      credentials,
      'GET',
      '/admin/pages.json',
    ),
    (error: any) => {
      assert.equal(error.code, 'connection_failed');
      assert.equal(error.details.reason, 'transport_failure');
      assert.ok(lookups > before);
      return true;
    },
  );
});
