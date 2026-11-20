import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configFromEnvironment } from '../src/app/config.js';

test('environment configuration is optional for knowledge-only MCP', () => {
  assert.equal(configFromEnvironment({}), undefined);
});

test('environment configuration builds a public HTTPS store', () => {
  const config = configFromEnvironment({
    INSALES_STORE_URL: 'https://shop.myinsales.ru',
    INSALES_STORE_NAME: 'Example shop',
    INSALES_API_KEY_ID: 'key-id',
    INSALES_API_KEY_PASSWORD: 'secret-password',
  })!;
  assert.equal(config.store.name, 'Example shop');
  assert.equal(config.store.url, 'https://shop.myinsales.ru');
  assert.match(config.store.id, /^configured-[a-f0-9]{12}$/);
  assert.deepEqual(config.credentials, { key: 'key-id', password: 'secret-password' });
  assert.doesNotMatch(JSON.stringify(config.store), /key-id|secret-password/);
});

test('partial or unsafe environment configuration fails without echoing secrets', () => {
  assert.throws(
    () => configFromEnvironment({ INSALES_STORE_URL: 'https://shop.myinsales.ru' }),
    (error: any) =>
      error.code === 'invalid_config' && error.details.missing.includes('INSALES_API_KEY_PASSWORD'),
  );
  const secret = 'do-not-print-this';
  try {
    configFromEnvironment({
      INSALES_STORE_URL: 'https://shop.myinsales.ru',
      INSALES_API_KEY_ID: 'bad:key',
      INSALES_API_KEY_PASSWORD: secret,
    });
    assert.fail('expected invalid config');
  } catch (error) {
    assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
  }
  assert.throws(() =>
    configFromEnvironment({
      INSALES_STORE_URL: 'http://shop.myinsales.ru',
      INSALES_API_KEY_ID: 'key',
      INSALES_API_KEY_PASSWORD: 'password',
    }),
  );
});
