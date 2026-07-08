#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./index.js";
import { flushAgentContext } from "./store/flush-context.js";

let shuttingDown = false;

function registerShutdownHooks(context: ReturnType<typeof createMcpServer>["context"]): void {
  const flushOnExit = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void flushAgentContext(context).finally(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", flushOnExit);
  process.once("SIGTERM", flushOnExit);
  process.once("beforeExit", () => {
    void flushAgentContext(context);
  });
}

async function main(): Promise<void> {
  const { server, context } = createMcpServer();
  registerShutdownHooks(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
