import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep plugin logging out of the user's real log; must be set before importing
// the module because log.ts resolves its path at load time.
process.env.OPENCODE_CONFIG_DIR = join(tmpdir(), `graphiti-extractor-test-${process.pid}`);

const { default: plugin } = await import("../src/index.ts");

const REGISTRY_KEY = "__graphitiExtractorV2";

function makeCtx() {
  const calls = { subscribe: 0, toolAdds: 0 };
  const store = new Map<string, any>();
  const storage = {
    async get(k: string) {
      return store.get(k);
    },
    async set(k: string, v: any) {
      store.set(k, v);
    },
    async remove(k: string) {
      store.delete(k);
    },
    async scan({ prefix }: { prefix: string }) {
      return {
        entries: [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      };
    },
  };
  const ctx: any = {
    location: { project: { id: "test-project" }, directory: "/tmp/test-project" },
    options: {},
    storage,
    tool: {
      async transform(cb: any) {
        cb({ add() { calls.toolAdds++; } });
        return { dispose: async () => {} };
      },
    },
    // An event stream that stays open and never yields.
    event: {
      subscribe() {
        calls.subscribe++;
        return {
          [Symbol.asyncIterator]() {
            return { next: () => new Promise(() => {}) };
          },
        };
      },
    },
    session: { async context() { return []; } },
  };
  return { ctx, calls };
}

test("subscribes exactly once per process across instances and reloads", async () => {
  delete (globalThis as any)[REGISTRY_KEY];

  // Several plugin instances (one per project/location) load in the same process.
  const a = makeCtx();
  const b = makeCtx();
  const c = makeCtx();
  const cleanupA = await plugin.setup(a.ctx);
  const cleanupB = await plugin.setup(b.ctx);
  const cleanupC = await plugin.setup(c.ctx);

  assert.equal(a.calls.subscribe, 1, "first instance subscribes");
  assert.equal(b.calls.subscribe, 0, "second instance reuses the subscriber");
  assert.equal(c.calls.subscribe, 0, "third instance reuses the subscriber");

  // Simulate a reload: the owner is torn down, then a fresh setup runs.
  await cleanupA?.();
  const d = makeCtx();
  await plugin.setup(d.ctx);
  assert.equal(d.calls.subscribe, 1, "re-subscribes after the owner is torn down");

  // A non-owner cleanup must not tear down the active subscriber.
  await cleanupB?.();
  await cleanupC?.();
  const e = makeCtx();
  await plugin.setup(e.ctx);
  assert.equal(e.calls.subscribe, 0, "still subscribed after a non-owner cleanup");

  delete (globalThis as any)[REGISTRY_KEY];
});

test("uuid identity is independent of the loading instance", async () => {
  // Two instances in the same group must derive the same id for the same
  // session/seq, otherwise the same episode could be written twice.
  delete (globalThis as any)[REGISTRY_KEY];
  const { deterministicUuid } = await import("../src/util.ts");
  assert.equal(
    deterministicUuid("oc:opencode:ses_abc:3"),
    deterministicUuid("oc:opencode:ses_abc:3"),
  );
  assert.notEqual(
    deterministicUuid("oc:opencode:ses_abc:3"),
    deterministicUuid("oc:opencode:ses_abc:4"),
  );
});
