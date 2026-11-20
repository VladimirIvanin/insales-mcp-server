import { callOperation } from './code-mode-client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Api, type Transport, type RequestOptions } from '../src/api.js';
import { createPreparedWriteFixture } from './prepared-write-fixture.js';
import { Fault } from '../src/shared/common.js';

type Json = Record<string, any>;
import { State, type Store } from '../src/infrastructure/persistence/state.js';
import type { Credentials } from '../src/app/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { Knowledge } from '../src/infrastructure/knowledge/index.js';

class CatalogTransport implements Transport {
  collections = new Map<number, Json>([
    [
      1,
      { id: 1, parent_id: null, title: 'Каталог', position: 0, is_smart: false, updated_at: '1' },
    ],
    [
      2,
      {
        id: 2,
        parent_id: 1,
        title: 'Обувь',
        position: 1,
        is_smart: false,
        updated_at: '1',
        field_values: [],
      },
    ],
  ]);
  collects = new Map<number, Json>();
  smartProducts = false;
  staleCollectIndex = false;
  calls: { method: string; path: string; body?: Json | undefined }[] = [];
  loseMethod?: string;
  async request(
    _store: Store,
    _credentials: Credentials,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: Json,
    _options?: RequestOptions,
  ) {
    this.calls.push({ method, path, body });
    const url = new URL(`https://store.test${path}`);
    const matchCollection = url.pathname.match(/^\/admin\/collections\/(\d+)\.json$/);
    const matchCollect = url.pathname.match(/^\/admin\/collects\/(\d+)\.json$/);
    if (method === 'GET') {
      if (url.pathname === '/admin/collections.json') {
        const parent = url.searchParams.get('parent_id');
        const page = Number(url.searchParams.get('page') ?? 1);
        const perPage = Number(url.searchParams.get('per_page') ?? 250);
        return [...this.collections.values()]
          .filter((row) => parent === null || Number(row.parent_id) === Number(parent))
          .slice((page - 1) * perPage, page * perPage);
      }
      if (url.pathname === '/admin/collects.json') {
        if (this.staleCollectIndex) return [];
        const product = url.searchParams.get('product_id');
        const collection = url.searchParams.get('collection_id');
        const page = Number(url.searchParams.get('page') ?? 1);
        const perPage = Number(url.searchParams.get('per_page') ?? 250);
        return [...this.collects.values()]
          .filter(
            (row) =>
              (!product || Number(row.product_id) === Number(product)) &&
              (!collection || Number(row.collection_id) === Number(collection)),
          )
          .slice((page - 1) * perPage, page * perPage);
      }
      if (url.pathname === '/admin/products.json')
        return this.smartProducts ? [{ id: 7, title: 'Товар' }] : [];
      if (matchCollection) {
        const row = this.collections.get(Number(matchCollection[1]));
        if (!row) throw new Fault('not_found', 'Missing collection');
        return structuredClone(row);
      }
      if (matchCollect) {
        const row = this.collects.get(Number(matchCollect[1]));
        if (!row) throw new Fault('not_found', 'Missing collect');
        return structuredClone(row);
      }
      if (url.pathname === '/admin/products/7.json') return { id: 7, title: 'Товар' };
      if (url.pathname === '/admin/collections/2/collection_field_values/color.json')
        return { id: 4, collection_field_id: 8, value: 'blue' };
      throw new Fault('not_found', 'Missing fixture');
    }
    let result: Json = { status: 'ok' };
    if (url.pathname === '/admin/collections.json' && method === 'POST') {
      const id = 10;
      const fields = body!.collection;
      this.collections.set(id, {
        id,
        ...fields,
        updated_at: '2',
        image: fields.image_attributes
          ? { id: 5, original_url: 'https://cdn.example.com/pic.jpg' }
          : null,
        field_values: (fields.field_values_attributes ?? []).map((field: Json) => ({
          id: field.id,
          collection_field_id: field.collection_field_id,
          value: field.value,
        })),
      });
      result = { id };
    } else if (matchCollection && method === 'PUT') {
      const id = Number(matchCollection[1]);
      const fields = body!.collection;
      const before = this.collections.get(id)!;
      this.collections.set(id, {
        ...before,
        ...fields,
        updated_at: '2',
        image: fields.image_attributes
          ? { id: 5, original_url: 'https://cdn.example.com/pic.jpg' }
          : before.image,
        field_values: fields.field_values_attributes
          ? fields.field_values_attributes.map((field: Json) => ({
              id: field.id,
              collection_field_id: field.collection_field_id,
              value: field.value,
            }))
          : before.field_values,
      });
    } else if (matchCollection && method === 'DELETE')
      this.collections.delete(Number(matchCollection[1]));
    else if (url.pathname === '/admin/collects.json' && method === 'POST') {
      const id = 20;
      this.collects.set(id, { id, ...body!.collect });
      result = { id };
    } else if (matchCollect && method === 'DELETE') this.collects.delete(Number(matchCollect[1]));
    else throw new Fault('not_found', 'Missing mutation fixture');
    if (this.loseMethod === method) throw new Fault('execution_unknown', 'Lost response');
    return result;
  }
}
function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'insales-catalog-'));
  const state = new State(directory, {
    id: 'one',
    name: 'Test',
    url: 'https://test.myinsales.ru',
  });
  state.rateSlot = () => 0;
  const transport = new CatalogTransport();
  const engine = createPreparedWriteFixture(
    new Api(state, { key: 'test', password: 'hidden' }, transport),
  );
  t.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { engine, transport };
}
test('collection list, detail, create and update use documented routes and verify image/custom field', async (t) => {
  const { engine, transport } = fixture(t);
  assert.equal((await engine.catalog.listCollections('one', 1, 20, 1)).items[0]!.title, 'Обувь');
  const create = await engine.catalog.proposeCollection('one', 'create', undefined, {
    title: 'Сумки',
    parent_id: 1,
    image_attributes: { src: 'https://images.example.com/pic.jpg' },
    field_values_attributes: [{ id: 4, value: 'blue' }],
  });
  assert.equal((await engine.apply(create.change_id)).status, 'applied');
  assert.deepEqual(
    transport.calls.find((call) => call.method === 'POST')!.body!.collection.title,
    'Сумки',
  );
  const before = await engine.catalog.readCollection('one', 2);
  const update = await engine.catalog.proposeCollection(
    'one',
    'update',
    2,
    { title: 'Новая обувь', is_hidden: true },
    before.revision,
  );
  assert.equal((await engine.apply(update.change_id)).status, 'applied');
  assert.equal((await engine.catalog.readCollection('one', 2)).data.title, 'Новая обувь');
  assert.ok(
    transport.calls.some(
      (call) => call.method === 'PUT' && call.path === '/admin/collections/2.json',
    ),
  );
});
test('collection pagination preserves parent filter and next page', async (t) => {
  const { engine, transport } = fixture(t);
  for (let id = 20; id < 41; id++)
    transport.collections.set(id, { id, parent_id: 1, title: `Категория ${id}`, updated_at: '1' });
  const first = await engine.catalog.listCollections('one', 1, 20, 1);
  assert.equal(first.items.length, 20);
  assert.equal(first.next_page, 2);
  const second = await engine.catalog.listCollections('one', 2, 20, 1);
  assert.equal(second.items.length, 2);
  assert.equal(second.next_page, null);
  assert.ok(
    transport.calls.some(
      (call) => call.path === '/admin/collections.json?page=2&per_page=20&parent_id=1',
    ),
  );
});
test('collection revision conflict and unsupported smart filters fail before mutation', async (t) => {
  const { engine, transport } = fixture(t);
  const before = await engine.catalog.readCollection('one', 2);
  transport.collections.get(2)!.title = 'Другой редактор';
  await assert.rejects(
    engine.catalog.proposeCollection('one', 'update', 2, { title: 'Wanted' }, before.revision),
    (error: any) => error.code === 'conflict',
  );
  await assert.rejects(
    engine.catalog.proposeCollection(
      'one',
      'update',
      2,
      { smart_collection_filters_attributes: [] },
      'a'.repeat(64),
    ),
    (error: any) => error.code === 'validation_failed',
  );
  assert.equal(
    transport.calls.some((call) => call.method === 'PUT'),
    false,
  );
});
test('delete blocks root, children and products; accepts empty leaf asynchronously', async (t) => {
  const { engine, transport } = fixture(t);
  const root = await engine.catalog.readCollection('one', 1);
  await assert.rejects(
    engine.catalog.proposeCollection('one', 'delete', 1, {}, root.revision),
    (error: any) => error.code === 'validation_failed',
  );
  transport.collections.set(3, { id: 3, parent_id: 2, title: 'Дочерняя', updated_at: '1' });
  let before = await engine.catalog.readCollection('one', 2);
  await assert.rejects(
    engine.catalog.proposeCollection('one', 'delete', 2, {}, before.revision),
    (error: any) => error.code === 'validation_failed',
  );
  transport.collections.delete(3);
  transport.collects.set(11, { id: 11, collection_id: 2, product_id: 7 });
  await assert.rejects(
    engine.catalog.proposeCollection('one', 'delete', 2, {}, before.revision),
    (error: any) => error.code === 'validation_failed',
  );
  transport.collects.clear();
  before = await engine.catalog.readCollection('one', 2);
  const draft = await engine.catalog.proposeCollection('one', 'delete', 2, {}, before.revision);
  transport.collects.set(11, { id: 11, collection_id: 2, product_id: 7 });
  await assert.rejects(
    engine.apply(draft.change_id),
    (error: any) => error.code === 'validation_failed',
  );
  transport.collects.clear();
  assert.equal((await engine.apply(draft.change_id)).status, 'accepted_async');
  assert.equal(transport.calls.filter((call) => call.method === 'DELETE').length, 1);
});
test('manual membership add/remove is verified; smart membership is rejected', async (t) => {
  const { engine, transport } = fixture(t);
  const add = await engine.catalog.proposeMembership('one', 'add', 2, 7);
  assert.equal((await engine.apply(add.change_id)).status, 'applied');
  assert.equal((await engine.catalog.listCollects('one', 1, 20, 7)).items.length, 1);
  const remove = await engine.catalog.proposeMembership('one', 'remove', 2, 7);
  assert.equal((await engine.apply(remove.change_id)).status, 'applied');
  assert.equal(transport.collects.size, 0);
  transport.collections.get(2)!.is_smart = true;
  assert.equal((await engine.catalog.readCollection('one', 2)).data.is_smart, true);
  await assert.rejects(
    engine.catalog.proposeMembership('one', 'add', 2, 7),
    (error: any) => error.code === 'unsupported_capability',
  );
});
test('lost create response never sends a duplicate POST', async (t) => {
  const { engine, transport } = fixture(t);
  transport.loseMethod = 'POST';
  const draft = await engine.catalog.proposeCollection('one', 'create', undefined, {
    title: 'Новая',
    parent_id: 1,
  });
  assert.equal((await engine.apply(draft.change_id)).status, 'execution_unknown');
  assert.equal((await engine.apply(draft.change_id)).status, 'execution_unknown');
  assert.equal(transport.calls.filter((call) => call.method === 'POST').length, 1);
});
test('unknown membership POST with stale index is not retried', async (t) => {
  const { engine, transport } = fixture(t);
  transport.staleCollectIndex = true;
  transport.loseMethod = 'POST';
  const draft = await engine.catalog.proposeMembership('one', 'add', 2, 7);
  assert.equal((await engine.apply(draft.change_id)).status, 'execution_unknown');
  assert.equal((await engine.apply(draft.change_id)).status, 'execution_unknown');
  assert.equal(transport.calls.filter((call) => call.method === 'POST').length, 1);
  transport.staleCollectIndex = false;
  assert.equal((await engine.apply(draft.change_id)).status, 'applied');
  assert.equal(transport.calls.filter((call) => call.method === 'POST').length, 1);
});
test('lost update and delete replies reconcile without repeating writes', async (t) => {
  const { engine, transport } = fixture(t);
  let before = await engine.catalog.readCollection('one', 2);
  const update = await engine.catalog.proposeCollection(
    'one',
    'update',
    2,
    { title: 'Сохранено' },
    before.revision,
  );
  transport.loseMethod = 'PUT';
  assert.equal((await engine.apply(update.change_id)).status, 'applied');
  await engine.apply(update.change_id);
  assert.equal(transport.calls.filter((call) => call.method === 'PUT').length, 1);
  before = await engine.catalog.readCollection('one', 2);
  const deletion = await engine.catalog.proposeCollection('one', 'delete', 2, {}, before.revision);
  transport.loseMethod = 'DELETE';
  assert.equal((await engine.apply(deletion.change_id)).status, 'accepted_async');
  await engine.apply(deletion.change_id);
  assert.equal(transport.calls.filter((call) => call.method === 'DELETE').length, 1);
});
test('reparenting checks ancestors and advanced field input is bounded', async (t) => {
  const { engine } = fixture(t);
  const before = await engine.catalog.readCollection('one', 2);
  await assert.rejects(
    engine.catalog.proposeCollection('one', 'update', 2, { parent_id: 2 }, before.revision),
    (error: any) => error.code === 'validation_failed',
  );
  await assert.rejects(
    engine.catalog.proposeCollection(
      'one',
      'update',
      2,
      { image_attributes: { src: 'https://127.0.0.1/private.png' } },
      before.revision,
    ),
    (error: any) => error.code === 'validation_failed',
  );
  await assert.rejects(
    engine.catalog.proposeCollection('one', 'create', undefined, {
      title: 'Smart',
      parent_id: 1,
      is_smart: true,
    }),
    (error: any) => error.code === 'validation_failed',
  );
});
test('delete rejects a smart collection with effective products even without collects', async (t) => {
  const { engine, transport } = fixture(t);
  transport.collections.get(2)!.is_smart = true;
  transport.smartProducts = true;
  const before = await engine.catalog.readCollection('one', 2);
  await assert.rejects(
    engine.catalog.proposeCollection('one', 'delete', 2, {}, before.revision),
    (error: any) => error.code === 'validation_failed',
  );
  assert.equal(
    transport.calls.some((call) => call.method === 'DELETE'),
    false,
  );
});
test('catalog MCP contract reads collection and applies typed proposal', async (t) => {
  const { engine } = fixture(t);
  const knowledge = new Knowledge();
  t.after(() => knowledge.close());
  const server = createMcpServer({ engine, knowledge });
  const client = new Client({ name: 'catalog-contract', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const listed = await callOperation(client, {
    name: 'read_content',
    arguments: { store_id: 'one', kind: 'collection', mode: 'list', parent_id: 1 },
  });
  assert.equal(JSON.parse((listed.content as any)[0].text).items[0].id, 2);
  const read = await callOperation(client, {
    name: 'read_content',
    arguments: { store_id: 'one', kind: 'collection', mode: 'get', id: 2 },
  });
  const revision = JSON.parse((read.content as any)[0].text).revision;
  const proposal = await callOperation(client, {
    name: 'change_collection',
    arguments: {
      store_id: 'one',
      action: 'update',
      id: 2,
      fields: { title: 'Новые товары' },
      base_revision: revision,
    },
  });
  assert.equal(JSON.parse((proposal.content as any)[0].text).status, 'applied');
  const forbidden = await callOperation(client, {
    name: 'change_collection',
    arguments: {
      store_id: 'one',
      action: 'update',
      id: 2,
      fields: { smart_collection_filters_attributes: [] },
      base_revision: revision,
    },
  });
  assert.equal(forbidden.isError, true);
});
