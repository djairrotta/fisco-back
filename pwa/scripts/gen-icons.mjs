// Gera os ícones do Vigia (escudo sentinela com olho + varredura) a partir de
// um só desenho vetorial, sem dependências externas:  node scripts/gen-icons.mjs
//   favicon.png (32) · icon-192 · icon-512 · maskable-512 · apple-touch-180
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

// ----------------------------------------------------------------- PNG cru
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
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------- geometria
// Tudo em coordenadas 0..1 no quadrado; s = escala do glifo (maskable menor).
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const clamp01 = (x) => Math.min(1, Math.max(0, x));

function roundRect(x, y, r = 0.22) {
  const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

// Escudo centrado no glifo (u,v em -0.5..0.5 / s).
function escudo(u, v) {
  if (v < -0.42 || v > 0.48) return false;
  // ombros arredondados no topo; base afunila em ponta.
  let meia;
  if (v < -0.3) meia = 0.36 * Math.sqrt(Math.max(0, 1 - ((v + 0.3) / 0.12) ** 2));
  else if (v < 0.06) meia = 0.36;
  else meia = 0.36 * Math.sqrt(Math.max(0, (0.48 - v) / 0.42));
  return Math.abs(u) <= meia;
}
function bordaEscudo(u, v) {
  // distância aproximada à borda, para o contorno claro
  for (let dv = -0.02; dv <= 0.02; dv += 0.01) if (!escudo(u, v + dv)) return escudo(u, v);
  for (let du = -0.02; du <= 0.02; du += 0.01) if (!escudo(u + du, v)) return escudo(u, v);
  return false;
}

// cores
const AZUL_CLARO = [74, 170, 255];
const AZUL = [10, 132, 255];
const AZUL_FUNDO = [0, 70, 180];
const NAVY_1 = [8, 26, 58];
const NAVY_2 = [3, 12, 32];
const ESCURO = [4, 14, 36];

function corDoPonto(x, y, s, cheio) {
  const u = (x - 0.5) / s, v = (y - 0.5) / s;
  // fundo do azulejo: navy profundo para o escudo azul saltar.
  let c = null;
  if (cheio || roundRect(x, y)) {
    const g = clamp01((y + 0.1) / 1.1);
    c = mix(NAVY_1, NAVY_2, g);
  }
  if (!escudo(u, v)) return c;

  // corpo do escudo (azul com brilho metálico no topo)
  const g = clamp01((v + 0.42) / 0.9);
  c = mix(mix(AZUL_CLARO, AZUL, clamp01(g * 1.4)), AZUL_FUNDO, clamp01((g - 0.5) / 0.5));
  const sheen = clamp01((0.0 - v) / 0.5);
  if (v < 0) c = mix(c, [255, 255, 255], sheen * 0.35);
  if (bordaEscudo(u, v)) c = mix(c, [255, 255, 255], 0.55);

  const dCentro = Math.hypot(u, v - 0.0);

  // olho (lente amendoada) centrado em v≈0
  const dentroOlho = Math.abs(v) <= 0.14 * Math.sqrt(Math.max(0, 1 - (u / 0.3) ** 2)) + 0.001 &&
    Math.abs(u) <= 0.3;
  if (dentroOlho) {
    c = mix(ESCURO, c, 0.12); // fundo escuro translúcido da lente
    // íris
    if (dCentro <= 0.135) {
      const gi = clamp01(dCentro / 0.135);
      c = mix([234, 244, 255], [90, 168, 255], gi);
      if (dCentro <= 0.065) c = ESCURO; // pupila
      if (Math.hypot(u - 0.03, v + 0.03) <= 0.025) c = [255, 255, 255]; // reflexo
    }
  }

  // anéis de radar (arcos claros)
  const anel = (r) => Math.abs(dCentro - r) < 0.006 && v < 0.06;
  if (anel(0.3) || anel(0.21)) c = mix(c, [255, 255, 255], 0.5);

  // borda do olho
  const bordaOlho = Math.abs(Math.abs(v) - (0.14 * Math.sqrt(Math.max(0, 1 - (u / 0.3) ** 2)))) < 0.012 &&
    Math.abs(u) <= 0.3;
  if (bordaOlho) c = mix(c, [255, 255, 255], 0.7);

  return c;
}

function icone(tam, s, cheio) {
  const SS = 4, buf = Buffer.alloc(tam * tam * 4);
  for (let py = 0; py < tam; py++) {
    for (let px = 0; px < tam; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / tam;
          const y = (py + (sy + 0.5) / SS) / tam;
          const c = corDoPonto(x, y, s, cheio);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const i = (py * tam + px) * 4, n = SS * SS;
      if (a > 0) {
        buf[i] = Math.round(r / (a / 255));
        buf[i + 1] = Math.round(g / (a / 255));
        buf[i + 2] = Math.round(b / (a / 255));
        buf[i + 3] = Math.round(a / n);
      }
    }
  }
  return png(tam, tam, buf);
}

const dir = new URL("../public/icons/", import.meta.url);
mkdirSync(dir, { recursive: true });
// "any": cantos arredondados, glifo grande. "maskable": fundo cheio, zona segura.
writeFileSync(new URL("favicon.png", dir), icone(32, 0.9, false));
writeFileSync(new URL("icon-192.png", dir), icone(192, 0.86, false));
writeFileSync(new URL("icon-512.png", dir), icone(512, 0.86, false));
writeFileSync(new URL("apple-touch-180.png", dir), icone(180, 0.82, true));
writeFileSync(new URL("maskable-512.png", dir), icone(512, 0.66, true));
console.log("ícones do Vigia gerados");
