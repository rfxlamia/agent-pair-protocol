import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentContext } from "./tools/pair.js";
import { createAgentContext } from "./tools/pair.js";
import { handleInbox, handleSend } from "./tools/inbox.js";
import { handleHumanApprove } from "./tools/human-approve.js";
import {
  handlePairInit,
  handlePairJoin,
  handleRevoke,
} from "./tools/pair.js";
import { createKeyStore } from "./store/keys.js";
import { createPendingQueue } from "./store/pending.js";
import { HttpRelayClient, resolveRelayUrl } from "./relay/client.js";

export interface CreateMcpServerOptions {
  context?: AgentContext;
  relayUrl?: string;
  keyPath?: string;
}

export function createMcpServer(options: CreateMcpServerOptions = {}): {
  server: McpServer;
  context: AgentContext;
} {
  const relay = new HttpRelayClient(options.relayUrl ?? resolveRelayUrl());
  const context =
    options.context ??
    createAgentContext({
      keyStore: createKeyStore({ keyPath: options.keyPath }),
      relay,
      pending: createPendingQueue(),
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
        "Start pairing with scope and bond mode; returns a human-shareable code.",
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
      description:
        "Look up a pairing code and queue human approval before SPAKE2 completes.",
      inputSchema: {
        code: z.string().describe("Out-of-band pairing code"),
      },
    },
    async (input) => handlePairJoin(context, input),
  );

  server.registerTool(
    "inbox",
    {
      title: "Pull inbox",
      description: "Pull signed envelopes from the relay using challenge-response auth.",
      inputSchema: {
        since: z
          .number()
          .optional()
          .describe("Sequence cursor; defaults to 0"),
      },
    },
    async (input) => handleInbox(context, input),
  );

  server.registerTool(
    "send",
    {
      title: "Send envelope",
      description: "Send a signed encrypted envelope to a bonded peer.",
      inputSchema: {
        to: z.string().describe("Recipient agent id"),
        type: z.string().describe("Envelope type"),
        payload: z.string().describe("UTF-8 payload"),
        thread: z.string().optional(),
        seq: z.number().optional(),
        ttl: z.number().optional(),
      },
    },
    async (input) => handleSend(context, input),
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
    "human_approve",
    {
      title: "Human approval gate",
      description:
        "Approve or reject a pending human-gated action. Requires via_human=true after user confirmation in chat.",
      inputSchema: {
        pending_id: z.string(),
        decision: z
          .string()
          .describe('Use "approve" or "reject:<reason>"'),
        via_human: z
          .boolean()
          .optional()
          .describe("Must be true when the human confirmed in chat"),
      },
    },
    async (input) => handleHumanApprove(context, input),
  );

  return { server, context };
}

export { createAgentContext, HttpRelayClient, createKeyStore, createPendingQueue };
