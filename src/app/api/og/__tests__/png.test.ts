/**
 * PNG kodér náhledu (`_og.ts` kreslí přes něj obrázek hry).
 *
 * Kodér se **dekóduje zpátky**, ne porovnává s uloženým souborem: snapshot by
 * potvrdil jen to, že se výstup nezměnil, ne že je to platné PNG. Kontrolní
 * součty a hlavička se proto čtou tak, jak je čte prohlížeč.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { crc32, decodePng, encodePng, hexToRgb } from '../png';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Rozdělí soubor na bloky a ověří jejich CRC — tak, jak to dělá čtečka. */
function chunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const found: { type: string; data: Uint8Array }[] = [];
  let at = 8;

  while (at < png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    const declared = view.getUint32(at + 8 + length);
    expect(crc32(png.subarray(at + 4, at + 8 + length)), `CRC bloku ${type}`).toBe(declared);
    found.push({ type, data });
    at += 12 + length;
  }

  return found;
}

describe('encodePng', () => {
  it('vydá platné PNG s hlavičkou, obrazem a koncem', () => {
    const png = encodePng(2, 2, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));

    expect([...png.subarray(0, 8)]).toEqual(SIGNATURE);

    const blocks = chunks(png);
    expect(blocks.map((block) => block.type)).toEqual(['IHDR', 'IDAT', 'IEND']);

    const header = new DataView(blocks[0].data.buffer, blocks[0].data.byteOffset, blocks[0].data.byteLength);
    expect(header.getUint32(0)).toBe(2);
    expect(header.getUint32(4)).toBe(2);
    expect([...blocks[0].data.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
  });

  it('pixely se dekódují zpátky, každý řádek s nulovým filtrem', () => {
    const pixels = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 255, 128]);
    const idat = chunks(encodePng(2, 2, pixels)).find((block) => block.type === 'IDAT')!;
    const raw = new Uint8Array(inflateSync(idat.data));

    // Řádek = filtr + 2 pixely po třech bajtech.
    expect(raw).toHaveLength(2 * (1 + 6));
    expect(raw[0]).toBe(0);
    expect(raw[7]).toBe(0);
    expect([...raw.subarray(1, 7)]).toEqual([9, 8, 7, 6, 5, 4]);
    expect([...raw.subarray(8, 14)]).toEqual([3, 2, 1, 0, 255, 128]);
  });

  it('rozměry, které nesedí s délkou, padnou hlasitě', () => {
    expect(() => encodePng(2, 2, new Uint8Array(11))).toThrow(/potřebuje 12 bajtů/);
  });

  it('crc32 sedí se známou hodnotou', () => {
    // `IEND` bez dat, hodnota z formátu PNG. Vlastní implementace kontrolního
    // součtu se musí porovnat s něčím, co nepochází z ní samé.
    expect(crc32(Uint8Array.from([0x49, 0x45, 0x4e, 0x44]))).toBe(0xae426082);
  });
});

describe('decodePng', () => {
  /** PNG s řádky po filtrech `filters` (RGBA) – kodér psaný proti formátu, ne podle dekodéru. */
  function filtered(width: number, rgba: Uint8Array, filters: readonly number[]): Uint8Array {
    const stride = width * 4;
    const raw: number[] = [];
    filters.forEach((filter, y) => {
      raw.push(filter);
      for (let x = 0; x < stride; x += 1) {
        const at = y * stride + x;
        const [a, b, c] = [x >= 4 ? rgba[at - 4] : 0, y > 0 ? rgba[at - stride] : 0, x >= 4 && y > 0 ? rgba[at - stride - 4] : 0];
        const p = a + b - c;
        const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
        raw.push((rgba[at] - [0, a, b, (a + b) >> 1, paeth][filter]) & 0xff);
      }
    });
    // Hlavička z `encodePng` (RGB) přepsaná na RGBA, IDAT vlastní.
    const header = chunks(encodePng(width, filters.length, new Uint8Array(width * filters.length * 3)))[0].data.slice();
    header[9] = 6;
    const block = (type: string, data: Uint8Array): number[] => {
      const body = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)).concat([...data]));
      const length = data.length;
      const crc = crc32(body);
      return [length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff, ...body, crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff];
    };
    return Uint8Array.from([...SIGNATURE, ...block('IHDR', header), ...block('IDAT', deflateSync(Uint8Array.from(raw))), ...block('IEND', new Uint8Array(0))]);
  }

  it('reads every PNG row filter back to the same pixels', () => {
    const width = 5;
    const rgba = Uint8Array.from({ length: width * 5 * 4 }, (_, i) => (i * 97 + 31) & 0xff);
    const decoded = decodePng(filtered(width, rgba, [0, 1, 2, 3, 4]));
    expect([decoded.width, decoded.height]).toEqual([5, 5]);
    expect([...decoded.rgba]).toEqual([...rgba]);
  });

  it('turns RGB into opaque RGBA and reads a real model thumbnail', () => {
    const { rgba } = decodePng(encodePng(2, 1, Uint8Array.from([1, 2, 3, 4, 5, 6])));
    expect([...rgba]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    const thumbnail = decodePng(readFileSync(join(process.cwd(), 'public/assets/worldstream/aquarium.png')));
    expect([thumbnail.width, thumbnail.height]).toEqual([256, 256]);
    expect(thumbnail.rgba).toHaveLength(256 * 256 * 4);
  });

  it('refuses what it cannot read, so the card falls back to no hero', () => {
    expect(() => decodePng(Uint8Array.from([1, 2, 3]))).toThrow(/podpis/);
    const png = encodePng(1, 1, Uint8Array.from([0, 0, 0]));
    png[8 + 8 + 8] = 16; // bitová hloubka 16 v IHDR
    expect(() => decodePng(png)).toThrow(/nepodporovaný/);
  });
});

describe('hexToRgb', () => {
  it('rozloží #rrggbb', () => {
    expect(hexToRgb('#2f9e8f')).toEqual([0x2f, 0x9e, 0x8f]);
  });

  it('odmítne jiný tvar', () => {
    expect(() => hexToRgb('2f9e8f')).toThrow();
    expect(() => hexToRgb('#2f9e8')).toThrow();
  });
});

