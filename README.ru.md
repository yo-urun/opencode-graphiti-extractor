# opencode-graphiti-extractor

[English](README.md) · **Русский** · [Srpski](README.sr.md)

**Лёгкий фоновый экстрактор памяти** для кодинг-агента
[OpenCode](https://opencode.ai) V2: пишет диалоги в существующий сервер
**Graphiti MCP** (темпоральный граф знаний). Намеренно минималистичен: по
умолчанию только захват, батчами, и почти нулевой стоимостью в обычном цикле агента.

> **Входит в** базовую сборку
> [`yo-urun/ai-assistant`](https://github.com/yo-urun/ai-assistant)
> (OpenCode V2 + Telegram-бот + Graphiti/FalkorDB). Плагин можно использовать и
> отдельно, с любой связкой OpenCode V2 + Graphiti.

## Зачем

На момент написания существующие плагины OpenCode↔Graphiti работали только на V1
(на OpenCode V2 они не запускались) и были тяжёлыми: блокировали первое сообщение
на поиске в памяти и писали в Graphiti на **каждом** ходе ассистента. Совместимые
с V2 альтернативы теперь есть, но они по-прежнему инъектят память в каждый запрос.
Этот плагин держит обратный дефолт: захват фоновый и батчами, а recall **выключен**,
пока его не включишь.

## Устройство

- **Без инъекции в промпт по умолчанию** → ноль лишних токенов и задержек в работе.
- **Опциональный recall** (`recall: start|turn`) инъектит небольшой блок памяти
  с бюджетом и редакцией секретов перед вызовами модели; выключен — снова ноль
  расходов.
- **Один подписчик на процесс** → плагин грузится по инстансу на проект, но слушает
  только один, поэтому каждое событие обрабатывается ровно один раз.
- **Пакетный захват по завершении хода** (`session.execution.succeeded`, с
  дебаунсом), а не на каждое сообщение.
- **Только дельта** (курсор на сессию) → без повторного чтения/переиндексации истории.
- **Сжатие + редакция секретов** до того, как что-то покинет машину.
- **Durable-очередь (outbox)** в хранилище плагина → переживает перезапуски.
- **Детерминированные локальные ID эпизодов** и курсор на сессию → идемпотентный
  захват; верификация сопоставляет эпизод по его уникальному `name`.
- **Один воркер с ограничением скорости** (token bucket) + оппортунистическая
  верификация (по имени).
- **Сага на сессию** для корректного битемпорального порядка.
- Ручной инструмент `memory` для поиска/добавления/статуса/redrive по требованию.

```
event(session.execution.succeeded, debounced)
  -> read new messages (ctx.session.context)
  -> redact + compact into one episode body
  -> durable outbox (uuid, saga, reference_time)
  -> paced add_memory (fire-and-forget)
  -> verify uuid against get_episodes
```

> Плагин пишет небольшой лог наблюдаемости в
> `~/.config/opencode/graphiti-extractor.log` (setup, события, захваты).

## Recall (опционально)

Захват — это половина петли. Включите `recall`, чтобы перед вызовом модели
инъектировать компактный блок памяти (через `ctx.session.hook("context")`):

- `start` — один поиск в начале сессии, блок переиспользуется;
- `turn` — обновлять поиск на каждое новое пользовательское сообщение.

Поиск ограничен `recallTimeoutMs` и никогда не блокирует вызов модели; ошибки и
таймауты проглатываются, поэтому недоступный Graphiti не остановит ход. Блок
дедуплицируется, редактируется от секретов и ограничен по бюджету. По умолчанию
выключен.

| опция | по умолчанию | значение |
|---|---|---|
| `recall` | `off` | `off` \| `start` \| `turn` |
| `recallMaxFacts` | `5` | максимум фактов/сущностей в блоке |
| `recallMaxChars` | `1200` | лимит длины блока |
| `recallTimeoutMs` | `800` | жёсткий таймаут поиска в Graphiti |

## Инструмент `memory`

| режим | аргументы | описание |
|---|---|---|
| `search` | `query` | семантический + графовый поиск по группе |
| `add` | `content` | сразу сохранить долговечную заметку |
| `status` | — | счётчики outbox + целевая группа/URL |
| `stats` | — | число эпизодов + outbox + активные настройки |
| `organize` | — | перестроить кластеры сообществ сейчас (`build_communities`) |
| `saga` | `saga` | саммари саги по имени (`summarize_saga`) |
| `redrive` | — | вернуть из dead-letter и прогнать очередь |

## Установка (локальный плагин)

Добавьте эту директорию в массив `plugins` глобального конфига OpenCode (абсолютным путём):

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": ["/absolute/path/to/opencode-graphiti-extractor"]
}
```

Опции можно передать объектной формой:

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

### Установка из npm

Пакет готов к публикации в npm. После публикации (workflow `Publish to npm`)
его можно указать по имени, а не по пути:

```jsonc
{
  "plugins": ["opencode-graphiti-extractor"]
}
```

## Конфигурация

| Опция | По умолчанию | Значение |
|---|---|---|
| `graphitiUrl` | `http://localhost:8000/mcp?codemode=false` | эндпоинт Graphiti MCP |
| `groupId` | `opencode` | группа графа знаний |
| `debounceMs` | `90000` | пауза простоя перед отправкой |
| `minTurns` | `3` | пропускать диалоги короче этого |
| `minChars` | `400` | пропускать эпизоды меньше этого |
| `maxChars` | `18000` | лимит тела эпизода |
| `maxEpisodesPerMin` | `6` | ограничение скорости |
| `maxAttempts` | `8` | попытки до dead-letter |
| `updateCommunities` | `false` | передавать `update_communities` в Graphiti при ingest (инкрементальные кластеры) |
| `organizeEveryHours` | `0` | перестраивать кластеры каждые N часов (`build_communities`); `0` — выключено |
| `sagaScope` | `session` | `session` — сага на сессию; `project` — общая сага проекта |
| `extractionInstructions` | `""` | доп. `custom_extraction_instructions` для каноничных имён сущностей/связей |
| `recall` | `off` | инъекция памяти перед вызовами модели: `off` \| `start` \| `turn` |
| `recallMaxFacts` | `5` | максимум фактов/сущностей в блоке |
| `recallMaxChars` | `1200` | лимит длины инъектируемого блока |
| `recallTimeoutMs` | `800` | жёсткий таймаут поиска при recall |

Переменные окружения совпадают 1:1: `GRAPHITI_UPDATE_COMMUNITIES`,
`GRAPHITI_ORGANIZE_EVERY_HOURS`, `GRAPHITI_SAGA_SCOPE`,
`GRAPHITI_EXTRACTION_INSTRUCTIONS`, `GRAPHITI_RECALL`,
`GRAPHITI_RECALL_MAX_FACTS`, `GRAPHITI_RECALL_MAX_CHARS`,
`GRAPHITI_RECALL_TIMEOUT_MS` (плюс `GRAPHITI_URL`, `GRAPHITI_GROUP_ID`).

## Демо

```text
# ~/.config/opencode/graphiti-extractor.log
setup {"group":"opencode","url":"http://graphiti:8000/mcp?codemode=false"}
subscriber started
queued    {"sessionId":"ses_…","chars":1372}
submitted {"name":"opencode ses_… #3","chars":1371}
verified  {"name":"opencode ses_… #3"}
```

Агент может обращаться к памяти по требованию через инструмент `memory`:

```json
{ "group": "opencode", "outbox": { "pending": 0, "submitted": 1, "verified": 14, "dead": 0 } }
```

## Тесты

```bash
npm test
```

Юнит-тесты покрывают чистые части (сжатие/редакция, детерминированные id, машина
состояний outbox, парсинг MCP-протокола). Сеть не нужна.

## Заметки / ограничения

- Сервер Graphiti извлекает сущности асинхронно и может быть медленным или
  ограниченным по частоте; эпизоды могут появляться минутами. Поэтому верификация
  оппортунистическая, а не мгновенная.
- Плагин дополняет, а не заменяет серверное извлечение самого Graphiti.

## Связанные репозитории

- **[yo-urun/ai-assistant](https://github.com/yo-urun/ai-assistant)** — self-hosted
  базовая сборка AI-ассистента (OpenCode V2 + Telegram-бот + Graphiti/FalkorDB),
  которая **включает этот плагин**.

## Лицензия

MIT
