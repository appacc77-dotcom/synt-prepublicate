# design/figma — только живой мост

Проект работает **исключительно** через `figma-agent` (DESIGN:OS Bridge) к файлу,
открытому в Figma desktop. Ни `.fig`, ни заранее выгруженных PNG здесь нет:
эталон читается с живого файла в момент работы.

Почему так: предыдущие эталоны были выгружены из **другого** файла
(`wbtBZLldiNMyOD4vX8ukKz`), а работаем мы с `NInjODHyOOjIitF3lq4Vpe`
(«Website Syntonia2»). Сравнение с чужим рендером даёт ложные числа — ровно так
появились «Library выросла с 159 до 806 элементов» и разошедшиеся токены.

| Каталог | Фаза | Что внутри |
|---|---|---|
| `live/` | P0 | снимки живого файла: `structure.json`, `ds.json` |
| `spec/` | P2 | `<page>.json`: секции → узлы → боксы → тексты → стили |
| `crops/` | P3 | `<section>.png` — эталон, экспортированный с узла |

## Как читать

```bash
figma-agent status --peek                 # жив ли мост
figma-agent scan-design-system --out design/figma/live/ds.json
figma-agent exec-js design/figma/live/read-structure.js   # страницы и фреймы
figma-agent context <nodeId> --budget 128 # CSS, токены, текст узла
figma-agent export-png --node <id> --out design/figma/pages/<page>/<section>/crop.png
```

## Правило

`project.json` фиксирует `fileKey` и дату чтения. **Число без fileKey — не
число.** Если файл в Figma сменили, всё в `live/`, `spec/` и `crops/` устарело
одновременно — перечитывается целиком, а не по частям.
