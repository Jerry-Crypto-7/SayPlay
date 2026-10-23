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
 * **Od P58C T2 kóduje i kartu výzvy hry.** Tu mezi P27B a P58C kreslil
 * `next/og`, jenže satori a resvg jsou MPL-2.0 a pravidla copyleft zakazují.
 * Kartu teď kreslí `raster.ts` a kóduje tenhle kodér; `decodePng` níže čte
 * náhledy modelů, které na kartu přijdou.
 *
 * Formát je záměrně ten nejjednodušší platný: 8 bitů na kanál, truecolor bez
 * alfy, každý řádek s filtrem 0. Žádná paleta, žádné prokládání.
 */

import { deflateSync, inflateSync } from 'node:zlib';

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

/**
 * Dekodér náhledu modelu (P58C T2): 8 bitů na kanál, RGB nebo RGBA, bez
 * prokládání – tak vypadají všechny náhledy v `public/assets`. Jiné PNG hodí
 * chybu a karta se nakreslí bez hrdiny.
 */
export function decodePng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  if (!SIGNATURE.every((byte, i) => png[i] === byte)) throw new Error('png: chybí podpis');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const idat: Uint8Array[] = [];
  let [width, height, channels] = [0, 0, 0];
  for (let at = 8; at + 8 <= png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      [width, height] = [view.getUint32(at + 8), view.getUint32(at + 12)];
      const [depth, colorType, interlace] = [data[8], data[9], data[12]];
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) throw new Error(`png: nepodporovaný formát ${depth}/${colorType}/${interlace}`);
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  if (channels === 0) throw new Error('png: chybí IHDR');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('png: krátká data');
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const up = y > 0 ? pixels[row - stride + x] : 0;
      const corner = x >= channels && y > 0 ? pixels[row - stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      } else if (filter !== 0) throw new Error(`png: neznámý filtr ${filter}`);
      pixels[row + x] = (value + predictor) & 0xff;
    }
  }
  if (channels === 4) return { width, height, rgba: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) rgba.set([pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2], 255], i * 4);
  return { width, height, rgba };
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
