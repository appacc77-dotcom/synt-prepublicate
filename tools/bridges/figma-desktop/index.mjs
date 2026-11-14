/**
 * Мост к Figma desktop: плагин «DESIGN:OS Bridge» → брокер → CLI `figma-agent`.
 *
 * Требует открытого Figma с нужным файлом и живым плагином; данные — то, что
 * видит приложение сейчас (не опубликованная версия).
 *
 * Все операции только читают: снимки дерева, список страниц, экспорт PNG,
 * справочник дизайн-системы. Ни одна не меняет файл.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runFigma, FigmaError } from '../../figma/cli.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(moduleDir, '..', '..', '..');

export const meta = {
  id: 'figma-desktop',
  title: 'Figma desktop (плагин + брокер figma-agent)',
  requires: 'Figma desktop с открытым файлом и запущенным плагином «DESIGN:OS Bridge»',
  source: 'живой файл',
};

function elapsed(start) {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e6);
}

/** Транспортные коды отделяем от ошибок плагина: это разные дефекты. */
function bridge(args, timeoutMs = 180000) {
  try {
    return runFigma(args, { timeoutMs });
  } catch (error) {
    if (error instanceof FigmaError) {
      const transport = ['E_NO_PLUGIN', 'E_NO_BROKER', 'E_TIMEOUT', 'E_NO_ANSWER', 'E_VERSION_MISMATCH'];
      const wrapped = new Error(`${error.code}: ${error.message}`);
      wrapped.code = transport.includes(error.code) ? 2 : 3;
      throw wrapped;
    }
    throw error;
  }
}

function runTemplate(templateName, replacements = {}, timeoutMs = 180000) {
  let source = readFileSync(join(moduleDir, 'templates', templateName), 'utf8');
  for (const [key, value] of Object.entries(replacements)) source = source.split(key).join(String(value));
  const tmp = join(tmpdir(), `bridge-${templateName.replace('.js', '')}-${process.pid}.js`);
  writeFileSync(tmp, source);
  return bridge(['exec-js', tmp, '--timeout', String(timeoutMs)], timeoutMs + 15000);
}

/** exec-js печатает console.log в массив `console`; берём последнюю JSON-строку. */
function consoleJson(reply) {
  const lines = Array.isArray(reply?.console) ? reply.console : [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const text = String(lines[i]);
    const at = text.indexOf('{');
    if (at < 0) continue;
    try {
      return JSON.parse(text.slice(at));
    } catch {
      /* не JSON — смотрим предыдущую строку */
    }
  }
  return null;
}

export async function status() {
  const start = process.hrtime.bigint();
  const reply = bridge(['status', '--peek'], 30000);
  const ms = elapsed(start);
  const plugin = reply.plugins?.[0] ?? null;
  return {
    ms,
    connected: Boolean(reply.connected),
    source: meta.id,
    file: plugin?.fileName ?? null,
    details: {
      brokerPort: reply.broker?.port ?? null,
      page: plugin?.page ?? null,
      pluginVersion: plugin?.pluginVersion ?? null,
      protocolMatch: plugin?.protocolMatch ?? null,
      fileKey: reply.fileContext?.fileKey ?? null,
    },
  };
}

export async function pages() {
  const start = process.hrtime.bigint();
  const reply = runTemplate('list-pages.template.js');
  const data = consoleJson(reply);
  if (!data) throw new Error('мост не вернул список страниц');
  return {
    ms: elapsed(start),
    source: meta.id,
    file: reply.fileContext?.fileKey ?? null,
    pages: data.pages,
  };
}

export async function tree({ page = 'Home', depth = 6, out = null }) {
  const start = process.hrtime.bigint();
  const reply = runTemplate('dump-tree.template.js', { __PAGE__: page, __MAX_DEPTH__: depth });
  const data = consoleJson(reply);
  if (!data || data.error) {
    throw new Error(`страница «${page}» не найдена; есть: ${(data?.pages ?? []).join(', ')}`);
  }
  if (out) writeFileSync(out, JSON.stringify(data, null, 1) + '\n');
  return { ms: elapsed(start), source: meta.id, file: data.file, data, out };
}

export async function png({ node, out, scale = 1 }) {
  if (!node) throw new Error('нужен --node <id|selection>');
  if (!out) throw new Error('нужен --out <file.png>');
  const start = process.hrtime.bigint();
  bridge(['export-png', '--node', String(node), '--out', out, '--scale', String(scale)]);
  return {
    ms: elapsed(start),
    source: meta.id,
    node,
    out,
    bytes: readFileSync(out).length,
  };
}

export async function timing({ page = 'Home', node = '79:105' } = {}) {
  const suite = [];
  const step = async (name, fn) => {
    const start = process.hrtime.bigint();
    const detail = await fn();
    suite.push({ step: name, ms: elapsed(start), ...detail });
  };
  await step('status', async () => {
    const reply = bridge(['status', '--peek'], 30000);
    return { connected: Boolean(reply.connected), file: reply.plugins?.[0]?.fileName ?? null };
  });
  await step('pages', async () => {
    const data = consoleJson(runTemplate('list-pages.template.js'));
    return { pages: data?.pages?.length ?? 0 };
  });
  await step('scan-design-system', async () => {
    const out = join(tmpdir(), `bridge-ds-${process.pid}.json`);
    bridge(['scan-design-system', '--out', out]);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    return { counts: parsed.counts ?? null };
  });
  await step('tree', async () => {
    const data = consoleJson(runTemplate('dump-tree.template.js', { __PAGE__: page, __MAX_DEPTH__: 6 }));
    return { page: data?.page ?? null, nodes: data?.total ?? 0 };
  });
  await step('png', async () => {
    const out = join(tmpdir(), `bridge-timing-${process.pid}.png`);
    bridge(['export-png', '--node', String(node), '--out', out, '--scale', '1']);
    return { node, out, bytes: readFileSync(out).length };
  });
  return { ms: suite.reduce((sum, item) => sum + item.ms, 0), source: meta.id, page, node, suite };
}

export default { meta, status, pages, tree, png, timing };
void repoRoot;
