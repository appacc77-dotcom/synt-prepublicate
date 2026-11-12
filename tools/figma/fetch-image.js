const n = await figma.getNodeByIdAsync("79:106");
const f = n.fills.find(x => x.type === "IMAGE");
const image = figma.getImageByHash(f.imageHash);
const bytes = new Uint8Array(await image.getBytesAsync());
let bin = "";
const CH = 0x8000;
for (let i = 0; i < bytes.length; i += CH) {
  bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
}
return { imageHash: f.imageHash, size: bytes.length, b64: btoa(bin) };
