CREATE TABLE IF NOT EXISTS cards (
  agent_id TEXT PRIMARY KEY,
  card_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS allowlists (
  agent_id TEXT PRIMARY KEY,
  allowed_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pair_sessions (
  session_id TEXT PRIMARY KEY,
  message_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  recipient_agent_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  sender_agent_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  msg_type TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_expires_at
  ON inbox (expires_at);

CREATE INDEX IF NOT EXISTS idx_inbox_recipient_time
  ON inbox (recipient_agent_id, received_at);

CREATE INDEX IF NOT EXISTS idx_inbox_thread_seq
  ON inbox (recipient_agent_id, thread_id, seq);

CREATE TABLE IF NOT EXISTS artifacts (
  hash TEXT PRIMARY KEY,
  blob BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
  nonce TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
