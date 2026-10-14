// Generates the monogram icons in public/icons (run once; output is committed).
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

const distToSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax,
    dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const insideRounded = (u, v, r) => {
  const cx = Math.min(Math.max(u, r), 1 - r),
    cy = Math.min(Math.max(v, r), 1 - r);
  return Math.hypot(u - cx, v - cy) <= r;
};
const isLetter = (u, v) => {
  const w = 0.065;
  return (
    distToSeg(u, v, 0.5, 0.2, 0.26, 0.8) < w ||
    distToSeg(u, v, 0.5, 0.2, 0.74, 0.8) < w ||
    distToSeg(u, v, 0.35, 0.6, 0.65, 0.6) < w * 0.85
  );
};

function png(size) {
  const ss = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let bg = 0,
        fg = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size,
            v = (y + (sy + 0.5) / ss) / size;
          if (!insideRounded(u, v, 0.22)) continue;
          if (isLetter(u, v)) fg++;
          else bg++;
        }
      const n = ss * ss,
        a = (bg + fg) / n,
        f = fg / Math.max(1, bg + fg);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(79 + (255 - 79) * f);
      raw[o + 1] = Math.round(70 + (255 - 70) * f);
      raw[o + 2] = Math.round(229 + (255 - 229) * f);
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public/icons", { recursive: true });
for (const s of [16, 48, 128]) writeFileSync(`public/icons/${s}.png`, png(s));
