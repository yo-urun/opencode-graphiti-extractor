import { redact } from "./compact.ts";
import { toTurns } from "./messages.ts";

/**
 * Pure helpers for the opt-in recall layer: turn Graphiti search results into a
 * small, redacted, budgeted context block that is injected before the model call.
 * No I/O here so it is cheap to unit-test.
 */

export interface RecallBudget {
  maxFacts: number;
  maxChars: number;
}

/** Best-effort extraction of fact strings from a `search_memory_facts` result. */
export function extractFactTexts(result: any): string[] {
  const raw = unwrap(result)?.facts;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const f of raw) {
    const text =
      typeof f === "string"
        ? f
        : typeof f?.fact === "string"
          ? f.fact
          : typeof f?.name === "string"
            ? f.name
            : undefined;
    if (typeof text === "string" && text.trim()) out.push(text.trim());
  }
  return out;
}

/** Best-effort extraction of entity names from a `search_nodes` result. */
export function extractNodeTexts(result: any): string[] {
  const raw = unwrap(result)?.nodes;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const n of raw) {
    const name = typeof n === "string" ? n : typeof n?.name === "string" ? n.name : undefined;
    if (typeof name === "string" && name.trim()) out.push(name.trim());
  }
  return out;
}

function unwrap(result: any): any {
  return result && typeof result === "object" && "result" in result ? result.result : result;
}

/**
 * Build the injected `<graphiti-memory>` block, or `undefined` when there is
 * nothing worth injecting. Deduplicates, redacts secrets, and respects the fact
 * and character budgets.
 */
export function buildMemoryBlock(facts: string[], nodes: string[], budget: RecallBudget): string | undefined {
  const seen = new Set<string>();
  const wanted: string[] = [];
  const push = (s: string) => {
    const line = redact(s).replace(/\s+/g, " ").trim();
    const key = line.toLowerCase();
    if (!line || seen.has(key)) return;
    seen.add(key);
    wanted.push(line);
  };
  // Facts first (they carry the relation), then entity names for orientation.
  for (const f of facts) {
    if (wanted.length >= budget.maxFacts) break;
    push(f);
  }
  for (const n of nodes) {
    if (wanted.length >= budget.maxFacts) break;
    push(n);
  }
  if (!wanted.length) return undefined;

  const header = [
    '<graphiti-memory source="graphiti">',
    "Advisory long-term memory. The current conversation always wins; verify before relying on it.",
  ];
  const footer = "</graphiti-memory>";
  const lines: string[] = [...header];
  let chars = header.join("\n").length + footer.length + 2;
  for (const item of wanted) {
    const line = `- ${item}`;
    if (chars + line.length + 1 > budget.maxChars) break;
    lines.push(line);
    chars += line.length + 1;
  }
  if (lines.length === header.length) return undefined;
  lines.push(footer);
  return lines.join("\n");
}

/** Text of the most recent user turn, used as the recall search query. */
export function latestUserText(messages: unknown, maxChars = 400): string | undefined {
  const turns = toTurns(messages);
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role !== "user") continue;
    const text = t.text.replace(/\s+/g, " ").trim();
    if (!text) return undefined;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }
  return undefined;
}

/** Id (or fallback text) of the most recent user turn, to detect a new message. */
export function latestUserKey(messages: unknown): string | undefined {
  const turns = toTurns(messages);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role !== "user") continue;
    return turns[i].id ?? turns[i].text.slice(0, 64);
  }
  return undefined;
}
