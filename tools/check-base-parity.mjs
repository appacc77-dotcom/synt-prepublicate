#!/usr/bin/env node
/**
 * Совместимость слоёв: дополнения не меняют основу.
 *
 *   node tools/check-base-parity.mjs
 *
 * Собирает дважды — «только из макета» и обычную, — замеряет все секции в
 * обеих сборках и сравнивает gate.json. Расхождение допустимо только там,
 * где дополнение явно объявило, что меняет это место (`allowedChanges` в
 * design/enhancements.json).
 *
 * Дорого (две сборки и два замера) — поэтому только в accept-stage2.
 *
 * Коды: 0 — основа та же, 1 — дополнения сдвинули основу, 2 — не смогли.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const pagesRoot = join(root, 'design/figma/pages');
const reportsDir = join(root, 'reports/base-parity');

if (!existsSync(pagesRoot)) {
  console.error('нет design/figma/pages — нечего сравнивать');
  process.exit(2);
}

const run = (command, args) =>
  spawnSync(command, args, { cwd: root, stdio: 'pipe', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' } });

/** Все секции из карты: спека, адрес страницы, способ найти корень. */
const project = JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8'));
const routes = project.routes ?? {};
const unitUrls = project.unitUrls ?? {};
const sharedNodes = project.shared ?? {};
const unitArgs = project.unitArgs ?? {};
const unitUrl = (unit) => unitUrls[unit] ?? routes[unit.split('/')[0]] ?? '/';

// Общие секции (шапка, подвал) стоят на каждой странице своим инстансом:
// корень ищется по id компонента, остальные узлы — по суффиксу.
function argsFor(unit) {
  if (unitArgs[unit]) return unitArgs[unit];
  const node = sharedNodes[unit.split('/').pop()];
  return node ? ['--root', node, '--by-suffix'] : [];
}
const units = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name === 'spec.json') {
      const unit = path.split(join(root, 'design/figma/pages/'))[1].replace('/spec.json', '');
      // Компоненты дизайн-системы живут вне страниц: у них свой адрес /ds,
      // и в базовой сборке их сравнивать не с чем.
      if (!unit.startsWith('design-system/')) units.push(unit);
    }
  }
};
walk(pagesRoot);

if (!units.length) {
  console.error('секций нет — сравнивать нечего');
  process.exit(2);
}

/** Замер всех секций одной сборки: пишет gate.json рядом со спеками. */
function measureAll(label) {
  const jobs = units.map((unit) => {
    const extra = argsFor(unit);
    const rootIndex = extra.indexOf('--root');
    return {
      spec: `design/figma/pages/${unit}/spec.json`,
      url: unitUrl(unit),
      ...(rootIndex >= 0 ? { root: extra[rootIndex + 1] } : {}),
      ...(extra.includes('--by-suffix') ? { bySuffix: true } : {}),
    };
  });
  const jobsFile = join(reportsDir, `jobs-${label}.json`);
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(jobsFile, JSON.stringify(jobs, null, 1) + '\n');
  const result = run(process.execPath, [join(root, 'tools/measure.mjs'), '--batch', jobsFile]);
  // 0 и 1 — рабочие исходы замера: зелёные ворота или красные. Оба дают
  // gate.json, который мы и сравниваем. Сбой среды — 2 и прочее.
  if (result.status !== 0 && result.status !== 1) {
    console.error(`замер ${label} не прошёл: ${String(result.stderr).slice(-300)}`);
    return false;
  }
  return true;
}

/** Снимок gate.json в reports/base-parity/<label>/<unit>.json. */
function collectGates(label) {
  const dir = join(reportsDir, label);
  mkdirSync(dir, { recursive: true });
  const gates = new Map();
  for (const unit of units) {
    const path = join(pagesRoot, unit, 'gate.json');
    if (!existsSync(path)) continue;
    copyFileSync(path, join(dir, `${unit.replace('/', '-')}.json`));
    gates.set(unit, JSON.parse(readFileSync(path, 'utf8')));
  }
  return gates;
}

// --- 1. Основа -------------------------------------------------------------
const buildBase = run('npm', ['run', 'build:base']);
if (buildBase.status !== 0) {
  console.error('base-сборка не прошла');
  process.exit(2);
}
if (!measureAll('base')) process.exit(2);
const baseGates = collectGates('base');

// --- 2. Основа с дополнениями ---------------------------------------------
const buildFull = run('npm', ['run', 'build']);
if (buildFull.status !== 0) {
  console.error('обычная сборка не прошла');
  process.exit(2);
}
if (!measureAll('composed')) process.exit(2);
const composedGates = collectGates('composed');

// --- 3. Сравнение ----------------------------------------------------------
const enhancements = existsSync(join(root, 'design/enhancements.json'))
  ? JSON.parse(readFileSync(join(root, 'design/enhancements.json'), 'utf8')).enhancements ?? {}
  : {};
// Разрешённые изменения: дополнение может объявить, какие секции ему можно
// двигать. Сейчас таких нет — значит основа должна совпадать до пикселя.
const allowed = new Set();
for (const item of Object.values(enhancements)) {
  for (const unit of item.allowedSections ?? []) allowed.add(unit);
}

const problems = [];
let compared = 0;
for (const unit of units) {
  const base = baseGates.get(unit);
  const composed = composedGates.get(unit);
  if (!base || !composed) {
    problems.push(`${unit}: нет замера в одной из сборок`);
    continue;
  }
  compared += 1;
  if (base.ok !== composed.ok) {
    if (!allowed.has(unit)) problems.push(`${unit}: вердикт ${base.ok ? 'зелёный' : 'красный'} в base, ${composed.ok ? 'зелёный' : 'красный'} в обычной`);
    continue;
  }
  if (base.worstDelta !== composed.worstDelta) {
    const delta = Math.abs((base.worstDelta ?? 0) - (composed.worstDelta ?? 0));
    if (delta > 1 && !allowed.has(unit)) {
      problems.push(`${unit}: худшее расхождение ${base.worstDelta} → ${composed.worstDelta} (сдвиг ${delta.toFixed(2)} px)`);
    }
  }
  if ((base.marked ?? 0) !== (composed.marked ?? 0) && !allowed.has(unit)) {
    problems.push(`${unit}: размечено ${base.marked} в base, ${composed.marked} с дополнениями`);
  }
}

if (problems.length) {
  console.error(`совместимость слоёв: сверено ${compared} · проблем ${problems.length}`);
  for (const problem of problems.slice(0, 12)) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`совместимость слоёв: ${compared} секций · основа не изменилась от дополнений`);
