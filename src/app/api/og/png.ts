/**
 * Nejmenší PNG kodér, jaký stačí na náhledový obrázek.
 *
 * **Proč ručně a ne knihovnou.** Náhled pro odkaz musí být PNG — SVG si
 * Facebook ani X do `og:image` nevezmou, takže „obrázek funguje" by platilo jen
 * v prohlížeči a nikde jinde. Jediný kandidát z ekosystému (`next/og`) táhne
 * satori a resvg ve WASM, což je nová závislost přes licenční bránu a WASM na
 * cestě k první odpovědi. Kodér je proti tomu padesát řádků nad `node:zlib`,
 * který v Node stejně je.
 *
 * **P27B T6 to pro náhled hry mění.** Paletový obrázek nenesl nic z hry, a
 * sdílený odkaz proto nerozlišil jednu hru od druhé. `next/og` je součástí
 * `next` (žádný nový balíček; satori, resvg a `@vercel/og` jsou MPL-2.0 a stojí
 * v `disclosure.json`) a WASM leží jen na cestě `…/og`, kterou volá crawler
 * sociální sítě – ne na cestě k prvnímu snímku hry. Tenhle kodér zůstává
 * pro paletovou zálohu a pro `/api/og`.
 *
 * Formát je záměrně ten nejjednodušší platný: 8 bitů na kanál, truecolor bez
 * alfy, každý řádek s filtrem 0. Žádná paleta, žádné prokládání.
 */

import { deflateSync } from 'node:zlib';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Blok PNG: délka, typ, data, CRC nad typem i daty. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i += 1) body[i] = type.charCodeAt(i);
  body.set(data, 4);

  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc32(body));
  return out;
}

/**
 * `rgb` má být `width * height * 3` bajtů, po řádcích shora dolů.
 *
 * Rozpor mezi rozměry a délkou je vada volajícího, ne vstup zvenčí — proto
 * padá hlasitě místo aby se dopočítával.
 */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array<ArrayBuffer> {
  const expected = width * height * 3;
  if (rgb.length !== expected) {
    throw new Error(`png: ${width}x${height} potřebuje ${expected} bajtů, dostal ${rgb.length}`);
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // bitová hloubka
  header[9] = 2; // truecolor RGB
  // 10, 11, 12 = komprese deflate, filtr adaptivní, bez prokládání — všechno 0.

  // Každý řádek začíná bajtem filtru. Nula znamená „žádný filtr": obrázek je
  // pár plných ploch, takže na něm chytřejší filtr nic neušetří.
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const parts = [SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))];
  const size = parts.reduce((total, part) => total + part.length, 0);
  const png = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

/** `#rrggbb` na trojici bajtů. Jiný tvar je vada dat palety. */
export function hexToRgb(hex: string): [number, number, number] {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`png: ${hex} není #rrggbb`);
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}
