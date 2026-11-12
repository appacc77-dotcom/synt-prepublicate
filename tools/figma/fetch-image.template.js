// Read-only: image bytes by hash → base64. __HASH__ подставляет экспортёр.
const image = figma.getImageByHash("__HASH__");
const bytes = new Uint8Array(await image.getBytesAsync());
let bin = "";
const CH = 0x8000;
for (let i = 0; i < bytes.length; i += CH) {
  bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
}
return { size: bytes.length, b64: btoa(bin) };
