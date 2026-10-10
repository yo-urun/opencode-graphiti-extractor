export type OutboxState = "pending" | "submitted" | "verified" | "dead";

export interface OutboxItem {
  uuid: string;
  groupId: string;
  sessionId: string;
  seq: number;
  name: string;
  body: string;
  referenceTime: string;
  saga: string;
  sagaPrevious?: string;
  state: OutboxState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface KV {
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<void>;
  remove(key: string): Promise<void>;
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{ entries: { key: string; value: any }[]; next?: string }>;
}

const PREFIX = "outbox:";

export class Outbox {
  private kv: KV;

  constructor(kv: KV) {
    this.kv = kv;
  }

  private key(uuid: string): string {
    return PREFIX + uuid;
  }

  async put(item: OutboxItem): Promise<void> {
    item.updatedAt = new Date().toISOString();
    await this.kv.set(this.key(item.uuid), item);
  }

  async get(uuid: string): Promise<OutboxItem | undefined> {
    return await this.kv.get(this.key(uuid));
  }

  async remove(uuid: string): Promise<void> {
    await this.kv.remove(this.key(uuid));
  }

  async list(): Promise<OutboxItem[]> {
    const out: OutboxItem[] = [];
    let after: string | undefined;
    for (let i = 0; i < 100; i++) {
      const page = await this.kv.scan({ prefix: PREFIX, ...(after ? { after } : {}), limit: 100 });
      for (const e of page.entries) out.push(e.value as OutboxItem);
      if (!page.next) break;
      after = page.next;
    }
    return out;
  }

  async byState(state: OutboxState): Promise<OutboxItem[]> {
    return (await this.list()).filter((i) => i.state === state);
  }

  async counts(): Promise<Record<OutboxState, number>> {
    const counts: Record<OutboxState, number> = { pending: 0, submitted: 0, verified: 0, dead: 0 };
    for (const i of await this.list()) counts[i.state] = (counts[i.state] ?? 0) + 1;
    return counts;
  }
}
