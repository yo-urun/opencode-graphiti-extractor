/**
 * Recall (memory injection into the model context) mode.
 * - "off"   — capture only, zero added tokens/latency (default).
 * - "start" — search once when a session begins and reuse the block.
 * - "turn"  — refresh the search on every new user message.
 */
export type RecallMode = "off" | "start" | "turn";

export interface ExtractorConfig {
  enabled: boolean;
  graphitiUrl: string;
  groupId: string;
  projectId: string;
  debounceMs: number;
  minTurns: number;
  minChars: number;
  maxChars: number;
  maxEpisodesPerMin: number;
  maxAttempts: number;
  /** Opt-in long-term recall. "off" preserves the no-injection default. */
  recall: RecallMode;
  recallMaxFacts: number;
  recallMaxChars: number;
  recallTimeoutMs: number;
  /**
   * Ask Graphiti to incrementally refresh community summaries when an episode is
   * ingested (`update_communities`). Off by default because it adds latency/cost
   * to every ingest.
   */
  updateCommunities: boolean;
  /**
   * Extra natural-language guidance passed to the extractor model for every
   * episode (`custom_extraction_instructions`) — used to keep entity/edge naming
   * canonical so the graph stays tidy and clusters cleanly.
   */
  extractionInstructions: string;
  /**
   * How often the background "organize" task rebuilds community clusters
   * (`build_communities`). 0 disables it. Set to e.g. 24 for a daily rebuild.
   */
  organizeEveryHours: number;
  /**
   * Saga scope for bi-temporal ordering: "session" (default) keeps one saga per
   * OpenCode session, "project" links every session of a project into one saga.
   */
  sagaScope: "session" | "project";
}

type AnyRecord = Record<string, any>;

const truthy = (v: unknown): boolean => v === true || v === "true" || v === "1" || v === 1;

function parseRecall(v: unknown): RecallMode {
  return v === "start" || v === "turn" ? v : "off";
}

export function resolveConfig(options: AnyRecord = {}, env: AnyRecord = {}, projectId = "default"): ExtractorConfig {
  const o = options ?? {};
  return {
    enabled: o.enabled !== false,
    graphitiUrl: o.graphitiUrl || env.GRAPHITI_URL || "http://localhost:8000/mcp?codemode=false",
    groupId: o.groupId || env.GRAPHITI_GROUP_ID || "opencode",
    projectId: o.projectId || projectId,
    debounceMs: Number(o.debounceMs ?? 90000),
    minTurns: Number(o.minTurns ?? 3),
    minChars: Number(o.minChars ?? 400),
    maxChars: Number(o.maxChars ?? 18000),
    maxEpisodesPerMin: Number(o.maxEpisodesPerMin ?? 6),
    maxAttempts: Number(o.maxAttempts ?? 8),
    recall: parseRecall(o.recall ?? env.GRAPHITI_RECALL),
    recallMaxFacts: Number(o.recallMaxFacts ?? env.GRAPHITI_RECALL_MAX_FACTS ?? 5),
    recallMaxChars: Number(o.recallMaxChars ?? env.GRAPHITI_RECALL_MAX_CHARS ?? 1200),
    recallTimeoutMs: Number(o.recallTimeoutMs ?? env.GRAPHITI_RECALL_TIMEOUT_MS ?? 800),
    updateCommunities: truthy(o.updateCommunities) || truthy(env.GRAPHITI_UPDATE_COMMUNITIES),
    extractionInstructions: String(o.extractionInstructions || env.GRAPHITI_EXTRACTION_INSTRUCTIONS || "").trim(),
    organizeEveryHours: Number(o.organizeEveryHours ?? env.GRAPHITI_ORGANIZE_EVERY_HOURS ?? 0),
    sagaScope: o.sagaScope === "project" || env.GRAPHITI_SAGA_SCOPE === "project" ? "project" : "session",
  };
}
