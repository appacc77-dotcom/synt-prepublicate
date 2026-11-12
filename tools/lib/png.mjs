/**
 * Минимальный декодер PNG: 8 бит, RGB или RGBA, без интерлейса.
 * Нужен, чтобы сравнивать и калибровать снимки без внешних зависимостей.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePngFile(path) {
  return decodePng(readFileSync(path));
}

export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('не PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    pos += 4;
    const type = buf.toString('ascii', pos, pos + 4);
    pos += 4;
    const data = buf.subarray(pos, pos + len);
    pos += len + 4;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG не поддержан');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
  }

  if (bitDepth !== 8) throw new Error(`bitDepth ${bitDepth} не поддержан`);
  if (colorType !== 2 && colorType !== 6) throw new Error(`colorType ${colorType} не поддержан`);

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * bpp);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const filter = raw[at];
    const cur = Buffer.from(raw.subarray(at + 1, at + 1 + stride));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (filter === 1) cur[x] = (cur[x] + a) & 255;
      else if (filter === 2) cur[x] = (cur[x] + b) & 255;
      else if (filter === 3) cur[x] = (cur[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        cur[x] = (cur[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else if (filter !== 0) {
        throw new Error(`фильтр ${filter} не поддержан`);
      }
    }
    cur.copy(out, y * stride);
    prev = cur;
  }

  return { width, height, bpp, data: out };
}
