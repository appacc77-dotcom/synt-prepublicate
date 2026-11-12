/**
 * Минимальный читатель ZIP: нужен, чтобы открыть .fig без внешних зависимостей.
 * Поддержаны методы store (0) и deflate (8) — других в .fig не встречается.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CEN = 0x02014b50;

export function readZip(path) {
  const buf = readFileSync(path);

  // конец центрального каталога ищем с хвоста: там комментарий переменной длины
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('не ZIP: нет end of central directory');

  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== CEN) throw new Error('битый центральный каталог');
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  function read(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    const at = entry.localOffset;
    if (buf.readUInt32LE(at) !== 0x04034b50) throw new Error(`битый локальный заголовок ${name}`);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const start = at + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + entry.compSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRawSync(raw);
    throw new Error(`метод сжатия ${entry.method} не поддержан`);
  }

  return {
    names: [...entries.keys()],
    read,
    json(name) {
      const raw = read(name);
      return raw ? JSON.parse(raw.toString('utf8')) : null;
    },
  };
}
