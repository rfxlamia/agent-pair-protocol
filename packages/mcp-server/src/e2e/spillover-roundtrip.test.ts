import { hasSpillMarker } from "@agentpair/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleHumanApprove } from "../tools/human-approve.js";
import { handleInbox, handleSend } from "../tools/inbox.js";
import { handleSessionMsg, handleSessionOpen } from "../tools/session.js";
import {
  type DualRelayEnv,
  createDualAgent,
  runPairingFlow,
  startDualRelay,
} from "./dual-server.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

function largeText(chars = 70_000): string {
  return "x".repeat(chars);
}

describe("e2e spillover round-trip", () => {
  let env: DualRelayEnv;

  beforeAll(async () => {
    env = await startDualRelay(13224);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("oversized core.msg and nego.turn round-trip via spillover", async () => {
    const alice = await createDualAgent(env, "spill-alice");
    const bob = await createDualAgent(env, "spill-bob");
    await runPairingFlow(alice, bob);

    const largeBody = largeText();
    const msgThread = crypto.randomUUID();

    const sent = structured(
      await handleSend(alice.ctx, { to: bob.agentId, body: largeBody, thread: msgThread }),
    );
    expect(sent.ok).toBe(true);

    const msgInbox = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(msgInbox.ok).toBe(true);
    if (!msgInbox.ok) {
      return;
    }
    const coreMsg = msgInbox.envelopes.find(
      (envelope) => envelope.type === "core.msg" && envelope.thread === msgThread,
    );
    expect(coreMsg).toBeDefined();
    expect(coreMsg?.payload).toEqual({ body: largeBody });
    expect(hasSpillMarker(coreMsg?.payload)).toBe(false);

    const opened = structured(
      await handleSessionOpen(alice.ctx, {
        to: bob.agentId,
        goal: "Spillover E2E",
        acceptance: [{ id: "A1", test: "executable", desc: "probe", runner: "vitest" }],
        budget: { max_turns: 10 },
        mandate: { agent_may: ["propose"], human_required: ["sign_final"] },
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }

    const bootstrap = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) {
      return;
    }

    const pending = bob.ctx.pending.list().find((item) => item.kind === "session_open");
    expect(pending).toBeDefined();
    if (!pending) {
      return;
    }

    await handleHumanApprove(bob.ctx, {
      pending_id: pending.id,
      decision: "approve",
      via_human: true,
    });

    structured(await handleInbox(alice.ctx, { since: 0 }));

    const largeProposal = JSON.stringify({ diff: largeBody });
    await handleSessionMsg(alice.ctx, {
      thread: opened.thread,
      type: "propose",
      body: largeProposal,
    });

    const bobInbox = structured(await handleInbox(bob.ctx, { since: bootstrap.cursor ?? 0 }));
    expect(bobInbox.ok).toBe(true);
    if (!bobInbox.ok) {
      return;
    }

    const negoTurn = bobInbox.envelopes.find(
      (envelope) => envelope.type === "nego.turn" && envelope.thread === opened.thread,
    );
    expect(negoTurn).toBeDefined();
    const turnPayload = negoTurn?.payload as { msg_type?: string; body?: string };
    expect(turnPayload.msg_type).toBe("propose");
    expect(turnPayload.body).toBe(largeProposal);
    expect(hasSpillMarker(negoTurn?.payload)).toBe(false);
  }, 30000);
});
