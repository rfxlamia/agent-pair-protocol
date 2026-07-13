import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REFERENCE_PROFILES } from "@agentpair/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FileBondStore } from "./bonds.js";

describe("bond profile migration on load", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function tempDataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-bond-migrate-"));
    tempDirs.push(dir);
    return dir;
  }

  it("defaults legacy bonds to REFERENCE_PROFILES and writes back", async () => {
    const dataDir = await tempDataDir();
    await writeFile(
      join(dataDir, "bonds.json"),
      JSON.stringify({
        v: 1,
        agents: {
          alice: [
            {
              peer: "bob",
              mode: "bonded_contact",
              scope: ["inbox"],
            },
          ],
        },
      }),
      "utf8",
    );

    const store = new FileBondStore({ dataDir });
    const bonds = store.get("alice");
    expect(bonds).toHaveLength(1);
    expect(bonds[0]?.profiles).toEqual([...REFERENCE_PROFILES]);
    await store.flush();

    const raw = JSON.parse(await readFile(join(dataDir, "bonds.json"), "utf8")) as {
      agents: { alice: Array<{ profiles?: string[] }> };
    };
    expect(raw.agents.alice[0]?.profiles).toEqual([...REFERENCE_PROFILES]);

    const reloaded = new FileBondStore({ dataDir });
    expect(reloaded.get("alice")[0]?.profiles).toEqual([...REFERENCE_PROFILES]);
  });

  it("preserves bonds that already have profiles", async () => {
    const dataDir = await tempDataDir();
    const customProfiles = ["core/1"];
    await writeFile(
      join(dataDir, "bonds.json"),
      JSON.stringify({
        v: 1,
        agents: {
          alice: [
            {
              peer: "bob",
              mode: "bonded_contact",
              scope: ["inbox"],
              profiles: customProfiles,
            },
          ],
        },
      }),
      "utf8",
    );

    const store = new FileBondStore({ dataDir });
    expect(store.get("alice")[0]?.profiles).toEqual(customProfiles);
    await store.flush();

    const raw = JSON.parse(await readFile(join(dataDir, "bonds.json"), "utf8")) as {
      agents: { alice: Array<{ profiles?: string[] }> };
    };
    expect(raw.agents.alice[0]?.profiles).toEqual(customProfiles);
  });

  it("rejects entire bonds.json when profiles field is invalid", async () => {
    const dataDir = await tempDataDir();
    const bondsPath = join(dataDir, "bonds.json");
    const invalidPayload = JSON.stringify({
      v: 1,
      agents: {
        alice: [
          {
            peer: "bob",
            mode: "bonded_contact",
            scope: ["inbox"],
            profiles: ["not-valid-profile-id"],
          },
        ],
      },
    });
    await writeFile(bondsPath, invalidPayload, "utf8");

    const store = new FileBondStore({ dataDir });
    expect(store.get("alice")).toEqual([]);

    const raw = await readFile(bondsPath, "utf8");
    expect(raw).toBe(invalidPayload);
  });

  it("accepts legacy bonds with unknown extra fields", async () => {
    const dataDir = await tempDataDir();
    await writeFile(
      join(dataDir, "bonds.json"),
      JSON.stringify({
        v: 1,
        agents: {
          alice: [
            {
              peer: "bob",
              mode: "bonded_contact",
              scope: ["inbox"],
              establishedAt: 1_700_000_000_000,
            },
          ],
        },
      }),
      "utf8",
    );

    const store = new FileBondStore({ dataDir });
    const bond = store.get("alice")[0];
    expect(bond?.profiles).toEqual([...REFERENCE_PROFILES]);
    expect(bond).toMatchObject({ establishedAt: 1_700_000_000_000 });
    await store.flush();
  });
});
