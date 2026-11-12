# Задание агенту: собрать одну секцию

Ты собираешь **одну** секцию по макету Figma. Работай изолированно: не трогай
главную страницу и чужие компоненты.

## Что прочитать сначала

1. `AGENTS.md` — правила проекта (§2 «Принципы переноса» обязателен).
2. Скилы: `figma-build` (как собирать) и `figma-gates` (как проверять).
3. `design/figma/pages/<page>/<section>/spec.json` — числа твоей секции.
4. `design/figma/pages/<page>/<section>/crop.png` — эталон, с ним сравнивают.

## Что сделать

### 1. Компонент

`src/components/<Имя>.astro` — имя из спеки, в PascalCase.

- `data-figma-node` на каждом элементе, который есть в спеке;
- раскладка из `autoLayout` (режим, `gap`, `pad`, выравнивания);
- `sizing`, `align`, `absolute` — из спеки, не на глаз;
- текст: классы из `src/styles/typography.css` по полю `styleName`;
- цвета: только `var(--color-…)`, отступы: только `var(--space-…)`;
- `scaleMode: CROP` → `background-size: 100/m00 × 100/m11`, `position: m02/(1−m00) × m12/(1−m11)`;
- `scaleMode: FILL` → размер `m00×100% × m11×100%`, позиция та же;
- обводка `INSIDE` → `box-shadow: inset 0 0 0 <w>px`, а не `border`;
- текст с фиксированной шириной из узла и нерусским переносом → `white-space: nowrap`;
- несколько стилей в одном абзаце (`segments`) → несколько `<span>`.

### 2. Ассеты

Копируй из `design/figma/assets/img` и `design/figma/assets/svg` в `public/img` и
`public/svg`. Имена делай уникальными: `<section>-<что>.png`.

Иконки лучше инлайновым SVG-компонентом с `currentColor`, а не `<img>`: файл
легко забыть скопировать, и ворота геометрии этого не заметят.

В конце — `npm run assets:check`: все ссылки должны существовать.

### 3. Изолированная страница

`src/pages/check-<page>-<section>.astro` — только твоя секция:

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
import Имя from '../components/Имя.astro';
---

<BaseLayout title="Проверка: <page>/<section>">
  <main class="page">
    <Имя ... />
  </main>
</BaseLayout>
```

Файл **не** должен начинаться с подчёркивания — Astro такие не собирает.

### 4. Проверка

Сборка и замер идут через замок: все агенты собирают один `dist/`, и без замка
они затопчут друг друга.

```bash
node tools/lock.mjs "npm run build && node tools/measure.mjs design/figma/pages/<page>/<section>/spec.json --url /check-<page>-<section>.html"
```

Готово, когда `вердикт: зелёные · расхождений 0`.

Красное почти всегда одно из: лишний паддинг, `min-width: auto` у flex-элемента,
рамка вместо inset-тени, текст шире эталона на доли пикселя (тогда ширина из узла),
или `flex-basis: 0` вместо `50%`.

### 5. Пиксель

```bash
node tools/lock.mjs "npm run shot -- .<класс> .screens/<page>-<section>.png 1440 --url /check-<page>-<section>.html"
node tools/compare -- design/figma/pages/<page>/<section>/crop.png .screens/<page>-<section>.png
```

Пиксель — сигнал, а не приёмка: 1–3 хорошо, 5 — заметная разница в фото, 10+ —
что-то не то. Если больше 10 — разберись, в чём дело, прежде чем сдавать.

## Границы

**Можно менять только:**

- `src/components/<Имя>.astro` (свой)
- `src/pages/check-<page>-<section>.astro` (свой)
- `public/img/*`, `public/svg/*` (свои файлы)

**Нельзя:** `src/pages/index.astro`, чужие компоненты, `tools/`, `skills/`,
`docs/`, `design/figma/**`, `package.json`.

## Что вернуть

Отчёт с числами, без впечатлений:

```
компонент: src/components/<Имя>.astro
страница:  src/pages/check-<page>-<section>.astro
геометрия: зелёные, расхождений 0 (N узлов)
пиксель:   X.XX
ассеты:    public/img/... (N файлов)
заметки:   что оказалось неочевидным в спеке
```

Если три итерации подряд красные по одному и тому же числу — остановись и
напиши, что именно не сходится.
