import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicUuid } from "../src/util.ts";
import { buildEpisode, redact, stripNoise } from "../src/compact.ts";
import { toTurns } from "../src/messages.ts";
import type { Turn } from "../src/messages.ts";

test("deterministicUuid is stable and uuid-shaped", () => {
  const a = deterministicUuid("oc:proj:sess:1");
  const b = deterministicUuid("oc:proj:sess:1");
  assert.equal(a, b);
  assert.notEqual(a, deterministicUuid("oc:proj:sess:2"));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("redact removes common secrets", () => {
  // Значения вымышленные: проверяем, что редакция секретов их убирает.
  const input = "key=sk-abcdefghijklmnopqrstuvwx token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ01 <private>hunter2</private>";
  const out = redact(input);
  assert.doesNotMatch(out, /sk-abcdefghijklmnopqrstuvwx/);
  assert.doesNotMatch(out, /ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ01/);
  assert.doesNotMatch(out, /hunter2/);
  assert.match(out, /REDACTED/);
});

test("stripNoise drops code and collapses whitespace", () => {
  const out = stripNoise("hello ```js\nconst x=1\n``` world `inline`   end");
  assert.doesNotMatch(out, /const x=1/);
  assert.doesNotMatch(out, /inline/);
  assert.match(out, /hello world end/);
});

test("buildEpisode builds labeled body and honors maxChars", () => {
  const turns: Turn[] = [
    { role: "user", text: "Remember the build command is bun run build", ts: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", text: "Noted: this project uses bun." },
  ];
  const r = buildEpisode(turns, { maxChars: 1000 });
  assert.match(r.body, /User: /);
  assert.match(r.body, /Assistant: /);
  assert.equal(r.firstTs, "2026-01-01T00:00:00.000Z");
  const capped = buildEpisode(turns, { maxChars: 20 });
  assert.ok(capped.chars <= 20);
  assert.ok(capped.body.length <= 20);
});

test("toTurns parses the V2 message shape (type + content parts)", () => {
  const messages = [
    { id: "a1", type: "user", time: { created: 1700000000000 }, content: [{ type: "text", text: "hi there" }] },
    { id: "a2", type: "assistant", time: { created: 1700000001000 }, content: [{ type: "reasoning", text: "thinking..." }, { type: "text", text: "hello" }, { type: "tool", text: "x" }] },
  ];
  const turns = toTurns(messages);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, "user");
  assert.equal(turns[0].id, "a1");
  assert.equal(turns[1].role, "assistant");
  assert.equal(turns[1].text, "hello");
  assert.equal(turns[1].ts, new Date(1700000001000).toISOString());
});

test("toTurns ignores synthetic parts and non-conversation roles", () => {
  const messages = [
    { info: { role: "user", id: "m1" }, parts: [{ type: "text", text: "hi" }] },
    { info: { role: "assistant", id: "m2" }, parts: [{ type: "text", text: "injected", synthetic: true }, { type: "text", text: "hello" }] },
    { info: { role: "tool", id: "m3" }, parts: [{ type: "text", text: "noise" }] },
  ];
  const turns = toTurns(messages);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].id, "m1");
  assert.equal(turns[1].text, "hello");
});
