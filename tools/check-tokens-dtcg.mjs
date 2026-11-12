#!/usr/bin/env node
/**
 * Токены в формате DTCG: схема и совпадение с CSS.
 *
 *   node tools/check-tokens-dtcg.mjs
 *
 * Зачем: `design/tokens.json` — стабильный обменный формат (W3C Design
 * Tokens 2025.10). Если он разойдётся с `tokens.css`, инструменты будут
 * читать одно, а вёрстка использовать другое.
 *
 * Коды: 0 — сходится, 1 — расхождение, 2 — нечего проверять.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const jsonPath = join(root, 'design/tokens.json');
const cssPath = join(root, 'src/styles/tokens.css');

if (!existsSync(jsonPath) || !existsSync(cssPath)) {
  console.error('нет design/tokens.json или src/styles/tokens.css — сначала npm run ds:tokens');
  process.exit(2);
}

const tokens = JSON.parse(readFileSync(jsonPath, 'utf8'));
const css = readFileSync(cssPath, 'utf8');
const problems = [];
let checked = 0;

const walk = (node, path) => {
  if (node && typeof node === 'object' && '$value' in node) {
    checked += 1;
    const type = node.$type;
    const value = node.$value;
    if (!type) problems.push(`${path}: нет $type`);
    if (type === 'dimension') {
      if (typeof value !== 'object' || typeof value.value !== 'number' || value.unit !== 'px') {
        problems.push(`${path}: dimension должен быть {value: число, unit: "px"}`);
      }
    } else if (type === 'color') {
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
        problems.push(`${path}: цвет не в виде #rrggbb или #rrggbbaa — ${value}`);
      }
    }
    return;
  }
  for (const [key, child] of Object.entries(node ?? {})) walk(child, `${path}/${key}`);
};

walk(tokens, '');

// Сверка с CSS: каждое значение из JSON должно быть в переменных CSS.
const cssVars = new Map();
for (const match of css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) cssVars.set(match[1], match[2].trim());

for (const [group, branch] of Object.entries(tokens)) {
  for (const [name, token] of Object.entries(branch)) {
    const cssName = token.$type === 'color' ? `color-${name}` : name;
    const expected = token.$type === 'dimension' ? `${token.$value.value}px` : token.$value;
    const actual = cssVars.get(cssName);
    if (!actual) {
      problems.push(`${group}/${name}: нет переменной --${cssName} в tokens.css`);
      continue;
    }
    // CSS пишет цвет функцией (rgba), DTCG — строкой hex8: сравниваем
    // приведённые значения, а не написание.
    const normalize = (value) => {
      const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/.exec(String(value).trim());
      if (!rgba) return String(value).toLowerCase();
      const hex = (n) => Number(n).toString(16).padStart(2, '0');
      const alpha = rgba[4] === undefined ? '' : hex(Math.round(Number(rgba[4]) * 255));
      return `#${hex(rgba[1])}${hex(rgba[2])}${hex(rgba[3])}${alpha}`;
    };
    if (normalize(actual) !== normalize(expected)) {
      problems.push(`${group}/${name}: в JSON ${expected}, в CSS ${actual}`);
    }
  }
}

if (problems.length) {
  console.error(`токены DTCG: ${checked} значений · проблем ${problems.length}`);
  for (const problem of problems.slice(0, 10)) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`токены DTCG: ${checked} значений · схема и CSS совпадают`);
