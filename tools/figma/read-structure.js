// Read-only: pages + top-level frames of the live file.
await figma.loadAllPagesAsync();
const pages = figma.root.children.map((p) => {
  const kids = p.children.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    w: Math.round(n.width),
    h: Math.round(n.height),
    x: Math.round(n.x),
    y: Math.round(n.y),
    // дети фрейма — это и есть секции страницы
    children: "children" in n ? n.children.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      w: Math.round(c.width),
      h: Math.round(c.height),
      x: Math.round(c.x),
      y: Math.round(c.y),
    })) : [],
  }));
  return { id: p.id, name: p.name, count: kids.length, frames: kids.slice(0, 40) };
});
return { fileName: figma.root.name, pages };
