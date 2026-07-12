import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpRelayClient, resolveRelayUrl } from "./relay/client.js";
import { createKeyStore } from "./store/keys.js";
import { createPendingQueue } from "./store/pending.js";
import { resolveDataDir } from "./store/persistent-store.js";
import { handleHumanApprove } from "./tools/human-approve.js";
import { handleClose, handleInbox, handleSend } from "./tools/inbox.js";
import { handleListBonds } from "./tools/list-bonds.js";
import type { AgentContext } from "./tools/pair.js";
import { createAgentContext } from "./tools/pair.js";
import {
  handlePairInit,
  handlePairInitCompleteTool,
  handlePairJoin,
  handleRevoke,
} from "./tools/pair.js";
import {
  handleSessionMsg,
  handleSessionOpen,
  handleSessionSign,
  handleSessionStatus,
} from "./tools/session.js";

export interface CreateMcpServerOptions {
  context?: AgentContext;
  relayUrl?: string;
  keyPath?: string;
  dataDir?: string;
}

export function createMcpServer(options: CreateMcpServerOptions = {}): {
  server: McpServer;
  context: AgentContext;
} {
  const relay = new HttpRelayClient(options.relayUrl ?? resolveRelayUrl());
  const dataDir =
    options.dataDir ?? (options.keyPath ? dirname(options.keyPath) : resolveDataDir());
  const keyPath = options.keyPath ?? join(dataDir, "keys.json");
  const context =
    options.context ??
    createAgentContext({
      keyStore: createKeyStore({ keyPath }),
      relay,
      dataDir,
    });

  const server = new McpServer({
    name: "agentpair",
    version: "0.0.0",
  });

  server.registerTool(
    "pair_init",
    {
      title: "Initialize pairing",
      description:
        "Start pairing with scope and bond mode; returns a human-shareable code. Initiator completion runs automatically in the background.",
      inputSchema: {
        scope: z.array(z.string()).describe("Capability scope for the bond"),
        mode: z
          .enum(["ephemeral_until_session_closes", "bonded_contact"])
          .describe("Bond lifetime mode"),
      },
    },
    async (input) => handlePairInit(context, input),
  );

  server.registerTool(
    "pair_join",
    {
      title: "Join pairing",
      description: "Look up a pairing code and queue human approval before SPAKE2 completes.",
      inputSchema: {
        code: z.string().describe("Out-of-band pairing code"),
      },
    },
    async (input) => handlePairJoin(context, input),
  );

  server.registerTool(
    "pair_init_complete",
    {
      title: "Complete initiator pairing",
      description:
        "Retry initiator-side SPAKE2 completion after pair_init. Normally automatic; use only if pairing stalled.",
      inputSchema: {
        code: z.string().describe("Pairing code from pair_init"),
      },
    },
    async (input) => handlePairInitCompleteTool(context, input),
  );

  server.registerTool(
    "inbox",
    {
      title: "Pull inbox",
      description:
        "Pull signed envelopes from the relay using challenge-response auth. On artifact_fetch_failed in rejected[], retry with since = cursor - 1.",
      inputSchema: {
        since: z
          .number()
          .optional()
          .describe("Relay rowid cursor; defaults to last persisted cursor"),
        include_history: z
          .boolean()
          .optional()
          .describe("When true, return envelopes from all senders (debug); default false"),
      },
    },
    async (input) => handleInbox(context, input),
  );

  server.registerTool(
    "send",
    {
      title: "Send message",
      description: "Send a core.msg envelope to a bonded peer.",
      inputSchema: {
        to: z.string().describe("Recipient agent id"),
        body: z.string().describe("Message body"),
        kind: z.string().optional().describe("Optional message kind label"),
        thread: z.string().optional(),
        seq: z.number().optional(),
        ttl: z.number().optional(),
      },
    },
    async (input) => handleSend(context, input),
  );

  server.registerTool(
    "close",
    {
      title: "Close thread",
      description: "Send core.close to stop messaging on a thread (unilateral).",
      inputSchema: {
        thread: z.string(),
        to: z.string().optional().describe("Peer agent id; inferred from session when omitted"),
        reason: z.string().optional(),
      },
    },
    async (input) => handleClose(context, input),
  );

  server.registerTool(
    "revoke",
    {
      title: "Revoke bond",
      description: "Remove a peer from the local allowlist and push to relay.",
      inputSchema: {
        peer: z.string().describe("Peer agent id to revoke"),
      },
    },
    async (input) => handleRevoke(context, input),
  );

  server.registerTool(
    "list_bonds",
    {
      title: "List bonded peers",
      description:
        "List all currently bonded peers for this agent's context, for debugging allowlist state after MCP restarts.",
      inputSchema: {},
    },
    async () => handleListBonds(context),
  );

  server.registerTool(
    "human_approve",
    {
      title: "Human approval gate",
      description:
        "Approve or reject a pending human-gated action. Requires via_human=true after user confirmation in chat.",
      inputSchema: {
        pending_id: z.string(),
        decision: z.string().describe('Use "approve" or "reject:<reason>"'),
        via_human: z.boolean().optional().describe("Must be true when the human confirmed in chat"),
      },
    },
    async (input) => handleHumanApprove(context, input),
  );

  server.registerTool(
    "session_open",
    {
      title: "Open session",
      description:
        "Open a negotiation session with goal, acceptance criteria, budget, and mandate.",
      inputSchema: {
        to: z.string().describe("Recipient agent id"),
        goal: z.string(),
        acceptance: z.array(
          z.object({
            id: z.string(),
            test: z.enum(["executable", "judgment"]),
            desc: z.string(),
            runner: z.string().optional(),
          }),
        ),
        budget: z.object({
          max_turns: z.number(),
          deadline: z.string().optional(),
        }),
        mandate: z.object({
          agent_may: z.array(z.string()),
          human_required: z.array(z.string()),
          escalate_on: z.array(z.string()).optional(),
        }),
      },
    },
    async (input) => handleSessionOpen(context, input),
  );

  server.registerTool(
    "session_msg",
    {
      title: "Session message",
      description:
        "Send a session negotiation message (propose, counter, accept, challenge, test_report).",
      inputSchema: {
        thread: z.string(),
        type: z.string(),
        body: z.string(),
      },
    },
    async (input) => handleSessionMsg(context, input),
  );

  server.registerTool(
    "session_sign",
    {
      title: "Sign session artifact",
      description: "Sign an artifact hash when executable tests are green and challenges filed.",
      inputSchema: {
        thread: z.string(),
        artifact_hash: z.string(),
      },
    },
    async (input) => handleSessionSign(context, input),
  );

  server.registerTool(
    "session_status",
    {
      title: "Session status",
      description: "Get current session state and negotiation progress.",
      inputSchema: {
        thread: z.string(),
      },
    },
    async (input) => handleSessionStatus(context, input),
  );

  return { server, context };
}

export { createAgentContext, HttpRelayClient, createKeyStore, createPendingQueue };
