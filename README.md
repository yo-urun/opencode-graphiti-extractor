# opencode-graphiti-extractor

**English** · [Русский](README.ru.md) · [Srpski](README.sr.md)

A **lightweight background memory extractor** for the [OpenCode](https://opencode.ai)
V2 coding agent that writes conversations into an existing **Graphiti MCP**
server (temporal knowledge graph). It is deliberately minimal: capture-only by
default, batched, and with near-zero cost in the normal agent loop.

> **Bundled in** the [`yo-urun/ai-assistant`](https://github.com/yo-urun/ai-assistant)
> base kit (OpenCode V2 + Telegram bot + Graphiti/FalkorDB). You can also use
> this plugin standalone with any OpenCode V2 + Graphiti setup.

## Why

When this plugin was written, the existing OpenCode↔Graphiti plugins were
V1-only and heavy: they blocked the first message on memory searches and wrote
to Graphiti on **every** assistant turn, which adds latency and token cost.
V2-compatible alternatives exist now, but they still inject memory into every
prompt. This plugin keeps the opposite default: capture is background and
batched, and recall is **off** unless you turn it on.

## Design

- **No prompt injection by default** → zero added tokens/latency during work.
- **Opt-in recall** (`recall: start|turn`) injects a small, budgeted, redacted
  memory block before model calls; still zero cost when off.
- **One process-wide subscriber** → the plugin loads once per project/location,
  but only a single instance listens, so each event is handled exactly once.
- **Batched capture on turn completion** (`session.execution.succeeded`, debounced),
  not per message.
- **Delta only** (cursor per session) → no re-reading/re-indexing the history.
- **Compaction + secret redaction** before anything leaves the machine.
- **Durable outbox** in plugin storage → survives restarts.
- **Deterministic local episode IDs** and a per-session cursor → idempotent
  capture; verification matches the episode by its unique `name`.
- **One paced worker** (token bucket) + opportunistic verification (by name).
- **Per-session saga** for correct bi-temporal ordering.
- Manual `memory` tool for on-demand search/add/status/redrive.

```
event(session.execution.succeeded, debounced)
  -> read new messages (ctx.session.context)
  -> redact + compact into one episode body
  -> durable outbox (uuid, saga, reference_time)
  -> paced add_memory (fire-and-forget)
  -> verify uuid against get_episodes
```

## Recall (optional)

Capture is one half of the loop. Set `recall` to inject a compact memory block
into the model context before each call (via `ctx.session.hook("context")`):

- `start` — search once when a session begins and reuse the block;
- `turn` — refresh the search on every new user message.

The search is bounded by `recallTimeoutMs` and never blocks the model call;
errors and timeouts are swallowed, so an unavailable Graphiti cannot stall a
turn. The block is deduplicated, secret-redacted, and capped. Off by default.

| option | default | meaning |
|---|---|---|
| `recall` | `off` | `off` \| `start` \| `turn` |
| `recallMaxFacts` | `5` | max facts/entities in the block |
| `recallMaxChars` | `1200` | character budget for the block |
| `recallTimeoutMs` | `800` | hard timeout for the Graphiti search |

> The plugin writes a small observability log to
> `~/.config/opencode/graphiti-extractor.log` (setup, events, captures).

## `memory` tool

| mode | args | description |
|---|---|---|
| `search` | `query` | semantic + graph search over the group |
| `add` | `content` | store a durable note immediately |
| `status` | — | outbox counts + target group/url |
| `stats` | — | episode count + outbox counts + active settings |
| `organize` | — | rebuild community clusters now (`build_communities`) |
| `saga` | `saga` | summarize a saga by name (`summarize_saga`) |
| `redrive` | — | requeue dead-lettered episodes and drain |

## Install (local plugin)

Add this directory to the global OpenCode config `plugins` array (use an absolute path):

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": ["/absolute/path/to/opencode-graphiti-extractor"]
}
```

Options can be passed with the object form:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-graphiti-extractor",
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

### Install from npm

The package is npm-ready. After publishing (see the `Publish to npm` workflow),
reference it by name instead of a path:

```jsonc
{
  "plugins": ["opencode-graphiti-extractor"]
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
| `updateCommunities` | `false` | pass `update_communities` to Graphiti on ingest (incremental clusters) |
| `organizeEveryHours` | `0` | rebuild community clusters every N hours (`build_communities`); `0` disables |
| `sagaScope` | `session` | `session` = one saga per session; `project` = one shared saga per project |
| `extractionInstructions` | `""` | extra `custom_extraction_instructions` to keep entity/edge naming canonical |
| `recall` | `off` | inject memory before model calls: `off` \| `start` \| `turn` |
| `recallMaxFacts` | `5` | max facts/entities injected |
| `recallMaxChars` | `1200` | character budget for the injected block |
| `recallTimeoutMs` | `800` | hard timeout for the recall search |

Environment variables map 1:1: `GRAPHITI_UPDATE_COMMUNITIES`,
`GRAPHITI_ORGANIZE_EVERY_HOURS`, `GRAPHITI_SAGA_SCOPE`,
`GRAPHITI_EXTRACTION_INSTRUCTIONS`, `GRAPHITI_RECALL`,
`GRAPHITI_RECALL_MAX_FACTS`, `GRAPHITI_RECALL_MAX_CHARS`,
`GRAPHITI_RECALL_TIMEOUT_MS` (plus `GRAPHITI_URL`, `GRAPHITI_GROUP_ID`).

## Demo

```text
# ~/.config/opencode/graphiti-extractor.log
setup {"group":"opencode","url":"http://graphiti:8000/mcp?codemode=false"}
subscriber started
queued    {"sessionId":"ses_…","chars":1372}
submitted {"name":"opencode ses_… #3","chars":1371}
verified  {"name":"opencode ses_… #3"}
```

The agent can query memory on demand through the `memory` tool:

```json
{ "group": "opencode", "outbox": { "pending": 0, "submitted": 1, "verified": 14, "dead": 0 } }
```

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

## Related

- **[yo-urun/ai-assistant](https://github.com/yo-urun/ai-assistant)** — self-hosted
  AI-assistant base kit (OpenCode V2 + Telegram bot + Graphiti/FalkorDB) that
  **bundles this plugin**.

## License

MIT
