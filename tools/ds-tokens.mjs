#!/usr/bin/env node
/**
 * Генератор токенов из живого файла Figma.
 *
 * Вход:  design/figma/live/ds.json        — переменные (spacing, radius, colors)
 *        design/figma/live/reality.json   — определения текстовых и paint-стилей
 * Выход: src/styles/tokens.css            — переменные
 *        src/styles/typography.css        — текстовые стили
 *
 * Руками не правится: запусти `npm run ds:tokens` после чтения файла.
 * Имена 1:1 с Figma: `space-xs` → `--space-xs`, `bg-page` → `--color-bg-page`.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const live = join(root, 'design/figma/live');

/** В выводе моста перед JSON бывает строка предупреждения линтера. */
function loadJson(path) {
  const text = readFileSync(path, 'utf8');
  const at = text.indexOf('{');
  return JSON.parse(text.slice(at));
}

const hex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');

/** id → token, чтобы разрешать VARIABLE_ALIAS вместо выдумывания цвета. */
let byId;

function resolveColor(c, depth = 0) {
  if (!c || depth > 4) return null;
  // Форма alias: { color: {type: VARIABLE_ALIAS, id}, opacity } или просто {type, id}
  const inner = c.color ?? c;
  if (inner.type === 'VARIABLE_ALIAS') {
    const target = byId.get(inner.id);
    if (!target) return null;
    const base = resolveColor(target.value, depth + 1);
    return base && c.opacity != null ? withAlpha(base, c.opacity / 100) : base;
  }
  if (typeof inner.r !== 'number') return null;
  const a = inner.a ?? 1;
  const base = `#${hex(inner.r)}${hex(inner.g)}${hex(inner.b)}`;
  const eff = c.opacity != null ? (c.opacity / 100) * a : a;
  return eff >= 0.999 ? base : withAlpha(base, eff);
}

function withAlpha(hexColor, a) {
  if (!hexColor?.startsWith('#')) return hexColor;
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
}

const WEIGHT = {
  Thin: 100, ExtraLight: 200, Light: 300, Regular: 400, Medium: 500,
  SemiBold: 600, Bold: 700, ExtraBold: 800, Black: 900,
};

const ds = loadJson(join(live, 'ds.json'));
const reality = loadJson(join(live, 'reality.json')).result ?? loadJson(join(live, 'reality.json'));
const project = loadJson(join(root, 'design/figma/project.json'));

// Семейства и их запасные шрифты — данные проекта: в другом проекте другие
// шрифты, и инструмент не должен знать про них. Если стека нет — собирается
// простой fallback из имени семейства.
const STACK = project.fonts ?? {};
byId = new Map(ds.tokens.map((t) => [t.id, t]));
const liveName = project.source?.fileName ?? 'live';
const liveKey = project.source?.fileKey ?? '';
const liveAt = new Date().toISOString().slice(0, 10);

// ---------- tokens.css ----------
const groups = new Map();
for (const t of ds.tokens) {
  const g = t.collection ?? 'Other';
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(t);
}

const out = [
  '/* Сгенерировано tools/ds-tokens.mjs из живого файла Figma. Не править руками. */',
  `/* Источник: ${liveName} · ${liveKey} · прочитано ${liveAt} */`,
  '',
  ':root {',
];
const skipped = [];

const SECTION = {
  Spacing: 'Отступы',
  Radius: 'Радиусы',
  Colors: 'Цвета',
  Stroke: 'Обводки',
  Layout: 'Раскладка',
};

// DTCG 2025.10: цвет — строка #rrggbb или #rrggbbaa, поэтому rgba()
// переводим в hex8: формат не знает функции CSS.
const dtcgColor = (value) => {
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/.exec(value);
  if (!rgba) return value;
  const hex = (n) => Number(n).toString(16).padStart(2, '0');
  const alpha = rgba[4] === undefined ? '' : hex(Math.round(Number(rgba[4]) * 255));
  return `#${hex(rgba[1])}${hex(rgba[2])}${hex(rgba[3])}${alpha}`;
};

// DTCG 2025.10: стабильный формат токенов для обмена между инструментами.
// CSS ниже строится из тех же значений, поэтому формат и вёрстка не разъедутся.
const dtcg = {};

for (const [group, items] of groups) {
  out.push(`  /* ${SECTION[group] ?? group} */`);
  const branch = (dtcg[group] = {});
  for (const t of items) {
    let value;
    if (t.type === 'COLOR') {
      value = resolveColor(t.value);
      if (!value) { skipped.push(`${t.collection}/${t.name}`); continue; }
      branch[t.name] = { $type: 'color', $value: dtcgColor(value) };
    } else {
      value = `${t.value}px`;
      branch[t.name] = { $type: 'dimension', $value: { value: t.value, unit: 'px' } };
    }
    const name = t.type === 'COLOR' ? `--color-${t.name}` : `--${t.name}`;
    out.push(`  ${name}: ${value};`);
  }
  out.push('');
}
out.push('}');
out.push('');

// ---------- typography.css ----------
const families = new Set();
for (const s of reality.textStyles) families.add(s.font.family);

// Семейства из «сырого» текста: в файле есть узлы, набранные размером без
// текстового стиля (Cormorant Garamond в hero страницы практик). Из стилей
// они не видны, и токена не было — компонент падал в подстановочный шрифт.
const specFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name === 'spec.json') specFiles.push(path);
  }
};
// На холодном старте секций ещё нет: папка появляется с первым экспортом.
// Без проверки `ds:tokens` падал на пустом проекте, хотя токены берутся
// из снимка файла, а не из спек.
const pagesDir = join(root, 'design/figma/pages');
if (existsSync(pagesDir)) walk(pagesDir);
for (const specPath of specFiles) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  for (const node of spec.nodes ?? []) {
    if (node.fontFamily) families.add(node.fontFamily);
  }
}

const typo = [
  '/* Сгенерировано tools/ds-tokens.mjs из живого файла Figma. Не править руками. */',
  '',
  ':root {',
];
for (const f of [...families].sort()) {
  const stack = STACK[f] ?? `"${f}", sans-serif`;
  const varName = `--font-${f.toLowerCase().replace(/\s+/g, '-')}`;
  typo.push(`  ${varName}: ${stack};`);
}
typo.push('}');
typo.push('');

/**
 * Figma считает высоту текстового узла как ОКРУГЛЁННУЮ высоту строки × число
 * строк: H4 38,57 → 39, script-m 71,4 → 71, script-xl 68,75 → 69. Если оставить
 * дробь, каждый блок расходится на 0,3–1,3 px и расхождение копится вниз по дереву.
 */
const lineHeight = (s) => {
  const lh = s.lineHeight;
  if (!lh) return 'normal';
  if (lh.unit === 'PIXELS') return `${Math.round(lh.value)}px`;
  if (lh.unit === 'PERCENT') return `${Math.round((s.size * lh.value) / 100)}px`;
  return 'normal';
};

const tracking = (s) => {
  const ls = s.letterSpacing;
  if (!ls || !ls.value) return '0';
  if (ls.unit === 'PIXELS') return `${+ls.value.toFixed(3)}px`;
  if (ls.unit === 'PERCENT') return `${+(ls.value / 100).toFixed(4)}em`;
  return '0';
};

for (const s of reality.textStyles) {
  const cls = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const family = `var(--font-${s.font.family.toLowerCase().replace(/\s+/g, '-')})`;
  const weight = WEIGHT[s.font.style] ?? s.font.variationSettings?.wght ?? 400;
  const caseRule = s.textCase === 'UPPER' ? 'uppercase' : s.textCase === 'LOWER' ? 'lowercase' : null;
  typo.push(`/* ${s.name} */`);
  typo.push(`.t-${cls} {`);
  typo.push(`  font-family: ${family};`);
  typo.push(`  font-weight: ${weight};`);
  typo.push(`  font-size: ${+s.size.toFixed(2)}px;`);
  typo.push(`  line-height: ${lineHeight(s)};`);
  typo.push(`  letter-spacing: ${tracking(s)};`);
  if (caseRule) typo.push(`  text-transform: ${caseRule};`);
  typo.push('}');
  typo.push('');
}

mkdirSync(join(root, 'src/styles'), { recursive: true });
writeFileSync(join(root, 'src/styles/tokens.css'), out.join('\n'));

// Тот же набор — в стабильном формате W3C Design Tokens.
mkdirSync(join(root, 'design'), { recursive: true });
writeFileSync(join(root, 'design/tokens.json'), JSON.stringify(dtcg, null, 2) + '\n');
writeFileSync(join(root, 'src/styles/typography.css'), typo.join('\n'));

const tokenCount = out.filter((l) => l.trim().startsWith('--')).length;
console.log(`tokens.css:     ${tokenCount} переменных`);
console.log(`typography.css: ${reality.textStyles.length} стилей, ${families.size} семейств`);
if (skipped.length) {
  // Неразрешённый токен — это не «мелочь»: переменная не создана, а
  // `var(--x)` без неё молча обнуляет свойство. Это не проверено, а не
  // проверено и чисто: код 3, как у остальных INCOMPLETE.
  console.error(`не разрешено: ${skipped.length} — ${skipped.join(', ')}`);
  console.error('токен не создан: var() без него обнулит свойство');
  process.exit(3);
}
console.log('не разрешено: 0');
