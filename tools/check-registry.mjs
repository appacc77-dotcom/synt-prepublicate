#!/usr/bin/env node
/**
 * Ворота реестров: изобретённое и долги.
 *
 *   node tools/check-registry.mjs
 *
 * Зачем: изобретённые элементы (меню без макета, «Оплата не подключена»)
 * не видны ни замеру, ни пикселю — сверять их не с чем. Если о них нет
 * записи, их забывают, и именно там заводятся расхождения (BACKLOG п. 3).
 * Долги этапа 1 (вопросы дизайнеру и заказчику) должны лежать в одном
 * месте, из которого строится отчёт о закрытии этапа.
 *
 * Проверяет:
 *   design/figma/invented.json
 *     — id уникальны, файл существует, селектор встречается в файле;
 *     — номера решений есть в docs/decisions.md;
 *     — каждая пометка data-invented="<id>" в src/ имеет запись, и каждая
 *       запись с marker: true имеет пометку;
 *     — записи без номера решения — предупреждение (решение не записано).
 *   docs/debts.json
 *     — id уникальны, статус и владелец из списка, номера решений существуют,
 *       файл источника существует.
 *
 * Код 0 — зелёные, 1 — красные. Предупреждения вердикт не меняют.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const errors = [];
const warnings = [];

function readJson(path) {
  const full = join(root, path);
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch (error) {
    errors.push(`${path}: не читается как JSON (${error.message.slice(0, 80)})`);
    return null;
  }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Номера решений из журнала: строки таблиц вида «| 76 | …».
const decisionsPath = join(root, 'docs/decisions.md');
const decisions = new Set();
if (existsSync(decisionsPath)) {
  for (const line of readFileSync(decisionsPath, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*(\d+)\s*\|/);
    if (m) decisions.add(Number(m[1]));
  }
}
const checkDecisions = (where, list) => {
  for (const n of list ?? []) {
    if (!decisions.has(n)) errors.push(`${where}: решения №${n} нет в docs/decisions.md`);
  }
};

// --- Изобретённое ------------------------------------------------------------
const invented = readJson('design/figma/invented.json');
const inventedIds = new Set();
if (!invented) {
  if (!errors.length) warnings.push('design/figma/invented.json нет — реестр изобретённого не ведётся');
} else {
  for (const entry of invented.entries ?? []) {
    const where = `invented/${entry.id ?? '?'}`;
    if (!entry.id) {
      errors.push(`${where}: нет id`);
      continue;
    }
    if (inventedIds.has(entry.id)) errors.push(`${where}: id повторяется`);
    inventedIds.add(entry.id);
    if (!['invented', 'external', 'designer'].includes(entry.origin)) {
      errors.push(`${where}: origin «${entry.origin}» — ожидается invented / external / designer`);
    }
    if (!entry.file || !existsSync(join(root, entry.file))) {
      errors.push(`${where}: файла ${entry.file} нет`);
    } else if (entry.selector) {
      const cls = entry.selector.replace(/^\./, '');
      if (!readFileSync(join(root, entry.file), 'utf8').includes(cls)) {
        errors.push(`${where}: селектора ${entry.selector} нет в ${entry.file} — запись устарела`);
      }
    }
    checkDecisions(where, entry.decisions);
    if (!(entry.decisions ?? []).length) warnings.push(`${where}: нет номера решения — записать в docs/decisions.md`);
  }

  // Пометки в разметке ↔ записи.
  const markers = new Map();
  for (const file of walk(join(root, 'src'))) {
    if (!/\.(astro|ts|js|mjs|html)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/data-invented=["']([^"']+)["']/g)) {
      markers.set(m[1], relative(root, file));
    }
  }
  for (const [id, file] of markers) {
    if (!inventedIds.has(id)) errors.push(`${file}: data-invented="${id}" без записи в design/figma/invented.json`);
  }
  for (const entry of invented.entries ?? []) {
    if (entry.marker && !markers.has(entry.id)) {
      errors.push(`invented/${entry.id}: marker: true, но data-invented="${entry.id}" в src/ нет`);
    }
  }
}

// Анимации ведутся в своём манифесте; здесь только проверяем номера решений.
const motion = readJson('design/motion/motion.json');
let motionInvented = 0;
for (const entry of motion?.entries ?? []) {
  if (String(entry.status ?? '').startsWith('invented')) motionInvented++;
  if (entry.decision) checkDecisions(`motion/${entry.file}${entry.selector}`, [entry.decision]);
}

// --- Долги -------------------------------------------------------------------
const debtsDoc = readJson('docs/debts.json');
const counts = {};
if (!debtsDoc) {
  if (!existsSync(join(root, 'docs/debts.json'))) warnings.push('docs/debts.json нет — реестр долгов не ведётся');
} else {
  const statuses = debtsDoc.statuses ?? ['open', 'waiting', 'done', 'rejected'];
  const owners = debtsDoc.owners ?? ['designer', 'client', 'owner', 'studio'];
  const ids = new Set();
  for (const debt of debtsDoc.debts ?? []) {
    const where = `debts/${debt.id ?? '?'}`;
    if (!debt.id) {
      errors.push(`${where}: нет id`);
      continue;
    }
    if (ids.has(debt.id)) errors.push(`${where}: id повторяется`);
    ids.add(debt.id);
    if (!statuses.includes(debt.status)) errors.push(`${where}: статус «${debt.status}» не из списка`);
    if (!owners.includes(debt.owner)) errors.push(`${where}: владелец «${debt.owner}» не из списка`);
    const file = String(debt.source ?? '').split('#')[0];
    if (file && !existsSync(join(root, file))) errors.push(`${where}: источника ${file} нет`);
    checkDecisions(where, debt.decisions);
    counts[debt.status] = (counts[debt.status] ?? 0) + 1;
  }
}

// --- Итог --------------------------------------------------------------------
console.log(
  `изобретённое: ${inventedIds.size} записей` +
    (motion ? `, анимаций invented в манифесте ${motionInvented}` : ''),
);
console.log(
  `долги: ${Object.entries(counts)
    .map(([status, n]) => `${status} ${n}`)
    .join(', ') || 'нет'}`,
);
for (const w of warnings) console.log(`  предупреждение: ${w}`);
if (errors.length) {
  console.error(`\nкрасных ${errors.length}:`);
  for (const e of errors.slice(0, 30)) console.error(`  ${e}`);
  process.exit(1);
}
console.log('реестры согласованы');
