import { ed25519 } from "@noble/curves/ed25519.js";

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

export function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  return ed25519.verify(signature, message, publicKey);
}
