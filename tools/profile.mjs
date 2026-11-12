#!/usr/bin/env node
/**
 * Разбор времени последнего прогона: какие шаги сколько заняли.
 *
 *   node tools/profile.mjs                 # последний прогон
 *   node tools/profile.mjs --run <id>      # конкретный
 *   node tools/profile.mjs --prev          # сравнить с предыдущим
 *
 * Числа берутся из `reports/runs/<id>/verdict.json` — там каждый шаг пишет
 * своё `ms`. Отдельно считается накладное время: разница между суммой шагов
 * и общим временем прогона.
 *
 * Зачем отдельный инструмент: «прогон идёт 47 секунд» — не ответ на вопрос
 * «что чинить». Ответ — «interactive 24 с, из них 17 с фиксированных пауз».
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const runsDir = join(root, 'reports/runs');
if (!existsSync(runsDir)) {
  console.error('нет reports/runs — сначала прогон');
  process.exit(2);
}

const runs = readdirSync(runsDir)
  .filter((name) => existsSync(join(runsDir, name, 'verdict.json')))
  .sort();

const runId = arg('--run', runs[runs.length - 1]);
const load = (id) => JSON.parse(readFileSync(join(runsDir, id, 'verdict.json'), 'utf8'));

if (!existsSync(join(runsDir, runId, 'verdict.json'))) {
  console.error(`нет прогона ${runId}`);
  process.exit(2);
}

const run = load(runId);
const totalMs = (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) || 0;
const steps = [...(run.steps ?? [])].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0));
const sumMs = steps.reduce((n, s) => n + (s.ms ?? 0), 0);

console.log(`прогон ${runId} · статус ${run.status} · шагов ${steps.length}`);
console.log(`общее ${(totalMs / 1000).toFixed(1)} с · сумма шагов ${(sumMs / 1000).toFixed(1)} с · накладные ${((totalMs - sumMs) / 1000).toFixed(1)} с\n`);

console.log('| шаг | время | доля | статус |');
console.log('|---|---:|---:|---|');
for (const step of steps) {
  const ms = step.ms ?? 0;
  const share = sumMs ? Math.round((ms / sumMs) * 100) : 0;
  console.log(`| ${step.id} | ${(ms / 1000).toFixed(1)} с | ${share} % | ${step.status} |`);
}

if (process.argv.includes('--prev')) {
  const index = runs.indexOf(runId);
  const prevId = index > 0 ? runs[index - 1] : null;
  if (!prevId) {
    console.log('\nпредыдущего прогона нет');
  } else {
    const prev = load(prevId);
    const prevMs = new Map((prev.steps ?? []).map((s) => [s.id, s.ms ?? 0]));
    console.log(`\nсравнение с ${prevId}:`);
    console.log('| шаг | было | стало | разница |');
    console.log('|---|---:|---:|---:|');
    for (const step of steps) {
      const before = prevMs.get(step.id);
      if (before === undefined) continue;
      const delta = (step.ms ?? 0) - before;
      if (Math.abs(delta) < 100) continue;
      const sign = delta > 0 ? '+' : '';
      console.log(`| ${step.id} | ${(before / 1000).toFixed(1)} с | ${((step.ms ?? 0) / 1000).toFixed(1)} с | ${sign}${(delta / 1000).toFixed(1)} с |`);
    }
  }
}
