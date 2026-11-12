#!/usr/bin/env node
/**
 * Сверка собранной страницы с рендером фрейма из Figma — целиком, а не по секциям.
 *
 *   node tools/page-compare.mjs [--page <ключ страницы>] [--url /]
 *
 * Зачем: посекционные ворота не видят, что блоки стоят в неверном порядке или
 * что между ними лишний отступ. Сравнение целой страницы это ловит: у нас
 * banner и pain однажды оказались переставлены — каждый по отдельности зелёный,
 * а страница расходилась на 125.
 *
 * Пишет `design/figma/live/page-<ключ>.json` с числами.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runFigma, FigmaError } from './figma/cli.mjs';
import { decodePngFile } from './lib/png.mjs';

const root = process.cwd();
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const route = arg('--url', '/');
const project = JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8'));
// По умолчанию — первая страница проекта, кроме дизайн-системы: у нового сайта
// первая страница не обязана называться home.
const firstPage = Object.keys(project.pages ?? {}).find((key) => key !== project.designSystemPage);
const pageKey = arg('--page', firstPage);
const structurePath = join(root, 'design/figma/structure.json');
const structure = existsSync(structurePath) ? JSON.parse(readFileSync(structurePath, 'utf8')) : null;
const frame = project.frames?.[pageKey];
if (!frame) {
  console.error(`в project.json нет фрейма для страницы «${pageKey}» — npm run discover -- --write`);
  process.exit(2);
}

// --- 1. рендер фрейма из Figma -------------------------------------------
const tmpFrame = join(tmpdir(), `frame-${pageKey}.png`);
if (!existsSync(tmpFrame)) {
  try {
    runFigma(['export-png', '--node', frame.id, '--out', tmpFrame, '--scale', '1'], { timeoutMs: 300000 });
  } catch (error) {
    if (error instanceof FigmaError) {
      console.error(`page-compare: ${error.code}: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}

// --- 2. снимок страницы ---------------------------------------------------
const tmpShot = join(tmpdir(), `page-${pageKey}.png`);
try {
  execFileSync(process.execPath, [join(root, 'tools/shot.mjs'), '.page', tmpShot, '1440', '--url', route], {
    stdio: 'ignore',
    timeout: 180000,
  });
} catch {
  console.error('page-compare: не удалось снять страницу (нужен npm run build и .page в разметке)');
  process.exit(2);
}

// --- 3. сравнение ---------------------------------------------------------
const ref = decodePngFile(tmpFrame);
const shot = decodePngFile(tmpShot);

// Сравниваем только непрерывное начало страницы: собранные секции идут подряд
// от нуля, пока не встретится пропуск. Иначе formats (в макете y=6255) сравнился
// бы с чужим блоком на y=2012 и дал бы разницу в сотни.
const built = (structure?.pages.find((p) => p.key === pageKey)?.sections ?? [])
  .filter((s) => s.images?.site)
  .sort((a, b) => a.y - b.y);
let prefix = 0;
for (const s of built) {
  // Перекрытие (шапка лежит поверх героя) — не пропуск: пропускаем такой блок.
  if (s.y < prefix) continue;
  if (s.y > prefix) break;
  prefix = s.y + s.h;
}
const w = Math.min(ref.width, shot.width);
const h = Math.min(ref.height, shot.height, prefix || Infinity);

let sum = 0;
let over16 = 0;
let over48 = 0;
const bands = [];
let bandSum = 0;
let bandCount = 0;

for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const ri = (y * ref.width + x) * ref.bpp;
    const si = (y * shot.width + x) * shot.bpp;
    let worst = 0;
    for (let ch = 0; ch < 3; ch++) {
      const d = Math.abs(ref.data[ri + ch] - shot.data[si + ch]);
      sum += d;
      if (d > worst) worst = d;
    }
    if (worst > 16) over16++;
    if (worst > 48) over48++;
    bandSum += worst;
    bandCount++;
  }
  if ((y + 1) % 100 === 0 || y === h - 1) {
    bands.push({ from: y + 1 - bandCount / w, to: y + 1, mean: +(bandSum / bandCount).toFixed(2) });
    bandSum = 0;
    bandCount = 0;
  }
}

const total = w * h;
const result = {
  at: new Date().toISOString(),
  page: pageKey,
  frame: frame.id,
  route,
  width: w,
  height: h,
  prefix,
  mean: +(sum / (total * 3)).toFixed(2),
  over16: +((over16 / total) * 100).toFixed(2),
  over48: +((over48 / total) * 100).toFixed(2),
  bands,
};

const live = join(root, 'design/figma/live');
mkdirSync(live, { recursive: true });
writeFileSync(join(live, `page-${pageKey}.json`), JSON.stringify(result, null, 2) + '\n');

rmSync(tmpFrame, { force: true });
rmSync(tmpShot, { force: true });

console.log(`страница: ${pageKey} (${frame.name}), маршрут ${route}`);
console.log(`размер:   ${w}×${h} — непрерывное начало собранных секций${prefix && h < prefix ? ` (собрано до ${prefix} px)` : ''}`);
console.log(`средняя разница: ${result.mean}`);
console.log(`пикселей > 16:   ${result.over16} %`);
console.log(`пикселей > 48:   ${result.over48} %`);

const worst = [...result.bands].sort((a, b) => b.mean - a.mean).slice(0, 5);
console.log('\nхудшие полосы по 100 px (средняя, от–до):');
for (const b of worst) console.log(`  ${String(b.mean).padStart(6)}  ${Math.round(b.from)}–${Math.round(b.to)}`);
