import type { AgentContext } from "../tools/pair.js";

type FlushableStore = { flush?: () => Promise<void> };

export async function flushAgentContext(ctx: AgentContext): Promise<void> {
  const stores = [
    ctx.bonds,
    ctx.pending,
    ctx.sessionStore,
    ctx.allowlist,
    ctx.inboxCursor,
    ctx.closedThreads,
  ] as FlushableStore[];
  const results = await Promise.allSettled(
    stores.map((store) => store.flush?.() ?? Promise.resolve()),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(
        "[agentpair] context flush failed",
        result.reason instanceof Error ? result.reason.message : result.reason,
      );
    }
  }
}

export function scheduleAgentContextFlush(ctx: AgentContext): void {
  void flushAgentContext(ctx).catch((error) => {
    console.error(
      "[agentpair] scheduled context flush failed",
      error instanceof Error ? error.message : error,
    );
  });
}
