# FigCraft: документация, установка и как мы к нему подключились

**Что это.** FigCraft — открытый редактор интерфейсов на Rust, «чистая реализация» привычного
дизайн-процесса (Figma-совместимая по поведению, но не по коду). Открывает `.fig` (best effort),
работает офлайн, файлы — обычные архивы `.figcraft`. Статус — **early alpha**. Лицензия MIT /
Apache-2.0. Репозиторий: <https://github.com/storytold/figcraft> (входит в семейство ArtCraft,
<https://getartcraft.com/apps/figcraft>).

## 1. Официальная документация (источник истины)

| Документ | О чём | Когда читать |
|---|---|---|
| [README.md](https://github.com/storytold/figcraft/blob/main/README.md) | обзор, возможности, «Built for agents» | первое знакомство |
| [docs/cli.md](https://github.com/storytold/figcraft/blob/main/docs/cli.md) | `figcraft-cli`: подкоманды, флаги, песочница путей, шрифты | автоматизация без окна |
| [docs/mcp.md](https://github.com/storytold/figcraft/blob/main/docs/mcp.md) | MCP-сервер: инструменты (`open_file`, `inspect_document`, `get_node`, `export`, `run_command`), подключение клиентов | агентская работа — **наш путь** |
| [docs/control-protocol.md](https://github.com/storytold/figcraft/blob/main/docs/control-protocol.md) | канал управления запущенного приложения (`figcraft --control PORT`, NDJSON) | если приложение уже открыто |
| [docs/file-format-parity.md](https://github.com/storytold/figcraft/blob/main/docs/file-format-parity.md) | что именно переносится из `.fig`/`.sketch`/REST-JSON и что нет | оценка пригодности как источника |
| [docs/gaps.md](https://github.com/storytold/figcraft/blob/main/docs/gaps.md) | честный список расхождений с Figma, по пунктам | оценка рисков |
| [docs/plugins.md](https://github.com/storytold/figcraft/blob/main/docs/plugins.md) | плагины: WASM, `figcraft-plugin.json`, песочница без сети/файлов/часов | **важно: плагины Figma не запускаются** |
| [docs/architecture.md](https://github.com/storytold/figcraft/blob/main/docs/architecture.md) | устройство движка и файла | если чиним что-то внутри |
| [docs/roadmap.md](https://github.com/storytold/figcraft/blob/main/docs/roadmap.md) | что впереди | планирование рисков |
| [AGENTS.md](https://github.com/storytold/figcraft/blob/main/AGENTS.md) | инструкции агентам в самом проекте | если контрибьютим |
| [docs/server.md](https://github.com/storytold/figcraft/blob/main/docs/server.md) | `figcraft-server`: совместные сессии, публикация плагинов | если нужен общий сервер |

Сторонний «fan guide» — <https://figcraft.app> (не официальный; использовать только как обзор).

## 2. Установка (macOS, что сделано у нас)

Бинарь не входит ни в `.dmg`, ни в `.app`; в Linux-AppImage входит (`FigCraft.AppImage cli …`).
Для macOS в релизе есть отдельный архив:

```bash
cd _tools
gh release download v0.18.1 -R storytold/figcraft \
  -p "figcraft-cli-0.18.1-macos-universal.zip" --clobber
unzip -o -q figcraft-cli-0.18.1-macos-universal.zip -d figcraft-cli-pkg
_tools/figcraft-cli-pkg/figcraft-cli-0.18.1-macos-universal/figcraft-cli --version   # 0.18.1
```

**Версии.** Приложение в системе — 0.15.0 (3.11.2026), CLI — 0.18.1 (12.11.2026). Для headless-режима
это работает (проверено). Для `mcp --attach` нужна согласованная пара «приложение + CLI»: приложение
запускается `figcraft --control <port>`, а roots задаются ему, не CLI.

**Путь к бинарю.** Модуль ищет `FIGCRAFT_CLI`, затем `../_tools/figcraft-cli-pkg/…/figcraft-cli`,
затем `figcraft-cli` в PATH.

**Системные шрифты.** По умолчанию CLI индексирует установленные шрифты (как приложение), поэтому
текст рисуется теми же начертаниями. Флаг `--no-system-fonts` / `FIGCRAFT_NO_SYSTEM_FONTS=1` делает
рендер машинно-независимым, но подменяет шрифты проекта на встроенные — для сверки с Figma это хуже.

## 3. Как подключено у нас

Модуль: [`tools/bridges/figcraft-cli/`](../tools/bridges/figcraft-cli/index.mjs) — контракт моста
описан в [`tools/bridges/README.md`](../tools/bridges/README.md).

Транспорт — `figcraft-cli mcp`, JSON-RPC по stdio. Песочница путей обязательна: чтение разрешено
только в каталоге файла, запись — в `$TMPDIR`, `reports/` и каталоге `--out`.

Используемые инструменты MCP:

| Инструмент | Зачем |
|---|---|
| `open_file {path}` | открыть `.fig`; отдаёт `summary` (страницы, слои, картинки, предупреждения) |
| `inspect_document {depth, allPages}` | дерево страниц и узлов (геометрия от родителя, текст, видимость) |
| `export {ids, format: "png", scale, path}` | кроп узла в PNG |

## 4. Что важно знать до того, как называть FigCraft источником истины

Из `docs/gaps.md` и нашего прогона:

1. **Плагины Figma не работают.** Наш мост «DESIGN:OS Bridge» там не запускается — это другой API,
   поэтому подключение к FigCraft сделано отдельным модулем, а не настройкой существующего.
2. **`.fig` — «best effort».** Открывается, дерево/геометрия/заливки/текст/компоненты/переменные
   переносятся, всё остальное — предупреждением. В нашем прогоне (старый `.fig`, 103 МБ) — 5 классов
   предупреждений: стили векторных сегментов (×172), привязанные к переменным векторные заливки (×28),
   привязки к переменным библиотеки (×6), фильтры картинок рисуются приближённо (×6), переменные без
   читаемого значения — пропущены.
3. **Рендерер — CPU (tiny-skia), не GPU Figma.** Канвас sRGB: P3 на экране клипается, в экспорт
   сохраняется. Числа: тот же кадр hero из Figma и из FigCraft расходится в среднем на **2,62**
   (для сравнения: наш собственный шум Figma-кроп ↔ вёрстка — 1,76, а два эталона Figma между собой
   (PNG ↔ PDF) — 1,68). То есть FigCraft ближе к Figma, чем порог нашего шума, но не совпадает с ним.
4. **Инстансы раскрываются иначе.** На Home общими оказались 1 256 путей из 1 732/1 272: у Figma
   больше на 476 узлов (внутренности инстансов: VECTOR 195, TEXT 187, GROUP 44, FRAME 22, INSTANCE 20),
   у FigCraft — на 16 (`tab-divider`). Геометрия и текст на общих путях совпали **полностью** (Δ = 0).
5. **Early alpha.** 0.15.0 у приложения, 0.18.1 у CLI; API меняется между релизами.

## 5. Команды

```bash
node tools/bridge.mjs figcraft status  --fig "<file.fig>"
node tools/bridge.mjs figcraft pages   --fig "<file.fig>"
node tools/bridge.mjs figcraft tree    --fig "<file.fig>" --page Home --depth 6 --out /tmp/figcraft-home.json
node tools/bridge.mjs figcraft png     --fig "<file.fig>" --node <id> --out /tmp/hero.png
node tools/bridge.mjs figcraft timing  --fig "<file.fig>" --page Home --node <id>
```

Сырые вызовы без нашего модуля: `figcraft-cli info <file>`, `figcraft-cli export ...`, `figcraft-cli mcp`.

## 6. Числа (14.11.2026, старый `.fig` 103 МБ, машина автора)

| Операция | Время |
|---|---:|
| `open_file` (103 МБ) | 1 372 мс |
| список страниц (файл открыт) | 1 мс |
| дерево Home до глубины 6 (1 272 узла) | 456 мс |
| PNG hero 1440×780 | 196 мс |
| Итого первые четыре шага | **2 025 мс** |

Сравнение с мостом к desktop — [`BRIDGES-2026-11-14.md`](BRIDGES-2026-11-14.md).
