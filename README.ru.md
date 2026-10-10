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

Существующие плагины OpenCode↔Graphiti работают только на V1 (на OpenCode V2 они
не запускаются), а популярный из них тяжёлый: он блокирует первое сообщение на
поиске в памяти и пишет в Graphiti на **каждом** ходе ассистента, добавляя задержку
и расход токенов. Этот плагин делает наоборот.

## Устройство

- **Без инъекции в промпт по умолчанию** → ноль лишних токенов и задержек в работе.
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

## Инструмент `memory`

| режим | аргументы | описание |
|---|---|---|
| `search` | `query` | семантический + графовый поиск по группе |
| `add` | `content` | сразу сохранить долговечную заметку |
| `status` | — | счётчики outbox + целевая группа/URL |
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
