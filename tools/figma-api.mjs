#!/usr/bin/env node
/**
 * Клиент Figma REST API — третий источник истины.
 *
 *   node tools/figma-api.mjs file [--depth 2]
 *   node tools/figma-api.mjs nodes <id,id,...>
 *   node tools/figma-api.mjs meta
 *
 * Токен берётся из FIGMA_TOKEN, иначе из пути `api.tokenFile` в project.json.
 * Токен не печатается и не попадает в артефакты.
 *
 * Отличие от моста: мост читает то, что открыто в приложении, и отдаёт любые
 * свойства плагина; API отдаёт **версию файла** и работает без открытого
 * приложения, но только опубликованное и с задержкой.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const project = JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8'));
const fileKey = project.source.fileKey;

function token() {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN.trim();
  const path = project.api?.tokenFile;
  if (path) {
    const abs = join(root, path);
    if (existsSync(abs)) return readFileSync(abs, 'utf8').trim();
  }
  return null;
}

const t = token();
if (!t) {
  console.error('нет токена: задай FIGMA_TOKEN или api.tokenFile в project.json');
  process.exit(2);
}

async function api(path) {
  const url = `https://api.figma.com/v1${path}`;
  const res = await fetch(url, { headers: { 'X-Figma-Token': t } });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`не JSON (${res.status}): ${text.slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(`${res.status}: ${json.err ?? json.message ?? 'ошибка API'}`);
  return json;
}

const [command, arg] = process.argv.slice(2);

try {
  if (command === 'meta' || !command) {
    const data = await api(`/files/${fileKey}?depth=1`);
    const out = {
      name: data.name,
      version: data.version,
      lastModified: data.lastModified,
      editorType: data.editorType,
      role: data.role,
      pages: (data.document?.children ?? []).map((p) => ({ id: p.id, name: p.name })),
    };
    console.log(`файл:      ${out.name}`);
    console.log(`версия:    ${out.version}`);
    console.log(`изменён:   ${out.lastModified}`);
    console.log(`страниц:   ${out.pages.length}`);
    mkdirSync(join(root, 'design/figma/live'), { recursive: true });
    writeFileSync(join(root, 'design/figma/live/api.json'), JSON.stringify(out, null, 2) + '\n');
  } else if (command === 'file') {
    const depth = Number(process.argv.includes('--depth') ? process.argv[process.argv.indexOf('--depth') + 1] : 2);
    const data = await api(`/files/${fileKey}?depth=${depth}`);
    const out = join(root, 'design/figma/live/api-file.json');
    writeFileSync(out, JSON.stringify(data, null, 1) + '\n');
    console.log(`страниц: ${data.document.children.length}, глубина ${depth}`);
    console.log(`файл: ${out}`);
  } else if (command === 'nodes') {
    if (!arg) {
      console.error('укажи id узлов через запятую');
      process.exit(2);
    }
    const data = await api(`/files/${fileKey}/nodes?ids=${encodeURIComponent(arg)}&depth=1`);
    console.log(JSON.stringify(data, null, 1).slice(0, 2000));
  } else {
    console.error(`неизвестная команда: ${command}`);
    process.exit(2);
  }
} catch (error) {
  console.error(`api: ${error.message}`);
  process.exit(3);
}
