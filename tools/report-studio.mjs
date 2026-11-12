#!/usr/bin/env node
/**
 * Собирает метрики студии из того, что уже посчитано.
 *
 *   node tools/report-studio.mjs [--check]
 *
 * Новых измерений здесь нет: только сводка по артефактам, которые и так
 * лежат на диске. Задача — чтобы цифры, по которым оценивается работа,
 * считались одной командой, а не выписывались из терминала вручную.
 *
 * Источники:
 *   design/figma/pages/**\/gate.json   покрытие разметки, красные замеры
 *   docs/debts.json                    долги по владельцам
 *   design/figma/invented.json         изобретённое
 *   reports/runs/<последний>/          вердикт прогона
 *
 * `--check` сравнивает с записанным файлом и говорит, устарел ли он.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const outPath = join(root, 'reports/studio.json');
const checkOnly = process.argv.includes('--check');

const readJson = (path, fallback = null) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);

// --- Замеры по секциям -----------------------------------------------------
const pagesDir = join(root, 'design/figma/pages');
// Считаем только то, что входит в приёмку: компоненты дизайн-системы живут
// на /ds, в карту страниц не входят, и их gate.json отражает другую проверку.
const acceptance = new Set(JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8')).acceptance ?? []);
const gates = [];
if (existsSync(pagesDir)) {
  for (const page of readdirSync(pagesDir)) {
    const pageDir = join(pagesDir, page);
    if (!statSync(pageDir).isDirectory()) continue;
    for (const section of readdirSync(pageDir)) {
      const file = join(pageDir, section, 'gate.json');
      const unit = `${page}/${section}`;
      if (existsSync(file) && (!acceptance.size || acceptance.has(unit))) gates.push({ unit, ...readJSONFile(file) });
    }
  }
}
function readJSONFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const coverages = gates.map((g) => g.coverage).filter((v) => typeof v === 'number');
const marked = gates.map((g) => g.markedRatio).filter((v) => typeof v === 'number');

// --- Долги и изобретённое --------------------------------------------------
const debts = readJson(join(root, 'docs/debts.json'), { debts: [] }).debts ?? [];
const openDebts = debts.filter((d) => d.status !== 'done' && d.status !== 'rejected');
const byOwner = {};
for (const d of openDebts) byOwner[d.owner ?? 'unknown'] = (byOwner[d.owner ?? 'unknown'] ?? 0) + 1;

const invented = readJson(join(root, 'design/figma/invented.json'), { entries: [] }).entries ?? [];

// --- Последний прогон ------------------------------------------------------
const runsDir = join(root, 'reports/runs');
let lastRun = null;
if (existsSync(runsDir)) {
  const runs = readdirSync(runsDir)
    .filter((name) => statSync(join(runsDir, name)).isDirectory())
    .sort();
  const name = runs[runs.length - 1];
  const verdict = readJson(join(runsDir, name, 'verdict.json'));
  if (verdict) {
    const results = verdict.units ? Object.keys(verdict.results ?? {}) : [];
    lastRun = {
      id: name,
      at: verdict.at ?? null,
      status: verdict.status ?? null,
      profile: verdict.profile ?? null,
      units: (verdict.units ?? []).length,
      red: results.length
        ? results.filter((u) => verdict.results?.[u]?.status === 'FAIL').length
        : null,
    };
  }
}

// --- Метрики ---------------------------------------------------------------
const studio = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sections: {
    withGate: gates.length,
    coverageMedian: median(coverages),
    markedRatioMedian: median(marked),
    redGates: gates.filter((g) => g.ok === false).length,
  },
  debts: {
    total: debts.length,
    open: openDebts.length,
    openByOwner: byOwner,
  },
  invented: { total: invented.length },
  lastRun,
};

const text = JSON.stringify(studio, null, 2) + '\n';

if (checkOnly) {
  if (!existsSync(outPath)) {
    console.error('нет reports/studio.json — запустите npm run report:studio');
    process.exit(1);
  }
  const current = readJson(outPath);
  // generatedAt меняется каждый прогон — сравниваем содержательное.
  const strip = (o) => JSON.stringify({ ...o, generatedAt: undefined });
  if (strip(current) !== strip(studio)) {
    console.error('reports/studio.json устарел — пересоберите: npm run report:studio');
    process.exit(1);
  }
  console.log('метрики студии актуальны');
  process.exit(0);
}

writeFileSync(outPath, text);
console.log(
  `метрики студии: секций ${studio.sections.withGate} · покрытие ${studio.sections.coverageMedian}% · ` +
    `размечено ${studio.sections.markedRatioMedian}% · долгов открыто ${studio.debts.open} · изобретено ${studio.invented.total}`,
);
console.log(`записано: reports/studio.json`);
