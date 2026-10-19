/**
 * Převzetí riggovaných postav Quaternius (P54B T3). Špatně namapovaný klip,
 * postava o kus nad zemí nebo fialová příšera vypadají v náhledu „skoro
 * dobře“ – proto test staví syntetickou postavu se známou výškou, barvou
 * a klipy a čte výsledek přes `GLTFLoader` jako hra.
 */

import { existsSync } from 'node:fs';

import { Document } from '@gltf-transform/core';
import { AnimationMixer, Box3, type Object3D, type SkinnedMesh, Texture, Vector3 } from 'three';
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { describe, expect, it } from 'vitest';

import { CACHE_DIR, CHARACTERS, HEIGHT_M, MAX_TEXTURE, MAX_TRIANGLES, clipMap, importCharacter, missingClips, processDocument } from '../import-cc0.mjs';

/** `#rrggbb` → lineární RGBA, jak ho nese `baseColorFactor`. */
const linear = (hex: string): [number, number, number, number] => {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return [r!, g!, b!, 1];
};
const PURPLE = linear('#7c3aed');
const TEAL = linear('#0d9488');
const GREY = linear('#9ca3af');
const PLUM = linear('#7a2e5a');

type Colour = [number, number, number, number];

/**
 * Postava z jedné kosti: síť `columns × rows` čtverců ve svislé rovině, 1 m široká,
 * 2 m vysoká, a klipy, které jen kývnou kostí. Víc barev = sloupec `c` má materiál
 * `colours[c % n]`, každý materiál své primitivum.
 */
function rig(colours: Colour | readonly Colour[], clips: readonly string[], columns = 1, rows = 1): Document {
  const palette: readonly Colour[] = typeof colours[0] === 'number' ? [colours as Colour] : (colours as readonly Colour[]);
  const doc = new Document();
  const buffer = doc.createBuffer();
  const hips = doc.createNode('Hips');
  const armature = doc.createNode('Armature').addChild(hips);
  const positions: number[] = [];
  for (let row = 0; row <= rows; row += 1) for (let column = 0; column <= columns; column += 1) positions.push(column / columns - 0.5, (2 * row) / rows, 0.25);
  const count = positions.length / 3;
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) weights[i * 4] = 1;
  const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
  const joints = doc.createAccessor().setType('VEC4').setArray(new Uint16Array(count * 4)).setBuffer(buffer);
  const weight = doc.createAccessor().setType('VEC4').setArray(weights).setBuffer(buffer);
  const mesh = doc.createMesh('Body');
  palette.forEach((colour, which) => {
    const indices: number[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = which; column < columns; column += palette.length) {
        const at = row * (columns + 1) + column;
        indices.push(at, at + 1, at + columns + 1, at + 1, at + columns + 2, at + columns + 1);
      }
    }
    mesh.addPrimitive(
      doc
        .createPrimitive()
        .setAttribute('POSITION', position)
        .setAttribute('JOINTS_0', joints)
        .setAttribute('WEIGHTS_0', weight)
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buffer))
        .setMaterial(doc.createMaterial(`Colour${which}`).setBaseColorFactor(colour)),
    );
  });
  const inverseBind = doc.createAccessor().setType('MAT4').setArray(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).setBuffer(buffer);
  const skin = doc.createSkin('Rig').addJoint(hips).setInverseBindMatrices(inverseBind).setSkeleton(hips);
  armature.addChild(doc.createNode('Body').setMesh(mesh).setSkin(skin));
  doc.createScene('Scene').addChild(armature);
  for (const name of clips) {
    const sampler = doc
      .createAnimationSampler()
      .setInput(doc.createAccessor().setType('SCALAR').setArray(new Float32Array([0, 1])).setBuffer(buffer))
      .setOutput(doc.createAccessor().setType('VEC4').setArray(new Float32Array([0, 0, 0, 1, 0, 0.38, 0, 0.92])).setBuffer(buffer))
      .setInterpolation('LINEAR');
    doc.createAnimation(name).addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(hips).setTargetPath('rotation').setSampler(sampler));
  }
  return doc;
}

const CHARACTER = { id: 'q-test', name: 'Test', class: 'humanoid', tags: ['tester'] } as const;

/** GLB → scéna, jak ji načte hra; textury nahradí prázdná, obrázek Node nerozbalí. */
function parse(bytes: Uint8Array): Promise<GLTF> {
  const loader = new GLTFLoader().register(() => ({ name: 'stub_textures', loadTexture: () => Promise.resolve(new Texture()) }));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => loader.parse(buffer, '', resolve, reject));
}

/** Obal klonu postavy v první póze klipu – přes kosti, ne přes klidovou pózu sítě. */
function posedBox(gltf: GLTF, clip: string): { box: Box3; clone: Object3D } {
  const clone = cloneSkinned(gltf.scene);
  const mixer = new AnimationMixer(clone);
  mixer.clipAction(gltf.animations.find((animation) => animation.name === clip)!).play();
  mixer.update(0);
  clone.updateMatrixWorld(true);
  return { box: new Box3().setFromObject(clone, true), clone };
}

describe('clip map of the Quaternius packs (P54B T3)', () => {
  it('maps the pack names onto the game states, the first listed name wins', () => {
    const uac = ['Death', 'Defeat', 'Idle', 'Jump', 'Punch', 'RecieveHit', 'Run', 'Shoot_OneHanded', 'SwordSlash', 'Victory', 'Walk'];
    expect(clipMap(uac)).toEqual({ idle: 'Idle', walk: 'Walk', run: 'Run', jump: 'Jump', hit: 'RecieveHit', die: 'Death', win: 'Victory', shoot: 'Punch' });
    expect(clipMap(['Idle', 'Walk', 'HitRecieve', 'Dance', 'Yes', 'Bite_Front'])).toEqual({ idle: 'Idle', walk: 'Walk', hit: 'HitRecieve', win: 'Yes', shoot: 'Bite_Front' });
    expect(clipMap(['Idle', 'Run', 'HitReact', 'Dance', 'SwordSlash'])).toMatchObject({ hit: 'HitReact', win: 'Dance', shoot: 'SwordSlash' });
    // Zvířata: běh je cval, zásah je škubnutí ve stoje.
    expect(clipMap(['Gallop', 'Idle', 'Idle_HitReact1', 'Idle_HitReact2', 'Walk'])).toEqual({ idle: 'Idle', walk: 'Walk', run: 'Gallop', hit: 'Idle_HitReact1' });
    // Létající příšery: vznášení je klid, rychlý let je běh.
    expect(clipMap(['Death', 'Fast_Flying', 'Flying_Idle', 'HitReact'])).toEqual({ idle: 'Flying_Idle', run: 'Fast_Flying', hit: 'HitReact', die: 'Death' });
  });

  it('needs idle and walk or run', () => {
    expect(missingClips({ idle: 'Idle', walk: 'Walk' })).toBeNull();
    expect(missingClips({ idle: 'Idle', run: 'Run' })).toBeNull();
    expect(missingClips({ walk: 'Walk', run: 'Run' })).toMatch(/idle/);
    expect(missingClips({ idle: 'Flying_Idle' })).toMatch(/walk or run/);
  });
});

describe('processDocument (P54B T3)', () => {
  it('keeps the skeleton and only the mapped clips, stands the character on its base at 1.8 m', async () => {
    const built = await processDocument(rig(TEAL, ['Idle', 'Walk', 'Run', 'Roll', 'SitDown']), CHARACTER);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.clips).toEqual({ idle: 'Idle', walk: 'Walk', run: 'Run' });
    const gltf = await parse(built.bytes);
    expect(gltf.animations.map((animation) => animation.name).sort()).toEqual(['Idle', 'Run', 'Walk']);
    const { box, clone } = posedBox(gltf, 'Idle');
    const skinned: SkinnedMesh[] = [];
    clone.traverse((node) => {
      if ((node as SkinnedMesh).isSkinnedMesh === true) skinned.push(node as SkinnedMesh);
    });
    expect(skinned.length).toBeGreaterThan(0);
    expect(skinned[0]!.skeleton.bones.length).toBeGreaterThan(0);
    expect(box.max.y - box.min.y).toBeCloseTo(HEIGHT_M, 2);
    expect(box.min.y).toBeCloseTo(0, 3);
    const center = box.getCenter(new Vector3());
    expect(center.x).toBeCloseTo(0, 3);
    expect(center.z).toBeCloseTo(0, 3);
    expect(built.dims[1]).toBeCloseTo(HEIGHT_M, 2);
  });

  it('bakes the material colour into the vertices under one shared material without textures', async () => {
    const built = await processDocument(rig(TEAL, ['Idle', 'Walk']), CHARACTER);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const gltf = await parse(built.bytes);
    const meshes: SkinnedMesh[] = [];
    gltf.scene.traverse((node) => {
      if ((node as SkinnedMesh).isSkinnedMesh === true) meshes.push(node as SkinnedMesh);
    });
    const colour = meshes[0]!.geometry.getAttribute('color');
    expect(colour).toBeDefined();
    [colour.getX(0), colour.getY(0), colour.getZ(0)].forEach((value, channel) => expect(value).toBeCloseTo(TEAL[channel]!, 4));
    expect(built.textures).toBe(0);
    expect(built.fallback).toBe('#0d9488');
  });

  it('excludes a model whose predominant hue is purple, and one without idle or walk/run', async () => {
    const purple = await processDocument(rig(PURPLE, ['Idle', 'Walk']), CHARACTER);
    expect(purple).toMatchObject({ ok: false, reason: expect.stringMatching(/purple/) });
    // Šedé tělo a fialová košile: jediný barevný odstín je fialová – převažuje, i když zabírá třetinu plochy.
    const shirt = await processDocument(rig([GREY, GREY, PURPLE], ['Idle', 'Walk'], 3), CHARACTER);
    expect(shirt).toMatchObject({ ok: false, reason: expect.stringMatching(/purple/) });
    // Tmavě fialový duch je pořád fialový – tma odstín nesmaže.
    const ghost = await processDocument(rig(linear('#24122c'), ['Idle', 'Walk']), CHARACTER);
    expect(ghost).toMatchObject({ ok: false, reason: expect.stringMatching(/purple/) });
    // Fialový jazyk šedé pandy (4 % plochy) je detail, ne odstín postavy.
    const tongue = await processDocument(rig([...Array.from({ length: 24 }, () => GREY), PURPLE], ['Idle', 'Walk'], 25), CHARACTER);
    expect(tongue).toMatchObject({ ok: true, fallback: '#9ca3af' });
    // Tyrkysová převažuje nad fialovým doplňkem: postava zůstane a záložní barva fialová není.
    const accent = await processDocument(rig([TEAL, TEAL, PURPLE], ['Idle', 'Walk'], 3), CHARACTER);
    expect(accent).toMatchObject({ ok: true, fallback: '#0d9488' });
    // Švestková (325°) není fialová podle pravidla 250–320°, ale k fialové se kloní: záložní barvou nebude.
    const plum = await processDocument(rig([PLUM, PLUM, TEAL], ['Idle', 'Walk'], 3), CHARACTER);
    expect(plum).toMatchObject({ ok: true, fallback: '#0d9488' });
    const still = await processDocument(rig(TEAL, ['Idle', 'Death']), CHARACTER);
    expect(still).toMatchObject({ ok: false, reason: expect.stringMatching(/walk or run/) });
  });

  it('simplifies a model over the triangle budget instead of dropping it', async () => {
    const built = await processDocument(rig(TEAL, ['Idle', 'Run'], 60, 60), CHARACTER);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.simplifiedFrom).toBe(7200);
    expect(built.triangles).toBeLessThanOrEqual(MAX_TRIANGLES);
  });
});

describe.skipIf(!existsSync(CACHE_DIR))('real packs from the CC0 cache (P54B T3)', () => {
  const byId = (id: string) => CHARACTERS.find((character) => character.id === id)!;

  it('a textured cute monster keeps its texture at most 512 px', async () => {
    const built = await importCharacter(byId('q-cute-yeti'), CACHE_DIR);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.textures).toBeGreaterThan(0);
    expect(built.textures).toBeLessThanOrEqual(MAX_TEXTURE);
    const { box } = posedBox(await parse(built.bytes), built.clips.idle!);
    expect(box.max.y - box.min.y).toBeCloseTo(HEIGHT_M, 2);
  });

  it('the flying demon with a single clip is excluded with its reason', async () => {
    const built = await importCharacter(byId('q-flying-demon'), CACHE_DIR);
    expect(built).toMatchObject({ ok: false, reason: expect.stringMatching(/walk or run/) });
  });
});
