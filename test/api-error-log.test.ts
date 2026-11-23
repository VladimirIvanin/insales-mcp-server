import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch as undiciFetch, Headers, Response } from 'undici';
import {
  ApiErrorLog,
  apiErrorLogEnabled,
  apiPathForLog,
  startApiErrorLog,
} from '../src/infrastructure/logging/api-error-log.js';
import { HttpTransport } from '../src/api.js';
import type { Store } from '../src/infrastructure/persistence/state.js';

test('API error log is enabled by default and can be disabled', () => {
  assert.equal(apiErrorLogEnabled({}), true);
  assert.equal(apiErrorLogEnabled({ INSALES_MCP_API_ERROR_LOG: '1' }), true);
  assert.equal(apiErrorLogEnabled({ INSALES_MCP_API_ERROR_LOG: '0' }), false);
  assert.throws(
    () => apiErrorLogEnabled({ INSALES_MCP_API_ERROR_LOG: 'yes' }),
    (error: any) => error.code === 'invalid_config',
  );
  const directory = mkdtempSync(join(tmpdir(), 'insales-api-log-disabled-'));
  try {
    assert.equal(
      startApiErrorLog({ INSALES_MCP_API_ERROR_LOG: '0' }, join(directory, 'logs')),
      undefined,
    );
    assert.equal(existsSync(join(directory, 'logs')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('startup removes only API error log files older than three days', () => {
  const directory = mkdtempSync(join(tmpdir(), 'insales-api-log-cleanup-'));
  try {
    const old = join(directory, 'api-errors-2020-01-01.jsonl');
    const fresh = join(directory, 'api-errors-2020-01-02.jsonl');
    const unrelated = join(directory, 'other.jsonl');
    for (const file of [old, fresh, unrelated]) writeFileSync(file, '{}\n');
    const now = Date.now();
    utimesSync(old, new Date(now - 4 * 86400000), new Date(now - 4 * 86400000));
    utimesSync(fresh, new Date(now - 2 * 86400000), new Date(now - 2 * 86400000));
    utimesSync(unrelated, new Date(now - 5 * 86400000), new Date(now - 5 * 86400000));
    assert.ok(startApiErrorLog({}, directory));
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(unrelated), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP and transport failures are logged without credentials or response bodies', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'insales-api-log-transport-'));
  try {
    const logger = new ApiErrorLog(directory);
    const store: Store = { id: 'one', name: 'Test', url: 'https://test.myinsales.ru' };
    const credentials = { key: 'private-key-id', password: 'private-password' };
    const http = new HttpTransport(
      undefined,
      (async () =>
        new Response(JSON.stringify({ message: 'private-password', token: 'upstream-secret' }), {
          status: 555,
          headers: { 'x-request-id': 'req-555' },
        })) as typeof undiciFetch,
      logger,
    );
    await assert.rejects(
      http.request(
        store,
        credentials,
        'GET',
        '/admin/theme_editor/v1/themes/10/widget_lists/4.json?view=inventory&token=query-secret',
      ),
      (error: any) => error.details.http_status === 555,
    );

    const network = new HttpTransport(
      undefined,
      (async () => {
        throw new TypeError('private-password', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
      }) as typeof undiciFetch,
      logger,
    );
    await assert.rejects(
      network.request(store, credentials, 'GET', '/admin/pages.json'),
      (error: any) =>
        error.code === 'connection_failed' &&
        error.message === 'Истекло время ожидания подключения к магазину.' &&
        error.details.reason === 'connect_timeout' &&
        error.details.transport_error === 'UND_ERR_CONNECT_TIMEOUT',
    );

    const okay = new HttpTransport(
      undefined,
      (async () => new Response('{}', { status: 200 })) as typeof undiciFetch,
      logger,
    );
    await okay.request(store, credentials, 'GET', '/admin/pages.json');

    const files = readdirSync(directory);
    assert.equal(files.length, 1);
    const file = join(directory, files[0]!);
    const raw = readFileSync(file, 'utf8');
    const entries = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((entry) => entry.phase),
      ['http_status', 'connect'],
    );
    assert.equal(entries[0].http_status, 555);
    assert.equal(entries[0].response_content_type, 'text/plain');
    assert.equal(entries[0].request_id, 'req-555');
    assert.equal(entries[1].transport_error, 'UND_ERR_CONNECT_TIMEOUT');
    assert.match(entries[0].path, /view=inventory/);
    assert.doesNotMatch(
      raw,
      /private-key-id|private-password|upstream-secret|query-secret|Authorization|Basic/,
    );
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('transport errors expose only known safe diagnostics and preserve uncertain writes', async () => {
  const store: Store = { id: 'one', name: 'Test', url: 'https://test.myinsales.ru' };
  const credentials = { key: 'private-key-id', password: 'private-password' };
  const unknown = new HttpTransport(undefined, (async () => {
    throw new TypeError('private-password', { cause: { code: 'PRIVATE_PASSWORD' } });
  }) as typeof undiciFetch);
  await assert.rejects(
    unknown.request(store, credentials, 'GET', '/admin/pages.json'),
    (error: any) =>
      error.code === 'connection_failed' &&
      error.details.reason === 'transport_failure' &&
      error.details.transport_error === undefined &&
      !JSON.stringify(error).includes('private-password'),
  );

  const timeout = new HttpTransport(undefined, (async () => {
    throw new TypeError('private-password', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  }) as typeof undiciFetch);
  await assert.rejects(
    timeout.request(store, credentials, 'POST', '/admin/pages.json', { page: {} }),
    (error: any) =>
      error.code === 'execution_unknown' &&
      error.details.reason === 'connect_timeout' &&
      error.details.transport_error === 'UND_ERR_CONNECT_TIMEOUT',
  );
});

test('logged paths retain numeric selectors and redact arbitrary query values', () => {
  assert.equal(
    apiPathForLog(
      '/admin/widgets.json?widget_list_id=4&page=2&view=inventory&path=%2Fsecret&token=abc',
    ),
    '/admin/widgets.json?widget_list_id=4&page=2&view=inventory&path=%5Bredacted%5D&token=%5Bredacted%5D',
  );
});

const transportStore: Store = { id: 'one', name: 'Test', url: 'https://test.myinsales.ru' };
const transportCredentials = { key: 'key', password: 'password' };
const transportPath = '/admin/pages/1.json';

test('widget PATCH exposes the Qrator support ID and logs no page or source', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'insales-qrator-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const supportId = '12345678-1234-4321-abcd-123456789abc';
  const http = new HttpTransport(
    undefined,
    async () =>
      new Response(
        `<html><p>Qrator Labs</p><b>Support ID:</b> ${supportId}<p>private-page</p></html>`,
        { status: 403, headers: { 'content-type': 'text/html', 'x-request-id': 'req-403' } },
      ),
    new ApiErrorLog(directory),
  );
  await assert.rejects(
    http.request(
      transportStore,
      transportCredentials,
      'PATCH',
      '/admin/theme_editor/v1/themes/7/widget_types/8.json',
      { snippet_content: 'private-source' },
    ),
    {
      code: 'request_blocked',
      details: { http_status: 403, support_id: supportId, request_id: 'req-403' },
    },
  );
  const entry = readFileSync(join(directory, readdirSync(directory)[0]!), 'utf8');
  assert.equal(JSON.parse(entry).support_id, supportId);
  assert.doesNotMatch(entry, /private-page|private-source/);
});

test('theme duplication distinguishes an API permission error from a Qrator page', async () => {
  const http = new HttpTransport(undefined, async () =>
    Response.json({ status: 'error', message: 'Недостаточно прав для операции' }, { status: 403 }),
  );
  await assert.rejects(
    http.request(
      transportStore,
      transportCredentials,
      'POST',
      '/admin/theme_editor/v1/themes/7/duplicate.json',
      { title: 'Copy' },
    ),
    {
      code: 'permission_denied',
      message: 'Недостаточно прав для операции (HTTP 403).',
      details: { http_status: 403 },
    },
  );
});

test('generic HTML keeps the original 403 and invalid support IDs stay private', async () => {
  for (const [html, code] of [
    ['<html>Access denied</html>', 'permission_denied'],
    ['<html>Access denied for user qrator</html>', 'permission_denied'],
    ['<html>Qrator Labs. ID: private-page-token</html>', 'request_blocked'],
  ] as const) {
    const http = new HttpTransport(undefined, async () => new Response(html, { status: 403 }));
    await assert.rejects(http.request(transportStore, transportCredentials, 'GET', transportPath), {
      code,
      details: { http_status: 403 },
    });
  }
});

test('empty HTTP responses preserve success and error semantics', async () => {
  let status = 204;
  const http = new HttpTransport(undefined, async () => new Response(null, { status }));
  assert.deepEqual(
    await http.request(transportStore, transportCredentials, 'DELETE', transportPath),
    {},
  );
  assert.deepEqual(
    await http.request(transportStore, transportCredentials, 'DELETE', transportPath, undefined, {
      raw: 'bytes',
    }),
    { bytes: Buffer.alloc(0) },
  );
  status = 404;
  await assert.rejects(http.request(transportStore, transportCredentials, 'GET', transportPath), {
    code: 'not_found',
  });
});

test('JSON content type follows presence of a request body', async () => {
  const seen: Array<[string | null, unknown]> = [];
  const http = new HttpTransport(undefined, async (_url, init) => {
    seen.push([new Headers(init?.headers).get('Content-Type'), init?.body]);
    return new Response(null, { status: 204 });
  });
  await http.request(transportStore, transportCredentials, 'GET', transportPath);
  await http.request(transportStore, transportCredentials, 'DELETE', transportPath);
  await http.request(transportStore, transportCredentials, 'PATCH', transportPath, {});
  assert.deepEqual(seen, [
    [null, undefined],
    [null, undefined],
    ['application/json', '{}'],
  ]);
});

test('validation errors keep nested field paths in both response formats', async () => {
  const field = 'items[0].' + 'a'.repeat(90);
  for (const errors of [[{ path: field, message: 'Required' }], { [field]: ['Required'] }]) {
    const http = new HttpTransport(
      undefined,
      async () => new Response(JSON.stringify({ errors }), { status: 422 }),
    );
    await assert.rejects(
      http.request(transportStore, transportCredentials, 'PATCH', transportPath, {}),
      {
        code: 'validation_failed',
        details: { http_status: 422, validation_errors: [{ field, message: 'Required' }] },
      },
    );
  }
});

test('API error metadata is not reported as invalid input fields', async () => {
  const http = new HttpTransport(undefined, async () =>
    Response.json(
      {
        code: 'not_a_block_widget',
        message: 'У виджета нет блочного контента.',
        outcome: 'not_applied',
      },
      { status: 422 },
    ),
  );
  await assert.rejects(
    http.request(
      transportStore,
      transportCredentials,
      'GET',
      '/admin/theme_editor/v1/themes/7/widgets/8/blocks.json',
    ),
    {
      code: 'validation_failed',
      details: { http_status: 422 },
    },
  );
});

test('known HTTP status survives an unreadable or oversized body', async () => {
  const broken = (status: number) =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error('cut'));
        },
      }),
      { status },
    );
  const cut = new HttpTransport(undefined, async () => broken(404));
  await assert.rejects(
    cut.request(transportStore, transportCredentials, 'PUT', transportPath, {}),
    {
      code: 'not_found',
    },
  );
  const unprocessable = new HttpTransport(undefined, async () => broken(422));
  await assert.rejects(
    unprocessable.request(transportStore, transportCredentials, 'PUT', transportPath, {}),
    (error: any) =>
      error.code === 'validation_failed' && error.details.validation_errors === undefined,
  );
  const oversized = new HttpTransport(
    undefined,
    async () => new Response('x'.repeat(8 * 1024 * 1024 + 1), { status: 429 }),
  );
  await assert.rejects(
    oversized.request(transportStore, transportCredentials, 'PUT', transportPath, {}),
    (error: any) => error.code === 'rate_limited' && error.details.retry_after_seconds === 60,
  );
  const payment = new HttpTransport(undefined, async () => broken(402));
  await assert.rejects(
    payment.request(transportStore, transportCredentials, 'PUT', transportPath, {}),
    { code: 'execution_unknown' },
  );
});

test('Retry-After is capped at one hour', async () => {
  for (const header of [
    '999999999',
    new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toUTCString(),
  ]) {
    const http = new HttpTransport(
      undefined,
      async () => new Response(null, { status: 429, headers: { 'Retry-After': header } }),
    );
    await assert.rejects(
      http.request(transportStore, transportCredentials, 'GET', transportPath),
      (error: any) => {
        assert.equal(error.code, 'rate_limited');
        assert.equal(error.details.retry_after_seconds, 3600);
        return true;
      },
    );
  }
});

test('Retry-After accepts seconds and dates and defaults for invalid or missing headers', async () => {
  const future = new Date(Date.now() + 120000).toUTCString();
  const past = new Date(Date.now() - 120000).toUTCString();
  for (const [header, expected] of [
    [null, 60],
    ['invalid', 60],
    ['1.5', 60],
    ['17', 17],
    ['0', 0],
    [past, 1],
    [future, 120],
  ] as const) {
    const http = new HttpTransport(
      undefined,
      async () =>
        new Response(null, {
          status: 429,
          ...(header === null ? {} : { headers: { 'Retry-After': header } }),
        }),
    );
    await assert.rejects(
      http.request(transportStore, transportCredentials, 'GET', transportPath),
      (error: any) => {
        assert.equal(error.code, 'rate_limited');
        const seconds = error.details.retry_after_seconds;
        if (header === future) assert.ok(seconds > 115 && seconds <= expected);
        else assert.equal(seconds, expected);
        return true;
      },
    );
  }
});
