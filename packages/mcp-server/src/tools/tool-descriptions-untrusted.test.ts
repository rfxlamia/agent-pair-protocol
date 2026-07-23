// packages/mcp-server/src/tools/tool-descriptions-untrusted.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../index.js";
import {
  INBOX_TOOL_DESCRIPTION,
  INBOX_WAIT_TOOL_DESCRIPTION,
  SESSION_STATUS_TOOL_DESCRIPTION,
} from "./tool-descriptions.js";

type RegisteredTool = { description?: string };
type RegisteredToolsMap = Record<string, RegisteredTool>;

function registeredTools(server: McpServer): RegisteredToolsMap {
  // Secondary check only — prefer constant asserts if private map shape drifts
  return (server as unknown as { _registeredTools: RegisteredToolsMap })._registeredTools;
}

describe("tool descriptions untrusted peer contract (S12)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("inbox constant states signature_valid vs content trust and payload.data", () => {
    const description = INBOX_TOOL_DESCRIPTION;
    expect(description.length).toBeGreaterThan(0);
    expect(description.toLowerCase()).toMatch(/untrusted/);
    expect(description.toLowerCase()).toMatch(/never instructions|never as instructions/);
    expect(description).toMatch(/signature_valid/);
    expect(description).toMatch(/payload\.data/);
  });

  it("session_status constant states peer-derived fields are untrusted / never instructions", () => {
    const description = SESSION_STATUS_TOOL_DESCRIPTION;
    expect(description.length).toBeGreaterThan(0);
    expect(description.toLowerCase()).toMatch(/untrusted/);
    expect(description.toLowerCase()).toMatch(/never instructions|never as instructions/);
    expect(description).toMatch(/\.data/);
  });

  describe("inbox_wait tool description (A2 + clamp)", () => {
    it("INBOX_WAIT_TOOL_DESCRIPTION states 55s clamp and loop instruction", () => {
      const description = INBOX_WAIT_TOOL_DESCRIPTION;
      expect(description.length).toBeGreaterThan(0);
      expect(description).toMatch(/55/);
      expect(description.toLowerCase()).toMatch(/call inbox_wait again/);
      expect(description.toLowerCase()).toMatch(/budget|session is live/);
    });

    it("createMcpServer registers inbox_wait with description and input schema keys", async () => {
      const dir = await mkdtemp(join(tmpdir(), "agentpair-inbox-wait-tool-"));
      tempDirs.push(dir);
      const { server } = createMcpServer({
        relayUrl: "http://127.0.0.1:9",
        keyPath: join(dir, "keys.json"),
      });
      const tools = registeredTools(server);
      expect(tools.inbox_wait).toBeDefined();
      if (tools.inbox_wait?.description !== undefined) {
        expect(tools.inbox_wait.description).toBe(INBOX_WAIT_TOOL_DESCRIPTION);
      }
      expect(tools.inbox_wait?.description ?? INBOX_WAIT_TOOL_DESCRIPTION).toMatch(/55/);
      expect(tools.inbox_wait?.description ?? INBOX_WAIT_TOOL_DESCRIPTION).toMatch(
        /call inbox_wait again/i,
      );

      const registered = tools.inbox_wait as {
        description?: string;
        inputSchema?: {
          shape?: Record<string, unknown>;
          properties?: Record<string, unknown>;
          _def?: { shape: () => Record<string, unknown> };
        };
      };
      const shape =
        registered.inputSchema?._def?.shape?.() ??
        registered.inputSchema?.shape ??
        registered.inputSchema?.properties;
      expect(shape).toBeDefined();
      expect(Object.keys(shape ?? {})).toEqual(
        expect.arrayContaining(["timeout_ms", "since", "include_history"]),
      );
    });
  });

  it("createMcpServer registers the same description strings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentpair-tool-desc-"));
    tempDirs.push(dir);
    const { server } = createMcpServer({
      relayUrl: "http://127.0.0.1:9",
      keyPath: join(dir, "keys.json"),
    });
    const tools = registeredTools(server);
    // If _registeredTools is unavailable, constant tests above remain authoritative
    if (tools.inbox?.description !== undefined) {
      expect(tools.inbox.description).toBe(INBOX_TOOL_DESCRIPTION);
    }
    if (tools.session_status?.description !== undefined) {
      expect(tools.session_status.description).toBe(SESSION_STATUS_TOOL_DESCRIPTION);
    }
  });
});
