import { resolveConfig } from "./config.ts";
import { GraphitiClient } from "./graphiti.ts";
import { Outbox } from "./outbox.ts";
import { Worker } from "./worker.ts";
import { toTurns } from "./messages.ts";
import { buildEpisode } from "./compact.ts";
import { deterministicUuid, isoNow, sha16, withTimeout } from "./util.ts";
import { buildMemoryBlock, extractFactTexts, extractNodeTexts, latestUserKey, latestUserText } from "./recall.ts";
import { fileLog } from "./log.ts";

/**
 * OpenCode V2 plugin: lightweight background memory extractor into an existing
 * Graphiti MCP server. Capture-only by default (no prompt injection), batched on
 * session idle, with a durable outbox and deterministic episode IDs.
 *
 * Lifecycle note: OpenCode loads the plugin once per project/location, and each
 * instance receives the whole server event stream. Without a process-wide guard
 * every instance would subscribe and process the same event N times. We therefore
 * subscribe exactly once per process and always work from the latest setup's deps.
 */

interface Deps {
  ctx: any;
  cfg: any;
  log: (msg: string, meta?: any) => void;
  client: GraphitiClient;
  outbox: Outbox;
  worker: Worker;
  flushTimers: Map<string, any>;
  recallCache: Map<string, RecallEntry>;
  runRecall: (messages: unknown) => Promise<string | null>;
  capture: (sessionId: string) => Promise<void>;
  schedule: (sessionId: string) => void;
}

interface RecallEntry {
  /** Latest user-message key this entry was searched for (mode "turn"). */
  key?: string;
  /** null = searched but empty; undefined = not searched yet. */
  block?: string | null;
}

interface Registry {
  deps?: Deps;
  controller?: AbortController;
  subscribed: boolean;
}

// Survives plugin reloads within the same server process.
const REGISTRY_KEY = "__graphitiExtractorV2";
function registry(): Registry {
  const g = globalThis as any;
  return (g[REGISTRY_KEY] ??= { subscribed: false } as Registry);
}

const RELEVANT = new Set([
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.text.ended",
  "session.compacted",
  "session.renamed",
  "session.deleted",
]);
const TRIGGERS = new Set(["session.idle", "session.execution.succeeded", "session.text.ended", "session.compacted"]);

function buildDeps(ctx: any, cfg: any, log: Deps["log"]): Deps {
  const client = new GraphitiClient(cfg.graphitiUrl);
  const outbox = new Outbox(ctx.storage);
  const worker = new Worker({
    client,
    outbox,
    log,
    groupId: cfg.groupId,
    maxPerMin: cfg.maxEpisodesPerMin,
    maxAttempts: cfg.maxAttempts,
    updateCommunities: cfg.updateCommunities,
    extractionInstructions: cfg.extractionInstructions,
  });
  const flushTimers = new Map<string, any>();
  const recallCache = new Map<string, RecallEntry>();

  /**
   * Search Graphiti for a compact recall block. Never throws and never blocks
   * for longer than cfg.recallTimeoutMs, so an unavailable server cannot stall
   * a model call.
   */
  async function runRecall(messages: unknown): Promise<string | null> {
    const query =
      latestUserText(messages) ||
      (cfg.recall === "start" ? "user profile preferences projects decisions" : undefined);
    if (!query) return null;
    const budget = { maxFacts: cfg.recallMaxFacts, maxChars: cfg.recallMaxChars };
    const [facts, nodes] = await Promise.allSettled([
      withTimeout(client.searchFacts(query, [cfg.groupId], cfg.recallMaxFacts), cfg.recallTimeoutMs),
      withTimeout(client.searchNodes(query, [cfg.groupId], cfg.recallMaxFacts), cfg.recallTimeoutMs),
    ]);
    const factTexts = facts.status === "fulfilled" ? extractFactTexts(facts.value) : [];
    const nodeTexts = nodes.status === "fulfilled" ? extractNodeTexts(nodes.value) : [];
    return buildMemoryBlock(factTexts, nodeTexts, budget) ?? null;
  }

  const cursorKey = (sid: string) => `cursor:${sid}`;
  const seqKey = (sid: string) => `seq:${sid}`;
  // Saga scope: one saga per session (default) or one shared saga per project.
  const sagaName = (sid: string) => (cfg.sagaScope === "project" ? `project:${cfg.projectId}` : `session:${sid}`);
  const sagaPrevKey = (sid: string) => `saga-prev:${sagaName(sid)}`;

  async function capture(sessionId: string): Promise<void> {
    try {
      const messages = await ctx.session.context({ sessionID: sessionId });
      const turns = toTurns(messages);
      if (!turns.length) { log("capture skip: no turns", { sessionId }); return; }

      const cursor = await ctx.storage.get(cursorKey(sessionId));
      let fresh = turns;
      if (typeof cursor === "string") {
        const idx = turns.findIndex((t) => t.id === cursor);
        fresh = idx >= 0 ? turns.slice(idx + 1) : turns.slice(-20);
      }
      if (fresh.length < cfg.minTurns) { log("capture skip: minTurns", { sessionId, fresh: fresh.length }); return; }

      const { body, chars, firstTs } = buildEpisode(fresh, { maxChars: cfg.maxChars });
      if (chars < cfg.minChars) { log("capture skip: minChars", { sessionId, chars }); return; }

      const seq = (Number(await ctx.storage.get(seqKey(sessionId))) || 0) + 1;
      // Identity is derived from the session, not the loading instance, so the
      // same episode resolves to the same id regardless of which project/plugin
      // instance captured it.
      const uuid = deterministicUuid(`oc:${cfg.groupId}:${sessionId}:${seq}`);
      const saga = sagaName(sessionId);
      const sagaPrevious = await ctx.storage.get(sagaPrevKey(sessionId));

      await outbox.put({
        uuid,
        groupId: cfg.groupId,
        sessionId,
        seq,
        name: `opencode ${sessionId} #${seq}`,
        body,
        referenceTime: firstTs ?? isoNow(),
        saga,
        sagaPrevious: typeof sagaPrevious === "string" ? sagaPrevious : undefined,
        state: "pending",
        attempts: 0,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      });

      const lastId = fresh[fresh.length - 1]?.id;
      if (typeof lastId === "string") await ctx.storage.set(cursorKey(sessionId), lastId);
      await ctx.storage.set(seqKey(sessionId), seq);
      await ctx.storage.set(sagaPrevKey(sessionId), uuid);
      log("queued", { sessionId, uuid, chars });
      void worker.drain();
    } catch (e) {
      log("capture failed", { sessionId, error: String(e).slice(0, 200) });
    }
  }

  function schedule(sessionId: string): void {
    const prev = flushTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    flushTimers.set(
      sessionId,
      setTimeout(() => {
        flushTimers.delete(sessionId);
        void capture(sessionId);
      }, cfg.debounceMs),
    );
  }

  return { ctx, cfg, log, client, outbox, worker, flushTimers, recallCache, runRecall, capture, schedule };
}

function handleEvent(event: any): void {
  const deps = registry().deps;
  if (!deps) return;
  const type = event?.type ?? "";
  if (!RELEVANT.has(type)) return;
  const data: any = event?.data ?? {};
  const sid = data?.sessionID ?? data?.session_id ?? data?.session?.id ?? data?.id ?? event?.sessionID;
  deps.log("event", { type, dataKeys: Object.keys(data).join(","), data: JSON.stringify(data).slice(0, 200), sid: typeof sid === "string" ? sid : undefined });
  if (TRIGGERS.has(type) && typeof sid === "string") deps.schedule(sid);
  if (type === "session.deleted" && typeof sid === "string") {
    deps.recallCache.delete(sid);
    const removals = [
      deps.ctx.storage.remove(`cursor:${sid}`),
      deps.ctx.storage.remove(`seq:${sid}`),
    ];
    // Only the per-session saga chain is session-scoped; a project saga must
    // survive an individual session deletion to keep its ordering intact.
    if (deps.cfg.sagaScope !== "project") {
      removals.push(deps.ctx.storage.remove(`saga-prev:session:${sid}`));
    }
    void Promise.allSettled(removals);
  }
}

/**
 * Start the single process-wide subscriber. Abort races each `next()` so the
 * loop stops promptly even if the underlying stream ignores the signal.
 */
function startSubscriber(ctx: any): AbortController {
  const reg = registry();
  const controller = new AbortController();
  reg.controller = controller;
  reg.subscribed = true;

  const iterate = async () => {
    const iterator = (ctx.event.subscribe({ signal: controller.signal }) as AsyncIterable<any>)[Symbol.asyncIterator]();
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    try {
      while (!controller.signal.aborted) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (next.done) break;
        handleEvent(next.value);
      }
    } catch {
      /* aborted or stream ended */
    } finally {
      const r = registry();
      if (r.controller === controller) {
        r.subscribed = false;
        r.controller = undefined;
      }
    }
  };
  void iterate();
  return controller;
}

export default {
  id: "graphiti-extractor",
  async setup(ctx: any) {
    const projectId = ctx?.location?.project?.id || sha16(String(ctx?.location?.directory ?? "default"));
    const cfg = resolveConfig(ctx?.options ?? {}, process.env ?? {}, projectId);
    const log = (msg: string, meta?: any) => fileLog(`[graphiti-extractor] ${msg}${meta ? " " + JSON.stringify(meta) : ""}`);
    log("setup", { projectId, group: cfg.groupId, url: cfg.graphitiUrl, debounceMs: cfg.debounceMs, minTurns: cfg.minTurns, sagaScope: cfg.sagaScope, updateCommunities: cfg.updateCommunities, organizeEveryHours: cfg.organizeEveryHours, recall: cfg.recall });

    if (!cfg.enabled) return;

    const deps = buildDeps(ctx, cfg, log);
    const reg = registry();
    // Always point the single subscriber at the freshest config/context.
    reg.deps = deps;

    // --- Manual memory tool (registered per instance so every location has it) ---
    try {
      await ctx.tool.transform((editor: any) => {
        editor.add({
          name: "memory",
          description: "Long-term memory (Graphiti). Search/add facts, inspect status, redrive the queue, rebuild clusters (organize), summarize a saga, or show stats.",
          input: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["search", "add", "status", "redrive", "organize", "saga", "stats"] },
              query: { type: "string" },
              content: { type: "string" },
              saga: { type: "string" },
            },
            required: ["mode"],
            additionalProperties: false,
          },
          options: { codemode: true },
          async execute(input: any) {
            // IMPORTANT: in Code Mode the tool body is serialized and runs without
            // the setup() closure. Resolve dependencies from the process-wide
            // registry instead of captured lexicals (outbox/client/worker/cfg).
            const d = registry().deps;
            if (!d) return { content: "memory tool error: extractor not initialized" };
            const { outbox, worker, client, cfg } = d;
            try {
              if (input.mode === "status") {
                const counts = await outbox.counts();
                return { content: JSON.stringify({ group: cfg.groupId, url: cfg.graphitiUrl, sagaScope: cfg.sagaScope, outbox: counts }) };
              }
              if (input.mode === "stats") {
                const counts = await outbox.counts();
                let episodes = 0;
                try {
                  const res = await client.getEpisodes([cfg.groupId], 200);
                  episodes = (res?.episodes ?? []).length;
                } catch { /* ignore */ }
                return { content: JSON.stringify({ group: cfg.groupId, episodes, sagaScope: cfg.sagaScope, updateCommunities: cfg.updateCommunities, outbox: counts }) };
              }
              if (input.mode === "organize") {
                const r = await worker.organize();
                return { content: JSON.stringify(r).slice(0, 2000) };
              }
              if (input.mode === "saga") {
                const name = String(input.saga ?? input.query ?? "").trim();
                if (!name) return { content: "mode=saga requires 'saga' (or 'query') with the saga name" };
                const r = await client.summarizeSaga(name, cfg.groupId);
                return { content: JSON.stringify(r).slice(0, 4000) };
              }
              if (input.mode === "redrive") {
                await worker.verify();
                const items = await outbox.list();
                const cutoff = Date.now() - 10 * 60 * 1000;
                let n = 0;
                for (const it of items) {
                  const age = Date.parse(it.updatedAt || it.createdAt || "1970-01-01T00:00:00Z");
                  const stale = !Number.isFinite(age) || age < cutoff;
                  if (it.state === "dead" || (it.state === "submitted" && stale)) {
                    it.state = "pending";
                    it.attempts = 0;
                    await outbox.put(it);
                    n += 1;
                  }
                }
                void worker.drain();
                return { content: `requeued ${n} item(s)` };
              }
              if (input.mode === "search") {
                const facts = await client.searchFacts(String(input.query ?? ""), [cfg.groupId], 10);
                const nodes = await client.searchNodes(String(input.query ?? ""), [cfg.groupId], 10);
                return { content: JSON.stringify({ facts, nodes }).slice(0, 4000) };
              }
              if (input.mode === "add") {
                const extra: Record<string, any> = {};
                if (cfg.extractionInstructions) extra.custom_extraction_instructions = cfg.extractionInstructions;
                await client.addMemory({
                  name: `manual ${Date.now()}`,
                  episode_body: String(input.content ?? ""),
                  group_id: cfg.groupId,
                  source: "text",
                  source_description: "manual memory tool",
                  reference_time: new Date().toISOString(),
                  ...extra,
                });
                return { content: "queued for processing" };
              }
              return { content: "unknown mode" };
            } catch (e) {
              return { content: `memory tool error: ${String(e).slice(0, 300)}` };
            }
          },
        });
      });
    } catch (e) {
      log("tool registration failed", { error: String(e).slice(0, 200) });
    }

    // --- Opt-in recall: inject a small, budgeted memory block before model calls ---
    // Off by default ("off") so the normal loop keeps zero added tokens/latency.
    // Search runs against Graphiti with a hard timeout; failures are swallowed.
    let recallRegistration: any;
    if (cfg.recall !== "off") {
      try {
        recallRegistration = await ctx.session.hook("context", async (event: any) => {
          try {
            const sid = event?.sessionID ?? event?.session?.id ?? event?.session_id;
            if (typeof sid !== "string" || !sid || !Array.isArray(event?.system)) return;
            const messages = event?.messages;
            const entry = deps.recallCache.get(sid) ?? {};
            if (cfg.recall === "turn") {
              const key = latestUserKey(messages);
              if (key && key !== entry.key) {
                entry.key = key;
                entry.block = await deps.runRecall(messages);
                deps.recallCache.set(sid, entry);
              }
            } else if (entry.block === undefined) {
              entry.block = await deps.runRecall(messages);
              deps.recallCache.set(sid, entry);
            }
            if (typeof entry.block === "string" && entry.block) {
              event.system.push({ type: "text", text: entry.block });
            }
          } catch (e) {
            log("recall failed", { error: String(e).slice(0, 200) });
          }
        });
        log("recall hook registered", { mode: cfg.recall, maxFacts: cfg.recallMaxFacts, maxChars: cfg.recallMaxChars });
      } catch (e) {
        log("recall hook registration failed", { error: String(e).slice(0, 200) });
      }
    }

    // --- Subscribe exactly once per process (see lifecycle note above) ---
    let ownsSubscription = false;
    let controller: AbortController | undefined;
    if (!reg.subscribed) {
      ownsSubscription = true;
      controller = startSubscriber(ctx);
      log("subscriber started", { projectId });
    } else {
      log("setup: subscriber already running, reused", { projectId });
    }

    // Startup: flush any durable leftovers from a previous run.
    void deps.worker.drain();

    // Periodic cluster rebuild — this is what makes memory "self-organize".
    // 0 disables it (default for standalone use; the kit enables it via env).
    let organizeTimer: any;
    if (Number.isFinite(cfg.organizeEveryHours) && cfg.organizeEveryHours > 0) {
      organizeTimer = setInterval(() => { void deps.worker.organize(); }, cfg.organizeEveryHours * 3600_000);
      if (organizeTimer?.unref) organizeTimer.unref();
      log("organize scheduled", { hours: cfg.organizeEveryHours });
    }

    return () => {
      // Stop this instance's worker and timers.
      deps.worker.stop();
      if (organizeTimer) clearInterval(organizeTimer);
      if (recallRegistration?.dispose) void recallRegistration.dispose();
      for (const t of deps.flushTimers.values()) clearTimeout(t);
      // Only the setup that owns the subscription may tear it down; on reload
      // OpenCode unloads before the next setup, which then re-subscribes.
      const r = registry();
      if (ownsSubscription && r.controller === controller) {
        try { controller?.abort(); } catch { /* ignore */ }
        r.controller = undefined;
        r.subscribed = false;
      }
    };
  },
};
