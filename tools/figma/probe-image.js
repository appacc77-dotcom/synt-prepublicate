const n = await figma.getNodeByIdAsync("79:106");
const f = n.fills.find(x => x.type === "IMAGE");
const image = figma.getImageByHash(f.imageHash);
const bytes = await image.getBytesAsync();
return { imageHash: f.imageHash, w: image.width, h: image.height, bytes: bytes.length, scaleMode: f.scaleMode };
