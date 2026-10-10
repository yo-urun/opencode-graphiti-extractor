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
 * The plugin intentionally has no runtime dependencies and uses the V2 plugin
 * context (events, session context, storage, tools).
 */
export default {
  id: "graphiti-extractor",
  async setup(ctx: any) {
    const projectId = ctx?.location?.project?.id || sha16(String(ctx?.location?.directory ?? "default"));
    const cfg = resolveConfig(ctx?.options ?? {}, process.env ?? {}, projectId);
    const log = (msg: string, meta?: any) => fileLog(`[graphiti-extractor] ${msg}${meta ? " " + JSON.stringify(meta) : ""}`);
    log("setup", { projectId, group: cfg.groupId, url: cfg.graphitiUrl, debounceMs: cfg.debounceMs, minTurns: cfg.minTurns });

    if (!cfg.enabled) return;

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
        const uuid = deterministicUuid(`oc:${cfg.projectId}:${sessionId}:${seq}`);
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

    // --- Register a manual memory tool (search / add) ---
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

    // --- Subscribe to server events ---
    const controller = new AbortController();
    const RELEVANT = new Set([
      "session.idle",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.text.ended",
      "session.renamed",
      "session.deleted",
    ]);
    const TRIGGERS = new Set(["session.idle", "session.execution.succeeded", "session.text.ended"]);
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = event?.type ?? "";
          if (!RELEVANT.has(type)) continue;
          const data: any = (event as any)?.data ?? {};
          const sid = data?.sessionID ?? data?.session_id ?? data?.session?.id ?? data?.id ?? (event as any)?.sessionID;
          log("event", { type, dataKeys: Object.keys(data).join(","), data: JSON.stringify(data).slice(0, 300), sid: typeof sid === "string" ? sid : undefined });
          if (TRIGGERS.has(type) && typeof sid === "string") schedule(sid);
          if (type === "session.deleted" && typeof sid === "string") {
            await ctx.storage.remove(cursorKey(sid)).catch(() => {});
            await ctx.storage.remove(seqKey(sid)).catch(() => {});
            await ctx.storage.remove(sagaKey(sid)).catch(() => {});
          }
        }
      } catch {
        /* stream ended or aborted */
      }
    })();

    // Startup: flush any durable leftovers from a previous run.
    void worker.drain();

    return () => {
      controller.abort();
      worker.stop();
      for (const t of flushTimers.values()) clearTimeout(t);
    };
  },
};
