/**
 * PNG kodér náhledu (`_og.ts` kreslí přes něj obrázek hry).
 *
 * Kodér se **dekóduje zpátky**, ne porovnává s uloženým souborem: snapshot by
 * potvrdil jen to, že se výstup nezměnil, ne že je to platné PNG. Kontrolní
 * součty a hlavička se proto čtou tak, jak je čte prohlížeč.
 */

import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { crc32, encodePng, hexToRgb } from '../png';

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

describe('hexToRgb', () => {
  it('rozloží #rrggbb', () => {
    expect(hexToRgb('#2f9e8f')).toEqual([0x2f, 0x9e, 0x8f]);
  });

  it('odmítne jiný tvar', () => {
    expect(() => hexToRgb('2f9e8f')).toThrow();
    expect(() => hexToRgb('#2f9e8')).toThrow();
  });
});

