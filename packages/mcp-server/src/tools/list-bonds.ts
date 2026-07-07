import { publicKeyToAgentId } from "@agentpair/protocol";
import type { AgentContext } from "./pair.js";
import { assertNoSecrets, toolTextResult } from "./util.js";

export async function handleListBonds(ctx: AgentContext) {
  const keyPair = await ctx.keyStore.loadOrCreate();
  const agentId = publicKeyToAgentId(keyPair.publicKey);
  const bonds = ctx.bonds.get(agentId);
  const result = { ok: true, agent_id: agentId, bonds };
  assertNoSecrets(result);
  return toolTextResult(result);
}
