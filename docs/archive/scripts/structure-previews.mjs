#!/usr/bin/env node
/**
 * Пересъёмка превью страниц для /structure.html.
 *
 * Запуск один раз:
 *   node scripts/structure-previews.mjs --once
 *
 * Наблюдение за канбаном (по умолчанию):
 *   node scripts/structure-previews.mjs
 *
 * Playwright — локальная devDependency проекта. Канбан DSH опционален:
 * `--once` снимает страницы без доски. Переопределяется через DSH_BOARD_URL.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const liveDir = path.join(root, 'public/structure/pages/live');
const versionFile = path.join(liveDir, 'version.json');
const eventsFile = path.join(root, '.state/preview-events.json');
const blocksScript = path.join(root, 'scripts/structure-blocks.mjs');
const baseUrl = process.env.SYNTONIA_URL ?? process.env.SYNTAONIA_URL ?? 'http://127.0.0.1:4321';
const boardUrl = process.env.DSH_BOARD_URL ?? 'http://127.0.0.1:57686/kanban/api/board';
const once = process.argv.includes('--once');
const intervalMs = Number(process.env.PREVIEWS_INTERVAL_MS ?? 3000);

const pages = [
  { id: 'masters', title: 'Page · Мастера', route: '/masters.html' },
  { id: 'practice', title: 'Page · Пространство практики', route: '/practice.html' },
  { id: 'library', title: 'Page · Библиотека', route: '/library.html' },
  { id: 'booking', title: 'Page · Запись', route: '/booking.html' },
  { id: 'quiz', title: 'Page · Quiz', route: '/quiz.html' },
  { id: 'offer', title: 'Page · Публичная оферта', route: '/offer.html' },
  { id: 'privacy', title: 'Page · Политика конфиденциальности', route: '/privacy.html' },
  { id: 'consent', title: 'Page · Согласие на обработку', route: '/consent.html' },
  { id: '404', title: 'Page · 404', route: '/404.html' },
];

mkdirSync(liveDir, { recursive: true });
mkdirSync(path.dirname(eventsFile), { recursive: true });

const readVersions = () => {
  try {
    return JSON.parse(readFileSync(versionFile, 'utf8'));
  } catch {
    return { pages: {} };
  }
};
const appendEvent = (page) => {
  let events = { updatedAt: null, events: [] };
  try {
    events = JSON.parse(readFileSync(eventsFile, 'utf8'));
  } catch {
    /* первый запуск */
  }
  if (!Array.isArray(events.events)) events.events = [];
  events.events = events.events.filter((event) => event.page !== page.id);
  events.events.push({ at: new Date().toISOString(), page: page.id, title: page.title });
  events.updatedAt = new Date().toISOString();
  mkdirSync(path.dirname(eventsFile), { recursive: true });
  const tmp = `${eventsFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(events, null, 2)}\n`);
  renameSync(tmp, eventsFile);
};

const writeVersions = (versions) => {
  const tmp = `${versionFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(versions, null, 2)}\n`);
  renameSync(tmp, versionFile);
};

const capture = async (browser, page) => {
  const tab = await browser.newPage({ viewport: { width: 1440, height: 760 } });
  try {
    await tab.goto(baseUrl + page.route, { waitUntil: 'networkidle', timeout: 30000 });
    await tab.evaluate(() => document.fonts.ready);
    await tab.waitForTimeout(250);
    const target = path.join(liveDir, `${page.id}.jpg`);
    const tmp = `${target}.tmp`;
    await tab.screenshot({ path: tmp, type: 'jpeg', quality: 82 });
    renameSync(tmp, target);
    return true;
  } finally {
    await tab.close();
  }
};

const boardCards = async () => {
  const response = await fetch(`${boardUrl}?ts=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`board HTTP ${response.status}`);
  const payload = await response.json();
  return payload?.board?.cards ?? [];
};

const main = async () => {
  const browser = await chromium.launch({ headless: true });
  let previous = new Map();
  let first = true;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const cards = await boardCards();
      const byTitle = new Map(cards.map((card) => [card.title, card.column]));
      const versions = readVersions();
      let changed = false;

      for (const page of pages) {
        const column = byTitle.get(page.title);
        const was = previous.get(page.title);
        const target = path.join(liveDir, `${page.id}.jpg`);
        const shouldCapture =
          column === 'done' &&
          (first || was !== 'done' || !existsSync(target));
        if (!shouldCapture) continue;
        try {
          await capture(browser, page);
          if (!first && was !== 'done') {
            try {
              execFileSync(process.execPath, [blocksScript, '--only', page.id], {
                env: process.env,
                stdio: 'inherit',
              });
            } catch (error) {
              console.error(`[preview] blocks ${page.id}: ${error.message}`);
            }
          }
          appendEvent(page);
          versions.pages[page.id] = String(Date.now());
          changed = true;
          console.log(`[preview] ${page.id} ← ${page.route}`);
        } catch (error) {
          console.error(`[preview] ${page.id}: ${error.message}`);
        }
      }

      const blockPages = cards
        .filter((card) => card.column === 'done' && /^(Home|Method|Shared) · /.test(card.title))
        .map((card) => ({
          card,
          pageId: card.title.startsWith('Home') ? 'home' : card.title.startsWith('Method') ? 'method' : 'shared',
        }));
      for (const { card, pageId } of blockPages) {
        const was = previous.get(card.title);
        if (first || was === 'done') continue;
        try {
          execFileSync(process.execPath, [blocksScript, '--only', pageId], {
            env: process.env,
            stdio: 'inherit',
          });
          versions.pages[pageId] = String(Date.now());
          appendEvent({ id: pageId, title: card.title });
          changed = true;
        } catch (error) {
          console.error(`[preview] blocks ${pageId}: ${error.message}`);
        }
      }
      if (changed) {
        versions.updatedAt = new Date().toISOString();
        writeVersions(versions);
      }
      previous = new Map(cards.map((card) => [card.title, card.column]));
      first = false;
    } catch (error) {
      console.error(`[preview] board: ${error.message}`);
    } finally {
      busy = false;
    }
  };

  if (once) {
    const versions = readVersions();
    for (const page of pages) {
      try {
        await capture(browser, page);
        versions.pages[page.id] = String(Date.now());
        appendEvent(page);
        console.log(`[preview] ${page.id} ← ${page.route}`);
      } catch (error) {
        console.error(`[preview] ${page.id}: ${error.message}`);
      }
    }
    versions.updatedAt = new Date().toISOString();
    writeVersions(versions);
    await browser.close();
    return;
  }

  await tick();
  console.log('[preview] watching board; Ctrl+C to stop');
  setInterval(tick, intervalMs);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
