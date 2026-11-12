#!/usr/bin/env node
/**
 * Ворота пилота генератора.
 *
 *   node tools/check-gen.mjs --gate drift       # файл _gen/*.astro совпадает с пересборкой
 *   node tools/check-gen.mjs --gate coverage    # доля узлов, собранных из спеки
 *   node tools/check-gen.mjs --gate overrides   # у каждого override есть причина и решение
 *
 * Зачем три отдельные ворота: у них разные причины краснеть.
 *
 *   drift     — кто-то поправил сгенерированный файл руками. Такая правка
 *               исчезнет при следующей генерации, поэтому её лучше поймать
 *               сразу, а не через месяц.
 *   coverage  — генератор молча перестал брать узлы (новая фича Figma,
 *               новый тип узла). Порог в project.json.gates.genCoverage.
 *   overrides — узел выпал из генерации без объяснения. Запись без причины
 *               — то же, что вёрстка без решения.
 *
 * Пилот ограничен `design/gen/targets.json`: если файла нет, ворота ничего
 * не проверяют и честно говорят об этом (код 3), а не зелёные молча.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const gate = arg('--gate', null);

if (!['drift', 'coverage', 'overrides'].includes(gate)) {
  console.error('Использование: node tools/check-gen.mjs --gate <drift|coverage|overrides>');
  process.exit(2);
}

const targetsPath = join(root, 'design/gen/targets.json');
if (!existsSync(targetsPath)) {
  console.error('пилот не заведён: нет design/gen/targets.json');
  process.exit(3);
}

const targets = JSON.parse(readFileSync(targetsPath, 'utf8')).sections ?? [];
if (!targets.length) {
  console.error('в design/gen/targets.json нет секций');
  process.exit(3);
}

/** Отчёт генератора: он же считает покрытие и расхождение файлов. */
function report() {
  try {
    const out = execFileSync(process.execPath, [join(root, 'tools/gen.mjs'), 'report', '--all'], {
      cwd: root,
      encoding: 'utf8',
    });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

if (gate === 'drift') {
  const { ok, out } = report();
  const drift = out.split('\n').filter((line) => line.includes('РАСХОДИТСЯ'));
  if (drift.length) {
    console.log('сгенерированные файлы поправлены руками:');
    for (const line of drift) console.log(`  ${line.trim()}`);
    console.error('\nпересоберите: node tools/gen.mjs emit --all (ручные правки — в design/gen/overrides/)');
    process.exit(1);
  }
  if (!ok) {
    console.error(out.trim().split('\n').pop() ?? 'отчёт генератора не получен');
    process.exit(2);
  }
  console.log(`сгенерированные файлы совпадают с пересборкой: ${targets.length} секции`);
  process.exit(0);
}

if (gate === 'coverage') {
  // Порог у каждой секции свой (design/gen/targets.json): у карусели он ниже,
  // чем у текста. Решение принимает gen.mjs report — здесь только вердикт.
  const { ok, out } = report();
  const lines = out.split('\n').filter(Boolean);
  const fail = lines.filter((l) => l.includes('ниже порога'));
  const cover = lines.find((l) => l.startsWith('покрытие:'));
  if (!ok || fail.length) {
    if (cover) console.log(cover);
    for (const line of fail) console.log(line.trim());
    console.error('\nгенератор перестал брать узлы: проверьте design/gen/targets.json и причины overrides');
    process.exit(1);
  }
  console.log(cover ?? 'покрытие посчитано');
  console.log(`пороги соблюдены: ${targets.filter((t) => t.gate !== false).length} секции с воротами`);
  process.exit(0);
}

if (gate === 'overrides') {
  const dir = join(root, 'design/gen/overrides');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  if (!files.length) {
    console.error('нет файлов overrides — генератор не отчитывается о пропусках');
    process.exit(1);
  }
  let count = 0;
  const problems = [];
  for (const file of files) {
    const data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    for (const item of data.overrides ?? []) {
      count += 1;
      if (!item.node) problems.push(`${file}: запись без узла`);
      if (!item.reason) problems.push(`${file}: ${item.node} без причины`);
      if (!item.decision) problems.push(`${file}: ${item.node} без номера решения`);
    }
  }
  if (problems.length) {
    console.log(`overrides: ${count} · нарушений: ${problems.length}`);
    for (const p of problems.slice(0, 10)) console.log(`  ${p}`);
    console.error('\noverride без причины — это пропуск, о котором никто не знает');
    process.exit(1);
  }
  console.log(`overrides: ${count} · у каждого есть причина и решение`);
  process.exit(0);
}
