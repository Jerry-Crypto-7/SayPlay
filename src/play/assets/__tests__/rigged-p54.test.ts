/**
 * Animované CC0 postavy P54B T3 (`src/assets/rigged-p54.json`). Postava, která
 * se načte, ale stojí (klip se nenaváže na kosti klonu), nebo visí kus nad
 * zemí, v náhledu projde – test proto každou načte jako hra: `GLTFLoader`,
 * `SkeletonUtils.clone`, `AnimationMixer` s klipem `idle`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AnimationMixer, Box3, type Object3D, type SkinnedMesh, Texture } from 'three';
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { describe, expect, it } from 'vitest';

import rigged from '@/assets/rigged-p54.json';
import { bodyClassOf } from '@/components/play/arcade/toy/body-class';
import { RIGGED_PREFIX, riggedCharacter } from '@/play/arcade/models';

import disclosure from '../../../../disclosure.json';
import { BASE_ENTRIES } from '../entries/base';
import { CATALOG_ENTRIES } from '../entries/catalog';
import { RIGGED_P32_ENTRIES } from '../entries/rigged-p32';
import { RIGGED_P54_ENTRIES } from '../entries/rigged-p54';
import { assetEntrySchema } from '../manifest';

const PUBLIC = join(process.cwd(), 'public');
const STATES = ['idle', 'walk', 'run', 'jump', 'hit', 'die', 'win', 'shoot'];
const MAX_TRIANGLES = 7000;
const MAX_BYTES = 1.5 * 1024 * 1024;
const PACKS = ['quaternius-ultimate-animated-character', 'quaternius-ultimate-animated-animals', 'quaternius-cute-monsters', 'quaternius-rpg-characters', 'quaternius-ultimate-monsters'];

const characters = rigged.characters;

/** Odstín 250–320° se sytostí nad 0,25 – stejné pravidlo jako `scripts/assets/cc0/palette.mjs`. */
function purple(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return false;
  const hue = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  const degrees = (hue + 360) % 360;
  return degrees >= 250 && degrees <= 320 && d / max > 0.25;
}

/** GLB z `public/` → scéna, jak ji načte hra; obrázek Node nerozbalí, textura je prázdná. */
function load(path: string): Promise<GLTF> {
  const bytes = readFileSync(join(PUBLIC, path));
  const loader = new GLTFLoader().register(() => ({ name: 'stub_textures', loadTexture: () => Promise.resolve(new Texture()) }));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => loader.parse(buffer, '', resolve, reject));
}

const pose = (root: Object3D): number[] => {
  const out: number[] = [];
  root.traverse((node) => {
    if ((node as { isBone?: boolean }).isBone === true) out.push(...node.quaternion.toArray(), ...node.position.toArray());
  });
  return out;
};

describe('rigged CC0 characters of P54B T3 – manifest', () => {
  it('imports at least 80 characters with unique q- ids that collide with no other manifest id', () => {
    expect(characters.length).toBeGreaterThanOrEqual(80);
    const ids = characters.map((character) => character.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^q-[a-z][a-z0-9-]*$/);
    const others = new Set([...BASE_ENTRIES, ...RIGGED_P32_ENTRIES, ...CATALOG_ENTRIES].map((entry) => entry.id));
    expect(ids.filter((id) => others.has(id))).toEqual([]);
  });

  it('every character has idle and walk or run, only known states, and the budgets', () => {
    for (const character of characters) {
      const clips: Partial<Record<string, string>> = character.clips;
      expect(Object.keys(clips).filter((state) => !STATES.includes(state)), character.id).toEqual([]);
      expect(clips.idle, character.id).toBeDefined();
      expect(clips.walk ?? clips.run, character.id).toBeDefined();
      expect(character.triangles, character.id).toBeLessThanOrEqual(MAX_TRIANGLES);
      expect(character.bytes, character.id).toBeLessThanOrEqual(MAX_BYTES);
      expect(character.textures, character.id).toBeLessThanOrEqual(512);
      expect(purple(character.fallback), character.id).toBe(false);
    }
  });

  it('records every excluded model with a reason, purple ones included', () => {
    for (const excluded of rigged.excluded) expect(excluded.reason.length, excluded.id).toBeGreaterThan(0);
    expect(rigged.excluded.some((excluded) => /purple/.test(excluded.reason))).toBe(true);
  });

  it('takes no word that already names an earlier manifest entry – today\'s choices stay until T4 routes them', () => {
    const earlier = [...BASE_ENTRIES, ...RIGGED_P32_ENTRIES, ...CATALOG_ENTRIES];
    const claimed = new Set(earlier.flatMap((entry) => [...entry.identity, entry.id.replace(/^(cc0|gen3d)-/, '')]));
    for (const entry of RIGGED_P54_ENTRIES) expect(entry.identity.filter((word) => claimed.has(word)), entry.id).toEqual([]);
    // Volné slovo dostane postavu Quaternius: vlk dřív neměl vlastní model.
    expect(RIGGED_P54_ENTRIES.find((entry) => entry.id === 'q-wolf')?.identity).toContain('wolf');
  });

  it('the entries pass the hero schema, keep the JSON order and reach the scene and the body class', () => {
    expect(RIGGED_P54_ENTRIES.map((entry) => entry.id)).toEqual(characters.map((character) => character.id));
    for (const entry of RIGGED_P54_ENTRIES) {
      const parsed = assetEntrySchema.safeParse(entry);
      expect(parsed.success, `${entry.id}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
      expect(entry.clips.idle, entry.id).not.toBe('procedural');
      expect(entry.clips.run, entry.id).not.toBe('procedural');
      expect(riggedCharacter(`${RIGGED_PREFIX}${entry.id}`)?.path, entry.id).toBe(entry.file);
      expect(bodyClassOf(`${RIGGED_PREFIX}${entry.id}`), entry.id).not.toBe('prop');
    }
  });

  it('every file is the recorded one, with a CC0 disclosure entry and its pack licence', () => {
    const entries = new Map(disclosure.entries.map((entry) => [entry.name, entry]));
    for (const character of characters) {
      const file = join(PUBLIC, character.path);
      expect(existsSync(file), character.path).toBe(true);
      const bytes = readFileSync(file);
      expect(bytes.length, character.id).toBe(character.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), character.id).toBe(character.sha256);
      expect(entries.get(`public${character.path}`)?.license, character.id).toBe('CC0-1.0');
    }
    for (const pack of PACKS) {
      const licence = `public/assets/worldstream/cc0/licenses/${pack}.txt`;
      expect(existsSync(join(process.cwd(), licence)), licence).toBe(true);
      expect(entries.has(licence), licence).toBe(true);
    }
  });
});

describe('rigged CC0 characters of P54B T3 – loading', () => {
  it.each(characters.map((character) => [character.id, character] as const))('%s: GLTFLoader + SkeletonUtils.clone, idle moves the bones, every clip is there, 1.8 m on its base', async (_, character) => {
    const gltf = await load(character.path);
    const names = new Set(gltf.animations.map((animation) => animation.name));
    for (const [state, clip] of Object.entries(character.clips)) expect(names.has(clip), `${state} → ${clip}`).toBe(true);

    const original = pose(gltf.scene);
    const clone = cloneSkinned(gltf.scene);
    const skinned: SkinnedMesh[] = [];
    clone.traverse((node) => {
      if ((node as SkinnedMesh).isSkinnedMesh === true) skinned.push(node as SkinnedMesh);
    });
    expect(skinned.length).toBeGreaterThan(0);
    expect(skinned.every((mesh) => mesh.skeleton.bones.length > 0)).toBe(true);

    const idle = gltf.animations.find((animation) => animation.name === character.clips.idle)!;
    expect(idle.duration).toBeGreaterThan(0);
    expect(idle.tracks.length).toBeGreaterThan(0);
    const mixer = new AnimationMixer(clone);
    mixer.clipAction(idle).play();
    mixer.update(0);
    clone.updateMatrixWorld(true);
    const start = pose(clone);
    const box = new Box3().setFromObject(clone, true);
    expect(box.max.y - box.min.y).toBeCloseTo(1.8, 1);
    expect(Math.abs(box.min.y)).toBeLessThan(0.02);
    mixer.update(idle.duration / 2);
    const middle = pose(clone);
    expect(middle.some((value, index) => Math.abs(value - start[index]!) > 1e-4)).toBe(true);
    // Klon nese vlastní kosti: pohyb klonu nesmí pohnout originálem.
    expect(pose(gltf.scene)).toEqual(original);
  });
});
