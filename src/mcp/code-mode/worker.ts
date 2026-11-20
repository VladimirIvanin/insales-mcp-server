import { parentPort, workerData } from 'node:worker_threads';
import { parse } from 'acorn';
import { getQuickJS } from 'quickjs-emscripten';
import { z } from 'zod';

const port = parentPort!;
const input = z
  .object({ code: z.string(), cpuMs: z.number(), memoryBytes: z.number() })
  .parse(workerData);
const QuickJS = await getQuickJS();
const vm = QuickJS.newContext();
vm.runtime.setMemoryLimit(input.memoryBytes);
vm.runtime.setMaxStackSize(512 * 1024);
let consumed = 0;
let started = performance.now();
let cpuExceeded = false;
vm.runtime.setInterruptHandler(() => {
  cpuExceeded = consumed + performance.now() - started > input.cpuMs;
  return cpuExceeded;
});
function segment<T>(work: () => T): T {
  started = performance.now();
  try {
    return work();
  } finally {
    consumed += performance.now() - started;
  }
}
const pending = new Map<number, ReturnType<typeof vm.newPromise>>();
let sequence = 0;
let finished = false;
function finish(payload: string) {
  if (finished) return;
  finished = true;
  port.postMessage({ type: 'done', payload });
}
function failure(code: string, message: string) {
  finish(JSON.stringify({ ok: false, error: { code, message } }));
}
function scriptSource(code: string) {
  try {
    const { body } = parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
    const statement = body[0];
    if (
      body.length === 1 &&
      statement?.type === 'ExpressionStatement' &&
      statement.expression.type === 'ArrowFunctionExpression' &&
      statement.expression.async
    ) {
      const { start, end } = statement.expression;
      return `(${code.slice(start, end)})()`;
    }
  } catch {
    // QuickJS parses function bodies and reports their syntax errors.
  }
  return `(async () => {\n${code}\n})()`;
}
const bridge = vm.newFunction('__bridge', (handle) => {
  const encoded = vm.getString(handle);
  const deferred = vm.newPromise();
  const id = ++sequence;
  pending.set(id, deferred);
  port.postMessage({ type: 'call', id, encoded });
  return deferred.handle;
});
vm.setProp(vm.global, '__bridge', bridge);
bridge.dispose();
const bootstrap = `
(() => {
  const send = globalThis.__bridge;
  delete globalThis.__bridge;
  const stringify = JSON.stringify.bind(JSON);
  const parse = JSON.parse.bind(JSON);
  const call = async (namespace, name, args) => {
    const encoded = stringify({namespace, name, args});
    const reply = parse(await send(encoded));
    if (!reply.ok) {
      const error = new Error(reply.error.message);
      error.code = reply.error.code;
      error.details = reply.error;
      throw error;
    }
    return reply.value;
  };
  globalThis.insales = new Proxy(Object.create(null), {
    get: (_, name) => typeof name === 'string' && name !== 'then'
      ? args => call('insales', name, args ?? {}) : undefined
  });
  globalThis.catalog = Object.freeze({
    search: (args = {}) => call('catalog', 'search', args),
    describe: args => call('catalog', 'describe', args)
  });
  globalThis.runtime = Object.freeze({
    get_execution: id => call('runtime', 'get_execution', {id}),
    get_result: (ref, options = {}) => call('runtime', 'get_result', {ref, ...options})
  });
  globalThis.__encode = value => value === undefined
    ? stringify({ok:false,error:{code:'missing_return',message:'Верните результат явно: return await catalog.search({query: "product"}); код является телом async-функции и не возвращает последнее выражение автоматически. После execute_write сначала проверьте runtime.get_execution(execution_id): исправление return не разрешает повторять уже выполненные изменения.'}})
    : stringify({ok: true, value});
  globalThis.__error = error => stringify({ok: false, error: {
    code: typeof error?.code === 'string' ? error.code : 'script_error',
    message: String(error?.message ?? error).slice(0, 4000),
    ...(error?.details ? {details:error.details} : {})
  }});
})();`;
const setup = segment(() => vm.evalCode(bootstrap));
if (setup.error) {
  setup.error.dispose();
  failure('sandbox_error', 'Не удалось создать песочницу.');
} else {
  setup.value.dispose();
  const source = scriptSource(input.code);
  const evaluated = segment(() =>
    vm.evalCode(
      `Promise.resolve().then(() => ${source}).then(__encode, __error)`,
      'insales-code.js',
    ),
  );
  if (evaluated.error) {
    let message = 'Ошибка JavaScript или превышение лимита памяти/CPU.';
    try {
      const handle = vm.getProp(evaluated.error, 'message');
      message = vm.getString(handle).slice(0, 4000) || message;
      handle.dispose();
    } catch {
      /* Resource exhaustion can prevent allocating the diagnostic. */
    }
    evaluated.error.dispose();
    failure(cpuExceeded ? 'cpu_limit' : 'script_error', message);
  } else {
    const promise = evaluated.value;
    void vm
      .resolvePromise(promise)
      .then((result) => {
        if (result.error) {
          result.error.dispose();
          failure(
            cpuExceeded ? 'cpu_limit' : 'sandbox_error',
            'Ошибка исполнения или превышение лимита памяти/CPU.',
          );
        } else {
          const payload = vm.getString(result.value);
          result.value.dispose();
          finish(payload);
        }
        promise.dispose();
      })
      .catch(() => failure('sandbox_error', 'Ошибка песочницы.'));
    const pump = () => {
      if (finished) return;
      const result = segment(() => vm.runtime.executePendingJobs(1));
      if (result.error) {
        result.error.dispose();
        failure(
          cpuExceeded ? 'cpu_limit' : 'sandbox_error',
          'Ошибка исполнения или превышение лимита памяти/CPU.',
        );
      } else if (vm.runtime.hasPendingJob()) setImmediate(pump);
    };
    port.on('message', (message: unknown) => {
      if (finished) return;
      const reply = z.object({ id: z.number(), encoded: z.string() }).parse(message);
      const deferred = pending.get(reply.id);
      if (!deferred) return;
      pending.delete(reply.id);
      const value = vm.newString(reply.encoded);
      deferred.resolve(value);
      value.dispose();
      deferred.dispose();
      pump();
    });
    pump();
  }
}
