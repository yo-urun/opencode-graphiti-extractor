import { createHash } from "node:crypto";

/** Deterministic UUID (v5-like) from an arbitrary key. Stable across restarts. */
export function deterministicUuid(key: string): string {
  const h = createHash("sha1").update(key, "utf8").digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function sha16(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex").slice(0, 16);
}

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function isoNow(): string {
  return new Date().toISOString();
}
