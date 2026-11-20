import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApplication } from '../../app/application.js';
import { createMcpServer } from '../server.js';

export async function serve() {
  const application = createApplication();
  const server = createMcpServer(application);
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      await server.close();
      await application.dispose();
    })();
    return closing;
  };
  const onSignal = () => {
    void close().catch((error) => {
      process.stderr.write(
        `Не удалось закрыть MCP: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
  };
  try {
    await server.connect(new StdioServerTransport());
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    return { server, application, close };
  } catch (error) {
    await close();
    throw error;
  }
}
