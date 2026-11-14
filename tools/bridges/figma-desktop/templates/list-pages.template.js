/**
 * Список страниц файла — минимальная операция для сверки мостов.
 *
 * Запускается через `figma-agent exec-js` из tools/bridge-desktop.mjs.
 * Только чтение.
 */

const pages = figma.root.children.map((page) => ({
  id: page.id,
  name: page.name,
  children: page.children.length,
}));

console.log(JSON.stringify({ file: figma.fileKey ?? null, pages }));
