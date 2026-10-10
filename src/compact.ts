import type { Turn } from "./messages.ts";

const SECRET_PATTERNS: RegExp[] = [
  /<private>[\s\S]*?<\/private>/gi,
  /\bsk-or-v1-[A-Za-z0-9]{20,}\b/g,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsbp_[A-Za-z0-9]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/g,
  /\b(api[_-]?key|secret|password|token)\s*[:=]\s*["']?([A-Za-z0-9._-]{12,})["']?/gi,
];

/** Redact likely secrets before anything leaves the machine for Graphiti. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, key) => (typeof key === "string" && key ? `${key}=[REDACTED]` : "[REDACTED]"));
  }
  return out;
}

/** Drop code, inline code and system-ish noise; collapse whitespace. */
export function stripNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/^\s*\[(system|reminder|instruction|note)\][^\n]*$/gim, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export interface CompactOptions {
  maxChars?: number;
  perTurnMax?: number;
}

export interface CompactResult {
  body: string;
  chars: number;
  firstTs?: string;
}

/** Build one compact, information-dense episode body from turns. */
export function buildEpisode(turns: Turn[], opts: CompactOptions = {}): CompactResult {
  const maxChars = opts.maxChars ?? 18000;
  const perTurnMax = opts.perTurnMax ?? 1500;
  const lines: string[] = [];
  let chars = 0;
  for (const t of turns) {
    let text = stripNoise(redact(t.text));
    if (!text) continue;
    if (text.length > perTurnMax) text = text.slice(0, perTurnMax) + " …";
    const line = `${t.role === "user" ? "User" : "Assistant"}: ${text}`;
    if (chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return { body: lines.join("\n"), chars, firstTs: turns[0]?.ts };
}
