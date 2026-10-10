import { test } from "node:test";
import assert from "node:assert/strict";
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
  async scan({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) {
    const keys = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
    let start = 0;
    if (after) {
      const i = keys.indexOf(after);
      start = i >= 0 ? i + 1 : 0;
    }
    const pageKeys = keys.slice(start, start + limit);
    const entries = pageKeys.map((k) => ({ key: k, value: this.m.get(k) }));
    const next = start + limit < keys.length ? pageKeys[pageKeys.length - 1] : undefined;
    return { entries, next };
  }
}

function item(uuid: string, seq: number): OutboxItem {
  return {
    uuid,
    groupId: "g",
    sessionId: "s",
    seq,
    name: "n",
    body: "b",
    referenceTime: "2026-01-01T00:00:00.000Z",
    saga: "session:s",
    state: "pending",
    attempts: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("outbox put/list/get/remove and state filtering", async () => {
  const ob = new Outbox(new MemKV());
  await ob.put(item("u1", 1));
  await ob.put(item("u2", 2));
  assert.equal((await ob.list()).length, 2);
  assert.equal((await ob.byState("pending")).length, 2);

  const u1 = await ob.get("u1");
  assert.equal(u1?.seq, 1);
  if (u1) {
    u1.state = "verified";
    await ob.put(u1);
  }
  assert.equal((await ob.byState("pending")).length, 1);
  assert.equal((await ob.byState("verified")).length, 1);

  await ob.remove("u2");
  assert.equal((await ob.list()).length, 1);
});
