// Draws the icon (a speech bubble collapsed to a single line) and writes 16/48/128 px PNGs. No dependencies.
//   node scripts/make-icons.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'extension', 'icons');
const BG_TOP = [124, 92, 255];
const BG_BOTTOM = [88, 60, 220];
const WHITE = [255, 255, 255];
const LINE = [124, 92, 255];

// Signed distance to a rounded rectangle centred at (cx, cy); coordinates are in 0..1 icon space.
function roundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Signed distance to a triangle (the bubble's tail).
function triangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const edge = (px, py, qx, qy) => {
    const ex = qx - px, ey = qy - py, wx = x - px, wy = y - py;
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    return [Math.hypot(wx - ex * t, wy - ey * t), ex * wy - ey * wx];
  };
  const [d1, s1] = edge(ax, ay, bx, by);
  const [d2, s2] = edge(bx, by, cx, cy);
  const [d3, s3] = edge(cx, cy, ax, ay);
  const inside = (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  return (inside ? -1 : 1) * Math.min(d1, d2, d3);
}

function shade(x, y) {
  const bg = BG_TOP.map((c, i) => c + (BG_BOTTOM[i] - c) * y);
  if (roundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) return null;
  const bubble = Math.min(
    roundRect(x, y, 0.5, 0.46, 0.3, 0.2, 0.12),
    triangle(x, y, [0.3, 0.6], [0.44, 0.6], [0.27, 0.8]),
  );
  if (bubble > 0) return bg;
  if (roundRect(x, y, 0.5, 0.46, 0.15, 0.045, 0.045) <= 0) return LINE;
  return WHITE;
}

function render(size) {
  const SS = 4; // supersampling per axis
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const i = (y * size + x) * 4;
      if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; }
      px[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return png(size, px);
}

function png(size, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(OUT, `${size}.png`), render(size));
  console.log(`icons/${size}.png`);
}
