import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approvalFilePath,
  codesEqual,
  deleteApprovalFileSync,
  deriveApprovalMacKey,
  formatApprovalFileBody,
  generateApprovalCode,
  hmacApprovalCode,
  isWellFormedApprovalCode,
  normalizeApprovalCode,
  writeApprovalFileSync,
} from "./approval-code.js";

describe("approval-code", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
    vi.restoreAllMocks();
  });

  function tempDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "agentpair-approval-"));
    tempDirs.push(dir);
    return dir;
  }

  const secretKey = new Uint8Array(32).fill(0xab);

  describe("normalizeApprovalCode", () => {
    it("strips surrounding whitespace", () => {
      expect(normalizeApprovalCode(" 012345 ")).toBe("012345");
    });

    it("returns null for empty or whitespace-only input", () => {
      expect(normalizeApprovalCode("")).toBeNull();
      expect(normalizeApprovalCode("   ")).toBeNull();
      expect(normalizeApprovalCode(undefined)).toBeNull();
    });
  });

  describe("isWellFormedApprovalCode", () => {
    it("accepts exactly six digits", () => {
      expect(isWellFormedApprovalCode("012345")).toBe(true);
      expect(isWellFormedApprovalCode("483920")).toBe(true);
    });

    it("rejects malformed codes", () => {
      expect(isWellFormedApprovalCode("12345")).toBe(false);
      expect(isWellFormedApprovalCode("1234567")).toBe(false);
      expect(isWellFormedApprovalCode("12a456")).toBe(false);
    });
  });

  describe("deriveApprovalMacKey + hmacApprovalCode + codesEqual", () => {
    it("verifies leading-zero code after normalize", () => {
      const macKey = deriveApprovalMacKey(secretKey);
      const normalized = normalizeApprovalCode(" 012345 ");
      expect(normalized).toBe("012345");
      if (normalized === null) {
        throw new Error("expected normalized code");
      }
      const verifier = hmacApprovalCode(macKey, normalized);
      const candidate = hmacApprovalCode(macKey, "012345");
      expect(codesEqual(verifier, candidate)).toBe(true);
    });

    it("rejects wrong code", () => {
      const macKey = deriveApprovalMacKey(secretKey);
      const verifier = hmacApprovalCode(macKey, "012345");
      const wrong = hmacApprovalCode(macKey, "999999");
      expect(codesEqual(verifier, wrong)).toBe(false);
    });

    it("returns false for unequal-length digests", () => {
      const a = Buffer.alloc(32, 1);
      const b = Buffer.alloc(16, 1);
      expect(codesEqual(a, b)).toBe(false);
    });
  });

  describe("generateApprovalCode", () => {
    it("zero-pads to six digits via unbiased randomInt", () => {
      const source = readFileSync(new URL("./approval-code.ts", import.meta.url), "utf8");
      expect(source).toContain("randomInt(0, 1_000_000)");
      expect(source).toContain('.padStart(6, "0")');
      for (let i = 0; i < 50; i++) {
        expect(generateApprovalCode()).toMatch(/^\d{6}$/);
      }
    });

    it("MUST NOT use randomBytes modulo 1_000_000", () => {
      const source = readFileSync(new URL("./approval-code.ts", import.meta.url), "utf8");
      expect(source).not.toMatch(/randomBytes[\s\S]*%\s*1[_]?000[_]?000/);
      expect(source).not.toMatch(/%\s*1[_]?000[_]?000/);
    });
  });

  describe("formatApprovalFileBody", () => {
    it("includes labeled code and approval context", () => {
      const body = formatApprovalFileBody({
        code: "483920",
        kind: "session_open",
        peer: "agent ab3f…",
        thread: "9c21…",
        createdAt: "2026-07-16T09:14:00.000Z",
      });
      expect(body).toContain("AgentPair approval code: 483920");
      expect(body).toContain("Approving: session_open");
      expect(body).toContain("peer agent ab3f…");
      expect(body).toContain("thread 9c21…");
      expect(body).toContain("Created:");
      expect(body).toContain("Share this code ONLY");
    });
  });

  describe("approvalFilePath", () => {
    it("places files under dataDir/approvals/<pending_id>", () => {
      expect(approvalFilePath("/data", "pend-1")).toBe(join("/data", "approvals", "pend-1"));
    });
  });

  describe("writeApprovalFileSync", () => {
    it("writes a 0600 file with labeled code and context", () => {
      const dataDir = tempDataDir();
      const pendingId = "pending-abc";
      const path = writeApprovalFileSync({
        dataDir,
        pendingId,
        code: "483920",
        kind: "session_open",
        peer: "agent ab3f…",
        thread: "9c21…",
        createdAt: "2026-07-16T09:14:00.000Z",
      });

      expect(path).toBe(approvalFilePath(dataDir, pendingId));
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
      const body = readFileSync(path, "utf8");
      expect(body).toContain("AgentPair approval code: 483920");
      expect(body).toContain("Approving: session_open");
    });
  });

  describe("deleteApprovalFileSync", () => {
    it("does not throw when the file is missing", () => {
      const dataDir = tempDataDir();
      expect(() => deleteApprovalFileSync(dataDir, "missing-id")).not.toThrow();
    });

    it("removes an existing approval file", async () => {
      const dataDir = tempDataDir();
      const pendingId = "to-delete";
      writeApprovalFileSync({
        dataDir,
        pendingId,
        code: "111111",
        kind: "pair_join",
        createdAt: "2026-07-16T09:14:00.000Z",
      });
      deleteApprovalFileSync(dataDir, pendingId);
      await expect(readFile(approvalFilePath(dataDir, pendingId), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
