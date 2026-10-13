import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMemoryBlock, extractFactTexts, extractNodeTexts, latestUserKey, latestUserText } from "../src/recall.ts";
import { withTimeout } from "../src/util.ts";
import { resolveConfig } from "../src/config.ts";

test("extractFactTexts handles wrapped results, .fact/.name and strings", () => {
  assert.deepEqual(extractFactTexts({ facts: [{ fact: "A works on B" }, { name: "C" }, "raw"] }), [
    "A works on B",
    "C",
    "raw",
  ]);
  // MCP tool results are sometimes wrapped in { result: ... }.
  assert.deepEqual(extractFactTexts({ result: { facts: [{ fact: "X" }] } }), ["X"]);
  assert.deepEqual(extractFactTexts({}), []);
});

test("extractNodeTexts handles names and drops empties", () => {
  assert.deepEqual(extractNodeTexts({ nodes: [{ name: "Anna" }, { name: "  " }, {}] }), ["Anna"]);
  assert.deepEqual(extractNodeTexts({ result: { nodes: [{ name: "my-project" }] } }), ["my-project"]);
});

test("buildMemoryBlock dedupes, redacts, caps and returns undefined when empty", () => {
  assert.equal(buildMemoryBlock([], [], { maxFacts: 5, maxChars: 1200 }), undefined);

  const block = buildMemoryBlock(
    ["Anna работает над my-project", "  anna работает над my-project  ", "token: sk-abcdefghijklmnopqrstuvwx"],
    ["my-project"],
    { maxFacts: 10, maxChars: 2000 },
  );
  assert.ok(block);
  assert.match(block!, /^<graphiti-memory/);
  assert.match(block!, /<\/graphiti-memory>$/);
  // duplicate collapsed
  assert.equal((block!.match(/Anna работает над my-project/g) ?? []).length, 1);
  // secret redacted
  assert.doesNotMatch(block!, /sk-abcdefghijklmnopqrstuvwx/);
  assert.match(block!, /REDACTED/);
});

test("buildMemoryBlock respects the fact budget and char budget", () => {
  const facts = Array.from({ length: 20 }, (_, i) => `fact number ${i}`);
  const capped = buildMemoryBlock(facts, [], { maxFacts: 3, maxChars: 4000 });
  assert.equal((capped!.match(/- fact number/g) ?? []).length, 3);

  const tiny = buildMemoryBlock(facts, [], { maxFacts: 20, maxChars: 160 });
  assert.ok(tiny === undefined || tiny.length <= 200, "char budget keeps the block small");
});

test("buildMemoryBlock returns undefined when only the char budget is exhausted", () => {
  const block = buildMemoryBlock(["a long fact that will not fit at all"], [], { maxFacts: 5, maxChars: 60 });
  assert.equal(block, undefined);
});

test("latestUserText/latestUserKey pick the last user turn (V2 shape)", () => {
  const messages = [
    { id: "u1", type: "user", content: [{ type: "text", text: "first question" }] },
    { id: "a1", type: "assistant", content: [{ type: "text", text: "answer" }] },
    { id: "u2", type: "user", content: [{ type: "text", text: "second   question" }] },
  ];
  assert.equal(latestUserText(messages), "second question");
  assert.equal(latestUserKey(messages), "u2");
  assert.equal(latestUserText([]), undefined);
  assert.equal(latestUserKey([{ id: "a", type: "assistant", content: [{ type: "text", text: "hi" }] }]), undefined);
});

test("withTimeout resolves fast work and rejects on timeout", async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 50), 42);
  await assert.rejects(() => withTimeout(new Promise(() => {}), 10), /timeout/);
});

test("resolveConfig parses recall options (default off, env override)", () => {
  const off = resolveConfig({}, {}, "p");
  assert.equal(off.recall, "off");
  assert.equal(off.recallMaxFacts, 5);
  assert.equal(off.recallMaxChars, 1200);
  assert.equal(off.recallTimeoutMs, 800);

  const env = resolveConfig({}, { GRAPHITI_RECALL: "start", GRAPHITI_RECALL_MAX_FACTS: "3" }, "p");
  assert.equal(env.recall, "start");
  assert.equal(env.recallMaxFacts, 3);

  const bogus = resolveConfig({ recall: "sometimes" }, {}, "p");
  assert.equal(bogus.recall, "off");
});
