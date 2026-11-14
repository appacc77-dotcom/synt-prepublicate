/**
 * Снимок дерева одной страницы для сверки мостов.
 *
 * Запускается через `figma-agent exec-js` из tools/bridge-desktop.mjs.
 * Отдаёт ту же форму, что и мост figcraft (`tools/bridge-figcraft.mjs`):
 * плоский список узлов с путём из имён — чтобы сверка была по одному ключу.
 *
 * Только чтение: ни одного свойства не пишем.
 */

const pageName = '__PAGE__';
const maxDepth = __MAX_DEPTH__;

const round = (value) => Math.round(value * 100) / 100;

/** Путь из имён; одинаковые имена у соседей различаются номером «#2». */
const pathOf = (parentPath, name, seen) => {
  const count = (seen.get(name) ?? 0) + 1;
  seen.set(name, count);
  return `${parentPath}/${count > 1 ? `${name}#${count}` : name}`;
};

const page = figma.root.children.find((p) => p.name === pageName);
if (!page) {
  console.log(
    JSON.stringify({
      error: 'page not found',
      pageName,
      pages: figma.root.children.map((p) => p.name),
    }),
  );
} else {
  const nodes = [];
  const walk = (node, depth, path) => {
    const record = { path, id: node.id, name: node.name, type: node.type, depth };
    if ('x' in node) {
      record.x = round(node.x);
      record.y = round(node.y);
    }
    if ('width' in node) {
      record.w = round(node.width);
      record.h = round(node.height);
    }
    if (node.type === 'TEXT') record.text = node.characters ?? '';
    if (typeof node.visible === 'boolean' && !node.visible) record.hidden = true;
    nodes.push(record);
    if ('children' in node && depth < maxDepth) {
      const seen = new Map();
      for (const child of node.children) {
        walk(child, depth + 1, pathOf(path, child.name, seen));
      }
    }
  };
  walk(page, 0, page.name);
  console.log(
    JSON.stringify({
      source: 'figma-bridge',
      file: figma.fileKey ?? null,
      page: page.name,
      depth: maxDepth,
      total: nodes.length,
      nodes,
    }),
  );
}
