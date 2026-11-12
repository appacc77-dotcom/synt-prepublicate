async function svg(id) {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) return null;
  const bytes = await n.exportAsync({ format: "SVG", svgOutlineText: true, svgIdAttribute: false });
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
return {
  arrow: await svg("I79:110;695:1532"),
  play: await svg("79:113"),
};
