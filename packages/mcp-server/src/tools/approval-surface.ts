import { approvalFilePath } from "../store/approval-code.js";
import { ApprovalChannelError } from "../store/pending.js";
import type { AgentContext } from "./pair.js";

export const APPROVAL_CHANNEL_UNAVAILABLE_HINT =
  "Fix dataDir disk permissions or free space, then retry the gated action.";

export const PENDING_APPROVAL_SUGGESTED_NEXT =
  "Read the approval code from approval_path (host filesystem only); then call human_approve with pending_id, decision, and approval_code.";

export function approvalPathForPending(ctx: AgentContext, pendingId: string): string | undefined {
  if (!ctx.dataDir) {
    return undefined;
  }
  return approvalFilePath(ctx.dataDir, pendingId);
}

export function withPendingApprovalSurface<T extends Record<string, unknown>>(
  ctx: AgentContext,
  result: T,
): T & { approval_path?: string; suggested_next?: string } {
  if (typeof result.pending_id !== "string") {
    return result;
  }
  const approval_path = approvalPathForPending(ctx, result.pending_id);
  if (!approval_path) {
    return result;
  }
  return {
    ...result,
    approval_path,
    suggested_next: PENDING_APPROVAL_SUGGESTED_NEXT,
  };
}

export function approvalChannelUnavailableResult(extra: Record<string, unknown> = {}): {
  ok: false;
  error: "approval_channel_unavailable";
  suggested_next: string;
} {
  return {
    ok: false,
    error: "approval_channel_unavailable",
    suggested_next: APPROVAL_CHANNEL_UNAVAILABLE_HINT,
    ...extra,
  };
}

export function isApprovalChannelError(error: unknown): error is ApprovalChannelError {
  return error instanceof ApprovalChannelError && error.code === "approval_channel_unavailable";
}
