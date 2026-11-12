#!/usr/bin/env node
/**
 * Ворота манифеста движения.
 *
 *   node tools/check-motion-manifest.mjs           # проверить
 *   node tools/check-motion-manifest.mjs --write   # пересобрать манифест
 *
 * Правило проекта: каждая анимация и каждый переход описаны в
 * `design/motion/motion.json` — с источником (`status`) и номером решения.
 * Анимация без записи — такой же дефект, как неучтённый `@media`: её никто не
 * решал, она просто появилась.
 *
 * Второе правило: длительность берётся из `src/styles/motion.css`, а не числом
 * в компоненте. Литерал `0.3s` в объявлении — дефект, даже если он «такой же».
 *
 * Разбор один и тот же для проверки и для записи: иначе манифест и код
 * разойдутся молча.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const root = process.cwd();
const manifestPath = join(root, 'design/motion/motion.json');
const write = process.argv.includes('--write');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Объявления transition/animation с их селекторами. Один разбор на всех. */
export function scanMotion() {
  const files = [
    ...walk(join(root, 'src')).filter((f) => f.endsWith('.astro')),
    ...walk(join(root, 'src/styles')).filter((f) => f.endsWith('.css')),
  ].sort();

  const found = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    // В .astro стили живут в <style>; разметка и frontmatter — не CSS.
    const isAstro = file.endsWith('.astro');
    const start = isAstro ? source.indexOf('<style') : 0;
    const end = isAstro ? source.indexOf('</style>', Math.max(0, start)) : -1;
    if (isAstro && start < 0) continue;
    const body = isAstro ? source.slice(start, end > 0 ? end : undefined) : source;
    // Разбор правил: снимаем комментарии и идём по блокам со счётчиком
    // скобок. Построчный разбор путался на `@media` и на универсальном `*`:
    // селектором становилось «}, }, [data-enhancements='off'] *».
    const clean = body.replace(/\/\*[\s\S]*?\*\//g, '');
    const stack = [];
    let buf = '';
    let lineNo = 1;
    const pending = [];
    for (let i = 0; i < clean.length; i += 1) {
      const ch = clean[i];
      if (ch === '\n') lineNo += 1;
      if (ch === '{') {
        stack.push({ selector: buf.trim().replace(/^[},]+/, '').replace(/\s+/g, ' ').trim(), depth: stack.length });
        buf = '';
        continue;
      }
      if (ch === '}') {
        const ctx = stack.pop();
        if (ctx && !ctx.selector.startsWith('@')) {
          for (const decl of pending) {
            if (decl.depth === ctx.depth + 1) {
              found.push({ file: relative(root, file), selector: ctx.selector, line: decl.line, declaration: decl.text });
            }
          }
        }
        for (let k = pending.length - 1; k >= 0; k -= 1) if (pending[k].depth > stack.length) pending.splice(k, 1);
        buf = '';
        continue;
      }
      if (ch === ';') {
        const text = buf.trim();
        if (text && /^(transition|animation)(-property|-duration)?\s*:/.test(text)) {
          const ctx = stack[stack.length - 1];
          if (ctx && !ctx.selector.includes('prefers-reduced-motion')) {
            pending.push({ depth: stack.length, text: text.replace(/;$/, ''), line: lineNo });
          }
        }
        buf = '';
        continue;
      }
      buf += ch;
    }
  }
  return found;
}

const found = scanMotion();

// Сгруппируем по file + selector: у одного правила бывает несколько объявлений.
const rules = new Map();
for (const item of found) {
  const key = `${item.file}::${item.selector}`;
  if (!rules.has(key)) rules.set(key, { file: item.file, selector: item.selector, declarations: [] });
  rules.get(key).declarations.push(item.declaration);
}

const LITERAL = /(^|[\s,(])(\d*\.?\d+)m?s\b/;
// Внутренние страницы (структура, дизайн-система) — инструмент, не дизайн:
// их длительности выбираются по удобству и не переносятся из макета.
const TOOL_PAGES = ['src/pages/structure.astro', 'src/pages/ds.astro'];

if (write) {
  const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { entries: [] };
  const byKey = new Map(previous.entries.map((e) => [`${e.file}::${e.selector}`, e]));
  const entries = [...rules.values()].map((rule) => {
    const old = byKey.get(`${rule.file}::${rule.selector}`);
    return {
      file: rule.file,
      selector: rule.selector,
      declaration: rule.declarations.join(' '),
      status: old?.status ?? 'invented',
      decision: old?.decision ?? 0,
    };
  });
  // Новый проект: папки `design/motion` ещё нет — создаём, иначе запись
  // падает с ENOENT на ровном месте.
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        version: 1,
        note: 'Каждая анимация и переход в src/ описаны здесь. status: invented:baseline — общий слой, invented — точечное решение, invented:tool — внутренняя страница, figma — из макета. decision — номер записи в docs/decisions.md.',
        entries,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`манифест записан: ${entries.length} записей`);
  process.exit(0);
}

if (!existsSync(manifestPath)) {
  console.error('нет design/motion/motion.json — соберите: npm run motion:manifest -- --write');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entries = new Map(manifest.entries.map((e) => [`${e.file}::${e.selector}`, e]));

const problems = [];

// 1. Каждое объявление описано.
for (const [key, rule] of rules) {
  if (!entries.has(key)) {
    problems.push({ kind: 'нет записи', file: rule.file, selector: rule.selector });
  }
}

// 2. Объявление не разошлось с кодом. Ключ «файл + селектор» этого не ловит:
// сменил значение в CSS — запись осталась старой и молчит.
for (const [key, rule] of rules) {
  const entry = entries.get(key);
  if (!entry) continue;
  const current = rule.declarations.join(' ');
  if ((entry.declaration ?? '') !== current) {
    problems.push({
      kind: 'объявление разошлось',
      file: rule.file,
      selector: rule.selector,
      declaration: `в манифесте «${entry.declaration ?? '—'}», в коде «${current}»`,
    });
  }
}

// 3. Каждая запись имеет источник и решение.
for (const [key, entry] of entries) {
  if (!entry.status) problems.push({ kind: 'нет status', file: entry.file, selector: entry.selector });
  if (!entry.decision) problems.push({ kind: 'нет decision', file: entry.file, selector: entry.selector });
  if (!rules.has(key)) problems.push({ kind: 'запись без кода', file: entry.file, selector: entry.selector });
}

// 4. Длительность — токеном, не числом.
for (const [key, rule] of rules) {
  for (const declaration of rule.declarations) {
    // `!important` — это защита reduced-motion: там длительность обязана быть
    // числом, чтобы перебить любой переход.
    if (TOOL_PAGES.includes(rule.file) || declaration.includes('!important')) continue;
    if (LITERAL.test(declaration) && !declaration.includes('var(--motion')) {
      problems.push({ kind: 'длительность числом', file: rule.file, selector: rule.selector, declaration });
    }
  }
}

console.log(`правил с движением: ${rules.size} · записей в манифесте: ${entries.size}`);

if (!problems.length) {
  console.log('все анимации описаны, длительности из токенов');
  process.exit(0);
}

console.error(`\nпроблем: ${problems.length}`);
for (const p of problems.slice(0, 20)) {
  const extra = p.declaration ? ` — ${p.declaration}` : '';
  console.error(`  ${p.kind}: ${p.file} ${p.selector}${extra}`);
}
console.error('\nзапись обязана совпадать с кодом: движение без записи — это движение, которого никто не решал,');
console.error('а разошедшаяся запись — манифест, которому больше нельзя верить. Пересобрать: npm run motion:manifest');
process.exit(1);
