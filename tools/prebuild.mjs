#!/usr/bin/env node
/**
 * Проверка перед сборкой: сгенерированные файлы на месте?
 *
 * Класс ошибки: в новом проекте `npm run build` падает с `Could not resolve
 * '../styles/tokens.css'` или `Module not found: structure.json`. По этому
 * сообщению не понять, что нужно просто выполнить шаги в другом порядке —
 * и человек идёт читать исходники вместо README.
 *
 * Порядок холодного старта:
 *   1. npm run scaffold        (или копия tools/ и design/figma/project.json)
 *   2. npm install
 *   3. npm run intake          → design/figma/live/*.json
 *   4. npm run ds:tokens       → src/styles/tokens.css, typography.css
 *   5. npm run structure       → design/figma/structure.json
 *   6. npm run build
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

const required = [
  { path: 'design/figma/live/structure.json', step: 'npm run intake', why: 'снимок страниц и секций живого файла' },
  { path: 'src/styles/tokens.css', step: 'npm run ds:tokens', why: 'токены цветов и отступов из переменных Figma' },
  { path: 'src/styles/typography.css', step: 'npm run ds:tokens', why: 'текстовые стили из файла' },
  { path: 'design/figma/structure.json', step: 'npm run structure', why: 'карта для страницы /structure.html' },
];

// Выпуск собирается без design/ и docs/ (решение 397): там только файлы
// сайта. В этом режиме обязательны лишь сгенерированные стили — они лежат
// в src/ и коммитятся вместе с ним.
const release = process.env.RELEASE === '1';
const requiredForRelease = required.filter((item) => item.path.startsWith('src/'));
const needed = release ? requiredForRelease : required;

const missing = needed.filter((item) => !existsSync(join(root, item.path)));

if (!missing.length) process.exit(0);

console.error('\nсборка не может начаться: нет сгенерированных файлов\n');
for (const item of missing) {
  console.error(`  ${item.path}`);
  console.error(`    └ нужно: ${item.step}   (${item.why})`);
}
console.error('\nпорядок холодного старта: intake → ds:tokens → structure → build');
process.exit(2);
