export function parseMcpBody(text: string): any {
  if (text && text.includes("data:")) {
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    const last = lines[lines.length - 1];
    if (last) return JSON.parse(last.slice(5).trim());
  }
  return JSON.parse(text);
}

type FetchLike = (input: any, init?: any) => Promise<any>;

export class GraphitiClient {
  private url: string;
  private fetchImpl: FetchLike;
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(url: string, fetchImpl: FetchLike = fetch as unknown as FetchLike) {
    this.url = url;
    this.fetchImpl = fetchImpl;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  private async post(payload: any, retry = true): Promise<any> {
    let res: any;
    try {
      res = await this.fetchImpl(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify(payload) });
    } catch (e) {
      throw new Error(`Graphiti request failed: ${(e as Error).message}`);
    }
    const sid = res.headers?.get?.("mcp-session-id");
    if (sid) this.sessionId = sid;
    const text: string = await res.text();
    if (!res.ok) {
      if (retry) {
        this.sessionId = null;
        await this.ensureSession();
        return this.post(payload, false);
      }
      throw new Error(`Graphiti HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    try {
      return parseMcpBody(text);
    } catch {
      return null;
    }
  }

  async ensureSession(): Promise<void> {
    if (this.sessionId) return;
    await this.post(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "opencode-graphiti-extractor", version: "0.2.1" },
        },
      },
      false,
    );
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, false);
  }

  async callTool(name: string, args: Record<string, any>): Promise<any> {
    await this.ensureSession();
    const r = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } });
    if (r?.error) throw new Error(`MCP error for ${name}: ${JSON.stringify(r.error).slice(0, 200)}`);
    const result = r?.result;
    if (result?.isError) {
      const t = result?.content?.[0]?.text ?? "";
      throw new Error(`Tool ${name} failed: ${String(t).slice(0, 300)}`);
    }
    const text = result?.content?.[0]?.text;
    if (typeof text === "string") {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return result;
  }

  addMemory(args: Record<string, any>) {
    return this.callTool("add_memory", args);
  }
  getEpisodes(groupIds: string[], max = 50) {
    return this.callTool("get_episodes", { group_ids: groupIds, max_episodes: max });
  }
  searchFacts(query: string, groupIds: string[], max = 10) {
    return this.callTool("search_memory_facts", { query, group_ids: groupIds, max_facts: max });
  }
  searchNodes(query: string, groupIds: string[], max = 10) {
    return this.callTool("search_nodes", { query, group_ids: groupIds, max_nodes: max });
  }
  deleteEpisode(uuid: string, groupId?: string) {
    return this.callTool("delete_episode", groupId ? { uuid, group_id: groupId } : { uuid });
  }
}
