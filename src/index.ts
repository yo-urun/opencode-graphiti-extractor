import { resolveConfig } from "./config.ts";
import { GraphitiClient } from "./graphiti.ts";
import { Outbox } from "./outbox.ts";
import { Worker } from "./worker.ts";
import { toTurns } from "./messages.ts";
import { buildEpisode } from "./compact.ts";
import { deterministicUuid, isoNow, sha16 } from "./util.ts";
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
  capture: (sessionId: string) => Promise<void>;
  schedule: (sessionId: string) => void;
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
  "session.renamed",
  "session.deleted",
]);
const TRIGGERS = new Set(["session.idle", "session.execution.succeeded", "session.text.ended"]);

function buildDeps(ctx: any, cfg: any, log: Deps["log"]): Deps {
  const client = new GraphitiClient(cfg.graphitiUrl);
  const outbox = new Outbox(ctx.storage);
  const worker = new Worker({ client, outbox, log, maxPerMin: cfg.maxEpisodesPerMin, maxAttempts: cfg.maxAttempts });
  const flushTimers = new Map<string, any>();

  const cursorKey = (sid: string) => `cursor:${sid}`;
  const seqKey = (sid: string) => `seq:${sid}`;
  const sagaKey = (sid: string) => `saga:${sid}`;

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
      const saga = `session:${sessionId}`;
      const sagaPrevious = await ctx.storage.get(sagaKey(sessionId));

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
      await ctx.storage.set(sagaKey(sessionId), uuid);
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

  return { ctx, cfg, log, client, outbox, worker, flushTimers, capture, schedule };
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
    void Promise.allSettled([
      deps.ctx.storage.remove(`cursor:${sid}`),
      deps.ctx.storage.remove(`seq:${sid}`),
      deps.ctx.storage.remove(`saga:${sid}`),
    ]);
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
    log("setup", { projectId, group: cfg.groupId, url: cfg.graphitiUrl, debounceMs: cfg.debounceMs, minTurns: cfg.minTurns });

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
          description: "Long-term memory (Graphiti). Search past facts or store a durable note. Use it when the user asks to recall or remember something.",
          input: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["search", "add", "status", "redrive"] },
              query: { type: "string" },
              content: { type: "string" },
            },
            required: ["mode"],
            additionalProperties: false,
          },
          options: { codemode: true },
          async execute(input: any) {
            try {
              if (input.mode === "status") {
                const counts = await outbox.counts();
                return { content: JSON.stringify({ group: cfg.groupId, url: cfg.graphitiUrl, outbox: counts }) };
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
                await client.addMemory({
                  name: `manual ${Date.now()}`,
                  episode_body: String(input.content ?? ""),
                  group_id: cfg.groupId,
                  source: "text",
                  source_description: "manual memory tool",
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

    return () => {
      // Stop this instance's worker and timers.
      deps.worker.stop();
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
