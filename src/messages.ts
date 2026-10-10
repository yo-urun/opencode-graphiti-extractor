export interface Turn {
  role: "user" | "assistant";
  text: string;
  ts?: string;
  id?: string;
}

/**
 * Convert OpenCode session messages into linear turns.
 * Tolerant of message shape; ignores synthetic parts (injected memory / system)
 * to prevent the feedback loop where recalled memory is re-ingested.
 */
export function toTurns(messages: unknown): Turn[] {
  const out: Turn[] = [];
  if (!Array.isArray(messages)) return out;
  for (const raw of messages) {
    const m = raw as Record<string, any>;
    const info = (m?.info ?? m) as Record<string, any>;
    const role = info?.role;
    if (role !== "user" && role !== "assistant") continue;
    const parts = (m?.parts ?? info?.parts ?? []) as any[];
    let text = "";
    for (const p of Array.isArray(parts) ? parts : []) {
      if (p?.type === "text" && typeof p.text === "string" && !p.synthetic) {
        text += (text ? "\n" : "") + p.text;
      }
    }
    if (!text.trim()) continue;
    const created = info?.time?.created ?? info?.time?.completed;
    out.push({
      role,
      text,
      ts: typeof created === "number" ? new Date(created).toISOString() : undefined,
      id: typeof info?.id === "string" ? info.id : undefined,
    });
  }
  return out;
}
