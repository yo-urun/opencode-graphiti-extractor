import type { GraphitiClient } from "./graphiti.ts";
import type { Outbox, OutboxItem } from "./outbox.ts";

export interface WorkerDeps {
  client: GraphitiClient;
  outbox: Outbox;
  log: (msg: string, meta?: any) => void;
  maxPerMin?: number;
  maxAttempts?: number;
}

/**
 * Single paced worker per instance: submits pending episodes with a token bucket
 * (the Graphiti server serializes per group anyway), then opportunistically
 * verifies submitted ones against recent episodes.
 */
export class Worker {
  private deps: WorkerDeps;
  private running = false;
  private stopped = false;
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
      uuid: item.uuid,
      reference_time: item.referenceTime,
      saga: item.saga,
    };
    if (item.sagaPrevious) args.saga_previous_episode_uuid = item.sagaPrevious;
    try {
      await this.deps.client.addMemory(args);
      item.state = "submitted";
      item.lastError = undefined;
      this.deps.log("submitted", { uuid: item.uuid, chars: item.body.length });
    } catch (e) {
      item.attempts += 1;
      item.lastError = String(e).slice(0, 300);
      if (item.attempts >= (this.deps.maxAttempts ?? 8)) item.state = "dead";
      this.deps.log("submit failed", { uuid: item.uuid, attempts: item.attempts, error: item.lastError });
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
        const known = new Set<string>(((res?.episodes ?? []) as any[]).map((e) => e.uuid));
        for (const it of items) {
          if (known.has(it.uuid)) {
            it.state = "verified";
            await this.deps.outbox.put(it);
            this.deps.log("verified", { uuid: it.uuid });
          }
        }
      } catch (e) {
        this.deps.log("verify failed", { groupId, error: String(e).slice(0, 200) });
      }
    }
  }
}
