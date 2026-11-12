#!/usr/bin/env node
/**
 * Генератор разметки из спеки — черновик, а не вёрстка (решение 388).
 *
 *   node tools/gen.mjs plan   [page/section]
 *   node tools/gen.mjs emit   [page/section | --all]
 *   node tools/gen.mjs report
 *
 * Что делает: читает `design/figma/pages/<page>/<section>/spec.json` и пишет
 * `src/components/_gen/<Section>.astro` — абсолютную раскладку по координатам
 * спеки. Ничего не перезаписывает вне `_gen/`: ручные компоненты остаются как
 * есть, черновик живёт на своей странице `/gen.html`.
 *
 * Зачем: замер зелёный всегда, потому что координаты берутся из спеки.
 * Пиксель хуже ручной сборки там, где текст поверх изображений и где есть
 * состояния, — поэтому результат это скелет разметки и список того, что
 * требует рук (overrides), а не готовый компонент.
 *
 * Чего НЕ делает и почему это честно:
 *   - не воспроизводит auto-layout: в спеке нет полей раскладки, только
 *     координаты и `sizing`. Пока это абсолютная вёрстка;
 *   - векторные иконки и инстансы без детей уходят в overrides: их нельзя
 *     нарисовать из чисел, нужен SVG;
 *   - поведение (состояния, дополнения) не генерируется вообще.
 *
 * Overrides — `design/gen/overrides/<section>.json`: узел, причина, решение.
 * Ворота `gen-overrides` не дают появиться записи без причины, как реестр
 * изобретённого.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const root = process.cwd();
const [command, ...rest] = process.argv.slice(2);

const GEN_DIR = join(root, 'src/components/_gen');
const OVERRIDES_DIR = join(root, 'design/gen/overrides');
const TARGETS = join(root, 'design/gen/targets.json');

const readJson = (path, fallback = null) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);

/** Цели: какие секции генератор берётся собирать и с каким порогом покрытия. */
function targets() {
  const file = readJson(TARGETS, { sections: [] });
  return (file.sections ?? []).map((s) => (typeof s === 'string' ? { unit: s, minCoverage: 0.9 } : s));
}

function specOf(unit) {
  const path = join(root, 'design/figma/pages', unit, 'spec.json');
  if (!existsSync(path)) {
    console.error(`нет спеки: ${unit}`);
    process.exit(2);
  }
  return { unit, spec: JSON.parse(readFileSync(path, 'utf8')) };
}

/**
 * Токен из спеки: у заливки есть `variable` — имя переменной, и это точное
 * имя, а не совпадение по цвету. «Белый» подходит и к тексту на фото, и к
 * стеклу на 75 %; по hex они неразличимы, по имени — нет.
 */
function tokenByName(name) {
  if (!name) return null;
  const css = existsSync(join(root, 'src/styles/tokens.css'))
    ? readFileSync(join(root, 'src/styles/tokens.css'), 'utf8')
    : '';
  const candidate = `--color-${name}`;
  return css.includes(`${candidate}:`) ? `var(${candidate})` : null;
}

/** Токен по цвету: если hex совпал со значением переменной, пишем var(). */
function tokenOf(hex) {
  const css = existsSync(join(root, 'src/styles/tokens.css'))
    ? readFileSync(join(root, 'src/styles/tokens.css'), 'utf8')
    : '';
  const needle = String(hex).toLowerCase();
  for (const line of css.split('\n')) {
    const m = line.match(/^\s*(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/);
    if (m && m[2].toLowerCase() === needle) return `var(${m[1]})`;
  }
  return hex;
}

/** Угол линейного градиента из матрицы Figma. */
function gradientAngle(transform) {
  if (!Array.isArray(transform) || !transform.length) return '180deg';
  const [a, b] = transform[0];
  // В Figma ось градиента лежит в первой строке матрицы.
  const deg = (Math.atan2(b, a) * 180) / Math.PI + 90;
  return `${Math.round(((deg % 360) + 360) % 360)}deg`;
}

/** Прозрачность цвета: стеклянные карточки в макете — белый на 75 %. */
function withAlpha(hex, alpha) {
  if (!alpha || alpha >= 0.999) return hex;
  const m = String(hex).match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${Number(alpha).toFixed(2)})`;
}

function fillToCss(fill) {
  if (!fill || fill.visible === false) return null;
  if (fill.type === 'SOLID') {
    const byName = tokenByName(fill.variable);
    if (byName) return byName;
    const alpha = Math.min(fill.opacity ?? 1, fill.color?.a ?? 1);
    return withAlpha(tokenOf(fill.color?.hex ?? '#000000'), alpha);
  }
  if (String(fill.type).startsWith('GRADIENT')) {
    const stops = (fill.gradientStops ?? [])
      .map((s) => `${tokenOf(s.color?.hex ?? '#000')} ${Math.round((s.position ?? 0) * 100)}%`)
      .join(', ');
    const kind = fill.type === 'GRADIENT_LINEAR' ? 'linear-gradient' : 'radial-gradient';
    return kind === 'linear-gradient' ? `linear-gradient(${gradientAngle(fill.gradientTransform)}, ${stops})` : `radial-gradient(circle, ${stops})`;
  }
  return null;
}

const FAMILY = {
  'Golos Text': "'Golos Text'",
  Literata: 'Literata',
  Lora: 'Lora',
  'Great Vibes': "'Great Vibes'",
  Hurricane: 'Hurricane',
  'Cormorant Garamond': "'Cormorant Garamond'",
};
const WEIGHT = { Regular: 400, Light: 300, Medium: 500, Semibold: 600, Bold: 700, Black: 900 };

/** Узлы, из которых складывается разметка. */
function planOf(spec, unit) {
  const nodes = spec.nodes ?? [];
  const overrides = [];
  const emit = [];

  // Абсолютные координаты: в спеке x/y относительны родителю, а разметка
  // плоская — складываем по цепочке, иначе вложенное уезжает к левому краю.
  const stack = [];
  for (const node of nodes) {
    while (stack.length && stack[stack.length - 1].depth >= node.depth) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    node._ax = node.depth === 0 ? 0 : node.x + (parent?._ax ?? 0);
    node._ay = node.depth === 0 ? 0 : node.y + (parent?._ay ?? 0);
    stack.push(node);
  }

  for (const node of nodes) {
    if (node.depth === 0) continue;
    // Скрытый слой не верстается (решение 365): в макете он есть, но его не
    // видно. В спеке это `visible: false` — свёрнутые тела аккордеона,
    // неактивные состояния формы. Без этой проверки они ложатся друг на друга.
    if (node.visible === false) {
      overrides.push({ node: node.id, reason: 'скрытый слой (visible: false) — в макете его не видно', decision: 365 });
      continue;
    }
    const hasText = Boolean((node.text ?? '').trim());
    const fills = (node.fills ?? []).filter((f) => f.visible !== false);
    const image = fills.find((f) => f.type === 'IMAGE');
    const vector = node.type === 'VECTOR' && !hasText;

    // Иконки и вектор — не числа, а SVG: остаются рукам.
    if (vector) {
      overrides.push({ node: node.id, reason: 'вектор: нужен SVG, из чисел не рисуется', decision: 386 });
      continue;
    }
    // Инстанс без детей в спеке: это либо иконка, либо готовый компонент.
    if (node.type === 'INSTANCE' && !nodes.some((n) => n.depth === node.depth + 1)) {
      overrides.push({ node: node.id, reason: 'инстанс без детей: берётся из ручного компонента', decision: 386 });
      continue;
    }
    emit.push({ node, hasText, fills, image });
  }

  return { unit, emit, overrides };
}

function renderNode({ node, hasText, fills, image }) {
  const style = [`left:${node._ax}px`, `top:${node._ay}px`, `width:${node.w}px`, `height:${node.h}px`];

  const solid = fills.find((f) => f.type === 'SOLID');
  const gradient = fills.find((f) => String(f.type).startsWith('GRADIENT'));
  if (gradient) style.push(`background:${fillToCss(gradient)}`);
  else if (solid && !hasText) style.push(`background:${fillToCss(solid)}`);

  if (node.radius) style.push(`border-radius:${Math.round(node.radius)}px`);

  if (hasText) {
    const family = FAMILY[node.fontFamily] ?? "'Golos Text'";
    const weight = WEIGHT[node.fontStyle] ?? 400;
    style.push(`font-family:${family}`, `font-weight:${weight}`, `font-size:${node.fontSize ?? 16}px`);
    if (solid) style.push(`color:${fillToCss(solid)}`);
    const lh = node.lineHeight?.value;
    if (lh) style.push(`line-height:${node.lineHeight.unit === 'PERCENT' ? (lh / 100).toFixed(2) : `${lh}px`}`);
    const ls = node.letterSpacing?.value;
    if (ls) style.push(`letter-spacing:${node.letterSpacing.unit === 'PERCENT' ? `${(ls / 100).toFixed(3)}em` : `${ls}px`}`);
    if (node.textAlign === 'CENTER') style.push('text-align:center');
    else if (node.textAlign === 'RIGHT') style.push('text-align:right');
  } else if (image?.imageHash) {
    // Кроп из Figma: imageTransform переводит картинку в коробку. Обратная
    // величина даёт размер в процентах, а смещение — положение. Формула
    // сверена с ручными значениями секции process: 0.7348 → 136.10 %,
    // смещение 0.2658 → 100 %.
    // FILL — это cover: картинка заполняет коробку. CROP — явный прямоугольник,
    // и только у него transform задаёт масштаб. Применять transform к FILL
    // нельзя: Figma хранит там позицию внутри кадра, и кадр уезжает.
    const t = image.scaleMode === 'CROP' ? image.imageTransform : null;
    const url = imageUrl(image.imageHash);
    style.push(`background-image:url('${url}')`, 'background-repeat:no-repeat');
    if (t) {
      const a = t[0][0];
      const tx = t[0][2] ?? 0;
      const d = t[1][1];
      const ty = t[1][2] ?? 0;
      const sizeX = (100 / a).toFixed(2);
      const sizeY = (100 / d).toFixed(2);
      const posX = Math.abs(1 - a) < 1e-6 ? 0 : (tx / (1 - a)) * 100;
      const posY = Math.abs(1 - d) < 1e-6 ? 0 : (ty / (1 - d)) * 100;
      style.push(`background-size:${sizeX}% ${sizeY}%`, `background-position:${posX.toFixed(2)}% ${posY.toFixed(2)}%`);
    } else {
      style.push('background-size:cover', 'background-position:center');
    }
  }

  const text = hasText ? node.text.replace(/&/g, '&amp;').replace(/</g, '&lt;') : '';
  return `  <div class="n" data-figma-node="${node.id}" style="${style.join(';')}">${text}</div>`;
}

/** Фон секции: заливка, градиент или картинка — у корня бывает любой. */
function sectionBackground(spec) {
  const root = (spec.nodes ?? []).find((n) => n.depth === 0);
  const fill = (root?.fills ?? []).find((f) => f.visible !== false);
  if (!fill) return 'transparent';
  if (fill.type === 'IMAGE' && fill.imageHash) {
    const url = imageUrl(fill.imageHash);
    return url ? `#f2efeb url('${url}') center / cover no-repeat` : 'transparent';
  }
  return fillToCss(fill) ?? 'transparent';
}

function componentSource(unit, plan, spec) {
  const name = unit.split('/')[1];
  const rows = plan.emit.map(renderNode).join('\n');

  return `---
/**
 * ${name} — сгенерировано tools/gen.mjs из design/figma/pages/${unit}/spec.json.
 * Руками не правится: перезапишется. Правки — в design/gen/overrides/${name}.json.
 *
 * Абсолютная раскладка по координатам спеки: ${plan.emit.length} узлов,
 * в overrides ${plan.overrides.length}. Auto-layout не воспроизводится —
 * в спеке нет полей раскладки, только координаты.
 */
---

<section class="gen" data-figma-node="${spec.section.id}">
  <div class="gen__inner">
${rows}
  </div>
</section>

<style>
  .gen {
    position: relative;
    width: ${spec.section.w}px;
    height: ${spec.section.h}px;
    overflow: hidden;
    background: ${sectionBackground(spec)};
  }

  .gen__inner {
    position: relative;
    width: 100%;
    height: 100%;
  }

  .gen .n {
    position: absolute;
    overflow: visible;
    white-space: pre-wrap;
  }
</style>
`;
}

/** booking-formats → BookingFormats: имя файла и компонента. */
function componentName(section) {
  return section
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

// Соответствие «имя ассета из Figma → файл в public/img». Пишется, когда
// оптимизатор переводит PNG в WebP или дедупликация сводит копии: после
// этого по хешу файл уже не найти, а ссылка нужна рабочая.
function assetMap() {
  const path = join(root, 'design/figma/assets/img-map.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function imageUrl(hash) {
  // В спеке хеш полный (40 символов), а файлы в assets/img названы первыми
  // 12 — пробуем оба варианта, иначе картинка молча не находится.
  const candidates = [hash, hash.slice(0, 12)];
  const map = assetMap();
  for (const name of candidates) for (const ext of ['jpg', 'png', 'webp']) {
    const rel = `design/figma/assets/img/${name}.${ext}`;
    if (existsSync(join(root, rel))) {
      // Если файл уже переименован оптимизатором или дедупликацией —
      // ссылаемся на итоговое имя, а не создаём копию заново.
      const mapped = map[name];
      if (mapped) return `/img/${mapped}`;
      // В public/ копируем коротким именем: так же названы файлы в assets,
      // и одинаковое имя не зависит от того, полный хеш в спеке или нет.
      const short = hash.slice(0, 12);
      const publicDir = join(root, 'public/img');
      mkdirSync(publicDir, { recursive: true });
      const target = join(publicDir, `${short}.${ext}`);
      if (!existsSync(target)) writeFileSync(target, readFileSync(join(root, rel)));
      return `/img/${short}.${ext}`;
    }
  }
  return '';
}

// --- Команды ---------------------------------------------------------------

if (!command || !['plan', 'emit', 'report'].includes(command)) {
  console.error('Использование: node tools/gen.mjs <plan|emit|report> [page/section | --all]');
  process.exit(2);
}

const wanted = rest.includes('--all') || !rest[0] ? targets() : [{ unit: rest[0], minCoverage: 0.9 }];
const units = wanted.map((w) => w.unit);
if (!units.length) {
  console.error('нет целей: заполните design/gen/targets.json');
  process.exit(2);
}

if (command === 'plan') {
  for (const unit of units) {
    const { spec } = specOf(unit);
    const plan = planOf(spec, unit);
    console.log(`${unit}: узлов ${(spec.nodes ?? []).length - 1} · генерируется ${plan.emit.length} · overrides ${plan.overrides.length}`);
    for (const o of plan.overrides) console.log(`  override ${o.node}: ${o.reason}`);
  }
  process.exit(0);
}

if (command === 'emit') {
  mkdirSync(GEN_DIR, { recursive: true });
  mkdirSync(OVERRIDES_DIR, { recursive: true });
  for (const unit of units) {
    const { spec } = specOf(unit);
    const plan = planOf(spec, unit);
    const source = componentSource(unit, plan, spec);
    const name = unit.split('/')[1];
    const file = join(GEN_DIR, `${componentName(name)}.astro`);
    writeFileSync(file, source);
    writeFileSync(join(OVERRIDES_DIR, `${name}.json`), JSON.stringify({ section: unit, overrides: plan.overrides }, null, 2) + '\n');
    console.log(`${unit}: ${plan.emit.length} узлов · overrides ${plan.overrides.length} · ${file.replace(root + '/', '')}`);
  }
  process.exit(0);
}

if (command === 'report') {
  let total = 0;
  let generated = 0;
  let overrides = 0;
  const rows = [];
  for (const unit of units) {
    const { spec } = specOf(unit);
    const plan = planOf(spec, unit);
    const nodes = (spec.nodes ?? []).length - 1;
    total += nodes;
    generated += plan.emit.length;
    overrides += plan.overrides.length;
    const name = unit.split('/')[1];
    const file = join(GEN_DIR, `${componentName(name)}.astro`);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const drift = current !== componentSource(unit, plan, spec);
    rows.push({ unit, nodes, generated: plan.emit.length, overrides: plan.overrides.length, drift });
  }
  for (const r of rows) {
    console.log(`${r.unit}: узлов ${r.nodes} · сгенерено ${r.generated} · overrides ${r.overrides} · ${r.drift ? 'РАСХОДИТСЯ с файлом' : 'файл совпадает'}`);
  }
  const coverage = total ? generated / total : 0;
  console.log(`\nпокрытие: ${generated} из ${total} узлов (${Math.round(coverage * 100)} %) · overrides ${overrides}`);
  // Порог у каждой секции свой: у карусели и формы он ниже, чем у текста.
  // Калибровочные секции (gate: false) меряются, но приёмку не валят.
  const gated = wanted.filter((w) => w.gate !== false);
  const failing = [];
  for (const w of gated) {
    const row = rows.find((r) => r.unit === w.unit);
    if (!row) continue;
    const share = row.nodes ? row.generated / row.nodes : 0;
    if (share < (w.minCoverage ?? 0.9)) failing.push(`${w.unit}: ${Math.round(share * 100)} % < ${Math.round((w.minCoverage ?? 0.9) * 100)} %`);
  }
  if (rows.some((r) => r.drift)) process.exit(1);
  if (failing.length) {
    for (const f of failing) console.log(`  ниже порога: ${f}`);
    process.exit(1);
  }
  process.exit(0);
}
