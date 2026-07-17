import { readFileSync } from "node:fs";
import { approvalFilePath } from "../store/approval-code.js";

export function readApprovalCode(dataDir: string, pendingId: string): string {
  const raw = readFileSync(approvalFilePath(dataDir, pendingId), "utf8");
  const match = raw.match(/\b(\d{6})\b/);
  if (!match) {
    throw new Error(`no approval code found for pending ${pendingId} in ${dataDir}`);
  }
  return match[1];
}
