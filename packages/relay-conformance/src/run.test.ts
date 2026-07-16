import { createRelayApp } from "@agentpair/relay";
import { afterEach, describe, expect, it } from "vitest";
import { installInProcessFetch, uninstallInProcessFetch } from "./fetch-bridge.js";
import { type SuiteResult, runConformanceSuite } from "./run.js";
import { seedInboxSeqGap } from "./suite/helpers/seed-inbox-gap.js";

const BASE = "http://in-process.test";

const FAST_REQUIRED_PROBE_IDS = [
  "default-deny",
  "challenge-roundtrip",
  "allowlist-blob",
  "inbox-idempotency",
  "hash-verify",
  "purge-dyad",
  "inbox-pull-shape",
] as const;

describe("runConformanceSuite — fast REQUIRED probes", () => {
  afterEach(() => {
    uninstallInProcessFetch();
  });

  it("passes all seven fast REQUIRED probes against in-process relay", async () => {
    const relay = createRelayApp();
    installInProcessFetch(BASE, relay.app);

    const result: SuiteResult = await runConformanceSuite(BASE, {
      slow: false,
      large: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.failed).toHaveLength(0);
    const passedIds = result.passed.map((p) => p.id);
    expect(passedIds).toEqual(expect.arrayContaining([...FAST_REQUIRED_PROBE_IDS]));
    expect(
      passedIds.filter((id) =>
        FAST_REQUIRED_PROBE_IDS.includes(id as (typeof FAST_REQUIRED_PROBE_IDS)[number]),
      ),
    ).toHaveLength(FAST_REQUIRED_PROBE_IDS.length);
    expect(result.skipped.map((p) => p.id)).toEqual(
      expect.arrayContaining(["pair-ttl", "artifact-10mb"]),
    );
  });

  it("skips slow and large probes when flags omitted (not failed)", async () => {
    const relay = createRelayApp();
    installInProcessFetch(BASE, relay.app);

    const result = await runConformanceSuite(BASE);
    const skippedIds = result.skipped.map((p) => p.id);
    expect(skippedIds).toContain("pair-ttl");
    expect(skippedIds).toContain("artifact-10mb");
    expect(
      result.failed.filter((p) => p.id === "pair-ttl" || p.id === "artifact-10mb"),
    ).toHaveLength(0);
  });

  it("emits ADVISORY reference-divergent (exit 0) when pull JSON has gaps stripped", async () => {
    const relay = createRelayApp();
    await seedInboxSeqGap(relay, BASE);

    installInProcessFetch(BASE, relay.app, {
      transformResponse: async (path, res) => {
        if (!path.startsWith("/inbox/") || res.status !== 200) return res;
        const text = await res.text();
        try {
          const json = JSON.parse(text) as Record<string, unknown>;
          expect(json.gaps).toBeDefined();
          json.gaps = undefined;
          return new Response(JSON.stringify(json), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch {
          return new Response(text, { status: res.status });
        }
      },
    });

    const result = await runConformanceSuite(BASE, { advisoryProbe: "gaps-stripped" });
    expect(result.exitCode).toBe(0);
    expect(result.advisories.some((a) => a.code === "reference-divergent")).toBe(true);
  });
});
