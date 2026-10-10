import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker.ts";
import { Outbox } from "../src/outbox.ts";
import type { KV, OutboxItem } from "../src/outbox.ts";

class MemKV implements KV {
  m = new Map<string, any>();
  async get(key: string) {
    return this.m.get(key);
  }
  async set(key: string, value: any) {
    this.m.set(key, value);
  }
  async remove(key: string) {
    this.m.delete(key);
  }
  async scan({ prefix }: { prefix: string }) {
    return {
      entries: [...this.m.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    };
  }
}

function pending(uuid: string, seq: number, extra: Partial<OutboxItem> = {}): OutboxItem {
  return {
    uuid,
    groupId: "g",
    sessionId: "s",
    seq,
    name: `n${seq}`,
    body: "b",
    referenceTime: "2026-01-01T00:00:00.000Z",
    saga: "session:s",
    sagaPrevious: seq > 1 ? `uuid-${seq - 1}` : undefined,
    state: "pending",
    attempts: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

test("worker forwards saga, update_communities and extraction instructions on submit", async () => {
  const calls: any[] = [];
  const client: any = {
    async addMemory(args: any) {
      calls.push(args);
      return { message: "queued" };
    },
    async getEpisodes() {
      return { episodes: [{ name: "n2" }] };
    },
    async buildCommunities() {
      return { community_count: 3, edge_count: 10 };
    },
  };
  const outbox = new Outbox(new MemKV());
  await outbox.put(pending("uuid-1", 1));
  await outbox.put(pending("uuid-2", 2));

  const logs: string[] = [];
  const worker = new Worker({
    client,
    outbox,
    log: (m) => logs.push(m),
    groupId: "g",
    updateCommunities: true,
    extractionInstructions: "Use canonical names.",
    maxPerMin: 100,
  });

  await worker.drain();

  assert.equal(calls.length, 2);
  assert.equal(calls[0].saga, "session:s");
  assert.equal(calls[0].saga_previous_episode_uuid, undefined, "first episode has no predecessor");
  assert.equal(calls[1].saga_previous_episode_uuid, "uuid-1", "second episode links to the first");
  assert.equal(calls[0].update_communities, true);
  assert.equal(calls[0].custom_extraction_instructions, "Use canonical names.");

  // The verified state should be reached because getEpisodes reports n2.
  assert.equal((await outbox.byState("verified")).length, 1);
});

test("worker organize() rebuilds communities for its group", async () => {
  const groups: string[][] = [];
  const client: any = {
    async addMemory() {
      return {};
    },
    async getEpisodes() {
      return { episodes: [] };
    },
    async buildCommunities(ids: string[]) {
      groups.push(ids);
      return { community_count: 5, edge_count: 42 };
    },
  };
  const worker = new Worker({ client, outbox: new Outbox(new MemKV()), log: () => {}, groupId: "opencode" });
  const res = await worker.organize();
  assert.deepEqual(groups, [["opencode"]]);
  assert.equal(res.community_count, 5);
});
