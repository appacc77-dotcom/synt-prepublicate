#!/usr/bin/env node
/**
 * Контракты проверок: файл и конвейер не должны разойтись.
 *
 *   node tools/check-contracts.mjs
 *
 * Что проверяется:
 *   - у каждого шага конвейера есть запись, и наоборот;
 *   - слои и профили — из объявленных;
 *   - dependsOn ссылается на существующие проверки, циклов нет;
 *   - inputs — существующие пути или глоб с существующим началом;
 *   - у каждой проверки есть timeoutMs и retryPolicy.
 *
 * Коды: 0 — контракты сходятся, 1 — расхождение, 2 — не смогли прочитать.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const contractsPath = join(root, 'tools/checks.json');
const conveyorPath = join(root, 'tools/conveyor.mjs');

if (!existsSync(contractsPath) || !existsSync(conveyorPath)) {
  console.error('нет tools/checks.json или tools/conveyor.mjs');
  process.exit(2);
}

let contracts;
try {
  contracts = JSON.parse(readFileSync(contractsPath, 'utf8'));
} catch (error) {
  console.error(`checks.json не читается: ${error.message}`);
  process.exit(2);
}

const problems = [];
const known = new Set(Object.keys(contracts.checks ?? {}));
const layers = new Set(Object.keys(contracts.layers ?? {}));
const profiles = new Set(Object.keys(contracts.profiles ?? {}));

// --- 1. Шаги конвейера против контрактов -----------------------------------
// Состав шагов спрашиваем у самого конвейера (`plan --json`), а не ищем
// регуляркой по исходнику: шаг, собранный динамически или иначе
// отформатированный, выпадал из сверки молча.
const stepIds = new Set();
const askPlan = (args) => {
  const plan = JSON.parse(
    execFileSync(process.execPath, [conveyorPath, 'plan', ...args, '--json'], { encoding: 'utf8', cwd: root, timeout: 60000 }),
  );
  for (const step of plan.steps ?? []) stepIds.add(step.id);
};
try {
  // Общий план даёт шаги проекта; план по секции добавляет measure, shot и
  // visual — они появляются только в режиме единицы.
  askPlan([]);
  const project = JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8'));
  const sample = (project.acceptance ?? [])[0];
  if (sample) askPlan(['--unit', sample]);
} catch (error) {
  console.error(`не удалось получить план шагов из конвейера: ${String(error.message).slice(0, 200)}`);
  process.exit(2);
}
// Пакетный замер и обычный имеют один id — measure.
for (const id of stepIds) {
  if (!known.has(id)) problems.push(`шаг ${id} есть в конвейере, но не описан в checks.json`);
}
for (const id of known) {
  if (!stepIds.has(id) && id !== 'contracts') {
    problems.push(`проверка ${id} описана, но шага с таким id в конвейере нет`);
  }
}

// --- 2. Слои, профили, обязательность -------------------------------------
for (const [id, check] of Object.entries(contracts.checks ?? {})) {
  if (!Array.isArray(check.layers) || !check.layers.length) {
    problems.push(`${id}: не указан слой`);
  } else {
    for (const layer of check.layers) {
      if (!layers.has(layer)) problems.push(`${id}: слой «${layer}» не объявлен`);
    }
  }
  if (!Array.isArray(check.mandatoryFor)) {
    problems.push(`${id}: не указано mandatoryFor`);
  } else {
    for (const profile of check.mandatoryFor) {
      if (!profiles.has(profile)) problems.push(`${id}: профиль «${profile}» не объявлен`);
    }
  }
  if (typeof check.timeoutMs !== 'number' || check.timeoutMs <= 0) {
    problems.push(`${id}: нет timeoutMs`);
  }
  if (!check.retryPolicy || typeof check.retryPolicy.attempts !== 'number') {
    problems.push(`${id}: нет retryPolicy.attempts`);
  }
  if (!check.scope) problems.push(`${id}: нет scope`);
}

// --- 3. Зависимости и циклы ------------------------------------------------
const state = new Map();
function visit(id, trail) {
  if (state.get(id) === 'done') return;
  if (state.get(id) === 'open') {
    problems.push(`цикл зависимостей: ${[...trail, id].join(' → ')}`);
    return;
  }
  state.set(id, 'open');
  for (const dep of contracts.checks[id]?.dependsOn ?? []) {
    if (!known.has(dep)) {
      problems.push(`${id}: dependsOn «${dep}» — такой проверки нет`);
      continue;
    }
    visit(dep, [...trail, id]);
  }
  state.set(id, 'done');
}
for (const id of known) visit(id, []);

// --- 4. Входы существуют ---------------------------------------------------
const globRoot = (path) => path.split('*')[0].replace(/\/$/, '');
for (const [id, check] of Object.entries(contracts.checks ?? {})) {
  for (const input of check.inputs ?? []) {
    const base = globRoot(input);
    if (!base) continue;
    if (!existsSync(join(root, base))) problems.push(`${id}: входа «${input}» нет на диске`);
  }
}

if (problems.length) {
  console.error(`контракты: ${known.size} проверок · проблем ${problems.length}`);
  for (const problem of problems.slice(0, 15)) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`контракты: ${known.size} проверок · слои, профили, зависимости и входы сходятся`);
