function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function deriveContentType(plaintext: Uint8Array): string {
  const text = decodeUtf8Strict(plaintext);
  if (text === null) {
    return "application/octet-stream";
  }
  try {
    JSON.parse(text);
    return "application/json";
  } catch {
    return "application/octet-stream";
  }
}

export function deriveSummary(plaintext: Uint8Array): string {
  const text = decodeUtf8Strict(plaintext);
  if (text === null) {
    return "";
  }
  return [...text].slice(0, 240).join("");
}
