import {
  MAX_SPILLOVER_PLAINTEXT_BYTES,
  hashArtifactBlob,
  publicKeyToAgentId,
} from "@agentpair/protocol";
import type { AgentContext } from "./pair.js";
import { toolTextResult } from "./util.js";

function putErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export async function handleArtifactPut(ctx: AgentContext, input: { content: string }) {
  const blob = new TextEncoder().encode(input.content);
  if (blob.byteLength === 0) {
    return toolTextResult({ ok: false, error: "invalid_payload" });
  }
  if (blob.byteLength > MAX_SPILLOVER_PLAINTEXT_BYTES) {
    return toolTextResult({ ok: false, error: "artifact_too_large" });
  }

  const keyPair = await ctx.keyStore.loadOrCreate();
  const agentId = publicKeyToAgentId(keyPair.publicKey);
  const artifact_hash = hashArtifactBlob(blob);

  try {
    await ctx.relay.putArtifact(artifact_hash, blob, agentId, keyPair.secretKey);
  } catch (err) {
    if (err instanceof Error && err.message === "hash_mismatch") {
      throw err;
    }
    const code = putErrorCode(err);
    return toolTextResult({ ok: false, error: code ?? "artifact_upload_failed" });
  }

  return toolTextResult({ ok: true, artifact_hash, size: blob.byteLength });
}
