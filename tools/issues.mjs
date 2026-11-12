#!/usr/bin/env node
/**
 * Реестр ошибок: один источник — docs/issues.json, читаемая версия — docs/ISSUES.md.
 *
 *   node tools/issues.mjs --write   # пересобрать ISSUES.md из JSON
 *   node tools/issues.mjs           # проверить реестр (ворота issues)
 *
 * Зачем отдельный файл. Дефекты мы уже ловим воротами, но сами находки
 * теряются в переписке и коммитах: через месяц никто не вспомнит, почему
 * карточки практик показывали не то фото. Здесь у каждой находки есть причина,
 * решение и — главное — **как не допустить её снова**: правило или ворота.
 *
 * Контракт записи:
 *   id          ISS-NNN, по порядку
 *   found       дата находки (YYYY-MM-DD)
 *   session     метка сессии, чтобы видеть, что нашлось за один заход
 *   area        где: компонент, секция, конвейер, процесс, хостинг
 *   severity    blocker | major | minor
 *   status      fixed | open | planned
 *   title       одна строка: что случилось
 *   symptom     как это выглядело снаружи (что увидел человек)
 *   cause       почему так вышло — без обвинений, по факту
 *   solution    что сделали (для open — что делать)
 *   prevention  как не повторить: {rule, gate, status}
 *   refs        решения и коммиты
 *
 * Ворота проверяют: уникальность id, заполненность полей, что ссылка на
 * ворота существует в tools/checks.json, и что у fixed есть коммит.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const write = process.argv.includes('--write');
const dataPath = join(root, 'docs/issues.json');
const mdPath = join(root, 'docs/ISSUES.md');

if (!existsSync(dataPath)) {
  console.error('нет docs/issues.json');
  process.exit(2);
}

const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const checks = JSON.parse(readFileSync(join(root, 'tools/checks.json'), 'utf8')).checks ?? {};

const SEVERITY = ['blocker', 'major', 'minor'];
const STATUS = ['fixed', 'open', 'planned'];
const problems = [];

const seen = new Set();
for (const issue of data.issues ?? []) {
  const where = issue.id ?? '(без id)';
  if (!issue.id || !/^ISS-\d{3}$/.test(issue.id)) problems.push(`${where}: id должен быть ISS-NNN`);
  if (seen.has(issue.id)) problems.push(`${where}: id повторяется`);
  seen.add(issue.id);

  for (const field of ['found', 'session', 'area', 'title', 'symptom', 'cause', 'solution']) {
    if (!issue[field]) problems.push(`${where}: пустое поле ${field}`);
  }
  if (!SEVERITY.includes(issue.severity)) problems.push(`${where}: severity «${issue.severity}» вне списка`);
  if (!STATUS.includes(issue.status)) problems.push(`${where}: status «${issue.status}» вне списка`);

  const gate = issue.prevention?.gate;
  if (gate && gate !== '—' && !checks[gate]) {
    problems.push(`${where}: ворота «${gate}» нет в tools/checks.json`);
  }
  if (!issue.prevention?.rule && !gate) {
    problems.push(`${where}: нет ни правила, ни ворот — находка останется без защиты`);
  }
  if (issue.status === 'fixed' && !(issue.refs?.commits ?? []).length) {
    problems.push(`${where}: помечено fixed, но нет коммита`);
  }
}

if (problems.length) {
  console.log(`реестр ошибок: записей ${(data.issues ?? []).length} · проблем ${problems.length}`);
  for (const row of problems.slice(0, 15)) console.log(`  ${row}`);
  console.error('\nреестр не сходится: исправьте issues.json (это единственный источник)');
  process.exit(1);
}

if (!write) {
  const open = (data.issues ?? []).filter((i) => i.status !== 'fixed').length;
  console.log(`реестр ошибок: ${(data.issues ?? []).length} записей · открытых ${open} · формат сходится`);
  process.exit(0);
}

// --- читаемая версия -------------------------------------------------------
const byStatus = { fix: [], open: [], planned: [] };
for (const issue of data.issues) {
  if (issue.status === 'fixed') byStatus.fix.push(issue);
  else if (issue.status === 'open') byStatus.open.push(issue);
  else byStatus.planned.push(issue);
}

const cell = (text) => String(text).replace(/\|/g, '\\|');
const md = [];
md.push('# Ошибки и как их не повторять');
md.push('');
md.push('Собирается из `docs/issues.json`: `node tools/issues.mjs --write`. Руками не править.');
md.push('Каждая запись — найденная проблема, её причина, решение и защита на будущее.');
md.push('');
md.push(
  `Всего **${data.issues.length}** · исправлено ${byStatus.fix.length} · открыто ${byStatus.open.length} · запланировано ${byStatus.planned.length}.`,
);
md.push('');
md.push('## Открытое');
md.push('');
md.push('| id | где | что | как не повторить |');
md.push('|---|---|---|---|');
for (const i of byStatus.open) {
  md.push(`| ${i.id} | ${cell(i.area)} | ${cell(i.title)} | ${cell(i.prevention?.rule ?? '')}${i.prevention?.gate && i.prevention.gate !== '—' ? ` \`${i.prevention.gate}\`` : ''} |`);
}
md.push('');
md.push('## Запланировано');
md.push('');
md.push('| id | где | что | защита |');
md.push('|---|---|---|---|');
for (const i of byStatus.planned) {
  md.push(`| ${i.id} | ${cell(i.area)} | ${cell(i.title)} | ${cell(i.prevention?.rule ?? '')}${i.prevention?.gate && i.prevention.gate !== '—' ? ` \`${i.prevention.gate}\`` : ''} |`);
}
md.push('');
md.push('## Исправлено');
md.push('');
for (const session of data.sessions ?? []) {
  const rows = byStatus.fix.filter((i) => i.session === session.id);
  if (!rows.length) continue;
  md.push(`### ${session.title ?? session.id}`);
  md.push('');
  if (session.summary) {
    md.push(session.summary);
    md.push('');
  }
  for (const i of rows) {
    md.push(`**${i.id} · ${i.title}** — ${i.severity}`);
    md.push('');
    md.push(`- было: ${i.symptom}`);
    md.push(`- причина: ${i.cause}`);
    md.push(`- сделано: ${i.solution}`);
    if (i.prevention?.rule) md.push(`- правило: ${i.prevention.rule}`);
    if (i.prevention?.gate && i.prevention.gate !== '—') md.push(`- ворота: \`${i.prevention.gate}\``);
    const refs = [];
    for (const d of i.refs?.decisions ?? []) refs.push(`решение ${d}`);
    for (const c of i.refs?.commits ?? []) refs.push(`коммит ${c}`);
    if (refs.length) md.push(`- ${refs.join(', ')}`);
    md.push('');
  }
}

writeFileSync(mdPath, md.join('\n') + '\n');
console.log(`docs/ISSUES.md пересобран: ${data.issues.length} записей`);
