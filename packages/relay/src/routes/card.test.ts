import { generateKeyPair, publicKeyToAgentId } from "@agentpair/protocol";
import { describe, expect, it } from "vitest";
import { createRelayApp } from "../server.js";

describe("card and health relay routes", () => {
  const agent = generateKeyPair();
  const agentId = publicKeyToAgentId(agent.publicKey);

  it("stores and returns agent card JSON", async () => {
    const { app } = createRelayApp();
    const card = JSON.stringify({
      agent_id: agentId,
      name: "relay-test-agent",
      capabilities: ["inbox"],
    });

    const putRes = await app.request(`/card/${agentId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: card,
    });
    expect(putRes.status).toBe(204);

    const getRes = await app.request(`/card/${agentId}`);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe(card);
  });

  it("returns 404 when card is missing", async () => {
    const { app } = createRelayApp();
    const res = await app.request("/card/ed25519:missing-agent");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("card_not_found");
  });

  it("returns health status ok", async () => {
    const { app } = createRelayApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});
