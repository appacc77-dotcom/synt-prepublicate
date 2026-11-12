// Read-only: one node as SVG. __NODE_ID__ подставляет экспортёр.
const node = await figma.getNodeByIdAsync("__NODE_ID__");
if (!node) return { error: "E_NOT_FOUND" };
const bytes = await node.exportAsync({ format: "SVG", svgOutlineText: true, svgIdAttribute: false });
let s = "";
for (const b of bytes) s += String.fromCharCode(b);
return { svg: s };
