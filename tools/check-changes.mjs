#!/usr/bin/env node
/**
 * Изменившаяся секция требует запроса на изменение.
 *
 *   node tools/check-changes.mjs            # текущий снимок против git HEAD
 *   node tools/check-changes.mjs --verbose  # показать и закрытые запросы
 *
 * Зачем: макет живёт, и правка «по месту» после сдачи незаметна. Запрос
 * `changes/CR-NNN.md` фиксирует, что изменилось и кто решил. Ворота красные,
 * если отпечаток секции изменился, а одобренного запроса на неё нет.
 *
 * Коды: 0 — всё покрыто, 1 — есть изменения без запроса, 2 — не смогли проверить.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const snapshotPath = join(root, 'design/figma/live/snapshot.json');
const changesDir = join(root, 'changes');
const verbose = process.argv.includes('--verbose');

if (!existsSync(snapshotPath)) {
  console.error('нет design/figma/live/snapshot.json — сначала npm run intake');
  process.exit(2);
}

const current = JSON.parse(readFileSync(snapshotPath, 'utf8'));

// Предыдущий снимок — из git. Нет git или файла в истории — проверять нечего:
// это не ошибка, просто сравнивать не с чем.
let previous = null;
try {
  const raw = execFileSync('git', ['show', 'HEAD:design/figma/live/snapshot.json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  previous = JSON.parse(raw);
} catch {
  console.log('предыдущего снимка в git нет — сравнивать не с чем');
  process.exit(0);
}

const before = previous.sections ?? {};
const after = current.sections ?? {};
const changed = [];
for (const unit of Object.keys(after)) {
  if (!before[unit]) {
    changed.push({ unit, kind: 'появилась' });
    continue;
  }
  const files = new Set([...Object.keys(before[unit]), ...Object.keys(after[unit])]);
  const diff = [...files].filter((f) => before[unit][f] !== after[unit][f]);
  if (diff.length) changed.push({ unit, kind: 'изменилась', files: diff });
}

if (!changed.length) {
  console.log('снимок совпадает с git: изменившихся секций нет');
  process.exit(0);
}

// Одобренные запросы: шапка между --- ---, поля id, status, sections.
const approved = new Map();
if (existsSync(changesDir)) {
  for (const file of readdirSync(changesDir)) {
    if (!/^CR-.*\.md$/.test(file)) continue;
    const text = readFileSync(join(changesDir, file), 'utf8');
    const head = text.split('---')[1] ?? '';
    const status = /status:\s*(\w+)/.exec(head)?.[1];
    const list = /sections:\s*\[([^\]]*)\]/.exec(head)?.[1] ?? '';
    const units = list.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    const id = /id:\s*([\w-]+)/.exec(head)?.[1] ?? file.replace('.md', '');
    for (const unit of units) {
      if (status === 'approved' || status === 'done') approved.set(unit, id);
      else if (verbose) console.log(`  ${id}: ${unit} — status ${status}, не считается`);
    }
  }
}

const uncovered = changed.filter((item) => !approved.has(item.unit));
const covered = changed.filter((item) => approved.has(item.unit));

console.log(`изменившихся секций: ${changed.length} · покрыто запросами: ${covered.length}`);
for (const item of covered) console.log(`  ${item.unit} — ${approved.get(item.unit)}`);

if (!uncovered.length) {
  console.log('все изменения покрыты запросами');
  process.exit(0);
}

console.error(`\nбез запроса на изменение: ${uncovered.length}`);
for (const item of uncovered) {
  console.error(`  ${item.unit} — ${item.kind}${item.files ? ` (${item.files.join(', ')})` : ''}`);
}
console.error('\nсоздайте changes/CR-NNN.md со status: approved и списком секций');
process.exit(1);
