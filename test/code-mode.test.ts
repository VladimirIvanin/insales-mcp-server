import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ActiveCalls } from '../src/app/active-calls.js';
import { z } from 'zod';
import { OperationRegistry } from '../src/mcp/operations.js';
import { CodeRuntime, CODE_LIMITS } from '../src/mcp/code-mode/runtime.js';
import { State } from '../src/infrastructure/persistence/state.js';
import { Fault } from '../src/shared/common.js';
import { cleanup } from '../src/infrastructure/persistence/cleanup.js';

function fixture() {
  const registry = new OperationRegistry();
  let writes = 0;
  registry.domain = 'themes';
  registry.tool(
    'get_widget',
    'Настройки виджета',
    { id: z.number().int().positive(), limit: z.number().default(5) },
    (a) => a,
  );
  registry.tool(
    'update_widget',
    'Изменить настройки виджета',
    { operation_id: z.string().uuid().optional(), conflict: z.boolean().default(false) },
    (a) => {
      if (a.conflict) throw new Fault('conflict', 'Conflict');
      writes++;
      return { status: 'applied', id: a.operation_id, writes };
    },
    'write',
    false,
  );
  registry.tool(
    'propose_widget',
    'Создать черновик',
    {},
    () => {
      writes++;
      return { change_id: randomUUID() };
    },
    'draft',
  );
  return { registry, runtime: new CodeRuntime(registry), writes: () => writes };
}

test('catalog supports Russian search, domain discovery and original schemas/defaults', async () => {
  const { runtime } = fixture();
  const result = await runtime.execute(
    'const methods = await catalog.search({query:"виджет настройки"}); const docs = await catalog.describe({names:[methods.methods[0].name]}); return {methods,docs,value:await insales.get_widget({id:1})};',
  );
  assert.equal(result.status, 'completed');
  const value = result.result as any;
  assert.ok(value.methods.methods.some((m: any) => m.name === 'get_widget'));
  assert.equal(value.docs[0].inputSchema.type, 'object');
  assert.equal(value.value.limit, 5);
  const invalid = await runtime.execute('return await insales.get_widget({id:"1"});');
  assert.equal((invalid.error as any).code, 'validation_failed');
});

test('read sandbox cannot mutate even through dynamic names or caught errors', async () => {
  const { runtime, writes } = fixture();
  for (const name of ['update_widget', 'propose_widget']) {
    const result = await runtime.execute(`return await insales[${JSON.stringify(name)}]({});`);
    assert.equal((result.error as any).code, 'read_only');
  }
  assert.equal(writes(), 0);
  assert.equal((await runtime.execute('return await insales.unknown({});')).status, 'error');
});

test('sandbox has no host capabilities, imports or shared globals across runs', async () => {
  process.env.CODE_MODE_TEST_SECRET = 'must-not-leak';
  try {
    const { runtime } = fixture();
    const result = await runtime.execute(
      'globalThis.persisted=42; return [typeof process,typeof require,typeof fetch,typeof Buffer,typeof setTimeout,typeof __bridge];',
    );
    assert.deepEqual(result.result, Array(6).fill('undefined'));
    assert.equal((await runtime.execute('return typeof persisted;')).result, 'undefined');
    assert.equal((await runtime.execute('return await import("node:fs");')).status, 'error');
    assert.equal(
      (await runtime.execute('return insales.constructor.constructor("return process")();')).status,
      'error',
    );
  } finally {
    delete process.env.CODE_MODE_TEST_SECRET;
  }
});

test('write executions persist operation receipts and never replay after restart or error', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'code-mode-'));
  let state = new State(directory);
  t.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { registry, writes } = fixture();
  let runtime = new CodeRuntime(registry, state);
  const id = randomUUID();
  const code = 'await insales.update_widget({}); throw new Error("after write");';
  const first = await runtime.execute(code, id);
  assert.equal(first.status, 'error');
  assert.equal(writes(), 1);
  assert.ok(first.steps[0]!.operation_id);
  state.close();
  state = new State(directory);
  runtime = new CodeRuntime(registry, state);
  assert.deepEqual(await runtime.execute(code, id), first);
  assert.equal(writes(), 1);
  await assert.rejects(runtime.execute('return 2;', id), { code: 'execution_id_reused' });
  const loaded = await runtime.execute(
    `return await runtime.get_execution(${JSON.stringify(id)});`,
  );
  assert.deepEqual(loaded.result, first);
});

test('conflicts block later writes even when the script catches the exception', async () => {
  const { runtime, writes } = fixture();
  const result = await runtime.execute(
    'try { await insales.update_widget({conflict:true}); } catch {} try { await insales.update_widget({}); } catch {} return "caught";',
    randomUUID(),
  );
  assert.equal(result.status, 'error');
  assert.equal(writes(), 0);
});

test('mutations are sequential and parallel reads are bounded', async () => {
  const registry = new OperationRegistry();
  let reads = 0,
    peakReads = 0,
    writes = 0,
    peakWrites = 0;
  registry.tool('read', 'read', {}, async () => {
    reads++;
    peakReads = Math.max(reads, peakReads);
    await new Promise((r) => setTimeout(r, 10));
    reads--;
    return 1;
  });
  registry.tool(
    'write',
    'write',
    {},
    async () => {
      writes++;
      peakWrites = Math.max(writes, peakWrites);
      await new Promise((r) => setTimeout(r, 10));
      writes--;
      return 1;
    },
    'write',
  );
  const runtime = new CodeRuntime(registry);
  assert.equal(
    (
      await runtime.execute(
        'return await Promise.all(Array.from({length:12},()=>insales.read({})));',
      )
    ).status,
    'completed',
  );
  assert.equal(peakReads, 4);
  assert.equal(
    (
      await runtime.execute(
        'return await Promise.all(Array.from({length:4},()=>insales.write({})));',
        randomUUID(),
      )
    ).status,
    'completed',
  );
  assert.equal(peakWrites, 1);
});

test('timeout drains already dispatched work and does not dispatch queued writes', async () => {
  const registry = new OperationRegistry();
  let calls = 0;
  let finished = 0;
  registry.tool(
    'slow',
    'slow',
    {},
    async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 1500));
      finished++;
      return 1;
    },
    'write',
  );
  const runtime = new CodeRuntime(registry, undefined, { ...CODE_LIMITS, wallMs: 1000 });
  const id = randomUUID();
  const code = 'return await Promise.all([insales.slow({}),insales.slow({})]);';
  const started = Date.now();
  const result = await runtime.execute(code, id);
  assert.equal(result.status, 'timed_out');
  assert.equal(calls, 1);
  assert.equal(finished, 1);
  assert.equal(result.steps[0]?.status, 'completed');
  assert.ok(Date.now() - started >= 1400);
  assert.equal((await runtime.execute(code, id)).status, 'timed_out');
  assert.equal(calls, 1);
  assert.equal(finished, 1);
});

for (const unawaited of [false, true]) {
  test(
    `pending write survives ${unawaited ? 'unawaited completion' : 'timeout'} and holds shutdown open`,
    { timeout: 8000 },
    async (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'code-mode-drain-'));
      const state = new State(directory, { id: 'shop', name: 'Test', url: 'https://shop.example' });
      const calls = new ActiveCalls();
      const registry = new OperationRegistry();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      t.after(async () => {
        release();
        await calls.drain();
        state.close();
        rmSync(directory, { recursive: true, force: true });
      });
      let writes = 0;
      registry.tool(
        'slow',
        'slow',
        { operation_id: z.string().uuid().optional() },
        async ({ operation_id }) => {
          writes++;
          await gate;
          return { id: operation_id, status: 'applied' };
        },
        'write',
      );
      const runtime = new CodeRuntime(
        registry,
        state,
        { ...CODE_LIMITS, wallMs: 1500, drainMs: 50 },
        calls,
      );
      const id = randomUUID();
      const operationId = randomUUID();
      const pending = `Promise.all([insales.slow({operation_id: "${operationId}"}), insales.slow({})])`;
      const code = unawaited ? `${pending}; return 1;` : `return await ${pending};`;
      const result = await calls.run(() => runtime.execute(code, id));
      assert.equal(result.status, unawaited ? 'error' : 'timed_out');
      assert.equal(
        (result.error as { code: string }).code,
        unawaited ? 'unawaited_calls' : 'execution_timeout',
      );
      assert.deepEqual(result.steps, [
        { effect: 'write', name: 'slow', operation_id: operationId, status: 'sending' },
      ]);
      assert.deepEqual(await runtime.execute(code, id), result);
      assert.equal(writes, 1);

      let drained = false;
      const shutdown = calls.drain().then(() => {
        drained = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(drained, false);
      release();
      await shutdown;
      assert.equal(runtime.store.execution(id).steps[0]?.status, 'applied');
      assert.equal(result.steps[0]?.status, 'sending');
      assert.equal(writes, 1);
    },
  );
}

test('standalone async arrows support nested defaults, comments and trailing semicolons', async () => {
  const { runtime } = fixture();
  for (const code of ['async () => 1', '/* comment */ (async (a = (1)) => a);']) {
    const result = await runtime.execute(code);
    assert.equal(result.status, 'completed');
    assert.equal(result.result, 1);
  }
  assert.equal(
    (await runtime.execute('const f = async (a = (1)) => a; return await f();')).result,
    1,
  );
});

test('bridge handles large arguments, parallel replies and multibyte results', async () => {
  const bytes = CODE_LIMITS.bridgeBytes - 512;
  const registry = new OperationRegistry();
  registry.tool('length', 'length', { value: z.string() }, ({ value }) => value.length);
  registry.tool('large', 'large', {}, () => 'a'.repeat(bytes));
  const runtime = new CodeRuntime(registry);
  const arg = await runtime.execute(`return await insales.length({value:"a".repeat(${bytes})});`);
  assert.equal(arg.result, bytes);
  const replies = await runtime.execute(
    'return await Promise.all(Array.from({length:4}, async () => (await insales.large({})).length));',
  );
  assert.deepEqual(replies.result, Array(4).fill(bytes), JSON.stringify(replies.error));

  const multi = await runtime.execute(`return "я".repeat(${bytes / 2});`);
  assert.equal(multi.status, 'completed', JSON.stringify(multi.error));
  assert.ok(multi.result_ref);
  const oversized = await runtime.execute(`return "я".repeat(${CODE_LIMITS.bridgeBytes / 2});`);
  assert.equal((oversized.error as { code: string }).code, 'response_too_large');
});

test('the default method-call limit reports call_limit', async () => {
  const { registry } = fixture();
  const runtime = new CodeRuntime(registry);
  const result = await runtime.execute(
    'for (let i = 0; i < 101; i++) await insales.get_widget({id:1});',
  );
  assert.equal(result.status, 'error');
  assert.equal((result.error as { code: string }).code, 'call_limit');
  assert.equal(JSON.stringify(result.error).includes('16 MiB'), false);
});

test('CPU, wall-time, memory and method-call limits return controlled errors', async () => {
  const { registry } = fixture();
  const runtime = new CodeRuntime(registry, undefined, {
    ...CODE_LIMITS,
    cpuMs: 50,
    wallMs: 1000,
    maxCalls: 3,
  });
  assert.equal((await runtime.execute('while(true) {}')).status, 'error');
  assert.equal((await runtime.execute('return await new Promise(()=>{});')).status, 'timed_out');
  assert.equal(
    (await runtime.execute('for(let i=0;i<5;i++) await insales.get_widget({id:1});')).status,
    'error',
  );
  const small = new CodeRuntime(registry, undefined, {
    ...CODE_LIMITS,
    memoryBytes: 4 * 1024 * 1024,
    wallMs: 1000,
  });
  assert.ok(
    ['error', 'timed_out'].includes(
      (await small.execute('const x=[]; while(true) x.push(new Array(10000).fill("long"));'))
        .status,
    ),
  );
});

test('large results remain recoverable without repeating writes and survive restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'code-results-'));
  const state = new State(directory);
  t.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { registry, writes } = fixture();
  let runtime = new CodeRuntime(registry, state);
  const result = await runtime.execute(
    'await insales.update_widget({}); return "x".repeat(70000);',
    randomUUID(),
  );
  assert.equal(result.status, 'completed');
  assert.ok(result.result_ref);
  assert.equal(result.result, undefined);
  runtime = new CodeRuntime(registry, state);
  const page = await runtime.execute(
    `return await runtime.get_result(${JSON.stringify(result.result_ref)},{offset:0,limit:1000});`,
  );
  assert.equal((page.result as any).text.length, 1000);
  assert.equal((page.result as any).next_offset, 1000);
  assert.equal(writes(), 1);
});

test('cleanup removes expired runtime records but retains unresolved execution receipts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'code-cleanup-'));
  const state = new State(directory);
  t.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  state.put('code_execution', 'old', { status: 'completed', steps: [] });
  state.put('code_execution', 'unknown', { status: 'running', steps: [] });
  state.put('code_result', 'old', { serialized: '{}' });
  state.put('code_read_result', 'old', { serialized: '{}' });
  state.db.prepare('UPDATE records SET updated_at_ms=?').run(Date.now() - 8 * 86400000);
  await cleanup(state, { apply: true });
  assert.equal((state.get('code_execution', 'old', (x) => x) as any).status, 'expired');
  assert.equal(
    state.get('code_result', 'old', (x) => x),
    undefined,
  );
  assert.equal(
    state.get('code_read_result', 'old', (x) => x),
    undefined,
  );
  assert.ok(state.get('code_execution', 'unknown', (x) => x));
});

test('failed domain results stop mutations even if they were returned instead of thrown', async () => {
  const registry = new OperationRegistry();
  let calls = 0;
  registry.tool(
    'write',
    'write',
    {},
    () => {
      calls++;
      return { status: 'failed', error: { code: 'validation_failed' } };
    },
    'write',
  );
  const result = await new CodeRuntime(registry).execute(
    'try { await insales.write({}); } catch {} try { await insales.write({}); } catch {}',
    randomUUID(),
  );
  assert.equal(result.status, 'error');
  assert.equal(calls, 1);
});

test('unawaited calls are drained and reflected in receipts', async () => {
  const registry = new OperationRegistry();
  let finished = false;
  registry.tool(
    'write',
    'write',
    {},
    async () => {
      await new Promise((r) => setTimeout(r, 50));
      finished = true;
      return 1;
    },
    'write',
  );
  const result = await new CodeRuntime(registry).execute(
    'void insales.write({}); return 1;',
    randomUUID(),
  );
  assert.equal(finished, true);
  assert.equal(result.steps[0]!.status, 'completed');
  if (result.status !== 'completed') assert.equal((result.error as any).code, 'unawaited_calls');
});

test('catalog mistakes and invalid operation arguments expose actionable schemas', async () => {
  const { runtime, registry } = fixture();
  const search = registry.search({ query: 'get widget id show instance single' }) as any;
  assert.equal(search.methods[0].name, 'get_widget');
  const wrongDescribe = await runtime.execute(
    'return await catalog.describe({name:"get_widget"});',
  );
  assert.equal((wrongDescribe.error as any).code, 'validation_failed');
  assert.match((wrongDescribe.error as any).message, /names/);
  assert.match((wrongDescribe.error as any).details.usage, /names/);
  const wrongArgs = await runtime.execute('return await insales.get_widget({product_id:1});');
  assert.equal((wrongArgs.error as any).details.inputSchema.required[0], 'id');
});

test('large errors and escaped result chunks preserve a bounded response', async () => {
  const registry = new OperationRegistry();
  registry.tool('fail', 'fail', {}, () => {
    throw new Fault('validation_failed', 'Details', { body: 'x'.repeat(80000) });
  });
  const runtime = new CodeRuntime(registry);
  const failed = await runtime.execute('return await insales.fail({});');
  assert.ok(failed.error_ref);
  assert.ok(Buffer.byteLength(JSON.stringify(failed)) < 65536);
  const large = await runtime.execute('return "\\u0000".repeat(20000);');
  const part = await runtime.execute(
    `return await runtime.get_result(${JSON.stringify(large.result_ref)},{limit:16000});`,
  );
  assert.ok(part.result);
  assert.equal(part.result_ref, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(part)) < 65536);
});

test('missing return gives an explicit correction instead of an empty result', async () => {
  const { runtime } = fixture();
  const result = await runtime.execute('await catalog.search({query:"widget"});');
  assert.equal(result.status, 'error');
  assert.equal((result.error as any).code, 'missing_return');
  assert.match((result.error as any).message, /return await/);
});

test('on-demand examples validate against every original operation schema', async () => {
  const { createOperations } = await import('../src/mcp/server.js');
  const { Knowledge } = await import('../src/infrastructure/knowledge/index.js');
  const { operationHelp } = await import('../src/mcp/operation-help.js');
  const knowledge = new Knowledge();
  try {
    const registry = createOperations({ engine: {} as any, knowledge });
    for (const [name, help] of Object.entries(operationHelp)) {
      const operation = registry.get(name);
      await operation.validate(help.args);
      for (const key of Object.keys(help.args))
        assert.ok(key in (operation.inputSchema.properties as object), `${name}.${key}`);
    }
  } finally {
    knowledge.close();
  }
});

test('expired execution IDs never replay after cleanup', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'code-expiry-'));
  const state = new State(directory);
  t.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { registry, writes } = fixture();
  const runtime = new CodeRuntime(registry, state);
  const id = randomUUID(),
    code = 'return await insales.update_widget({});';
  assert.equal((await runtime.execute(code, id)).status, 'completed');
  state.db
    .prepare("UPDATE records SET updated_at_ms=? WHERE kind='code_execution'")
    .run(Date.now() - 8 * 86400000);
  await cleanup(state, { apply: true });
  assert.equal((await new CodeRuntime(registry, state).execute(code, id)).status, 'expired');
  assert.equal(writes(), 1);
});
