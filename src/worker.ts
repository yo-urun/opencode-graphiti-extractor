import type { GraphitiClient } from "./graphiti.ts";
import type { Outbox, OutboxItem } from "./outbox.ts";

export interface WorkerDeps {
  client: GraphitiClient;
  outbox: Outbox;
  log: (msg: string, meta?: any) => void;
  groupId: string;
  maxPerMin?: number;
  maxAttempts?: number;
  updateCommunities?: boolean;
  extractionInstructions?: string;
}

/**
 * Single paced worker per instance: submits pending episodes with a token bucket
 * (the Graphiti server serializes per group anyway), then opportunistically
 * verifies submitted ones against recent episodes.
 *
 * Besides the ingest path it also owns the "organize" maintenance task that
 * rebuilds community (cluster) summaries over the group.
 */
export class Worker {
  private deps: WorkerDeps;
  private running = false;
  private stopped = false;
  private organizing = false;
  private stamps: number[] = [];

  constructor(deps: WorkerDeps) {
    this.deps = deps;
  }

  stop(): void {
    this.stopped = true;
  }

  private allow(): boolean {
    const max = this.deps.maxPerMin ?? 6;
    const now = Date.now();
    this.stamps = this.stamps.filter((t) => now - t < 60_000);
    return this.stamps.length < max;
  }

  async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const pending = (await this.deps.outbox.byState("pending")).sort((a, b) => a.seq - b.seq);
      for (const item of pending) {
        if (this.stopped || !this.allow()) break;
        await this.submit(item);
        this.stamps.push(Date.now());
      }
      await this.verify();
    } catch (e) {
      this.deps.log("drain failed", { error: String(e).slice(0, 200) });
    } finally {
      this.running = false;
    }
  }

  private async submit(item: OutboxItem): Promise<void> {
    const args: Record<string, any> = {
      name: item.name,
      episode_body: item.body,
      group_id: item.groupId,
      source: "message",
      source_description: "opencode session",
      reference_time: item.referenceTime,
    };
    // Bi-temporal ordering: keep episodes inside the same saga linked in order so
    // Graphiti can summarize the evolving narrative (summarize_saga).
    if (item.saga) args.saga = item.saga;
    if (item.sagaPrevious) args.saga_previous_episode_uuid = item.sagaPrevious;
    // Incremental clustering: let Graphiti fold the new episode into communities.
    if (this.deps.updateCommunities) args.update_communities = true;
    // Steer extraction so entity/edge naming stays canonical (tidier clusters).
    if (this.deps.extractionInstructions) {
      args.custom_extraction_instructions = this.deps.extractionInstructions;
    }
    try {
      await this.deps.client.addMemory(args);
      item.state = "submitted";
      item.lastError = undefined;
      this.deps.log("submitted", { name: item.name, chars: item.body.length, saga: item.saga });
    } catch (e) {
      item.attempts += 1;
      item.lastError = String(e).slice(0, 300);
      if (item.attempts >= (this.deps.maxAttempts ?? 8)) item.state = "dead";
      this.deps.log("submit failed", { name: item.name, attempts: item.attempts, error: item.lastError });
    }
    await this.deps.outbox.put(item);
  }

  async verify(): Promise<void> {
    const submitted = await this.deps.outbox.byState("submitted");
    if (!submitted.length) return;
    const groups = new Map<string, OutboxItem[]>();
    for (const it of submitted) {
      const arr = groups.get(it.groupId) ?? [];
      arr.push(it);
      groups.set(it.groupId, arr);
    }
    for (const [groupId, items] of groups) {
      try {
        const res = await this.deps.client.getEpisodes([groupId], 100);
        const known = new Set<string>(
          ((res?.episodes ?? []) as any[]).map((e) => e.name).filter((n) => typeof n === "string"),
        );
        for (const it of items) {
          if (known.has(it.name)) {
            it.state = "verified";
            await this.deps.outbox.put(it);
            this.deps.log("verified", { name: it.name });
          }
        }
      } catch (e) {
        this.deps.log("verify failed", { groupId, error: String(e).slice(0, 200) });
      }
    }
  }

  /**
   * Maintenance: rebuild community (cluster) summaries for the group. Expensive
   * on the Graphiti side (full-graph pass + LLM summary per community), so it is
   * guarded against concurrent runs and scheduled by the caller.
   */
  async organize(): Promise<any> {
    if (this.stopped || this.organizing) return { skipped: true };
    this.organizing = true;
    const started = Date.now();
    try {
      const res = await this.deps.client.buildCommunities([this.deps.groupId]);
      const count = res?.community_count ?? res?.result?.community_count ?? "?";
      const edges = res?.edge_count ?? res?.result?.edge_count ?? "?";
      this.deps.log("organized", { group: this.deps.groupId, community_count: count, edge_count: edges, ms: Date.now() - started });
      return res;
    } catch (e) {
      this.deps.log("organize failed", { group: this.deps.groupId, error: String(e).slice(0, 200) });
      return { error: String(e).slice(0, 200) };
    } finally {
      this.organizing = false;
    }
  }
}
