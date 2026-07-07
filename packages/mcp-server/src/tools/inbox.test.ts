import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDualAgent,
  runPairingFlow,
  startDualRelay,
  type DualRelayEnv,
} from "../e2e/dual-server.js";
import { handleInbox } from "./inbox.js";
import { handleSessionOpen, handleSessionStatus } from "./session.js";

function structured<T>(result: { structuredContent: T }): T {
  return result.structuredContent;
}

describe("inbox production path", () => {
  let env: DualRelayEnv;

  beforeAll(async () => {
    env = await startDualRelay(3022);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("handleInbox routes session.open envelopes into session state", async () => {
    const alice = await createDualAgent(env, "inbox-alice");
    const bob = await createDualAgent(env, "inbox-bob");
    await runPairingFlow(alice, bob);

    const opened = structured(
      await handleSessionOpen(alice.ctx, {
        to: bob.agentId,
        goal: "Inbox routing probe",
        acceptance: [
          {
            id: "A1",
            test: "executable",
            desc: "probe",
            runner: "payload-size",
          },
        ],
        budget: { max_turns: 10 },
        mandate: {
          agent_may: ["propose"],
          human_required: ["sign_final"],
        },
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }

    const bobStatusBefore = structured(
      await handleSessionStatus(bob.ctx, { thread: opened.thread }),
    );
    expect(bobStatusBefore.ok).toBe(false);
    if (bobStatusBefore.ok) {
      return;
    }
    expect(bobStatusBefore.error).toBe("session_not_found");

    const inboxResult = structured(await handleInbox(bob.ctx, { since: 0 }));
    expect(inboxResult.ok).toBe(true);
    if (!inboxResult.ok) {
      return;
    }
    expect(
      inboxResult.envelopes.some((envelope) => envelope.type === "session.open"),
    ).toBe(true);

    const bobPendingAfter = bob.ctx.pending
      .list()
      .filter((item) => item.kind === "session_open");
    expect(bobPendingAfter).toHaveLength(1);

    const bobStatusAfter = structured(
      await handleSessionStatus(bob.ctx, { thread: opened.thread }),
    );
    expect(bobStatusAfter.ok).toBe(true);
    if (!bobStatusAfter.ok) {
      return;
    }
    expect(bobStatusAfter.status).toBe("pending");
  });
});
