import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ShapeOutput,
  ZodRawShapeCompat,
} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { errorResult, isRecord } from '../shared/common.js';
import type { ActiveCalls } from '../app/active-calls.js';

type Effect = 'read' | 'draft' | 'write';

/** Keep each handler's parsed arguments tied to its public Zod shape. */
export function createToolRegistrar(server: McpServer, calls?: ActiveCalls) {
  return function tool<Shape extends ZodRawShapeCompat>(
    name: string,
    description: string,
    schema: Shape,
    handler: (args: ShapeOutput<Shape>) => unknown,
    effect: Effect = 'read',
    idempotent = effect !== 'draft',
  ) {
    const handle = async (args: ShapeOutput<Shape>): Promise<CallToolResult> => {
      try {
        const result = await handler(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          ...(isRecord(result) &&
          typeof result.execution_id === 'string' &&
          ['error', 'timed_out', 'expired'].includes(String(result.status))
            ? { isError: true }
            : {}),
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(errorResult(error)) }],
        };
      }
    };
    const callback = (args: ShapeOutput<Shape>) =>
      calls ? calls.run(() => handle(args)) : handle(args);
    // TypeScript cannot reduce the SDK's conditional callback type for a
    // generic raw shape; the cast is confined to this protocol boundary.
    server.registerTool<ZodRawShapeCompat, Shape>(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: effect === 'read',
          destructiveHint: effect === 'write',
          idempotentHint: idempotent,
          openWorldHint: !(name.includes('knowledge') || name === 'get_widget_standards'),
        },
      },
      callback as unknown as ToolCallback<Shape>,
    );
  };
}

export type ToolRegistrar = ReturnType<typeof createToolRegistrar>;
