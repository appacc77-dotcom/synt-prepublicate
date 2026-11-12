#!/usr/bin/env node
/**
 * Собирает данные для страницы /structure.html из артефактов.
 *
 *   node tools/structure.mjs
 *
 * Вход (всё уже на диске):
 *   design/figma/project.json        — страницы и канонические фреймы
 *   design/figma/live/structure.json — снимок живого файла (что есть в Figma).
 *                                      Другой файл с похожим именем —
 *                                      design/figma/structure.json — это
 *                                      ВЫХОД этого инструмента, данные страницы.
 *   design/figma/pages/<page>/<section>/    — spec.json, crop.png, gate.json, pixel.json
 *   .screens/<slug>.png              — снимок собранной секции
 *
 * Выход:
 *   design/figma/structure.json      — данные страницы
 *   public/structure/*.png           — превью «Figma» и «сделано»
 *
 * Руками ничего не правится: статус выводится из наличия файлов и ворот.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const project = JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8'));
const live = JSON.parse(readFileSync(join(root, 'design/figma/live/structure.json'), 'utf8'));

const sectionsRoot = join(root, project.paths.sections);
const outDir = join(root, 'public/structure');
mkdirSync(outDir, { recursive: true });

// --- индекс секций: id узла → папка с артефактами -------------------------
const byNode = new Map();
if (existsSync(sectionsRoot)) {
  for (const pageDir of readdirSync(sectionsRoot)) {
    const pagePath = join(sectionsRoot, pageDir);
    if (!statSync(pagePath).isDirectory()) continue;
    for (const sectionDir of readdirSync(pagePath)) {
      const dir = join(pagePath, sectionDir);
      const specPath = join(dir, 'spec.json');
      if (!existsSync(specPath)) continue;
      const slug = `${pageDir}-${sectionDir}`;
      const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const read = (name) => {
      const p = join(dir, name);
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    };
    byNode.set(spec.section.id, {
      slug,
      dir: dir.slice(root.length + 1),
      spec,
      gate: read('gate.json'),
      pixel: read('pixel.json'),
      image: read('image.json'),
      assets: countAssets(spec),
      });
    }
  }
}

// --- что выгружено из Figma ----------------------------------------------
function countAssets(spec) {
  const images = spec.assets?.images ?? [];
  const icons = spec.assets?.icons ?? [];
  const byExt = (list, ext) => list.filter((a) => a.file.toLowerCase().endsWith(ext)).length;
  const bytes = [...images, ...icons].reduce((s, a) => s + (a.bytes ?? 0), 0);
  const nodes = spec.nodes ?? [];
  return {
    nodes: spec.counts?.nodes ?? nodes.length,
    images: images.length,
    png: byExt(images, '.png'),
    jpg: byExt(images, '.jpg'),
    svg: icons.length,
    bytes,
    // Что Figma знает сверх геометрии: токены, эффекты, поведение в раскладке.
    bound: nodes.filter((n) => n.bound).length,
    effects: nodes.filter((n) => n.effects).length,
    fills: nodes.filter((n) => n.sizing?.h === 'FILL').length,
  };
}

// --- статус ---------------------------------------------------------------
function statusOf(entry) {
  if (!entry) return { key: 'todo', label: 'не выгружен' };
  if (!entry.gate) return { key: 'exported', label: 'выгружен' };
  if (!entry.gate.ok) return { key: 'red', label: 'ворота красные' };
  if (entry.pixel) return { key: 'green', label: 'зелёный' };
  return { key: 'measured', label: 'геометрия ок' };
}

// --- превью ---------------------------------------------------------------
function publish(slug, entry) {
  // Кроп лежит в папке секции: pages/<страница>/<секция>/crop.png
  const figma = join(root, entry.dir, 'crop.png');
  if (existsSync(figma)) copyFileSync(figma, join(outDir, `${slug}-figma.png`));
  const shot = join(root, '.screens', `${slug}.png`);
  const hasShot = existsSync(shot);
  if (hasShot) copyFileSync(shot, join(outDir, `${slug}-site.png`));
  return {
    figma: existsSync(figma) ? `/structure/${slug}-figma.png` : null,
    site: hasShot ? `/structure/${slug}-site.png` : null,
  };
}

// --- страницы и их секции -------------------------------------------------
const pages = [];
for (const [pageKey, pageId] of Object.entries(project.pages)) {
  if (pageKey === project.designSystemPage) continue;
  const canonical = project.frames[pageKey];
  if (!canonical) continue;

  const page = live.pages.find((p) => p.id === pageId);
  const frame = page?.frames.find((f) => f.id === canonical.id);
  if (!frame) continue;

  const sections = (frame.children ?? []).map((child) => {
    const entry = byNode.get(child.id);
    const status = statusOf(entry);
    return {
      id: child.id,
      name: child.name,
      type: child.type,
      x: child.x,
      y: child.y,
      w: child.w,
      h: child.h,
      slug: entry?.slug ?? null,
      dir: entry?.dir ?? null,
      status,
      gate: entry?.gate
        ? { ok: entry.gate.ok, red: entry.gate.red, marked: entry.gate.marked, nodes: entry.gate.nodes, coverage: entry.gate.coverage, worstDelta: entry.gate.worstDelta, at: entry.gate.at }
        : null,
      pixel: entry?.pixel ? { mean: entry.pixel.mean, over16: entry.pixel.over16, over48: entry.pixel.over48, at: entry.pixel.at } : null,
      assets: entry?.assets ?? null,
      images: entry ? publish(entry.slug, entry) : { figma: null, site: null },
    };
  });

  const route = project.routes?.[pageKey] ?? null;
  const routeFile = route === '/' ? 'index.astro' : route?.replace(/^\//, '').replace(/\.html$/, '.astro');
  const built = !!routeFile && existsSync(join(root, 'src/pages', routeFile));

  pages.push({
    key: pageKey,
    id: pageId,
    route,
    built,
    title: page?.name ?? pageKey,
    frame: { id: frame.id, name: frame.name, w: frame.w, h: frame.h },
    sections,
    counts: countSections(sections),
  });
}

function countSections(list) {
  const c = { total: list.length, green: 0, measured: 0, red: 0, exported: 0, todo: 0 };
  for (const s of list) c[s.status.key] = (c[s.status.key] ?? 0) + 1;
  return c;
}

const totals = pages.reduce(
  (acc, p) => {
    acc.total += p.counts.total;
    for (const k of ['green', 'measured', 'red', 'exported', 'todo']) acc[k] += p.counts[k] ?? 0;
    return acc;
  },
  { total: 0, green: 0, measured: 0, red: 0, exported: 0, todo: 0 },
);

// Реальный объём склада: ассеты общие, по секциям они считаются многократно.
const assetsRoot = join(root, project.paths.assets ?? 'design/figma/assets');
let assetFiles = 0;
let assetBytes = 0;
if (existsSync(assetsRoot)) {
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        assetFiles++;
        assetBytes += st.size;
      }
    }
  };
  walk(assetsRoot);
}

const data = {
  at: new Date().toISOString(),
  file: { name: project.source.fileName, key: project.source.fileKey },
  totals,
  assetsTotal: { files: assetFiles, bytes: assetBytes },
  pages,
};
writeFileSync(join(root, 'design/figma/structure.json'), JSON.stringify(data, null, 2) + '\n');

console.log(`страниц: ${pages.length}, секций: ${totals.total}`);
console.log(`  зелёных ${totals.green} · геометрия ок ${totals.measured} · красных ${totals.red} · выгружено ${totals.exported} · не выгружено ${totals.todo}`);
for (const p of pages) {
  console.log(`  ${p.title.padEnd(10)} ${String(p.counts.total).padStart(2)} секций · ${p.frame.w}×${p.frame.h}`);
}
