export interface Turn {
  role: "user" | "assistant";
  text: string;
  ts?: string;
  id?: string;
}

/**
 * Convert OpenCode session messages into linear turns.
 * Supports both the V2 shape (`{ type, content: [{type:'text',text}] }`) and the
 * legacy shape (`{ info:{role}, parts:[...] }`). Only plain text parts are kept;
 * reasoning/tool parts and synthetic injected parts are ignored.
 */
export function toTurns(messages: unknown): Turn[] {
  const out: Turn[] = [];
  if (!Array.isArray(messages)) return out;
  for (const raw of messages) {
    const m = raw as Record<string, any>;
    const info = (m?.info ?? m) as Record<string, any>;
    const role = info?.role ?? m?.type;
    if (role !== "user" && role !== "assistant") continue;
    const parts = (m?.content ?? m?.parts ?? info?.parts ?? []) as any[];
    let text = "";
    for (const p of Array.isArray(parts) ? parts : []) {
      if (p?.type === "text" && typeof p.text === "string" && !p.synthetic) {
        text += (text ? "\n" : "") + p.text;
      }
    }
    if (!text.trim()) continue;
    const created = info?.time?.created ?? m?.time?.created ?? m?.time?.completed;
    const id = typeof info?.id === "string" ? info.id : typeof m?.id === "string" ? m.id : undefined;
    out.push({
      role,
      text,
      ts: typeof created === "number" ? new Date(created).toISOString() : undefined,
      id,
    });
  }
  return out;
}
