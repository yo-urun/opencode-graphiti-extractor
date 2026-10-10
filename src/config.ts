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
}

type AnyRecord = Record<string, any>;

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
  };
}
