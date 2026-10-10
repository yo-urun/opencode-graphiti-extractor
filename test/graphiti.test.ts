import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphitiClient, parseMcpBody } from "../src/graphiti.ts";

function jsonResponse(obj: any, sessionId?: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === "mcp-session-id" ? sessionId ?? null : null) },
    text: async () => JSON.stringify(obj),
  };
}

test("parseMcpBody handles plain JSON and SSE", () => {
  assert.deepEqual(parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'), { jsonrpc: "2.0", id: 1, result: { ok: true } });
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
  assert.equal(parseMcpBody(sse).result.ok, true);
});

test("client initializes a session and calls a tool with the session header", async () => {
  const calls: any[] = [];
  const fakeFetch = async (_url: any, init: any) => {
    const payload = JSON.parse(init.body);
    calls.push({ payload, headers: init.headers });
    if (payload.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { serverInfo: { name: "Graphiti" } } }, "sid-123");
    if (payload.method === "notifications/initialized") return jsonResponse({});
    return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text: '{"message":"queued"}' }], isError: false } });
  };
  const client = new GraphitiClient("http://localhost:8000/mcp?codemode=false", fakeFetch as any);
  const res = await client.addMemory({ name: "n", episode_body: "b", group_id: "g", uuid: "abc" });

  assert.equal(res.message, "queued");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].payload.method, "initialize");
  assert.equal(calls[1].payload.method, "notifications/initialized");
  assert.equal(calls[2].payload.params.name, "add_memory");
  assert.equal(calls[2].payload.params.arguments.uuid, "abc");
  // Session id learned from initialize must be echoed on later calls
  assert.equal(calls[2].headers["mcp-session-id"], "sid-123");
});
