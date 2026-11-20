import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ROOT } from '../src/shared/common.js';

// Existing domain scenarios exercise the same operations through the new public interface.
const baseline = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/mcp-contract.json'), 'utf8'));
const reads = new Set(
  baseline.tools.filter((tool: any) => tool.annotations.readOnlyHint).map((tool: any) => tool.name),
);
export function operationRequest(request: { name: string; arguments?: Record<string, unknown> }) {
  return {
    name: reads.has(request.name) ? 'execute_read' : 'execute_write',
    arguments: {
      code: `return await insales[${JSON.stringify(request.name)}](${JSON.stringify(request.arguments ?? {})});`,
      ...(!reads.has(request.name) ? { execution_id: randomUUID() } : {}),
    },
  };
}
export async function callOperation(
  client: Client,
  request: { name: string; arguments?: Record<string, unknown> },
) {
  const response = await client.callTool(operationRequest(request));
  const execution = JSON.parse((response.content as any)[0].text);
  if (!execution.execution_id) return response;
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(execution.status === 'completed' ? execution.result : execution.error),
      },
    ],
    ...(execution.status !== 'completed' ? { isError: true } : {}),
  };
}
