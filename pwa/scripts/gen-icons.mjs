// Gera os ícones do Correio (envelope neutro, estilo Apple) sem dependências:
//   node scripts/gen-icons.mjs
// Saída: public/icons/icon.svg (fonte), icon-192.png, icon-512.png,
// maskable-512.png e apple-touch-icon.png (180, fundo cheio).
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------- PNG mínimo
function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(tipo, dados) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(dados.length);
  const td = Buffer.concat([Buffer.from(tipo), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------ geometria (0..1)
// Envelope centrado; `s` = escala do glifo (maskable usa a zona segura).
const ENV = { x0: 0.2, x1: 0.8, y0: 0.29, y1: 0.71, r: 0.06 };
const TRACO = 0.03;

function noRetArred(x, y, a) {
  const cx = Math.min(Math.max(x, a.x0 + a.r), a.x1 - a.r);
  const cy = Math.min(Math.max(y, a.y0 + a.r), a.y1 - a.r);
  return Math.hypot(x - cx, y - cy) <= a.r;
}
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
const PONTA = { x: 0.5, y: 0.53 }; // vértice da aba

/** Cor do pixel (x,y em 0..1) ou null (transparente). */
function cor(x, y, s, cheio) {
  // fundo: grafite metálico (neutro; o acento vem de cada caixa)
  const fundoDentro = cheio || noRetArred(x, y, { x0: 0, x1: 1, y0: 0, y1: 1, r: 0.225 });
  let c = null;
  if (fundoDentro) {
    const t = y;
    const brilho = Math.max(0, 1 - Math.hypot(x - 0.5, y + 0.1) / 0.95) * 28;
    c = [
      Math.round(150 - 72 * t + brilho),
      Math.round(160 - 74 * t + brilho),
      Math.round(176 - 78 * t + brilho),
    ];
  }
  const u = 0.5 + (x - 0.5) / s, v = 0.5 + (y - 0.5) / s;
  if (noRetArred(u, v, ENV)) {
    // papel: branco com leve degradê
    const g = Math.round(255 - 14 * (v - ENV.y0) / (ENV.y1 - ENV.y0));
    c = [g, g, Math.min(255, g + 2)];
    const d = Math.min(
      distSeg(u, v, ENV.x0 + 0.02, ENV.y0 + 0.02, PONTA.x, PONTA.y),
      distSeg(u, v, PONTA.x, PONTA.y, ENV.x1 - 0.02, ENV.y0 + 0.02),
    );
    if (d < TRACO / 2) c = [92, 102, 118];
  }
  return c;
}

function icone(tam, s, cheio) {
  const SS = 4, buf = Buffer.alloc(tam * tam * 4);
  for (let py = 0; py < tam; py++) {
    for (let px = 0; px < tam; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = cor((px + (sx + 0.5) / SS) / tam, (py + (sy + 0.5) / SS) / tam, s, cheio);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const i = (py * tam + px) * 4;
      if (a > 0) {
        buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a;
        buf[i + 3] = Math.round((255 * a) / (SS * SS));
      }
    }
  }
  return png(tam, tam, buf);
}

// ------------------------------------------------------------- SVG (fonte)
function svg() {
  const k = (n) => +(n * 512).toFixed(1);
  const e = ENV;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="fundo" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#96a0b0"/>
      <stop offset="1" stop-color="#4e5662"/>
    </linearGradient>
    <radialGradient id="brilho" cx="0.5" cy="-0.1" r="0.95">
      <stop offset="0" stop-color="#fff" stop-opacity="0.11"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="papel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#f1f1f3"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="${k(0.225)}" fill="url(#fundo)"/>
  <rect width="512" height="512" rx="${k(0.225)}" fill="url(#brilho)"/>
  <rect x="${k(e.x0)}" y="${k(e.y0)}" width="${k(e.x1 - e.x0)}" height="${k(e.y1 - e.y0)}" rx="${k(e.r)}" fill="url(#papel)"/>
  <path d="M${k(e.x0 + 0.02)} ${k(e.y0 + 0.02)} L${k(PONTA.x)} ${k(PONTA.y)} L${k(e.x1 - 0.02)} ${k(e.y0 + 0.02)}" fill="none" stroke="#5c6676" stroke-width="${k(TRACO)}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

const dir = new URL("../public/icons/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("icon.svg", dir), svg());
writeFileSync(new URL("icon-192.png", dir), icone(192, 1, false));
writeFileSync(new URL("icon-512.png", dir), icone(512, 1, false));
// maskable: fundo cheio, glifo reduzido para a zona segura (80%)
writeFileSync(new URL("maskable-512.png", dir), icone(512, 0.8, true));
// iOS arredonda sozinho: fundo cheio
writeFileSync(new URL("apple-touch-icon.png", dir), icone(180, 1, true));
console.log("ícones gerados em public/icons/");
