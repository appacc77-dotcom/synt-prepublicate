/**
 * Страницы файла и их верхнеуровневые фреймы — для `tools/discover.mjs`.
 * Отдаёт только то, из чего собирается project.json.
 */
const pages = [];

for (const page of figma.root.children) {
  if (page.type !== "PAGE") continue;
  const frames = [];
  // Фрейм бывает завёрнут в группу: в чужом файле страница — это GROUP, а
  // внутри один FRAME. Смотреть только на верхний уровень значит объявить
  // страницу пустой и не найти в ней ничего.
  const flatten = (node) => {
    if (["FRAME", "COMPONENT", "SECTION"].includes(node.type)) return [node];
    if (["GROUP", "SECTION"].includes(node.type) && "children" in node) {
      return node.children.flatMap(flatten);
    }
    return [];
  };
  for (const child of page.children.flatMap(flatten)) {
    frames.push({
      id: child.id,
      name: child.name,
      type: child.type,
      w: Math.round(child.width),
      h: Math.round(child.height),
      children: "children" in child ? child.children.length : 0,
      // Пустые фреймы и разделители в работу не идут.
      empty: !("children" in child) || child.children.length === 0,
    });
  }
  pages.push({ id: page.id, name: page.name, frames });
}

return { fileKey: figma.fileKey ?? null, name: figma.root.name, pages };
