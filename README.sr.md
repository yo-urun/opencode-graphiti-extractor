# opencode-graphiti-extractor

[English](README.md) · [Русский](README.ru.md) · **Srpski**

**Lagani pozadinski ekstraktor memorije** za [OpenCode](https://opencode.ai)
V2 coding agent koji upisuje razgovore u postojeći **Graphiti MCP** server
(temporalni graf znanja). Namerno je minimalan: podrazumevano samo snimanje,
grupisano, uz gotovo nikakav trošak u normalnom ciklusu agenta.

> **Dolazi u** osnovnom paketu
> [`yo-urun/ai-assistant`](https://github.com/yo-urun/ai-assistant)
> (OpenCode V2 + Telegram bot + Graphiti/FalkorDB). Plugin možeš koristiti i
> samostalno, sa bilo kojom OpenCode V2 + Graphiti postavkom.

## Zašto

Kada je ovaj plugin nastao, postojeći OpenCode↔Graphiti pluginovi radili su samo na
V1 (na OpenCode V2 se nisu pokretali) i bili teški: blokirali su prvu poruku na
pretrazi memorije i upisivali u Graphiti na **svakom** potezu asistenta, što dodaje
kašnjenje i trošak tokena. Sada postoje i V2-kompatibilne alternative, ali one i
dalje ubacuju memoriju u svaki prompt. Ovaj plugin drži suprotan podrazumevani
režim: snimanje je pozadinsko i grupisano, a recall je **isključen** dok ga ne
uključiš.

## Dizajn

- **Bez ubacivanja u prompt podrazumevano** → nula dodatnih tokena/kašnjenja tokom rada.
- **Opcioni recall** (`recall: start|turn`) ubacuje mali blok memorije sa budžetom i
  redakcijom tajni pre poziva modela; isključen — opet nula troška.
- **Jedan pretplatnik po procesu** → plugin se učitava po jedan po projektu/lokaciji,
  ali sluša samo jedan, pa se svaki događaj obrađuje tačno jednom.
- **Grupisano snimanje po završetku poteza** (`session.execution.succeeded`, sa
  debounce), a ne po poruci.
- **Samo delta** (kursor po sesiji) → bez ponovnog čitanja/reindeksiranja istorije.
- **Sažimanje + redakcija tajni** pre nego što bilo šta napusti uređaj.
- **Trajni outbox** u skladištu plugina → preživljava restarte.
- **Deterministički lokalni ID-jevi epizoda** i kursor po sesiji → idempotentno
  snimanje; verifikacija spaja epizodu po njenom jedinstvenom `name`.
- **Jedan tempirani radnik** (token bucket) + oportunistička verifikacija (po imenu).
- **Saga po sesiji** za ispravan bitemporalni redosled.
- Ručni `memory` alat za pretragu/dodavanje/status/redrive na zahtev.

```
event(session.execution.succeeded, debounced)
  -> read new messages (ctx.session.context)
  -> redact + compact into one episode body
  -> durable outbox (uuid, saga, reference_time)
  -> paced add_memory (fire-and-forget)
  -> verify uuid against get_episodes
```

> Plugin piše mali log za nadzor u
> `~/.config/opencode/graphiti-extractor.log` (setup, događaji, snimanja).

## Recall (opciono)

Snimanje je jedna polovina petlje. Postavi `recall` da ubaciš kompaktan blok
memorije u kontekst modela pre svakog poziva (preko `ctx.session.hook("context")`):

- `start` — jedna pretraga na početku sesije, blok se ponovo koristi;
- `turn` — osveži pretragu na svaku novu korisničku poruku.

Pretraga je ograničena sa `recallTimeoutMs` i nikada ne blokira poziv modela;
greške i tajmauti se gutaju, pa nedostupan Graphiti ne može da zaustavi potez.
Blok se dedupliče, rediguje od tajni i ograničava. Podrazumevano isključen.

| opcija | podrazumevano | značenje |
|---|---|---|
| `recall` | `off` | `off` \| `start` \| `turn` |
| `recallMaxFacts` | `5` | maksimum činjenica/entiteta u bloku |
| `recallMaxChars` | `1200` | ograničenje dužine bloka |
| `recallTimeoutMs` | `800` | tvrdi tajmaut pretrage |

## Alat `memory`

| režim | argumenti | opis |
|---|---|---|
| `search` | `query` | semantička + grafovska pretraga po grupi |
| `add` | `content` | odmah sačuvaj trajnu belešku |
| `status` | — | brojači outbox-a + ciljna grupa/URL |
| `stats` | — | broj epizoda + outbox + aktivna podešavanja |
| `organize` | — | rebuild klastera zajednica sada (`build_communities`) |
| `saga` | `saga` | sažetak sage po imenu (`summarize_saga`) |
| `redrive` | — | vrati iz dead-letter i pokreni obradu |

## Instalacija (lokalni plugin)

Dodaj ovaj direktorijum u `plugins` niz globalnog OpenCode konfiga (apsolutnom putanjom):

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": ["/absolute/path/to/opencode-graphiti-extractor"]
}
```

Opcije možeš proslediti u objektnom obliku:

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

### Instalacija sa npm-a

Paket je spreman za npm. Posle objave (workflow `Publish to npm`) možeš ga
navesti po imenu umesto putanje:

```jsonc
{
  "plugins": ["opencode-graphiti-extractor"]
}
```

## Konfiguracija

| Opcija | Podrazumevano | Značenje |
|---|---|---|
| `graphitiUrl` | `http://localhost:8000/mcp?codemode=false` | Graphiti MCP endpoint |
| `groupId` | `opencode` | grupa grafa znanja |
| `debounceMs` | `90000` | pauza mirovanja pre slanja |
| `minTurns` | `3` | preskoči razgovore kraće od ovoga |
| `minChars` | `400` | preskoči epizode manje od ovoga |
| `maxChars` | `18000` | ograničenje tela epizode |
| `maxEpisodesPerMin` | `6` | tempiranje |
| `maxAttempts` | `8` | pokušaji pre dead-letter |
| `updateCommunities` | `false` | prosleđuje `update_communities` Graphiti-ju pri ingest-u (inkrementalni klasteri) |
| `organizeEveryHours` | `0` | rebuild klastera svakih N sati (`build_communities`); `0` — isključeno |
| `sagaScope` | `session` | `session` — saga po sesiji; `project` — zajednička saga projekta |
| `extractionInstructions` | `""` | dodatne `custom_extraction_instructions` za kanonska imena entiteta/veza |
| `recall` | `off` | ubaci memoriju pre poziva modela: `off` \| `start` \| `turn` |
| `recallMaxFacts` | `5` | maksimum činjenica/entiteta u bloku |
| `recallMaxChars` | `1200` | ograničenje dužine ubacenog bloka |
| `recallTimeoutMs` | `800` | tvrdi tajmaut pretrage pri recall-u |

Promenljive okruženja se poklapaju 1:1: `GRAPHITI_UPDATE_COMMUNITIES`,
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

Agent može da pretražuje memoriju na zahtev preko `memory` alata:

```json
{ "group": "opencode", "outbox": { "pending": 0, "submitted": 1, "verified": 14, "dead": 0 } }
```

## Testovi

```bash
npm test
```

Unit testovi pokrivaju čiste delove (sažimanje/redakcija, deterministički id-jevi,
state machine outbox-a, parsiranje MCP protokola). Mreža nije potrebna.

## Napomene / ograničenja

- Graphiti server izvlači entitete asinhrono i može biti spor ili ograničen po
  frekvenciji; epizode se mogu pojaviti za nekoliko minuta. Zato je verifikacija
  oportunistička, a ne trenutna.
- Namenjen je da dopuni, a ne da zameni Graphiti-jevu serversku ekstrakciju.

## Povezani repozitorijumi

- **[yo-urun/ai-assistant](https://github.com/yo-urun/ai-assistant)** — self-hosted
  osnovni paket AI asistenta (OpenCode V2 + Telegram bot + Graphiti/FalkorDB) koji
  **uključuje ovaj plugin**.

## Licenca

MIT
