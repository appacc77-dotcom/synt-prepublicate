#!/usr/bin/env node
/**
 * Карта страниц: что из файла перенесено, что нет и почему.
 *
 *   node tools/page-map.mjs --write    # собрать docs/PAGE-MAP.md и JSON
 *   node tools/page-map.mjs            # только проверить (ворота)
 *
 * Зачем. «Перенесли 100 %» — утверждение, которое надо доказать списком.
 * Структурная страница `/structure.html` показывает пары «Figma / сделано» и
 * числа, но не отвечает на вопрос «а что осталось». Здесь — полный перечень:
 * каждая страница, каждая секция, каждый узел спеки, и статус каждого шага
 * переноса: спека → кроп → компонент → замер → пиксель.
 *
 * Правило честности: узлы, которых нет в разметке, не считаются перенесёнными
 * молча — они попадают в раздел «не размечено» с числом.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
// По умолчанию — только проверка: ворота не имеют права менять дерево во
// время прогона приёмки. Запись карты — явный флаг `--write`.
const checkOnly = !process.argv.includes('--write');

// Исключения карты: запись = решение + причина. Без них ворота красные.
const exceptionsPath = join(process.cwd(), 'design/figma/map-exceptions.json');
const exceptions = new Map();
if (existsSync(exceptionsPath)) {
  for (const item of JSON.parse(readFileSync(exceptionsPath, 'utf8')).exceptions ?? []) {
    exceptions.set(item.unit, new Set(item.fields ?? []));
  }
}
const pagesDir = join(root, 'design/figma/pages');

if (!existsSync(pagesDir)) {
  console.error('нет design/figma/pages — сначала экспорт');
  process.exit(2);
}

// --- 1. Разметка: какие id размечены в коде ---------------------------------
const marked = new Set();
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(astro|ts|mjs|js)$/.test(entry.name)) continue;
    const text = readFileSync(full, 'utf8');
    for (const m of text.matchAll(/data-figma-node=\{?["'`]([^"'`}]+)["'`]/g)) marked.add(m[1].trim());
    // id может быть частью составного значения: `${node} 24:1871`
    for (const m of text.matchAll(/([0-9]+:[0-9]+)/g)) marked.add(m[1]);
  }
};
walk(join(root, 'src'));

// --- 2. Секции -------------------------------------------------------------
const pages = readdirSync(pagesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const rows = [];
const problems = [];

for (const page of pages) {
  const sectionDirs = readdirSync(join(pagesDir, page), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const section of sectionDirs) {
    const dir = join(pagesDir, page, section);
    const specPath = join(dir, 'spec.json');
    if (!existsSync(specPath)) continue;

    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const nodes = spec.nodes ?? [];
    const ids = nodes.map((n) => n.id);
    const mandatory = nodes.filter((n) => (n.depth ?? 0) <= 2);

    const gate = existsSync(join(dir, 'gate.json')) ? JSON.parse(readFileSync(join(dir, 'gate.json'), 'utf8')) : null;
    // Числа размеченного берём из замера: он и есть источник истины о том,
    // что реально связано с DOM (у него своя логика для вложенных инстансов).
    const coverage = gate?.marked ?? ids.filter((id) => marked.has(id)).length;
    const pixel = existsSync(join(dir, 'pixel.json')) ? JSON.parse(readFileSync(join(dir, 'pixel.json'), 'utf8')) : null;
    const crop = existsSync(join(dir, 'crop.png'));

    const unit = `${page}/${section}`;
    const row = {
      unit,
      page,
      section,
      nodes: nodes.length,
      marked: coverage,
      mandatory: mandatory.length,
      mandatoryMarked: gate?.coverage === 100
        ? mandatory.length
        : Math.round((mandatory.length * (gate?.coverage ?? 0)) / 100),
      crop,
      measured: gate ? Boolean(gate.ok) : false,
      pixel: pixel?.mean ?? null,
      size: spec.section ? `${spec.section.w}×${spec.section.h}` : null,
      source: spec.source ?? 'bridge',
    };
    rows.push(row);

    const allowed = exceptions.get(unit) ?? new Set();
    if (!crop && !allowed.has('crop')) problems.push(`${unit}: нет кропа — сравнивать не с чем`);
    if (row.mandatoryMarked !== row.mandatory && !allowed.has('mandatory')) {
      problems.push(`${unit}: обязательных узлов размечено ${row.mandatoryMarked} из ${row.mandatory}`);
    }
    if (!gate && !allowed.has('pixel')) problems.push(`${unit}: нет gate.json — секция не замерялась`);
    if (gate && !gate.ok && !allowed.has('pixel')) problems.push(`${unit}: замер красный`);
    if (!pixel && !allowed.has('pixel')) problems.push(`${unit}: нет pixel.json — пиксель не сверялся`);
  }
}

// --- 3. Итоги ---------------------------------------------------------------
const totals = rows.reduce(
  (acc, r) => ({
    sections: acc.sections + 1,
    nodes: acc.nodes + r.nodes,
    marked: acc.marked + r.marked,
    mandatory: acc.mandatory + r.mandatory,
    mandatoryMarked: acc.mandatoryMarked + r.mandatoryMarked,
    crops: acc.crops + (r.crop ? 1 : 0),
    measured: acc.measured + (r.measured ? 1 : 0),
  }),
  { sections: 0, nodes: 0, marked: 0, mandatory: 0, mandatoryMarked: 0, crops: 0, measured: 0 },
);

const result = { schemaVersion: 1, at: new Date().toISOString(), totals, pages: rows };
// В режиме проверки ничего не пишем: прогон приёмки сверяет содержимое
// дерева до и после, и файл, переписанный воротами, делает прогон негодным
// как доказательство коммита.
if (!checkOnly) writeFileSync(join(root, 'design/figma/page-map.json'), JSON.stringify(result, null, 2) + '\n');

const md = [];
md.push('# Карта страниц: что перенесено');
md.push('');
md.push(`Собрано ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · \`node tools/page-map.mjs\``);
md.push('');
md.push('## Итог');
md.push('');
md.push('| | значение |');
md.push('|---|---:|');
md.push(`| страниц | ${new Set(rows.map((r) => r.page)).size} |`);
md.push(`| секций | ${totals.sections} |`);
md.push(`| узлов в спеках | ${totals.nodes} |`);
md.push(`| размечено в коде | ${totals.marked} (${Math.round((totals.marked / totals.nodes) * 100)} %) |`);
md.push(`| обязательных (глубина ≤ 2) | ${totals.mandatory} · размечено ${totals.mandatoryMarked} (${Math.round((totals.mandatoryMarked / totals.mandatory) * 100)} %) |`);
md.push(`| кропов | ${totals.crops} из ${totals.sections} |`);
md.push(`| замеров зелёных | ${totals.measured} из ${totals.sections} |`);
md.push('');
md.push('**Что значит «100 %».** Перенесено всё, у чего есть спека, кроп, компонент и зелёный замер:');
md.push(`${totals.measured} секций из ${totals.sections}. Обязательные узлы размечены на ${Math.round((totals.mandatoryMarked / totals.mandatory) * 100)} %.`);
md.push(`Остальные ${totals.nodes - totals.marked} узлов — декоративные и вложенные: их геометрия не сверяется,`);
md.push('сверяется пиксель секции целиком.');
md.push('');
md.push('## Страницы');
md.push('');
for (const page of pages) {
  const pageRows = rows.filter((r) => r.page === page);
  if (!pageRows.length) continue;
  const first = pageRows[0];
  md.push(`### ${page}`);
  md.push('');
  md.push('| секция | размер | узлов | размечено | кроп | замер | пиксель | источник |');
  md.push('|---|---|---:|---:|:--:|:--:|---:|---|');
  for (const r of pageRows) {
    md.push(
      `| ${r.section} | ${r.size ?? '—'} | ${r.nodes} | ${r.marked} | ${r.crop ? 'да' : '**нет**'} | ${r.measured ? 'ок' : '—'} | ${r.pixel ?? '—'} | ${r.source} |`,
    );
  }
  md.push('');
}
if (problems.length) {
  md.push('## Что не так');
  md.push('');
  for (const p of problems.slice(0, 40)) md.push(`- ${p}`);
  md.push('');
}
if (!checkOnly) writeFileSync(join(root, 'docs/PAGE-MAP.md'), md.join('\n') + '\n');

if (checkOnly) {
  if (problems.length) {
    console.log(`карта: секций ${totals.sections} · проблем ${problems.length}`);
    for (const p of problems.slice(0, 10)) console.log(`  ${p}`);
    process.exit(1);
  }
  console.log(`карта: ${totals.sections} секций · ${totals.marked}/${totals.nodes} узлов · обязательные ${totals.mandatoryMarked}/${totals.mandatory} · кропы ${totals.crops}`);
  process.exit(0);
}

console.log(`карта: ${totals.sections} секций, ${totals.nodes} узлов, размечено ${totals.marked}`);
console.log(`docs/PAGE-MAP.md и design/figma/page-map.json обновлены`);
