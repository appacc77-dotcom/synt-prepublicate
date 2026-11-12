#!/usr/bin/env node
/**
 * Поблочные скриншоты текущей сборки для /structure.html.
 *
 * «До» — статические Figma-секции; старый сервер syntonia-deepseek больше
 * не нужен. Запуск: node scripts/structure-blocks.mjs [--only page]
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public/structure/blocks');
const newBase = process.env.SYNTONIA_URL ?? 'http://127.0.0.1:4321';
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

mkdirSync(outDir, { recursive: true });

const items = [
  // masters
  ['masters', 'founder-hero', '/masters.html', '.masters-hero', '/masters.html', '.master-hero'],
  ['masters', 'masters-team', '/masters.html', '.masters-team', '/masters.html', '.masters-team'],
  ['masters', 'masters-more', '/masters.html', '.masters-more', '/masters.html', '.masters-more'],
  // practice
  ['practice', 'hero', '/practice.html', '.practice-hero', '/practice.html', '.page-hero'],
  ['practice', 'practice-free', '/practice.html', '.practice-free', '/practice.html', '#free'],
  ['practice', 'quiz', '/practice.html', '.practice-quiz', '/practice.html', '.quiz-banner'],
  ['practice', 'practice-pay', '/practice.html', '.practice-pay', '/practice.html', '#paid'],
  ['practice', 'kody-practice-pay', '/practice.html', '.practice-codes', '/practice.html', '#codes'],
  ['practice', 'practice-package', '/practice.html', '.practice-packages', '/practice.html', '#packages'],
  ['practice', 'info-section', '/practice.html', '.practice-info', '/practice.html', '.practice-info'],
  // library
  ['library', 'library-hero', '/library.html', '.library-hero', '/library.html', '.page-hero'],
  ['library', 'library-book', '/library.html', '.library-book', '/library.html', '.book'],
  ['library', 'library-journal', '/library.html', '.library-journal', '/library.html', '.journal'],
  ['library', 'library-issues', '/library.html', '.issues', '/library.html', '.issues'],
  // booking
  ['booking', 'booking-hero', '/booking.html', '.booking-hero', '/booking.html', '.page-hero'],
  ['booking', 'booking-formats', '/booking.html', '.booking', '/booking.html', '.booking'],
  // quiz
  ['quiz', 'quiz-section', '/quiz.html', 'main#main', '/quiz.html', '.quiz'],
  // legal
  ['offer', 'legal', '/offer.html', '.legal', '/offer.html', '.legal-page'],
  ['privacy', 'legal', '/privacy.html', '.legal', '/privacy.html', '.legal-page'],
  ['consent', 'legal', '/consent.html', '.legal', '/consent.html', '.legal-page'],
  ['404', '404', '/404.html', '.notfound', '/404.html', '.legal-page--404'],
  // home
  ['home', 'hero', '/', '.hero', null, null, 'public/structure/home-hero-site.jpg'],
  ['home', 'banner', '/', '.banner', null, null, 'public/structure/home-banner-site.jpg'],
  ['home', 'pain', '/', '.pain', null, null, 'public/structure/home-pain-site.jpg'],
  ['home', 'method', '/', '.method', null, null, 'public/structure/home-method-site.jpg'],
  ['home', 'quiz', '/', '.quiz', null, null, 'public/structure/home-quiz-site.jpg'],
  ['home', 'founder', '/', '.founder', null, null, 'public/structure/home-founder-site.jpg'],
  ['home', 'process', '/', '.process', null, null, 'public/structure/home-process-site.jpg'],
  ['home', 'entry', '/', '.entry', null, null, 'public/structure/home-entry-site.jpg'],
  ['home', 'formats', '/', '.formats', null, null, 'public/structure/home-formats-site.jpg'],
  ['home', 'voices', '/', '.voices', null, null, 'public/structure/home-voices-site.jpg'],
  ['home', 'library', '/', '.library', null, null, 'public/structure/home-library-site.jpg'],
  ['home', 'air', '/', '.air-photo', null, null, 'public/structure/home-air-site.jpg'],
  ['home', 'faq', '/', '.faq', null, null, 'public/structure/home-faq-site.jpg'],
  // method
  ['method', 'hero', '/method.html', '.method-hero', null, null, 'public/structure/method-hero-site.jpg'],
  ['method', 'principles', '/method.html', '.method-principles', null, null, 'public/structure/method-principles-site.jpg'],
  ['method', 'cta', '/method.html', '.method-cta', null, null, 'public/structure/method-cta-site.jpg'],
  // shared
  ['shared', 'header', '/', '.site-header', null, null],
  ['shared', 'footer', '/', 'footer.footer', null, null],
];

const shot = async (browser, base, route, selector, output) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(base + route, { waitUntil: 'networkidle', timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    const el = page.locator(selector).first();
    if (!(await el.count())) throw new Error(`selector not found: ${selector}`);
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await el.screenshot({ path: output, type: 'jpeg', quality: 82 });
  } finally {
    await page.close();
  }
};

const browser = await chromium.launch({ headless: true });
for (const [page, block, route, selector, , , afterPath] of items) {
  if (only && page !== only) continue;
  const after = afterPath ? path.resolve(root, afterPath) : path.join(outDir, `${page}-${block}-after.jpg`);
  mkdirSync(path.dirname(after), { recursive: true });
  try {
    await shot(browser, newBase, route, selector, after);
    console.log(`[after] ${page}/${block}`);
  } catch (error) {
    console.error(`[after] ${page}/${block}: ${error.message}`);
  }
}
await browser.close();
