/** Rejects padding, non-alphabet, non-canonical, and empty input per SPEC §3. */
export function decodeBase64UrlStrict(value: string): Uint8Array {
  if (value.length === 0) {
    throw new Error("Invalid base64url encoding");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url encoding");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) {
    throw new Error("Non-canonical base64url encoding");
  }
  return new Uint8Array(bytes);
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
