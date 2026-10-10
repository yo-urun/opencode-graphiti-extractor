# opencode-graphiti-extractor

A **lightweight background memory extractor** for the [OpenCode](https://opencode.ai)
V2 coding agent that writes conversations into an existing **Graphiti MCP**
server (temporal knowledge graph). It is deliberately minimal: capture-only by
default, batched, and with near-zero cost in the normal agent loop.

## Why

Existing OpenCode↔Graphiti plugins are V1-only (they do not run on OpenCode V2),
and the popular one is heavy: it blocks the first message on memory searches and
writes to Graphiti on **every** assistant turn, which adds latency and token
cost. This plugin does the opposite.

## Design

- **No prompt injection by default** → zero added tokens/latency during work.
- **Batched capture on `session.idle`** (debounced), not per message.
- **Delta only** (cursor per session) → no re-reading/re-indexing the history.
- **Compaction + secret redaction** before anything leaves the machine.
- **Durable outbox** in plugin storage → survives restarts.
- **Deterministic UUIDs** per episode → idempotent, verifiable, deletable.
- **One paced worker** (token bucket) + opportunistic verification.
- **Per-session saga** for correct bi-temporal ordering.
- Manual `memory` tool for on-demand search/add.

```
event(session.idle, debounced)
  -> read new messages (ctx.session.context)
  -> redact + compact into one episode body
  -> durable outbox (uuid, saga, reference_time)
  -> paced add_memory (fire-and-forget)
  -> verify uuid against get_episodes
```

## Install (local plugin)

Add this directory to the global OpenCode config `plugins` array:

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": ["C:/projects/opencode-graphiti-extractor"]
}
```

Options can be passed with the object form:

```jsonc
{
  "plugins": [
    {
      "package": "C:/projects/opencode-graphiti-extractor",
      "options": {
        "graphitiUrl": "http://localhost:8000/mcp?codemode=false",
        "groupId": "opencode",
        "debounceMs": 90000,
        "minTurns": 3,
        "maxChars": 18000,
        "maxEpisodesPerMin": 6
      }
    }
  ]
}
```

## Configuration

| Option | Default | Meaning |
|---|---|---|
| `graphitiUrl` | `http://localhost:8000/mcp?codemode=false` | Graphiti MCP endpoint |
| `groupId` | `opencode` | knowledge-graph group |
| `debounceMs` | `90000` | idle debounce before flush |
| `minTurns` | `3` | skip conversations shorter than this |
| `minChars` | `400` | skip episodes smaller than this |
| `maxChars` | `18000` | episode body cap |
| `maxEpisodesPerMin` | `6` | pacing |
| `maxAttempts` | `8` | retries before dead-letter |

## Tests

```bash
npm test
```

Unit tests cover the pure pieces (compaction/redaction, deterministic ids,
outbox state machine, MCP protocol parsing). No network required.

## Notes / limitations

- The Graphiti server performs entity extraction asynchronously and can be slow
  or rate-limited; episodes may take minutes to appear. Verification is
  therefore opportunistic, not instant.
- This is designed to complement, not replace, Graphiti's own server-side
  extraction.

## License

MIT
