/**
 * Мост к FigCraft через `figcraft-cli mcp`.
 *
 * Отличие от Figma desktop: данные берутся из архива (`.fig`, `.figcraft`,
 * REST-JSON) локальным процессом, окно не нужно. Плагинов Figma FigCraft не
 * запускает — это другой API, поэтому и модуль другой, а форма ответа общая
 * (см. ../README.md).
 *
 * Зависимости: бинарь `figcraft-cli` версии, совместимой с приложением.
 * Путь: FIGCRAFT_CLI, иначе соседний `_tools/figcraft-cli-pkg/…/figcraft-cli`,
 * иначе PATH.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { McpClient } from './mcp-client.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(moduleDir, '..', '..', '..');

export const meta = {
  id: 'figcraft-cli',
  title: 'FigCraft (CLI, MCP по stdio)',
  requires: 'бинарь figcraft-cli; архив .fig/.figcraft/REST-JSON на диске',
  source: 'архив',
};

function elapsed(start) {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e6);
}

export function cliPath() {
  if (process.env.FIGCRAFT_CLI) return process.env.FIGCRAFT_CLI;
  const base = join(repoRoot, '..', '_tools');
  const candidates = [
    join(base, 'figcraft-cli-pkg', 'figcraft-cli-0.18.1-macos-universal', 'figcraft-cli'),
    join(base, 'figcraft-cli-pkg', 'figcraft-cli'),
    join(base, 'figcraft-cli'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return 'figcraft-cli';
}

/** Файл и каталоги, к которым сессии разрешено обращаться. */
function resolveFile(fig) {
  if (!fig) throw new Error('нужен --fig <file.fig|file.figcraft>');
  const abs = fig.startsWith('/') ? fig : join(process.cwd(), fig);
  if (!existsSync(abs)) throw new Error(`файл не найден: ${abs}`);
  return abs;
}

/** Каталог вывода добавляется в разрешённые на запись: файл может лежать где угодно. */
function openClient(abs, extraWriteRoots = []) {
  const writeRoots = [...new Set([tmpdir(), join(repoRoot, 'reports'), ...extraWriteRoots])];
  for (const dir of writeRoots) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return new McpClient({
    command: cliPath(),
    args: [
      'mcp',
      '--automation-read-root',
      dirname(abs),
      ...writeRoots.flatMap((dir) => ['--automation-write-root', dir]),
    ],
  });
}

const round = (value) => (typeof value === 'number' ? Math.round(value * 100) / 100 : undefined);

/**
 * Документ FigCraft → плоский список узлов.
 * Пути строятся по именам, одноимённые соседи получают «#2»; глубина
 * ограничивается тем же `depth`, что у desktop-моста, — иначе сверка сравнивает
 * разные объёмы.
 */
function flatten(page, maxDepth) {
  const nodes = [];
  const walk = (node, depth, path) => {
    const record = { path, id: node.id, name: node.name, type: node.type, depth };
    if (typeof node.x === 'number') {
      record.x = round(node.x);
      record.y = round(node.y);
    }
    if (typeof node.width === 'number') {
      record.w = round(node.width);
      record.h = round(node.height);
    }
    if (node.type === 'TEXT' && typeof node.characters === 'string') record.text = node.characters;
    if (node.visible === false) record.hidden = true;
    nodes.push(record);
    if (depth >= maxDepth) return;
    const counters = new Map();
    for (const child of Array.isArray(node.children) ? node.children : []) {
      const count = (counters.get(child.name) ?? 0) + 1;
      counters.set(child.name, count);
      walk(child, depth + 1, `${path}/${count > 1 ? `${child.name}#${count}` : child.name}`);
    }
  };
  walk(page, 0, page.name);
  return nodes;
}

const pagesOf = (document) => document?.pages ?? document?.document?.pages ?? [];
const docOf = (payload) => payload?.document ?? payload;

export async function status({ fig }) {
  const abs = resolveFile(fig);
  const client = openClient(abs);
  try {
    const start = process.hrtime.bigint();
    const hello = await client.initialize();
    const opened = await client.call('open_file', { path: abs });
    const ms = elapsed(start);
    const summary = opened?.opened?.summary ?? opened?.summary ?? {};
    const document = docOf(opened);
    return {
      ms,
      connected: true,
      file: abs,
      source: meta.id,
      server: hello?.serverInfo?.name ?? null,
      protocol: hello?.protocolVersion ?? null,
      details: {
        name: summary.name ?? document?.name ?? null,
        pages: summary.pages ?? pagesOf(document).length,
        layers: summary.layers ?? null,
        images: summary.images ?? null,
        warnings: (opened?.opened?.warnings ?? opened?.warnings ?? []).length,
        repairs: (opened?.opened?.repairs ?? []).length,
      },
    };
  } finally {
    client.close();
  }
}

export async function pages({ fig }) {
  const abs = resolveFile(fig);
  const client = openClient(abs);
  try {
    const start = process.hrtime.bigint();
    await client.initialize();
    const opened = await client.call('open_file', { path: abs });
    const list = pagesOf(docOf(opened)).map((page) => ({
      id: page.id,
      name: page.name,
      children: Array.isArray(page.children) ? page.children.length : (page.childCount ?? 0),
    }));
    return { ms: elapsed(start), file: abs, source: meta.id, pages: list };
  } finally {
    client.close();
  }
}

export async function tree({ fig, page = 'Home', depth = 6, out = null }) {
  const abs = resolveFile(fig);
  const client = openClient(abs);
  try {
    const start = process.hrtime.bigint();
    await client.initialize();
    await client.call('open_file', { path: abs });
    const payload = await client.call('inspect_document', { depth, allPages: true });
    const document = docOf(payload);
    const list = pagesOf(document);
    const target = list.find((item) => item.name === page);
    if (!target) {
      throw new Error(`страница «${page}» не найдена; есть: ${list.map((p) => p.name).join(', ')}`);
    }
    const nodes = flatten(target, depth);
    const data = { source: meta.id, file: abs, page: target.name, depth, total: nodes.length, nodes };
    if (out) writeFileSync(out, JSON.stringify(data, null, 1) + '\n');
    return { ms: elapsed(start), file: abs, source: meta.id, data, out };
  } finally {
    client.close();
  }
}

export async function png({ fig, node, out, scale = 1 }) {
  const abs = resolveFile(fig);
  if (!node) throw new Error('нужен --node <id>');
  if (!out) throw new Error('нужен --out <file.png>');
  const client = openClient(abs, [dirname(out)]);
  try {
    const start = process.hrtime.bigint();
    await client.initialize();
    await client.call('open_file', { path: abs });
    const ids = /^\d+(:\d+)?$/.test(String(node)) ? [Number(String(node).split(':').pop())] : [node];
    const exported = await client.call('export', { ids, format: 'png', scale, path: out });
    return {
      ms: elapsed(start),
      file: abs,
      source: meta.id,
      node,
      out,
      bytes: existsSync(out) ? readFileSync(out).length : null,
      exported,
    };
  } finally {
    client.close();
  }
}

export async function timing({ fig, page = 'Home', node = null, depth = 6 }) {
  const abs = resolveFile(fig);
  const client = openClient(abs);
  const suite = [];
  const step = async (name, fn) => {
    const start = process.hrtime.bigint();
    const detail = await fn();
    suite.push({ step: name, ms: elapsed(start), ...detail });
  };
  try {
    await client.initialize();
    await step('open_file', async () => {
      const opened = await client.call('open_file', { path: abs });
      const summary = opened?.opened?.summary ?? {};
      return { pages: summary.pages ?? null, layers: summary.layers ?? null, images: summary.images ?? null };
    });
    await step('pages', async () => {
      const payload = await client.call('inspect_document', { depth: 0, allPages: true });
      return { pages: pagesOf(docOf(payload)).length };
    });
    let treeMs = 0;
    await step('tree', async () => {
      const start = process.hrtime.bigint();
      const payload = await client.call('inspect_document', { depth, allPages: true });
      const target = pagesOf(docOf(payload)).find((item) => item.name === page);
      const nodes = target ? flatten(target, depth) : [];
      treeMs = elapsed(start);
      return { page: target?.name ?? null, nodes: nodes.length, bytes: JSON.stringify(nodes).length };
    });
    if (node) {
      await step('png', async () => {
        const out = join(tmpdir(), `figcraft-timing-${process.pid}.png`);
        const ids = /^\d+(:\d+)?$/.test(String(node)) ? [Number(String(node).split(':').pop())] : [node];
        await client.call('export', { ids, format: 'png', scale: 1, path: out });
        return { node, out, bytes: existsSync(out) ? readFileSync(out).length : null };
      });
    }
    return { ms: suite.reduce((sum, item) => sum + item.ms, 0), file: abs, source: meta.id, page, node, treeMs, suite };
  } finally {
    client.close();
  }
}

export default { meta, status, pages, tree, png, timing };
