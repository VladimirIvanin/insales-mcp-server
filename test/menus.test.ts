import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Api, type Transport } from '../src/api.js';
import { createPreparedWriteFixture } from './prepared-write-fixture.js';
import { Fault } from '../src/shared/common.js';

type Json = Record<string, any>;
import { State } from '../src/infrastructure/persistence/state.js';

test('menu and link list items use scoped routes, revisions and verified drafts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'insales-menus-'));
  const state = new State(directory, { id: 'one', name: 'Test', url: 'https://test.myinsales.ru' });
  state.rateSlot = () => 0;
  t.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const menus = new Map<number, Json>([[1, { id: 1, name: 'Main', handle: 'main' }]]);
  const items = new Map<number, Json>([
    [
      2,
      {
        id: 2,
        title: 'Catalog',
        url: '/collection',
        position: 1,
        related_object_id: 'Collection_8',
      },
    ],
  ]);
  const writes: string[] = [];
  const transport: Transport = {
    async request(_store, _credentials, method, path, body?: Json) {
      if (method === 'GET') {
        if (path === '/admin/menus.json') return [...menus.values()];
        if (path === '/admin/menus/1/items.json') return [...items.values()];
        if (path === '/admin/menus/1.json')
          return (
            menus.get(1) ??
            (() => {
              throw new Fault('not_found', 'menu');
            })()
          );
        if (path === '/admin/menus/3.json')
          return (
            menus.get(3) ??
            (() => {
              throw new Fault('not_found', 'menu');
            })()
          );
        if (path === '/admin/menus/1/items/2.json')
          return (
            items.get(2) ??
            (() => {
              throw new Fault('not_found', 'item');
            })()
          );
        if (path === '/admin/menus/1/items/4.json')
          return (
            items.get(4) ??
            (() => {
              throw new Fault('not_found', 'item');
            })()
          );
      }
      writes.push(`${method} ${path}`);
      if (method === 'PUT' && path === '/admin/menus/1.json') {
        menus.set(1, { ...menus.get(1), ...body?.menu });
        return menus.get(1);
      }
      if (method === 'PUT' && path === '/admin/menus/1/items/2.json') {
        items.set(2, { ...items.get(2), ...body?.menu_item });
        return items.get(2);
      }
      if (method === 'POST' && path === '/admin/menus.json') {
        const created = { id: 3, ...body?.menu };
        menus.set(3, created);
        return created;
      }
      if (method === 'POST' && path === '/admin/menus/1/items.json') {
        const created = { id: 4, position: 2, related_object_id: 'Page_0', ...body?.menu_item };
        items.set(4, created);
        return created;
      }
      throw new Fault('not_found', path);
    },
  };
  const engine = createPreparedWriteFixture(
    new Api(state, { key: 'key', password: 'secret' }, transport),
  );
  assert.deepEqual(
    (await engine.menus.list('one', 'menu_item', 1)).items.map((item) => item.id),
    [2],
  );
  const menu = await engine.menus.read('one', 'menu', 1);
  const draft = await engine.menus.propose(
    'one',
    'menu',
    'update',
    { name: 'New main' },
    1,
    undefined,
    menu.revision,
  );
  assert.equal((await engine.apply(draft.change_id)).status, 'applied');
  assert.equal((await engine.apply(draft.change_id)).status, 'applied');
  assert.deepEqual(writes, ['PUT /admin/menus/1.json']);
  const item = await engine.menus.read('one', 'menu_item', 2, 1);
  await assert.rejects(
    engine.menus.propose('one', 'menu_item', 'update', { url: '/page/about' }, 2, 1, item.revision),
    (error: any) => error.code === 'validation_failed',
  );
  const itemDraft = await engine.menus.propose(
    'one',
    'menu_item',
    'update',
    { title: 'Shop' },
    2,
    1,
    item.revision,
  );
  items.get(2)!.title = 'Changed elsewhere';
  await assert.rejects(
    engine.apply(itemDraft.change_id),
    (error: any) => error.code === 'conflict',
  );
  assert.deepEqual(writes, ['PUT /admin/menus/1.json']);
  const newMenu = await engine.menus.propose('one', 'menu', 'create', {
    name: 'Footer',
    handle: 'footer',
  });
  assert.equal((await engine.apply(newMenu.change_id)).status, 'applied');
  const newItem = await engine.menus.propose(
    'one',
    'menu_item',
    'create',
    { title: 'About', url: '/page/about' },
    undefined,
    1,
  );
  assert.equal((await engine.apply(newItem.change_id)).status, 'applied');
  assert.equal((await engine.apply(newItem.change_id)).status, 'applied');
  assert.deepEqual(writes.slice(1), ['POST /admin/menus.json', 'POST /admin/menus/1/items.json']);
});
