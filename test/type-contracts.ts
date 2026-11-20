import { z } from 'zod';
import type { ToolRegistrar } from '../src/mcp/register-tool.js';

// Compile-only assertions: an invalid tool argument or command must fail tsc.
declare const register: ToolRegistrar;
function compileOnly() {
  register('typed_example', 'Example', { id: z.number() }, (args) => {
    const id: number = args.id;
    // @ts-expect-error A string argument is not accepted by the registered schema.
    const wrong: string = args.id;
    return { id, wrong };
  });
}
void compileOnly;
