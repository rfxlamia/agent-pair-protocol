import { createJsonPersistentStore, resolveDataDir, storePath } from "./persistent-store.js";

interface EnvelopeSeqFile {
  v: 1;
  streams: Record<string, number>;
}

const EMPTY_ENVELOPE_SEQ_FILE: EnvelopeSeqFile = { v: 1, streams: {} };

export interface EnvelopeSeqStore {
  init(forAgentId: string): Promise<void>;
  getLastAccepted(thread: string, from: string): number;
  commitAccepted(thread: string, from: string, seq: number): void;
  flush(): Promise<void>;
  filePath?: string;
}

export function streamKey(thread: string, from: string): string {
  return `${thread}\0${from}`;
}

function validateEnvelopeSeqFile(parsed: unknown): EnvelopeSeqFile | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as EnvelopeSeqFile;
  if (record.v !== 1 || typeof record.streams !== "object" || record.streams === null) {
    return undefined;
  }
  for (const value of Object.values(record.streams)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return undefined;
    }
  }
  return { v: 1, streams: { ...record.streams } };
}

export function resolveEnvelopeSeqPath(dataDir?: string): string {
  return storePath(resolveDataDir(dataDir), "envelope-seq.json");
}

export class MemoryEnvelopeSeqStore implements EnvelopeSeqStore {
  private agentId: string | undefined;
  private streams: Record<string, number> = {};

  async init(forAgentId: string): Promise<void> {
    this.agentId = forAgentId;
  }

  getLastAccepted(thread: string, from: string): number {
    if (!this.agentId) {
      return 0;
    }
    return this.streams[streamKey(thread, from)] ?? 0;
  }

  commitAccepted(thread: string, from: string, seq: number): void {
    if (!this.agentId) {
      return;
    }
    if (!Number.isFinite(seq) || seq < 0) {
      return;
    }
    this.streams[streamKey(thread, from)] = seq;
  }

  async flush(): Promise<void> {
    // no-op
  }
}

export function createFileEnvelopeSeqStore(
  options: { filePath?: string; dataDir?: string; agentId?: string } = {},
): EnvelopeSeqStore & { filePath: string } {
  const filePath = options.filePath ?? resolveEnvelopeSeqPath(options.dataDir);
  let agentId = options.agentId;
  let streams: Record<string, number> = {};
  const backing = createJsonPersistentStore({
    filePath,
    defaultData: structuredClone(EMPTY_ENVELOPE_SEQ_FILE),
    validate: validateEnvelopeSeqFile,
  });

  return {
    filePath,
    async init(forAgentId: string): Promise<void> {
      agentId = forAgentId;
      streams = { ...backing.read().streams };
    },
    getLastAccepted(thread: string, from: string): number {
      if (!agentId) {
        return 0;
      }
      return streams[streamKey(thread, from)] ?? 0;
    },
    commitAccepted(thread: string, from: string, seq: number): void {
      if (!agentId) {
        return;
      }
      if (!Number.isFinite(seq) || seq < 0) {
        return;
      }
      streams = { ...streams, [streamKey(thread, from)]: seq };
      backing.replace({ v: 1, streams: { ...streams } });
    },
    flush: () => backing.flush(),
  };
}
