// Read-only: children of one frame with bounds — the section map.
const id = ui.args?.id || "79:103";
const node = await figma.getNodeByIdAsync(id);
if (!node) return { error: "E_NOT_FOUND", id };
const kids = node.children.map((n) => ({
  id: n.id,
  name: n.name,
  type: n.type,
  x: Math.round(n.x),
  y: Math.round(n.y),
  w: Math.round(n.width),
  h: Math.round(n.height),
}));
return {
  id: node.id,
  name: node.name,
  w: Math.round(node.width),
  h: Math.round(node.height),
  count: kids.length,
  sections: kids,
};
