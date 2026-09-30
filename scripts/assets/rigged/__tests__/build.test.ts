import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import disclosure from '../../../../disclosure.json';
import rigged from '../../../../src/assets/rigged.json';
import riggedP32 from '../../../../src/assets/rigged-p32.json';
import { HERO_MAX_BYTES, MAX_BYTES, MAX_TEXTURE, MAX_TRIANGLES, readGlb } from '../build.mjs';

const ROOT = join(__dirname, '..', '..', '..', '..');
const STATES = ['idle', 'run', 'jump', 'shoot', 'hit', 'die'];

interface Accessor { readonly bufferView?: number; readonly byteOffset?: number; readonly count: number }
interface BufferView { readonly byteOffset?: number; readonly byteLength: number }

/** Délka klipu přímo z dat GLB: největší čas ze vstupů jeho samplerů (ne z `max` v JSON). */
function clipSeconds(doc: { accessors: Accessor[]; bufferViews: BufferView[] }, bin: Buffer, animation: { samplers: { input: number }[] }): number {
  let longest = 0;
  for (const sampler of animation.samplers) {
    const accessor = doc.accessors[sampler.input]!;
    const view = doc.bufferViews[accessor.bufferView!]!;
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    for (let i = 0; i < accessor.count; i += 1) longest = Math.max(longest, bin.readFloatLE(start + i * 4));
  }
  return longest;
}

describe('riggované postavy (P26B T4)', () => {
  const characters = rigged.characters;

  it('manifest má 8–20 postav s unikátním id a tagy', () => {
    expect(characters.length).toBeGreaterThanOrEqual(8);
    expect(characters.length).toBeLessThanOrEqual(20);
    expect(new Set(characters.map((c) => c.id)).size).toBe(characters.length);
    for (const character of characters) expect(character.tags.length, character.id).toBeGreaterThan(0);
  });

  it.each([...rigged.characters, ...riggedP32.characters].map((c) => [c.id, c] as const))('%s: každý klip z mapy v GLB existuje a má délku > 0', (_, character) => {
    const file = join(ROOT, 'public', character.path);
    expect(existsSync(file), file).toBe(true);
    const { doc, bin } = readGlb(readFileSync(file));
    const clips = character.clips as Record<string, string>;
    expect(Object.keys(clips)).toEqual(expect.arrayContaining(['idle', 'run']));
    for (const [state, clip] of Object.entries(clips)) {
      expect(STATES, state).toContain(state);
      const animation = doc.animations?.find((a: { name: string }) => a.name === clip);
      expect(animation, `${character.id}: ${state} → ${clip}`).toBeDefined();
      expect(clipSeconds(doc, bin, animation), `${character.id}: ${clip}`).toBeGreaterThan(0);
    }
    // Jen namapované klipy – ostatní by nafukovaly soubor.
    expect(doc.animations.length).toBe(new Set(Object.values(clips)).size);
  });

  it('postavy drží rozpočet trojúhelníků a velikosti, textury jsou uvnitř GLB', () => {
    for (const character of characters) {
      const bytes = readFileSync(join(ROOT, 'public', character.path));
      const { doc } = readGlb(bytes);
      expect(character.triangles, character.id).toBeLessThanOrEqual(MAX_TRIANGLES);
      expect(statSync(join(ROOT, 'public', character.path)).size, character.id).toBeLessThanOrEqual(MAX_BYTES);
      expect(doc.buffers.every((buffer: { uri?: string }) => buffer.uri === undefined), character.id).toBe(true);
      expect((doc.images ?? []).every((image: { uri?: string }) => image.uri === undefined), character.id).toBe(true);
    }
  });

  it('každý soubor v public/…/rigged má v disclosure položku s licencí z whitelistu', () => {
    const entries = new Map(disclosure.entries.map((entry) => [entry.name, entry]));
    for (const character of [...characters, ...riggedP32.characters]) {
      const entry = entries.get(`public${character.path}`);
      expect(entry, character.id).toBeDefined();
      expect(['CC0-1.0', 'CC-BY-4.0']).toContain(entry!.license);
    }
    expect(entries.has('public/assets/worldstream/rigged/PROVENANCE.md')).toBe(true);
  });
});

describe('animovaní hrdinové vět P32 (P32C T3)', () => {
  /** Hrdinové a nepřátelé vět, pro které T2 našel jen statický model – a sady CC0 je mají. */
  const WANTED = ['penguin', 'cat', 'dog', 'polar-bear', 'ghost', 'robot'];

  it('každý hledaný hrdina má postavu s klipy idle a run', () => {
    for (const tag of WANTED) {
      const character = riggedP32.characters.find((c) => c.tags.includes(tag));
      expect(character, tag).toBeDefined();
      expect(Object.keys(character!.clips), tag).toEqual(expect.arrayContaining(['idle', 'run']));
    }
  });

  it('hrdina drží rozpočet 400 KB a textury nejvýš 512 px uvnitř GLB', async () => {
    for (const character of riggedP32.characters) {
      const bytes = readFileSync(join(ROOT, 'public', character.path));
      expect(bytes.length, character.id).toBeLessThanOrEqual(HERO_MAX_BYTES);
      const { doc, bin } = readGlb(bytes);
      for (const image of doc.images ?? []) {
        expect(image.uri, character.id).toBeUndefined();
        const view = doc.bufferViews[image.bufferView];
        const start = view.byteOffset ?? 0;
        const { width, height } = await sharp(bin.subarray(start, start + view.byteLength)).metadata();
        expect(Math.max(width!, height!), character.id).toBeLessThanOrEqual(MAX_TEXTURE);
      }
    }
  });
});
