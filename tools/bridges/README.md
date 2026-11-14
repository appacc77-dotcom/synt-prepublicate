# Мосты к источнику макета

Два независимых канала, через которые конвейер читает макет:

| Модуль | Что читает | Что нужно на машине |
|---|---|---|
| [`figma-desktop/`](figma-desktop/index.mjs) | живой файл в Figma desktop, через плагин и брокер `figma-agent` | Figma desktop с открытым файлом и запущенным плагином «DESIGN:OS Bridge» |
| [`figcraft-cli/`](figcraft-cli/index.mjs) | архив `.fig` / `.figcraft` / REST-JSON, через `figcraft-cli mcp` (JSON-RPC по stdio) | бинарь `figcraft-cli` (в воркспейсе: `_tools/figcraft-cli-pkg/.../figcraft-cli`) |

## Контракт модуля

Модуль отдаёт объект с пятью функциями. Форма входа и выхода у обоих мостов
одинаковая — поэтому их можно сравнивать и переключать без переписывания ворот.

```js
export const meta = { id, title, requires, source };
export async function status(opts)  // { ms, connected, file, details }
export async function pages(opts)   // { ms, file, pages: [{ id, name, children }] }
export async function tree(opts)    // { ms, data: { source, file, page, depth, total, nodes } }
export async function png(opts)     // { ms, node, out, bytes }
export async function timing(opts)  // { ms, suite: [{ step, ms, ... }] }
```

`opts` — объект: `{ fig?, page?, depth?, node?, out?, scale? }`. Мост берёт
только то, что ему нужно; лишнее игнорируется.

### Узел (`nodes[]`) — общая единица сверки

```json
{
  "path": "Home/main/hero",   // путь из имён; одноимённые соседи: «formats#2»
  "id": "79:105",             // id источника (у мостов РАЗНЫЕ — не сравнивать)
  "name": "hero",
  "type": "FRAME",
  "depth": 2,
  "x": 0, "y": 104,           // координаты ОТНОСИТЕЛЬНО РОДИТЕЛЯ
  "w": 1440, "h": 780,
  "text": "…",                // только у TEXT
  "hidden": true              // только если слой скрыт
}
```

Правила, без которых сверка врёт:

1. **Путь — единственный общий ключ.** `id` у Figma (`79:105`) и FigCraft (`716`)
   не связаны и между мостами не сравниваются.
2. **Одноимённые соседи нумеруются** (`formats#2`, `formats#3`), иначе пять
   кадров `main` схлопнутся в один путь.
3. **Координаты — от родителя.** Мосты возвращают их в разных системах, поэтому
   каждый модуль приводит к родительской системе до выхода.
4. **Округление до 0,01 px** одинаковое у обоих: иначе сверка ловит шум float.

## Как добавить третий мост

1. Скопировать `figcraft-cli/` как образец: свой транспорт + нормализация в узел.
2. Зарегистрировать в [`index.mjs`](index.mjs).
3. Прогнать `node tools/bridge.mjs <id> timing` и `node tools/bridges/compare.mjs`
   против любого существующего моста — контракт проверяется сверкой, а не обещанием.

## Команды

```bash
node tools/bridge.mjs figma status
node tools/bridge.mjs figma pages
node tools/bridge.mjs figma tree --page Home --depth 6 --out /tmp/figma-home.json
node tools/bridge.mjs figma png --node 79:105 --out /tmp/figma-hero.png
node tools/bridge.mjs figma timing --page Home --node 79:105

node tools/bridge.mjs figcraft status --fig "/path/Website Syntonia.fig"
node tools/bridge.mjs figcraft tree --fig <file> --page Home --depth 6 --out /tmp/figcraft-home.json
node tools/bridge.mjs figcraft png --fig <file> --node <id> --out /tmp/figcraft-hero.png
node tools/bridge.mjs figcraft timing --fig <file> --page Home

node tools/bridges/compare.mjs --a /tmp/figma-home.json --b /tmp/figcraft-home.json

# пиксель по всем собранным секциям: кроп Figma ↔ рендер FigCraft
node tools/bridges/pixel-parity.mjs --fig /path/to/file.fig --out reports/pixel-parity.md

# данные дизайн-системы: имена токенов, стилей, компонентов, осей вариантов
node tools/bridges/data-parity.mjs --fig /path/to/file.fig --out reports/data-parity.md

# пиксель по страницам целиком: PNG обоих мостов
node tools/bridges/page-parity.mjs --fig /path/to/file.fig --out reports/page-parity.md --dir /tmp/page-parity
```
