# Протокол холодного старта

Доказательство: тот же набор команд доводит пустую папку до собранного сайта
по живому файлу Figma. Прогон 08.11.2026, папка `/tmp/cold-final`, внутри
только `tools/`.

## Шаги и коды

| № | команда | код | артефакт |
|---|---|---:|---|
| 1 | `node tools/scaffold.mjs` | 0 | `astro.config.mjs`, `tsconfig.json`, `package.json`, `src/**`, `public/fonts/fonts.css` |
| 2 | `npm install` | 0 | 159 пакетов, astro 7.4.5 |
| 3 | `node tools/discover.mjs --write` | 0 | `design/figma/project.json`: 8 страниц |
| 4 | `npm run intake` | 0 | `design/figma/live/{structure,ds,reality,snapshot}.json` |
| 5 | `npm run fonts` | 0 | `public/fonts/fonts.css` + **31** файл woff2 |
| 6 | `npm run ds:tokens` | 0 | `src/styles/{tokens,typography}.css` |
| 7 | `npm run structure` | 0 | `design/figma/structure.json`: **46** секций, **7** страниц |
| 8 | `npm run motion:manifest` | 0 | `design/motion/motion.json` |
| 9 | `npm run build` | 0 | `dist/structure.html` **91 867** байт |
| 10 | `npm run verify` | 0 | источники сходятся, ассеты на месте, шаблон совпадает |
| 11 | `node tools/conveyor.mjs check --all` | **3** | «секций в объёме нет» — проверять нечего |

Ни одной правки кода, ни одной правки инструкций.

## Экспорт секции в том же проекте

| № | команда | код | артефакт |
|---|---|---:|---|
| 12 | `node tools/export-section.mjs 79:105 --name hero` | 0 | `design/figma/pages/home/hero/{spec,crop,states}` |
| 13 | `npm run structure` | 0 | секция помечена `data-status="exported"` |
| 14 | `npm run build` | 0 | `dist/structure.html` с секцией |
| 15 | `node tools/conveyor.mjs check --all` | **3** | «страниц сайта в dist нет» — ворота с страницей не запускались |

## Проект задаётся одним JSON

В той же папке поменяли `source.fileName` в `design/figma/project.json`,
пересобрали: новое имя появилось на странице структуры, старое исчезло.
Код не трогали.

## Граница

Конвейер доводит до карты секций, экспортированной секции, шрифтов, токенов
и работающих ворот. Дальше — сборка компонента по `spec.json`: это вёрстка по
макету, работа агента, а не перенос файлов. Обещать её автоматизацию было бы
враньём.

## Что было починено по дороге

| дефект | решение |
|---|---|
| `ds:tokens` падал на пустом проекте | обход `design/figma/pages` только при наличии папки |
| каркас ссылался на шрифт Syntonia | предзагрузка убрана, заглушка `public/fonts/fonts.css` |
| `check-bindings` считал «нечего проверять» ошибкой | код 0 при пустом проекте, 2 при непустой карте без папки |
| `conveyor check --all` падал на пустом проекте | пустой объём → INCOMPLETE (3) с подсказкой |
| `measure` врал о причине на несуществующей странице | проверка `dist/<адрес>` до браузера |
| объём проверки не выводился из экспорта | скан принимает `spec.json` |
| шрифтов не было ни в одной команде | `npm run fonts` из текстовых стилей файла |
| `motion:manifest` падал на новом проекте | папка создаётся перед записью |
| «нет dist» при существующем dist | два разных сообщения в шести воротах |
| восемь красных ворот на несобранном сайте | один ответ конвейера, код 3 |
