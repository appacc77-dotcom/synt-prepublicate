#!/usr/bin/env node
/**
 * Собирает отчёт дизайнеру из реестра долгов.
 *
 *   node tools/report-designer.mjs [--check]
 *
 * Зачем: `docs/FIGMA-ISSUES.md` — проза, а статусы и владельцы живут в
 * `docs/debts.json`. Два источника расходятся молча: долг закрыли, а в
 * документе он всё ещё «открыт», или наоборот. Отсюда — таблица, собранная
 * из реестра, которую документ показывает между маркерами.
 *
 * `--check` ничего не пишет, только говорит, совпадает ли таблица в файле с
 * реестром: 0 — совпадает, 1 — расходится. Так расхождение видно в воротах,
 * а не через месяц в переписке.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const checkOnly = process.argv.includes('--check');

const START = '<!-- designer-report:start -->';
const END = '<!-- designer-report:end -->';

const debtsPath = join(root, 'docs/debts.json');
const docPath = join(root, 'docs/FIGMA-ISSUES.md');
if (!existsSync(debtsPath)) {
  console.error('нет docs/debts.json');
  process.exit(2);
}
if (!existsSync(docPath)) {
  console.error('нет docs/FIGMA-ISSUES.md');
  process.exit(2);
}

const debts = JSON.parse(readFileSync(debtsPath, 'utf8')).debts ?? [];
const STATUS = { open: 'открыт', waiting: 'ждёт', done: 'закрыт', rejected: 'отклонён' };

// Дизайнеру показываем только его пункты: клиентские и студийные ему не нужны.
const items = debts.filter((d) => d.owner === 'designer').sort((a, b) => {
  const num = (id) => Number(String(id).replace(/\D/g, '')) || 0;
  return num(a.id) - num(b.id);
});

const open = items.filter((d) => d.status !== 'done' && d.status !== 'rejected').length;

const rows = items.map((d) => `| ${d.id} | ${d.title} | ${STATUS[d.status] ?? d.status} |`).join('\n');

const block = `${START}
<!-- Собрано tools/report-designer.mjs из docs/debts.json. Руками не править. -->

**Пункты для дизайнера:** ${items.length}, из них открыто **${open}**.

| | что | статус |
|---|---|---:|
${rows}
${END}`;

const source = readFileSync(docPath, 'utf8');
const hasMarkers = source.includes(START) && source.includes(END);

if (checkOnly) {
  if (!hasMarkers) {
    console.error('в docs/FIGMA-ISSUES.md нет маркеров отчёта — запустите npm run report:designer');
    process.exit(1);
  }
  const from = source.indexOf(START);
  const to = source.indexOf(END) + END.length;
  const current = source.slice(from, to);
  if (current !== block) {
    console.error('таблица в документе разошлась с docs/debts.json — пересоберите: npm run report:designer');
    process.exit(1);
  }
  console.log(`отчёт дизайнеру сходится с реестром: ${items.length} пунктов, открыто ${open}`);
  process.exit(0);
}

let next;
if (hasMarkers) {
  const from = source.indexOf(START);
  const to = source.indexOf(END) + END.length;
  next = source.slice(0, from) + block + source.slice(to);
} else {
  // Ставим блок сразу после сводки, до разделов с подробностями.
  const at = source.indexOf('\n## 1.');
  next = at === -1
    ? `${source.trimEnd()}\n\n${block}\n`
    : `${source.slice(0, at)}\n${block}\n${source.slice(at)}`;
}

writeFileSync(docPath, next);
console.log(`отчёт дизайнеру: ${items.length} пунктов, открыто ${open} · записано в docs/FIGMA-ISSUES.md`);
