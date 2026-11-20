import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Response, type fetch as undiciFetch } from 'undici';
import { Api, HttpTransport } from '../src/api.js';
import { State } from '../src/infrastructure/persistence/state.js';
import { InSalesClient } from '../src/infrastructure/insales/admin-client.js';
import { decodeAssetBody, inlineBinaryLimitBytes } from '../src/features/themes/asset-body.js';
import { downloadThemeAsset } from '../src/features/themes/download-asset.js';
import { DirectThemeResources } from '../src/features/themes/direct.js';
import { themeResourceContract } from '../src/features/themes/resource-contract.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x80, 0xff]);
const css = 'body { color: красный; }';

function method(id: string) {
  const result = themeResourceContract.find((entry) => entry.id === id);
  assert.ok(result);
  return result;
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function apiFor(t: TestContext, fetchImpl: typeof undiciFetch) {
  const directory = mkdtempSync(join(tmpdir(), 'asset-binary-'));
  const state = new State(directory, {
    id: 'one',
    name: 'Test',
    url: 'https://test.myinsales.ru',
  });
  state.rateSlot = () => 0;
  const api = new Api(
    state,
    { key: 'key', password: 'secret' },
    new HttpTransport(undefined, fetchImpl),
  );
  t.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return api;
}

function respond(body: Buffer | string, status = 200, type?: string) {
  return new Response(body, {
    status,
    headers: type ? { 'content-type': type } : {},
  });
}

test('raw theme assets keep binary bytes and leave text as a string', async (t) => {
  let body: Buffer | string = png;
  let status = 200;
  let type: string | undefined = 'image/png';
  const api = apiFor(t, (async () => respond(body, status, type)) as typeof undiciFetch);
  const service = new DirectThemeResources(api);
  const binary = await service.execute(method('target-assets-raw'), 'one', { theme_id: 10, id: 3 });
  assert.deepEqual(binary, {
    encoding: 'base64',
    content_type: 'image/png',
    size: png.length,
    sha256: sha256(png),
    data: png.toString('base64'),
  });
  const legacy = await new InSalesClient(api, 'one').assets(10).raw(3);
  assert.deepEqual(legacy, binary);

  body = css;
  type = 'text/css; charset=utf-8';
  assert.equal(
    await service.execute(method('target-assets-raw'), 'one', { theme_id: 10, id: 4 }),
    css,
  );

  body = JSON.stringify({ errors: { name: ['Занято'] } });
  status = 422;
  type = 'application/json';
  await assert.rejects(
    () => service.execute(method('target-assets-raw'), 'one', { theme_id: 10, id: 5 }),
    (error: any) =>
      error.code === 'validation_failed' && error.details.validation_errors[0].field === 'name',
  );
});

test('an oversized binary asset is described without its bytes', async (t) => {
  const previous = process.env.INSALES_MCP_MAX_INLINE_BINARY_KB;
  process.env.INSALES_MCP_MAX_INLINE_BINARY_KB = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.INSALES_MCP_MAX_INLINE_BINARY_KB;
    else process.env.INSALES_MCP_MAX_INLINE_BINARY_KB = previous;
  });
  const bytes = Buffer.alloc(2048, 0xff);
  const decoded = decodeAssetBody({ bytes, contentType: 'font/woff2' });
  assert.equal(typeof decoded, 'object');
  assert.ok(typeof decoded !== 'string');
  assert.equal(decoded.truncated, true);
  assert.equal(decoded.data, undefined);
  assert.equal(decoded.size, bytes.length);
  assert.equal(decoded.sha256, sha256(bytes));
  process.env.INSALES_MCP_MAX_INLINE_BINARY_KB = '0';
  assert.throws(inlineBinaryLimitBytes, (error: any) => error.code === 'invalid_config');
});

test('asset metadata drops corrupted binary content and keeps text', async (t) => {
  let payload = {
    id: 3,
    content_type: 'image/png',
    content: 'испорченный текст',
    name: 'logo.png',
  };
  const api = apiFor(t, (async () =>
    respond(JSON.stringify(payload), 200, 'application/json')) as typeof undiciFetch);
  const service = new DirectThemeResources(api);
  const binary = await service.execute(method('target-assets-show'), 'one', {
    theme_id: 10,
    id: 3,
  });
  assert.equal((binary as { content?: string }).content, undefined);
  assert.equal((binary as { content_omitted?: string }).content_omitted, 'binary');

  payload = { id: 4, content_type: 'text/css', content: css, name: 'theme.css' };
  const text = await service.execute(method('target-assets-show'), 'one', { theme_id: 10, id: 4 });
  assert.equal((text as { content?: string }).content, css);
});

test('download writes the original bytes and refuses traversal or a symlink', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'asset-download-'));
  const outside = join(directory, 'outside.bin');
  const root = join(directory, 'downloads');
  mkdirSync(root);
  writeFileSync(outside, 'secret');
  symlinkSync(outside, join(root, 'link.bin'));
  const previous = process.env.INSALES_MCP_DOWNLOAD_DIR;
  process.env.INSALES_MCP_DOWNLOAD_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.INSALES_MCP_DOWNLOAD_DIR;
    else process.env.INSALES_MCP_DOWNLOAD_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const api = apiFor(t, (async () => respond(png, 200, 'image/png')) as typeof undiciFetch);
  const saved = await downloadThemeAsset(api, 'one', 10, 3);
  assert.equal(readFileSync(saved.path).equals(png), true);
  assert.equal(saved.sha256, sha256(png));
  assert.equal(saved.content_type, 'image/png');
  assert.equal(saved.path, join(root, 'theme-10-asset-3.png'));

  await assert.rejects(
    () => downloadThemeAsset(api, 'one', 10, 3, '../outside.bin'),
    (error: any) => error.code === 'validation_failed',
  );
  await assert.rejects(
    () => downloadThemeAsset(api, 'one', 10, 3, 'link.bin'),
    (error: any) => error.code === 'permission_denied',
  );
  assert.equal(readFileSync(outside, 'utf8'), 'secret');
});
