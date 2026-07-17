import { createHmac, hkdfSync, randomInt, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const APPROVAL_FILE_MODE = 0o600;
const APPROVAL_DIR_MODE = 0o700;
const APPROVAL_HKDF_INFO = "agentpair-approval-v1";

export interface FormatApprovalFileBodyInput {
  code: string;
  kind: string;
  peer?: string;
  thread?: string;
  createdAt: string | number | Date;
}

export interface WriteApprovalFileInput extends FormatApprovalFileBodyInput {
  dataDir: string;
  pendingId: string;
}

export function approvalFilePath(dataDir: string, pendingId: string): string {
  return join(dataDir, "approvals", pendingId);
}

export function generateApprovalCode(): string {
  const value = randomInt(0, 1_000_000);
  return String(value).padStart(6, "0");
}

export function deriveApprovalMacKey(secretKey: Uint8Array): Buffer {
  return hkdfSync("sha256", secretKey, Buffer.alloc(0), APPROVAL_HKDF_INFO, 32);
}

export function hmacApprovalCode(key: Buffer, code: string): Buffer {
  return createHmac("sha256", key).update(code, "utf8").digest();
}

export function codesEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function normalizeApprovalCode(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  const stripped = raw.replace(/\s/g, "");
  if (stripped.length === 0) {
    return null;
  }
  return stripped;
}

export function isWellFormedApprovalCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

function formatCreatedAt(createdAt: string | number | Date): string {
  if (createdAt instanceof Date) {
    return createdAt.toISOString();
  }
  if (typeof createdAt === "number") {
    return new Date(createdAt).toISOString();
  }
  return createdAt;
}

function formatApprovingLine(kind: string, peer?: string, thread?: string): string {
  const parts: string[] = [`Approving: ${kind}`];
  const details: string[] = [];
  if (peer) {
    details.push(`peer ${peer}`);
  }
  if (thread) {
    details.push(`thread ${thread}`);
  }
  if (details.length > 0) {
    parts.push(`— ${details.join(" , ")}`);
  }
  return parts.join(" ");
}

export function formatApprovalFileBody(input: FormatApprovalFileBodyInput): string {
  const lines = [
    `AgentPair approval code: ${input.code}`,
    "",
    formatApprovingLine(input.kind, input.peer, input.thread),
    `Created:   ${formatCreatedAt(input.createdAt)}`,
    "",
    "Share this code ONLY if you expect and intend to approve this request.",
    "If you did not initiate this, do not share the code with anyone or anything.",
    "",
  ];
  return lines.join("\n");
}

export function writeApprovalFileSync(input: WriteApprovalFileInput): string {
  const filePath = approvalFilePath(input.dataDir, input.pendingId);
  const approvalsDir = join(input.dataDir, "approvals");
  mkdirSync(approvalsDir, { recursive: true, mode: APPROVAL_DIR_MODE });
  const body = formatApprovalFileBody(input);
  writeFileSync(filePath, body, { encoding: "utf8", mode: APPROVAL_FILE_MODE });
  chmodSync(filePath, APPROVAL_FILE_MODE);
  return filePath;
}

export function deleteApprovalFileSync(dataDir: string, pendingId: string): void {
  const filePath = approvalFilePath(dataDir, pendingId);
  try {
    unlinkSync(filePath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }
}
