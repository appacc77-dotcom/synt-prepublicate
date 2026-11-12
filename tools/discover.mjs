#!/usr/bin/env node
/**
 * Заполняет project.json из живого файла: страницы и канонические фреймы.
 *
 *   node tools/discover.mjs            # показать, что нашлось
 *   node tools/discover.mjs --write    # записать pages и frames в project.json
 *   node tools/discover.mjs --check    # сверить project.json с файлом, exit 1 при расхождении
 *
 * Зачем: чтобы новый сайт начинался с одного JSON, а не с ручного переписывания
 * id фреймов. Всё остальное в project.json (пути, допуски, маршруты) не трогается.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { runFigma, FigmaError } from './figma/cli.mjs';

const root = process.cwd();
const write = process.argv.includes('--write');
const check = process.argv.includes('--check');

const projectPath = join(root, 'design/figma/project.json');
const project = existsSync(projectPath) ? JSON.parse(readFileSync(projectPath, 'utf8')) : null;

let reply;
try {
  reply = runFigma(['exec-js', join(root, 'tools/figma/discover.js')], { timeoutMs: 120000 });
} catch (error) {
  if (error instanceof FigmaError) {
    console.error(`discover: ${error.code}: ${error.message}`);
    process.exit(2);
  }
  throw error;
}

const data = reply?.result;
if (!data?.pages) {
  console.error('discover: пустой ответ моста');
  process.exit(3);
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '');

/**
 * Канонический фрейм страницы. Приоритет: фрейм с именем `main` (так размечены
 * основные страницы в макете), иначе первый непустой — он же первый в файле.
 * Высота не годится: у Library журнальный выпуск выше основной страницы,
 * а у Quiz самый высокий фрейм — результат теста, а не сама страница.
 */
function pickFrame(frames) {
  const usable = frames.filter((f) => !f.empty);
  if (!usable.length) return null;
  const main = usable.find((f) => f.name.trim().toLowerCase() === 'main');
  return main ?? usable[0];
}

const found = [];
for (const page of data.pages) {
  const frame = pickFrame(page.frames);
  found.push({
    key: slug(page.name),
    name: page.name,
    id: page.id,
    frame: frame ? { id: frame.id, name: frame.name, w: frame.w, h: frame.h } : null,
    others: page.frames.filter((f) => f !== frame).map((f) => ({ id: f.id, name: f.name, h: f.h })),
  });
}

// --- --check: сверить с project.json -------------------------------------
if (check) {
  const problems = [];
  if (!project) problems.push('нет project.json');
  else {
    if (project.source?.fileKey !== data.fileKey) {
      problems.push(`fileKey: ${project.source?.fileKey} в JSON против ${data.fileKey} в файле`);
    }
    for (const f of found) {
      const inJson = project.pages?.[f.key];
      if (!inJson) {
        if (f.frame) problems.push(`страница «${f.name}» есть в файле, нет в project.json`);
        continue;
      }
      if (inJson !== f.id) problems.push(`страница «${f.name}»: id ${inJson} против ${f.id}`);
      const jsonFrame = project.frames?.[f.key];
      if (f.frame && jsonFrame?.id !== f.frame.id) {
        problems.push(`фрейм «${f.name}»: ${jsonFrame?.id ?? 'нет'} против ${f.frame.id}`);
      }
    }
    for (const key of Object.keys(project.pages ?? {})) {
      if (!found.some((f) => f.key === key)) problems.push(`в project.json есть страница «${key}», в файле её нет`);
    }
  }
  if (problems.length) {
    for (const p of problems) console.log(`  ✗ ${p}`);
    console.log(`\nрасхождений: ${problems.length}`);
    process.exit(1);
  }
  console.log(`project.json совпадает с файлом: ${found.filter((f) => f.frame).length} страниц`);
  process.exit(0);
}

// --- отчёт ----------------------------------------------------------------
console.log(`файл: ${data.name} · ${data.fileKey}`);
console.log(`страниц: ${found.length}\n`);
for (const f of found) {
  const frame = f.frame ? `${f.frame.name} ${f.frame.w}×${f.frame.h} (${f.frame.id})` : 'нет пригодного фрейма';
  console.log(`  ${f.name.padEnd(16)} → ${f.key.padEnd(12)} ${frame}`);
  if (f.others.length) {
    console.log(`  ${''.padEnd(16)}   ещё фреймов: ${f.others.map((o) => `${o.name} ${o.h}`).join(', ')}`);
  }
}

// --- --write --------------------------------------------------------------
if (write) {
  const next = project ?? {
    source: { fileKey: data.fileKey, fileName: data.name },
    paths: { live: 'design/figma/live', sections: 'design/figma/pages', assets: 'design/figma/assets' },
    gates: { geometryTolerancePx: 1, pixelDelta: 16 },
    // Токен REST лежит в корне проекта и не коммитится. Путь не должен
    // указывать на соседний проект: так конвейер перестаёт быть переносимым.
    api: { tokenFile: '.figma-token' },
  };
  next.source = { ...next.source, fileKey: data.fileKey, fileName: data.name };
  next.pages = Object.fromEntries(found.filter((f) => f.frame).map((f) => [f.key, f.id]));
  // Страница дизайн-системы не даёт секций: её фрейм — витрина компонентов,
  // а не блок сайта. Ключ определяем по имени страницы, а не по константе.
  const dsPage = found.find((f) => /design\s*system|дизайн[-\s]*систем/i.test(f.name));
  if (dsPage) next.designSystemPage = dsPage.key;
  next.frames = Object.fromEntries(
    found.filter((f) => f.frame).map((f) => [f.key, { id: f.frame.id, name: f.frame.name }]),
  );
  mkdirSync(dirname(projectPath), { recursive: true });
  writeFileSync(projectPath, JSON.stringify(next, null, 2) + '\n');
  console.log(`\nзаписано в ${projectPath}: ${Object.keys(next.pages).length} страниц`);
} else if (!check) {
  console.log('\nничего не записано. Для записи: --write');
}
