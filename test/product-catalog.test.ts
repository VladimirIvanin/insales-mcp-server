import { callOperation } from './code-mode-client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type * as ImageUpload from '../src/infrastructure/uploads/image.js';
import { Api, type Transport, type RequestOptions } from '../src/api.js';
import { createPreparedWriteFixture } from './prepared-write-fixture.js';
import { DEFAULT_UPLOAD_DIRECTORY, Fault } from '../src/shared/common.js';

type Json = Record<string, any>;
import { cleanup } from '../src/infrastructure/persistence/cleanup.js';
import { State, type Store } from '../src/infrastructure/persistence/state.js';
import type { Credentials } from '../src/app/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { Knowledge } from '../src/infrastructure/knowledge/index.js';

class ProductTransport implements Transport {
  product?: Json;
  images = new Map<number, Json>();
  variants = new Map<number, Json>();
  collects = new Map<number, Json>();
  similars = new Set<number>();
  supplementaries = new Set<number>();
  calls: { method: string; path: string; body?: Json | undefined }[] = [];
  nextImage = 50;
  nextVariant = 60;
  nextCollect = 70;
  loseCreate = false;
  limitImages = false;
  reverseVariantImages = false;
  private imageLimited = false;
  private optionValues(options: Json[] = []) {
    return options.map((option, index) => ({
      id: 200 + index,
      option_name_id: this.product?.option_names.find((name: Json) => name.title === option.title)
        ?.id,
      title: option.value,
    }));
  }
  private setProperties(fields: Json) {
    if (!('properties_attributes' in fields)) return;
    const names = new Map<string, number>();
    this.product!.properties = [];
    this.product!.characteristics = [];
    for (const pair of fields.properties_attributes) {
      if (!names.has(pair.title)) {
        const id = 300 + names.size;
        names.set(pair.title, id);
        this.product!.properties.push({ id, title: pair.title });
      }
      this.product!.characteristics.push({
        id: 400 + this.product!.characteristics.length,
        property_id: names.get(pair.title),
        title: pair.value,
      });
    }
  }
  private setOptions(fields: Json) {
    if (!('options' in fields)) return;
    for (const option of fields.options) {
      if (option.option_name_id) continue;
      const id = 10 + this.product!.option_names.length;
      this.product!.option_names.push({ id, title: option.title });
      for (const variant of this.variants.values())
        variant.option_values.push({
          id: 200 + variant.option_values.length,
          option_name_id: id,
          title: option.value,
        });
    }
  }
  async request(
    _store: Store,
    _credentials: Credentials,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: Json,
    _options?: RequestOptions,
  ) {
    this.calls.push({ method, path, body });
    const pathname = new URL(`https://store.test${path}`).pathname;
    const image = pathname.match(/^\/admin\/products\/40\/images\/(\d+)\.json$/);
    const variant = pathname.match(/^\/admin\/products\/40\/variants\/(\d+)\.json$/);
    const collect = pathname.match(/^\/admin\/collects\/(\d+)\.json$/);
    if (method === 'GET') {
      if (pathname === '/admin/collections/2.json')
        return { id: 2, title: 'Телефоны', is_smart: false };
      if (pathname === '/admin/products/90.json') return { id: 90, title: 'Related' };
      if (pathname === '/admin/products/40.json') {
        if (!this.product) throw new Fault('not_found', 'Missing');
        return { ...this.product, variants: [...this.variants.values()] };
      }
      if (pathname === '/admin/products/40/similars.json')
        return [...this.similars].map((id) => ({ id }));
      if (pathname === '/admin/products/40/supplementaries.json')
        return [...this.supplementaries].map((id) => ({ id }));
      if (image) return this.images.get(Number(image[1]));
      if (variant) {
        const row = this.variants.get(Number(variant[1]));
        if (!row || !this.reverseVariantImages || !Array.isArray(row.image_ids)) return row;
        return { ...row, image_ids: [...row.image_ids].reverse() };
      }
      if (collect) return this.collects.get(Number(collect[1]));
      throw new Fault('not_found', 'Missing');
    }
    if (method === 'POST' && pathname === '/admin/products.json') {
      this.product = {
        id: 40,
        ...body!.product,
        option_names: (body!.product.options ?? []).map((option: Json, index: number) => ({
          id: 10 + index,
          title: option.title,
        })),
        properties: [],
        characteristics: [],
      };
      this.setProperties(body!.product);
      this.variants.set(41, {
        id: 41,
        product_id: 40,
        ...body!.product.variants_attributes[0],
        option_values: this.optionValues(body!.product.options ?? []),
      });
      if (this.loseCreate) throw new Fault('execution_unknown', 'Lost response');
      return { id: 40 };
    }
    if (method === 'PUT' && pathname === '/admin/products/40.json') {
      this.setOptions(body!.product);
      Object.assign(this.product!, body!.product);
      this.setProperties(body!.product);
      return { id: 40 };
    }
    if (method === 'POST' && pathname === '/admin/products/40/images.json') {
      if (this.limitImages && !this.imageLimited) {
        this.imageLimited = true;
        throw new Fault('rate_limited', '429', { retry_after_seconds: 1 });
      }
      const id = this.nextImage++;
      this.images.set(id, { id, product_id: 40, ...body!.image });
      return { id };
    }
    if (method === 'POST' && pathname === '/admin/products/40/variants.json') {
      const id = this.nextVariant++;
      this.variants.set(id, {
        id,
        product_id: 40,
        ...body!.variant,
        option_values: this.optionValues(body!.variant.options ?? []),
      });
      return { id };
    }
    if (method === 'PUT' && variant) {
      Object.assign(this.variants.get(Number(variant[1]))!, body!.variant);
      if (body!.variant.options)
        this.variants.get(Number(variant[1]))!.option_values = this.optionValues(
          body!.variant.options,
        );
      return { id: Number(variant[1]) };
    }
    if (method === 'POST' && pathname === '/admin/collects.json') {
      const id = this.nextCollect++;
      this.collects.set(id, { id, ...body!.collect });
      return { id };
    }
    if (method === 'POST' && pathname === '/admin/products/40/similars.json') {
      this.similars.add(body!.similar_ids[0]);
      return { status: 'ok' };
    }
    if (method === 'POST' && pathname === '/admin/products/40/supplementaries.json') {
      this.supplementaries.add(body!.supplementary_ids[0]);
      return { status: 'ok' };
    }
    throw new Fault('not_found', 'Missing mutation');
  }
}
function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'insales-product-'));
  const state = new State(directory, {
    id: 'one',
    name: 'Test',
    url: 'https://test.myinsales.ru',
  });
  state.rateSlot = () => 0;
  const transport = new ProductTransport();
  const engine = createPreparedWriteFixture(
    new Api(state, { key: 'test', password: 'hidden' }, transport),
  );
  t.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, engine, transport };
}
test('create product with option variants, URL/local images, assignments and collection', async (t) => {
  const { directory, engine, transport } = fixture(t);
  const old = process.env.INSALES_MCP_UPLOAD_DIR;
  process.env.INSALES_MCP_UPLOAD_DIR = directory;
  t.after(() => {
    if (old === undefined) delete process.env.INSALES_MCP_UPLOAD_DIR;
    else process.env.INSALES_MCP_UPLOAD_DIR = old;
  });
  const path = join(directory, 'front.png');
  writeFileSync(path, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
  const change = await engine.products.proposeCreate('one', {
    product: {
      title: 'iPhone',
      description: 'Описание',
      html_title: 'Телефон',
      is_hidden: false,
      video_links_attributes: [{ url: 'https://example.com/video' }],
      properties_attributes: [
        { title: 'Память', value: '8 GB' },
        { title: 'Цвет корпуса', value: 'Чёрный' },
      ],
    },
    variants: [
      {
        sku: 'IP-B',
        price: 100,
        width: 10,
        external_id: 'external-black',
        options: [{ title: 'Цвет', value: 'Чёрный' }],
        image_keys: ['front'],
      },
      {
        sku: 'IP-W',
        price: 120,
        options: [{ title: 'Цвет', value: 'Белый' }],
        image_keys: ['back'],
      },
    ],
    images: [
      { key: 'front', local_path: path },
      { key: 'back', src: 'https://cdn.example.com/back.jpg' },
    ],
    collection_ids: [2],
    similar_ids: [90],
    supplementary_ids: [90],
  });
  assert.equal((await engine.apply(change.change_id)).status, 'applied');
  assert.equal(transport.product!.is_hidden, false);
  assert.deepEqual(
    transport.product!.characteristics.map((item: Json) => item.title),
    ['8 GB', 'Чёрный'],
  );
  assert.equal(transport.images.size, 2);
  assert.equal(transport.variants.size, 2);
  assert.equal(transport.collects.size, 1);
  assert.deepEqual([...transport.similars], [90]);
  assert.deepEqual([...transport.supplementaries], [90]);
  assert.deepEqual(transport.variants.get(41)!.image_ids, [50]);
  assert.equal(transport.variants.get(41)!.width, 10);
  assert.equal(transport.variants.get(41)!.external_id, 'external-black');
  assert.deepEqual(transport.variants.get(60)!.image_ids, [51]);
  assert.ok(
    transport.calls.some(
      (call) => call.path === '/admin/products/40/images.json' && call.body?.image.attachment,
    ),
  );
  assert.equal(
    transport.calls.find((call) => call.path === '/admin/products.json')!.body!.product.is_hidden,
    true,
  );
  await cleanup(engine.api.state, { apply: true, now: Date.now() + 86400001 });
  assert.equal((await engine.apply(change.change_id)).status, 'applied');
  assert.equal(transport.calls.filter((call) => call.path === '/admin/products.json').length, 1);
});
test('default upload directory accepts a relative local_path', async (t) => {
  const { engine } = fixture(t);
  const old = process.env.INSALES_MCP_UPLOAD_DIR;
  delete process.env.INSALES_MCP_UPLOAD_DIR;
  t.after(() => {
    if (old === undefined) delete process.env.INSALES_MCP_UPLOAD_DIR;
    else process.env.INSALES_MCP_UPLOAD_DIR = old;
  });
  mkdirSync(DEFAULT_UPLOAD_DIRECTORY, { recursive: true });
  const directory = mkdtempSync(join(DEFAULT_UPLOAD_DIRECTORY, 'test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'front.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  const change = await engine.products.proposeCreate('one', {
    product: { title: 'Phone' },
    variants: [{ price: 1 }],
    images: [{ key: 'front', local_path: `${basename(directory)}/front.png` }],
  });
  assert.ok(change.change_id);
});
test('relative local path resolves inside configured upload root and changed file is rejected before writing', async (t) => {
  const { directory, engine, transport } = fixture(t);
  const old = process.env.INSALES_MCP_UPLOAD_DIR;
  process.env.INSALES_MCP_UPLOAD_DIR = directory;
  t.after(() => {
    if (old === undefined) delete process.env.INSALES_MCP_UPLOAD_DIR;
    else process.env.INSALES_MCP_UPLOAD_DIR = old;
  });
  const path = join(directory, 'front.png');
  writeFileSync(path, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  const plan = {
    product: { title: 'Phone' },
    variants: [{ price: 1 }],
    images: [{ key: 'front', local_path: 'front.png' }],
  };
  const change = await engine.products.proposeCreate('one', plan);
  writeFileSync(path, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]));
  await assert.rejects(engine.apply(change.change_id), (error: any) => error.code === 'conflict');
  assert.equal(
    transport.calls.some((call) => call.method === 'POST'),
    false,
  );
});
test('image sources cannot read outside upload directory or use private URLs', async (t) => {
  const { directory, engine } = fixture(t);
  const old = process.env.INSALES_MCP_UPLOAD_DIR;
  process.env.INSALES_MCP_UPLOAD_DIR = directory;
  t.after(() => {
    if (old === undefined) delete process.env.INSALES_MCP_UPLOAD_DIR;
    else process.env.INSALES_MCP_UPLOAD_DIR = old;
  });
  const outside = mkdtempSync(join(tmpdir(), 'insales-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const path = join(outside, 'private.png');
  writeFileSync(path, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  await assert.rejects(
    engine.products.proposeCreate('one', {
      product: { title: 'Phone' },
      variants: [{}],
      images: [{ key: 'a', local_path: path }],
    }),
    (error: any) => error.code === 'permission_denied',
  );
  await assert.rejects(
    engine.products.proposeCreate('one', {
      product: { title: 'Phone' },
      variants: [{}],
      images: [{ key: 'a', local_path: relative(directory, path) }],
    }),
    (error: any) => error.code === 'permission_denied',
  );
  symlinkSync(path, join(directory, 'linked.png'));
  await assert.rejects(
    engine.products.proposeCreate('one', {
      product: { title: 'Phone' },
      variants: [{}],
      images: [{ key: 'a', local_path: 'linked.png' }],
    }),
    (error: any) => error.code === 'permission_denied',
  );
  await assert.rejects(
    engine.products.proposeCreate('one', {
      product: { title: 'Phone' },
      variants: [{}],
      images: [{ key: 'a', src: 'https://127.0.0.1/image.png' }],
    }),
    (error: any) => error.code === 'validation_failed',
  );
});
test('local images accept a configured root symlink and reject a default root symlink', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'insales-upload-root-'));
  const old = process.env.INSALES_MCP_UPLOAD_DIR;
  t.after(() => {
    if (old === undefined) delete process.env.INSALES_MCP_UPLOAD_DIR;
    else process.env.INSALES_MCP_UPLOAD_DIR = old;
    rmSync(directory, { recursive: true, force: true });
  });
  // common.js derives its default directory from its module URL.
  cpSync(new URL('../src/', import.meta.url), join(directory, 'dist', 'src'), { recursive: true });
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  const imageModule = pathToFileURL(join(directory, 'dist/src/infrastructure/uploads/image.js'));
  const { localFile, attachment } = (await import(imageModule.href)) as typeof ImageUpload;
  const realRoot = join(directory, 'images');
  const configured = join(directory, 'configured');
  mkdirSync(realRoot);
  symlinkSync(realRoot, configured, 'dir');
  symlinkSync(realRoot, join(directory, '.uploads'), 'dir');
  const content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const path = join(realRoot, 'image.png');
  writeFileSync(path, content);

  delete process.env.INSALES_MCP_UPLOAD_DIR;
  await assert.rejects(localFile('image.png'), { code: 'permission_denied' });

  process.env.INSALES_MCP_UPLOAD_DIR = configured;
  const prepared = await localFile('image.png');
  assert.equal(await attachment(prepared), content.toString('base64'));
  content[8] = 2;
  writeFileSync(path, content);
  await assert.rejects(attachment(prepared), { code: 'conflict' });
});

test('rate limit during image upload resumes creation without a second product', async (t) => {
  const { engine, transport } = fixture(t);
  transport.limitImages = true;
  const change = await engine.products.proposeCreate('one', {
    product: { title: 'Phone', is_hidden: false },
    variants: [{ price: 1 }],
    images: [{ key: 'a', src: 'https://cdn.example.com/a.jpg' }],
  });
  const paused = await engine.apply(change.change_id);
  assert.equal(paused.status, 'partial_failure');
  assert.equal(transport.product!.is_hidden, true);
  assert.equal(transport.images.size, 0);
  assert.equal((await engine.apply(change.change_id)).status, 'applied');
  assert.equal(transport.product!.is_hidden, false);
  assert.equal(transport.images.size, 1);
  assert.equal(transport.calls.filter((call) => call.path === '/admin/products.json').length, 1);
});
test('reordered variant image ids still count as saved', async (t) => {
  const { engine, transport } = fixture(t);
  transport.reverseVariantImages = true;
  const change = await engine.products.proposeCreate('one', {
    product: { title: 'Phone', is_hidden: true },
    variants: [{ price: 1, image_keys: ['a', 'b'] }],
    images: [
      { key: 'a', src: 'https://cdn.example.com/a.jpg' },
      { key: 'b', src: 'https://cdn.example.com/b.jpg' },
    ],
  });
  assert.equal((await engine.apply(change.change_id)).status, 'applied');
  assert.deepEqual(transport.variants.get(41)!.image_ids, [50, 51]);

  const variant = await engine.products.readItem('one', 40, 'variant', 41);
  const update = await engine.products.proposeItem(
    'one',
    40,
    'variant',
    'update',
    41,
    { image_ids: [51, 50] },
    variant.revision,
  );
  assert.equal((await engine.apply(update.change_id)).status, 'applied');
});
test('lost create response is not submitted a second time', async (t) => {
  const { engine, transport } = fixture(t);
  transport.loseCreate = true;
  const change = await engine.products.proposeCreate('one', {
    product: { title: 'Phone' },
    variants: [{ price: 1 }],
  });
  assert.equal((await engine.apply(change.change_id)).status, 'execution_unknown');
  assert.equal((await engine.apply(change.change_id)).status, 'execution_unknown');
  assert.equal(transport.calls.filter((call) => call.path === '/admin/products.json').length, 1);
});
test('duplicate variant combinations and foreign image IDs fail before product creation', async (t) => {
  const { engine, transport } = fixture(t);
  await assert.rejects(
    engine.products.proposeCreate('one', {
      product: { title: 'Phone' },
      variants: [{ price: 1 }, { price: 2 }],
    }),
    (error: any) => error.code === 'validation_failed',
  );
  await assert.rejects(
    engine.products.proposeCreate('one', {
      product: { title: 'Phone' },
      variants: [{ price: 1, image_ids: [999] }],
    }),
    (error: any) => error.code === 'validation_failed',
  );
  assert.equal(
    transport.calls.some((call) => call.method === 'POST'),
    false,
  );
});
test('MCP exposes product create and full card read', async (t) => {
  const { engine } = fixture(t);
  const server = createMcpServer({ engine, knowledge: new Knowledge() });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const proposal = await callOperation(client, {
    name: 'create_product',
    arguments: { store_id: 'one', product: { title: 'Phone' }, variants: [{ price: 100 }] },
  });
  assert.equal(proposal.isError, undefined);
  assert.equal(JSON.parse((proposal.content as any)[0].text).status, 'applied');
  const read = await callOperation(client, {
    name: 'read_product_card',
    arguments: { store_id: 'one', id: 40 },
  });
  assert.equal(JSON.parse((read.content as any)[0].text).data.variants[0].id, 41);
  const revision = JSON.parse((read.content as any)[0].text).revision;
  const properties = await callOperation(client, {
    name: 'update_product_properties',
    arguments: {
      store_id: 'one',
      id: 40,
      changes: { set: [{ title: 'Память', value: '8 GB' }] },
      base_revision: revision,
    },
  });
  assert.equal(properties.isError, undefined);
  assert.equal(JSON.parse((properties.content as any)[0].text).status, 'applied');
  const refreshed = await callOperation(client, {
    name: 'read_product_card',
    arguments: { store_id: 'one', id: 40 },
  });
  const option = await callOperation(client, {
    name: 'add_product_option',
    arguments: {
      store_id: 'one',
      id: 40,
      option: { title: 'Цвет', default_value: 'Black' },
      base_revision: JSON.parse((refreshed.content as any)[0].text).revision,
    },
  });
  assert.equal(option.isError, undefined);
  assert.equal(JSON.parse((option.content as any)[0].text).status, 'applied');
  const images = await callOperation(client, {
    name: 'create_product_images',
    arguments: {
      store_id: 'one',
      items: [{ product_id: 40, fields: { src: 'https://cdn.example.com/front.jpg' } }],
    },
  });
  assert.equal(images.isError, undefined);
  assert.equal(JSON.parse((images.content as any)[0].text).items[0].result_id, 50);
});
test('existing product card, image and variant support scoped revisions and changes', async (t) => {
  const { engine, transport } = fixture(t);
  const created = await engine.products.proposeCreate('one', {
    product: { title: 'Phone' },
    variants: [{ price: 100 }],
  });
  assert.equal((await engine.apply(created.change_id)).status, 'applied');
  const card = await engine.products.read('one', 40);
  const details = await engine.products.proposeDetails(
    'one',
    40,
    { html_title: 'Phone SEO', is_hidden: true },
    card.revision,
  );
  assert.equal((await engine.apply(details.change_id)).status, 'applied');
  const image = await engine.products.proposeItem('one', 40, 'image', 'create', undefined, {
    src: 'https://cdn.example.com/a.jpg',
    title: 'Front',
  });
  assert.equal((await engine.apply(image.change_id)).status, 'applied');
  const variant = await engine.products.readItem('one', 40, 'variant', 41);
  const update = await engine.products.proposeItem(
    'one',
    40,
    'variant',
    'update',
    41,
    { image_ids: [50], price: 110 },
    variant.revision,
  );
  assert.equal((await engine.apply(update.change_id)).status, 'applied');
  assert.deepEqual(transport.variants.get(41)!.image_ids, [50]);
  assert.equal(transport.product!.html_title, 'Phone SEO');
  await assert.rejects(
    engine.products.proposeItem(
      'one',
      40,
      'variant',
      'update',
      41,
      { price: 120 },
      variant.revision,
    ),
    (error: any) => error.code === 'conflict',
  );
});
test('batch proposes and applies 30 images with one change id and no duplicate POST', async (t) => {
  const { engine, transport } = fixture(t);
  const created = await engine.products.proposeCreate('one', {
    product: { title: 'Phone' },
    variants: [{ price: 100 }],
  });
  await engine.apply(created.change_id);
  const items = Array.from({ length: 30 }, (_, index) => ({
    product_id: 40,
    fields: { src: `https://cdn.example.com/${index}.jpg`, title: `Image ${index}` },
  }));
  const change = await engine.products.proposeImagesBatch('one', items);
  assert.equal(change.items.length, 30);
  assert.equal((await engine.validate(change.change_id)).valid, true);
  const operation = await engine.apply(change.change_id);
  assert.equal(operation.status, 'applied');
  assert.equal(operation.items.length, 30);
  assert.equal(new Set(operation.items.map((item) => item.result_id)).size, 30);
  assert.deepEqual(engine.getOperation(change.change_id), operation);
  await engine.apply(change.change_id);
  assert.equal(
    transport.calls.filter(
      (call) => call.method === 'POST' && call.path === '/admin/products/40/images.json',
    ).length,
    30,
  );
  await assert.rejects(
    engine.products.proposeImagesBatch('one', [
      ...items,
      { product_id: 40, fields: { src: 'https://cdn.example.com/31.jpg' } },
    ]),
    (error: any) => error.code === 'validation_failed',
  );
});
test('one image batch keeps product IDs scoped when the same source is reused', async (t) => {
  const { engine, transport } = fixture(t);
  const created = await engine.products.proposeCreate('one', {
    product: { title: 'Phone' },
    variants: [{}],
  });
  await engine.apply(created.change_id);
  const original = transport.request.bind(transport);
  const secondImages = new Map<number, Json>();
  transport.request = async (...args) => {
    if (args[2] === 'GET' && args[3] === '/admin/products/42.json')
      return { ...transport.product, id: 42, variants: [] };
    if (args[2] === 'POST' && args[3] === '/admin/products/42/images.json') {
      transport.calls.push({ method: args[2], path: args[3], body: args[4] });
      secondImages.set(80, { id: 80, product_id: 42, ...args[4]!.image });
      return { id: 80 };
    }
    if (args[2] === 'GET' && args[3] === '/admin/products/42/images/80.json')
      return secondImages.get(80);
    return original(...args);
  };
  const source = 'https://cdn.example.com/shared.jpg';
  const change = await engine.products.proposeImagesBatch(
    'one',
    [40, 42].map((product_id) => ({ product_id, fields: { src: source } })),
  );
  const operation = await engine.apply(change.change_id);
  assert.equal(operation.status, 'applied');
  assert.deepEqual(
    operation.items.map((item: any) => [item.product_id, item.result_id]),
    [
      [40, 50],
      [42, 80],
    ],
  );
  assert.equal(
    transport.calls.filter((call) => call.method === 'POST' && call.path.includes('/images.json'))
      .length,
    2,
  );
});
test('image batch continues after 422 and retries only through a new draft', async (t) => {
  const { engine, transport } = fixture(t);
  const created = await engine.products.proposeCreate('one', {
    product: { title: 'Phone' },
    variants: [{}],
  });
  await engine.apply(created.change_id);
  const original = transport.request.bind(transport);
  let rejectSource = true;
  transport.request = async (...args) => {
    if (
      args[2] === 'POST' &&
      args[3] === '/admin/products/40/images.json' &&
      args[4]?.image?.src === 'https://cdn.example.com/b.jpg' &&
      rejectSource
    ) {
      transport.calls.push({ method: args[2], path: args[3], body: args[4] });
      throw new Fault('validation_failed', 'InSales вернул HTTP 422.', {
        http_status: 422,
        validation_errors: [{ field: 'src', message: 'Не удалось загрузить файл' }],
      });
    }
    return original(...args);
  };
  const items = ['a', 'b', 'c'].map((name) => ({
    product_id: 40,
    fields: { src: `https://cdn.example.com/${name}.jpg` },
  }));
  const change = await engine.products.proposeImagesBatch('one', items);
  const operation = await engine.apply(change.change_id);
  assert.equal(operation.status, 'partial_failure');
  assert.deepEqual(
    operation.items.map((item) => item.status),
    ['applied', 'failed', 'applied'],
  );
  assert.deepEqual((operation.items[1]!.error as Json)?.validation_errors, [
    { field: 'src', message: 'Не удалось загрузить файл' },
  ]);
  await engine.apply(change.change_id);
  assert.equal(
    transport.calls.filter(
      (call) => call.method === 'POST' && call.path === '/admin/products/40/images.json',
    ).length,
    3,
  );
  rejectSource = false;
  const retry = await engine.products.proposeImagesBatch('one', [items[1]]);
  assert.equal((await engine.apply(retry.change_id)).status, 'applied');
  assert.equal(
    transport.calls.filter(
      (call) => call.method === 'POST' && call.path === '/admin/products/40/images.json',
    ).length,
    4,
  );
  assert.equal(transport.images.size, 3);
});
test('image batch resumes a sent item from its saved child operation', async (t) => {
  const { engine, transport } = fixture(t);
  const created = await engine.products.proposeCreate('one', {
    product: { title: 'Phone' },
    variants: [{}],
  });
  await engine.apply(created.change_id);
  const change = await engine.products.proposeImagesBatch(
    'one',
    ['a', 'b'].map((name) => ({
      product_id: 40,
      fields: { src: `https://cdn.example.com/${name}.jpg` },
    })),
  );
  const draft = engine.prepared(change.change_id);
  assert.equal(draft?.kind, 'product_images_batch');
  if (!draft || draft.kind !== 'product_images_batch') throw new Error('Missing image batch draft');
  await engine.products.applyItem(draft.items[0]!);
  engine.api.state.put('operation', change.change_id, {
    id: change.change_id,
    store_id: 'one',
    status: 'running',
    items: [
      { kind: 'image', product_id: 40, change_id: draft.items[0]!.id, status: 'sending' },
      { kind: 'image', product_id: 40, change_id: draft.items[1]!.id, status: 'pending' },
    ],
  });
  const operation = await engine.apply(change.change_id);
  assert.equal(operation.status, 'applied');
  assert.equal(
    transport.calls.filter(
      (call) => call.method === 'POST' && call.path === '/admin/products/40/images.json',
    ).length,
    2,
  );
});
test('unknown image create result is never submitted again by a batch', async (t) => {
  const { engine, transport } = fixture(t);
  const created = await engine.products.proposeCreate('one', {
    product: { title: 'Phone' },
    variants: [{}],
  });
  await engine.apply(created.change_id);
  const original = transport.request.bind(transport);
  transport.request = async (...args) => {
    const result = await original(...args);
    if (args[2] === 'POST' && args[3] === '/admin/products/40/images.json')
      throw new Fault('execution_unknown', 'Ответ не подтверждён.');
    return result;
  };
  const change = await engine.products.proposeImagesBatch('one', [
    { product_id: 40, fields: { src: 'https://cdn.example.com/a.jpg' } },
  ]);
  assert.equal((await engine.apply(change.change_id)).status, 'execution_unknown');
  assert.equal((await engine.apply(change.change_id)).status, 'execution_unknown');
  assert.equal(
    transport.calls.filter(
      (call) => call.method === 'POST' && call.path === '/admin/products/40/images.json',
    ).length,
    1,
  );
});
test('variant options require complete existing dimensions and unique combinations', async (t) => {
  const { engine, transport } = fixture(t);
  const created = await engine.products.proposeCreate('one', {
    product: { title: 'Phone' },
    variants: [
      {
        price: 100,
        options: [
          { title: 'Цвет', value: 'Black' },
          { title: 'Размер', value: 'Small' },
        ],
      },
    ],
  });
  assert.equal((await engine.apply(created.change_id)).status, 'applied');
  await assert.rejects(
    engine.products.proposeItem('one', 40, 'variant', 'create', undefined, { price: 120 }),
    (error: any) => error.code === 'validation_failed',
  );
  await assert.rejects(
    engine.products.proposeItem('one', 40, 'variant', 'create', undefined, {
      price: 120,
      options: [{ title: 'Цвет', value: 'White' }],
    }),
    (error: any) => error.code === 'validation_failed',
  );
  await assert.rejects(
    engine.products.proposeItem('one', 40, 'variant', 'create', undefined, {
      price: 120,
      options: [
        { title: 'Цвет', value: 'Black' },
        { title: 'Размер', value: 'Small' },
      ],
    }),
    (error: any) => error.code === 'validation_failed',
  );
  assert.equal(
    transport.calls.filter(
      (call) => call.path === '/admin/products/40/variants.json' && call.method === 'POST',
    ).length,
    0,
  );
  const second = await engine.products.proposeItem('one', 40, 'variant', 'create', undefined, {
    price: 120,
    options: [
      { title: 'Цвет', value: 'White' },
      { title: 'Размер', value: 'Large' },
    ],
  });
  assert.equal((await engine.apply(second.change_id)).status, 'applied');
  const before = await engine.products.readItem('one', 40, 'variant', 60);
  await assert.rejects(
    engine.products.proposeItem(
      'one',
      40,
      'variant',
      'update',
      60,
      { options: [{ title: 'Цвет', value: 'Blue' }] },
      before.revision,
    ),
    (error: any) => error.code === 'validation_failed',
  );
  const update = await engine.products.proposeItem(
    'one',
    40,
    'variant',
    'update',
    60,
    {
      options: [
        { title: 'Цвет', value: 'Blue' },
        { title: 'Размер', value: 'Large' },
      ],
    },
    before.revision,
  );
  assert.equal((await engine.apply(update.change_id)).status, 'applied');
  assert.deepEqual(
    transport.variants.get(60)!.option_values.map((item: Json) => item.title),
    ['Blue', 'Large'],
  );
  assert.deepEqual(
    transport.variants.get(41)!.option_values.map((item: Json) => item.title),
    ['Black', 'Small'],
  );
});
test('property change preserves unrelated values and checks the complete result', async (t) => {
  const { engine, transport } = fixture(t);
  const created = await engine.products.proposeCreate('one', {
    product: {
      title: 'Phone',
      properties_attributes: [
        { title: 'Память', value: '8 GB' },
        { title: 'Цвет', value: 'Black' },
      ],
    },
    variants: [{ price: 100 }],
  });
  assert.equal((await engine.apply(created.change_id)).status, 'applied');
  let card = await engine.products.read('one', 40);
  await assert.rejects(
    engine.products.proposeDetails(
      'one',
      40,
      { properties_attributes: [{ title: 'Память', value: '12 GB' }] },
      card.revision,
    ),
    (error: any) => error.code === 'validation_failed',
  );
  const change = await engine.products.proposeProperties(
    'one',
    40,
    { set: [{ title: 'Память', value: '12 GB' }] },
    card.revision,
  );
  assert.equal((await engine.apply(change.change_id)).status, 'applied');
  assert.deepEqual(transport.product!.characteristics.map((item: Json) => item.title).sort(), [
    '12 GB',
    'Black',
  ]);
  card = await engine.products.read('one', 40);
  const multi = await engine.products.proposeProperties(
    'one',
    40,
    {
      set: [
        { title: 'Память', value: '12 GB' },
        { title: 'Память', value: '16 GB' },
      ],
    },
    card.revision,
  );
  assert.equal((await engine.apply(multi.change_id)).status, 'applied');
  assert.deepEqual(transport.product!.characteristics.map((item: Json) => item.title).sort(), [
    '12 GB',
    '16 GB',
    'Black',
  ]);
  card = await engine.products.read('one', 40);
  const remove = await engine.products.proposeProperties(
    'one',
    40,
    { remove_titles: ['Цвет'] },
    card.revision,
  );
  assert.equal((await engine.apply(remove.change_id)).status, 'applied');
  assert.deepEqual(transport.product!.characteristics.map((item: Json) => item.title).sort(), [
    '12 GB',
    '16 GB',
  ]);
});
test('new product option gives every existing variant a default value', async (t) => {
  const { engine, transport } = fixture(t);
  const created = await engine.products.proposeCreate('one', {
    product: { title: 'Phone' },
    variants: [
      { price: 100, options: [{ title: 'Цвет', value: 'Black' }] },
      { price: 120, options: [{ title: 'Цвет', value: 'White' }] },
    ],
  });
  assert.equal((await engine.apply(created.change_id)).status, 'applied');
  const card = await engine.products.read('one', 40);
  const change = await engine.products.proposeOptionAdd(
    'one',
    40,
    { title: 'Размер', default_value: 'M' },
    card.revision,
  );
  assert.equal((await engine.apply(change.change_id)).status, 'applied');
  assert.deepEqual(
    transport.product!.option_names.map((name: Json) => name.title),
    ['Цвет', 'Размер'],
  );
  assert.equal(transport.variants.get(41)!.option_values.at(-1).title, 'M');
  assert.equal(transport.variants.get(60)!.option_values.at(-1).title, 'M');
  const before = await engine.products.readItem('one', 40, 'variant', 60);
  const update = await engine.products.proposeItem(
    'one',
    40,
    'variant',
    'update',
    60,
    {
      options: [
        { title: 'Цвет', value: 'White' },
        { title: 'Размер', value: 'L' },
      ],
    },
    before.revision,
  );
  assert.equal((await engine.apply(update.change_id)).status, 'applied');
  assert.equal(transport.variants.get(60)!.option_values.at(-1).title, 'L');
  assert.equal(transport.variants.get(41)!.option_values.at(-1).title, 'M');
});
