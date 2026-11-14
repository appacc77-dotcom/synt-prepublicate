#!/usr/bin/env node
/**
 * Собирает состояние проекта из артефактов и обновляет таблицу в STATUS.md.
 *
 *   node tools/status.mjs          # напечатать
 *   node tools/status.mjs --write  # переписать блок между маркерами в STATUS.md
 *
 * Числа не пересказываются в документах: они читаются из gate.json и pixel.json
 * рядом с каждой секцией. Если секция пересобрана, достаточно позвать это.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const pagesDir = join(root, 'design/figma/pages');

const rows = [];
for (const page of readdirSync(pagesDir)) {
  const dir = join(pagesDir, page);
  for (const name of readdirSync(dir)) {
    const gatePath = join(dir, name, 'gate.json');
    const pixelPath = join(dir, name, 'pixel.json');
    if (!existsSync(gatePath)) continue;

    const gate = JSON.parse(readFileSync(gatePath, 'utf8'));
    const pixel = existsSync(pixelPath) ? JSON.parse(readFileSync(pixelPath, 'utf8')) : null;
    rows.push({ page, name, gate, pixel });
  }
}

const built = rows.filter((r) => r.gate.ok);
const red = rows.filter((r) => !r.gate.ok);
const mean = built.filter((r) => r.pixel).reduce((s, r) => s + r.pixel.mean, 0) / Math.max(1, built.filter((r) => r.pixel).length);

rows.sort((a, b) => (a.page === b.page ? (b.pixel?.mean ?? 0) - (a.pixel?.mean ?? 0) : a.page.localeCompare(b.page)));

const lines = [];
lines.push(`секций собрано: **${built.length}** из ${rows.length}${red.length ? `, красных: ${red.length}` : ''}`);
lines.push('');
lines.push('| секция | геометрия | узлов | пиксель | > 16 | > 48 |');
lines.push('|---|---:|---:|---:|---:|---:|');
for (const r of rows) {
  const g = r.gate.ok ? 'зелёная' : `**${r.gate.red} красных**`;
  const p = r.pixel ? r.pixel.mean.toFixed(2) : '—';
  const o16 = r.pixel ? `${r.pixel.over16.toFixed(2)} %` : '—';
  const o48 = r.pixel ? `${r.pixel.over48.toFixed(2)} %` : '—';
  lines.push(`| ${r.page}/${r.name} | ${g} | ${r.gate.marked} | ${p} | ${o16} | ${o48} |`);
}
lines.push('');
lines.push(`средний пиксель по собранным: **${mean.toFixed(2)}**`);

// Последний прогон конвейера: вердикт и пригодность к выпуску.
const latestPath = join(root, 'reports/runs/latest');
if (existsSync(latestPath)) {
  const id = readFileSync(latestPath, 'utf8').trim();
  const verdictPath = join(root, 'reports/runs', id, 'verdict.json');
  if (existsSync(verdictPath)) {
    const v = JSON.parse(readFileSync(verdictPath, 'utf8'));
    const red = (v.steps ?? []).filter((step) => step.kind === 'gate' && step.status !== 'PASS').map((step) => step.id);
    lines.push('');
    lines.push(
      `последний прогон: \`${v.runId}\` · **${v.status}** · ${v.mode ?? (v.unit ? 'unit' : 'full')}` +
        // Решение 419: «пригоден» относится к прогону (PASS, полный, чистое
        // дерево), а не к готовности сайта к запуску. Продуктовые блокеры —
        // в разделе «Запуск» выше, их из verdict не вывести.
        ` · прогон ${v.releaseEligible ? 'пригоден' : 'не пригоден'} к публикации` +
        (red.length ? ` · не PASS: ${red.slice(0, 8).join(', ')}${red.length > 8 ? ` и ещё ${red.length - 8}` : ''}` : ''),
    );
  }
}

// Реестры: изобретённое и долги этапа 1. Закрытие этапа — по этим числам.
const readJson = (path) => (existsSync(join(root, path)) ? JSON.parse(readFileSync(join(root, path), 'utf8')) : null);
const invented = readJson('design/figma/invented.json');
const debts = readJson('docs/debts.json');
if (invented || debts) {
  lines.push('');
  if (invented) lines.push(`изобретённое (\`design/figma/invented.json\`): **${invented.entries.length}** записей`);
  if (debts) {
    const open = debts.debts.filter((d) => d.status === 'open' || d.status === 'waiting');
    const by = {};
    for (const d of open) by[d.owner] = (by[d.owner] ?? 0) + 1;
    const blocking = open.filter((d) => d.blocksRelease);
    lines.push(
      `долги этапа 1 (\`docs/debts.json\`): открыто **${open.length}** из ${debts.debts.length}` +
        ` · ${Object.entries(by).map(([owner, n]) => `${owner} ${n}`).join(', ')}` +
        (blocking.length ? ` · блокируют сдачу: ${blocking.map((d) => d.id).join(', ')}` : ''),
    );
  }
}

// Закрытие этапа 1: один блок, по которому принимается решение о сдаче.
// Считается по реестру долгов, а не по памяти: что открыто, у кого, что
// блокирует и что уже закрыто.
if (debts) {
  const all = debts.debts ?? [];
  const blocking = all.filter((d) => d.blocksRelease && d.status !== 'done' && d.status !== 'rejected');
  const closed = all.filter((d) => d.status === 'done' || d.status === 'rejected');
  lines.push('');
  lines.push('### Закрытие этапа 1');
  lines.push('');
  if (blocking.length) {
    lines.push(`не готово: блокируют сдачу **${blocking.length}** — ${blocking.map((d) => `${d.id} (${d.owner})`).join(', ')}`);
    for (const d of blocking) lines.push(`- \`${d.id}\` ${d.title} — у ${d.owner}`);
  } else {
    lines.push('готово: блокирующих долгов нет');
  }
  lines.push('');
  lines.push(`закрыто ${closed.length} из ${all.length} · открыто ${all.length - closed.length}`);
  const byKind = {};
  for (const d of all.filter((x) => x.status !== 'done' && x.status !== 'rejected')) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  if (Object.keys(byKind).length) lines.push(`по типу: ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ')}`);
}

const table = lines.join('\n');
console.log(table);

if (process.argv.includes('--write')) {
  const statusPath = join(root, 'STATUS.md');
  const status = readFileSync(statusPath, 'utf8');
  const start = '<!-- status:start -->';
  const end = '<!-- status:end -->';
  if (!status.includes(start) || !status.includes(end)) {
    console.error(`\nв STATUS.md нет маркеров ${start} … ${end}`);
    process.exit(1);
  }
  const next = status.replace(
    new RegExp(`${start}[\\s\\S]*?${end}`),
    `${start}\n${table}\n${end}`,
  );
  writeFileSync(statusPath, next);
  console.log('\nSTATUS.md обновлён');
}
