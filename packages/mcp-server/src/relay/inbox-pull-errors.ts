export interface InboxPullHttpStatusMapping {
  error: string;
  retryable: boolean;
}

const INBOX_PULL_5XX = /^inbox_pull_failed_5\d\d$/;

export function mapInboxPullHttpStatus(status: number): InboxPullHttpStatusMapping {
  if (status === 429) {
    return { error: "inbox_pull_failed_429", retryable: true };
  }
  if (status >= 500 && status <= 599) {
    return { error: `inbox_pull_failed_${status}`, retryable: true };
  }
  return { error: "unexpected_challenge_status", retryable: false };
}

export function isTransientInboxPullError(error: string): boolean {
  if (error === "relay_unavailable" || error === "inbox_pull_failed_429") {
    return true;
  }
  return INBOX_PULL_5XX.test(error);
}

export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (header == null) {
    return undefined;
  }
  const seconds = Number.parseInt(header, 10);
  if (!Number.isFinite(seconds) || Number.isNaN(seconds)) {
    return undefined;
  }
  return seconds * 1000;
}
