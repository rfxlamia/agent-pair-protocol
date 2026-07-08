import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type PakeRole = "initiator" | "joiner";

export interface PakeSessionHandle {
  finish(peerMessage: Uint8Array): Uint8Array;
  outboundMessage(): Uint8Array;
  free(): void;
}

type WasmPakeSession = {
  outboundMessage(): Uint8Array;
  finish(peerMessage: Uint8Array): Uint8Array;
  free(): void;
};

type WasmPakeSessionClass = {
  startInitiator(pairingCode: string, sessionId: string): WasmPakeSession;
  startJoiner(pairingCode: string, sessionId: string): WasmPakeSession;
};

const require = createRequire(import.meta.url);
const moduleDir = dirname(fileURLToPath(import.meta.url));

function resolveWasmPkgDir(): string {
  const candidates = [join(moduleDir, "../wasm/pkg"), join(moduleDir, "../../wasm/pkg")];
  for (const dir of candidates) {
    if (existsSync(join(dir, "spake2_pake.js"))) {
      return dir;
    }
  }
  const fallback = candidates[1];
  if (!fallback) {
    throw new Error("SPAKE2 WASM package directory not found");
  }
  return fallback;
}

const wasmPkgDir = resolveWasmPkgDir();

let PakeSessionClass: WasmPakeSessionClass | null = null;

function wrapSession(session: WasmPakeSession): PakeSessionHandle {
  return {
    outboundMessage(): Uint8Array {
      return session.outboundMessage();
    },
    finish(peerMessage: Uint8Array): Uint8Array {
      return session.finish(peerMessage);
    },
    free(): void {
      session.free();
    },
  };
}

export async function init(): Promise<void> {
  if (PakeSessionClass) {
    return;
  }

  const wasm = require(join(wasmPkgDir, "spake2_pake.js")) as {
    PakeSession: WasmPakeSessionClass;
  };
  PakeSessionClass = wasm.PakeSession;
}

function getPakeSessionClass(): WasmPakeSessionClass {
  if (!PakeSessionClass) {
    throw new Error("PAKE WASM not initialized; call init() first");
  }
  return PakeSessionClass;
}

export function start(
  role: PakeRole,
  pairingCode: string,
  sessionId: string,
): { session: PakeSessionHandle; message: Uint8Array } {
  const PakeSession = getPakeSessionClass();
  const session =
    role === "initiator"
      ? PakeSession.startInitiator(pairingCode, sessionId)
      : PakeSession.startJoiner(pairingCode, sessionId);
  const message = session.outboundMessage();
  return { session: wrapSession(session), message };
}

export function respond(
  pairingCode: string,
  sessionId: string,
  _initiatorMessage: Uint8Array,
): { session: PakeSessionHandle; message: Uint8Array } {
  return start("joiner", pairingCode, sessionId);
}

export function finish(session: PakeSessionHandle, peerMessage: Uint8Array): Uint8Array {
  return session.finish(peerMessage);
}
