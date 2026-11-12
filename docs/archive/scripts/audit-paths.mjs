#!/usr/bin/env node
/**
 * Проверка переносимости: в коде, скриптах и конфигах не должно быть
 * абсолютных домашних путей, соседних репозиториев и PLAYWRIGHT_PATH.
 * Исторические reports/ и docs/system/ исключены: это не runtime-код.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const files = [];
const skipDirs = new Set(['node_modules', 'dist', '.git', '.astro', '.npmcache', '.npmlogs', '.state', 'public', 'design', 'reports', 'docs']);
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(root, full);
    if (name.startsWith('.') && name !== '.nvmrc') continue;
    if (statSync(full).isDirectory()) {
      if (!skipDirs.has(rel.split('/')[0])) walk(full);
      continue;
    }
    if (/\.(astro|ts|mjs|js|json|md)$/.test(name) && name !== 'package-lock.json') files.push(full);
  }
};
for (const name of ['src', 'scripts']) walk(join(root, name));
for (const name of ['AGENTS.md', 'README.md', 'package.json', 'astro.config.mjs', 'tsconfig.json']) {
  const full = join(root, name);
  try { statSync(full); files.push(full); } catch { /* нет файла */ }
}

const patterns = [
  [/\/Users\/[A-Za-z0-9._-]+/g, 'абсолютный /Users/...'],
  [/\.\.\/(syntonia-deepseek|agent-system|figma-layout-kit)/g, 'соседний репозиторий'],
  [/PLAYWRIGHT_PATH/g, 'внешний Playwright'],
];
const failures = [];
for (const file of files) {
  if (file.endsWith('audit-paths.mjs')) continue;
  const text = readFileSync(file, 'utf8');
  for (const [pattern, label] of patterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length) failures.push(`${relative(root, file)}: ${label} (${matches.length})`);
  }
}
if (failures.length) {
  console.error('[audit:paths] ошибки:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[audit:paths] ${files.length} файлов, абсолютных/соседних путей нет`);
