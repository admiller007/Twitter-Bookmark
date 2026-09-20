/**
 * Generates the extension icons as PNGs with no image dependencies:
 * raw RGBA pixels -> zlib deflate -> minimal PNG chunks.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [29, 155, 240, 255];   // X blue
const FG = [255, 255, 255, 255];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

/** A rounded square with a bookmark ribbon cut out of it. */
function pixel(x, y, size) {
  const r = size * 0.22;
  const inCorner = (cx, cy) => (x - cx) ** 2 + (y - cy) ** 2 > r ** 2;
  if (x < r && y < r && inCorner(r, r)) return [0, 0, 0, 0];
  if (x > size - r && y < r && inCorner(size - r, r)) return [0, 0, 0, 0];
  if (x < r && y > size - r && inCorner(r, size - r)) return [0, 0, 0, 0];
  if (x > size - r && y > size - r && inCorner(size - r, size - r)) return [0, 0, 0, 0];

  const left = size * 0.31;
  const right = size * 0.69;
  const top = size * 0.2;
  const bottom = size * 0.8;
  if (x >= left && x <= right && y >= top && y <= bottom) {
    // Notch at the bottom of the ribbon.
    const midX = size / 2;
    const notchTop = size * 0.58;
    const depth = (bottom - y) / (bottom - notchTop);
    if (y > notchTop && Math.abs(x - midX) < (right - left) / 2 * depth) return BG;
    return FG;
  }
  return BG;
}

for (const size of [16, 48, 128]) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  writeFileSync(resolve(outDir, `icon${size}.png`), png);
  console.log(`wrote public/icons/icon${size}.png (${png.length} bytes)`);
}
