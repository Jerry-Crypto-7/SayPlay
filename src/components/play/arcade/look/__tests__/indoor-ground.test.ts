/**
 * P62 T6: interiér má podlahu interiéru i mimo arénu. Soudce po T2–T5 na dev větě s003 (běžec v supermarketu) dál
 * psal „outdoor road over pale hills rather than a supermarket“ a u s039 (střelnice v obchoďáku) „washed-out, sparse
 * open space“: dlažbu interiéru (T3) kladla jen aréna, údolí běžce (`buildValley`) a zem ostatních žánrů
 * (`buildFieldGround`) dál malovaly zem sady – světlé skvrny jako sníh, štěrk krajnice u šedého pásu cesty.
 *
 * Test čte, co scéna z dev věty opravdu nakreslí: údolí běžce (`RunnerValley`) a zem střelnice (`WorldBackdrop` →
 * `FieldGround`) – síť, materiál i texel dlažby –, s háčky Reactu nahrazenými jedním průchodem (vzor `indoor.test.ts`).
 * Venkovní sady se nemění: otisk sítě údolí, pásu cesty a země je připíchnutý z 6beb49d3.
 */

import { type ReactElement, type ReactNode, Fragment, isValidElement } from 'react';
import { BufferGeometry, Color, type DataTexture, type Mesh, type MeshStandardMaterial, SRGBColorSpace } from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { type ArcadeWorld, UNIT } from '@/play/arcade/contract';
import { type Look, LOOK_IDS, LOOKS, type LookId, SURFACES, sceneLook } from '@/play/arcade/look';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft/draft';

import { RunnerValley } from '../../runner/RunnerWorld';
import { WorldBackdrop } from '../../WorldBackdrop';
import { FieldGround } from '../FieldGround';
import { buildFieldGround } from '../ground';
import { buildValley } from '../rig/terrain/valley';

import { isPurple } from '../../../../../../scripts/assets/cc0/palette.mjs';

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
    useMemo: (make: () => unknown) => make(),
    useRef: (current: unknown) => ({ current }),
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
  };
});

type Element = ReactElement<Record<string, unknown>>;

const INDOOR = ['mall', 'supermarket', 'living_room', 'factory', 'castle', 'cave'] as const;
const OUTDOOR = LOOK_IDS.filter((id) => !(INDOOR as readonly LookId[]).includes(id));
const DEV = [
  { id: 's003', sentence: 'A hamster escaping a supermarket while a giant Roomba hunts me', look: 'supermarket', control: 'runner' },
  { id: 's039', sentence: 'zombie shooter in a mall', look: 'mall', control: 'shooter' },
] as const;

const typeName = (element: Element): string => (typeof element.type === 'string' ? element.type : element.type === Fragment ? 'Fragment' : ((element.type as { name?: string }).name ?? 'anonymous'));
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => elements(child));
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
const named = (node: ReactNode, name: string): Element[] => elements(node).filter((element) => typeName(element) === name);

const world = (length: number): ArcadeWorld => ({ seed: 7, length: length * UNIT }) as unknown as ArcadeWorld;

/** Údolí běžce, jak ho scéna kreslí: síť, materiál a pásy cesty s barvou jejich materiálu. */
function runnerGround(look: Look) {
  const tree = RunnerValley({ look, world: world(120), terrain: { current: null as Mesh | null }, path: null }) as ReactNode;
  const valleys = elements(tree).filter((element) => (element.props.userData as { terrain?: string } | undefined)?.terrain === 'valley');
  expect(valleys).toHaveLength(1);
  const valley = valleys[0]!;
  const strips = named(tree, 'mesh')
    .filter((mesh) => mesh !== valley)
    .map((mesh) => ({ geometry: mesh.props.geometry as BufferGeometry, color: named(mesh.props.children as ReactNode, 'meshStandardMaterial')[0]?.props.color as string | undefined }));
  return { geometry: valley.props.geometry as BufferGeometry, map: (valley.props.material as MeshStandardMaterial).map as DataTexture | null, strips };
}

/** Zem střelnice: `FieldGround` z podkladu `WorldBackdrop`, jeden průchod. */
function shooterGround(look: Look) {
  const grounds = named(WorldBackdrop({ control: 'shooter', length: 60, look, seed: 7 }), 'FieldGround');
  expect(grounds).toHaveLength(1);
  const mesh = named(FieldGround(grounds[0]!.props as never), 'mesh')[0]!;
  const material = named(mesh.props.children as ReactNode, 'meshStandardMaterial')[0]!;
  return { geometry: mesh.props.geometry as BufferGeometry, map: (material.props.map ?? null) as DataTexture | null };
}

/** Podíl texelů, jejichž barva je `hex` v odstínu `low`–`high`× (projekce jako `surfaceShare` v `indoor.test.ts`). */
function texelShare(map: DataTexture, hex: string, low = 0.7, high = 1.15): number {
  const { data, width, height } = map.image as { data: Uint8Array; width: number; height: number };
  const target = new Color(hex);
  const t = [target.r, target.g, target.b] as const;
  const c = new Color();
  let hit = 0;
  for (let i = 0; i < width * height; i += 1) {
    c.setRGB(data[i * 4]! / 255, data[i * 4 + 1]! / 255, data[i * 4 + 2]! / 255, SRGBColorSpace);
    const k = (c.r * t[0] + c.g * t[1] + c.b * t[2]) / (t[0] ** 2 + t[1] ** 2 + t[2] ** 2);
    if (k >= low && k <= high && Math.hypot(c.r - k * t[0], c.g - k * t[1], c.b - k * t[2]) < 0.03) hit += 1;
  }
  return hit / (width * height);
}

/**
 * Země leží v dlažbě interiéru: textura je dlažba povrchu sady (dílce a spáry), síť nese UV v metrech, aby dílec
 * měl svou velikost, a bílé vrcholy – barvu dá jen dlažba, žádné sněhové skvrny ani krajnice.
 */
function expectIndoorFloor(name: string, look: Look, ground: { geometry: BufferGeometry; map: DataTexture | null }): void {
  const floor = look.interior!.floor;
  const surface = SURFACES[floor];
  expect(ground.map, `${name}: floor texture`).not.toBeNull();
  const map = ground.map!;
  // Šachovnice má polovinu dílců v druhé barvě (na půl cesty ke spáře), ostatní povrchy jednu.
  expect(texelShare(map, surface.color), `${name}: ${floor} tiles`).toBeGreaterThan(floor === 'checker' ? 0.3 : 0.4);
  expect(texelShare(map, surface.edge, 0.95, 1.05), `${name}: ${floor} seams`).toBeGreaterThan(0.01);
  if (floor === 'checker') expect(texelShare(map, `#${new Color(surface.color).lerp(new Color(surface.edge), 0.5).getHexString()}`, 0.8, 1.1), `${name}: checker`).toBeGreaterThan(0.2);
  const { data } = map.image as { data: Uint8Array };
  let purple = 0;
  for (let i = 0; i < data.length; i += 4) if (isPurple([data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255])) purple += 1;
  expect(purple, `${name}: purple texels`).toBe(0);
  // Dílec v metrech: UV vrcholu = jeho x, z (síť před ohnutím po trati), perioda textury je celý počet dílců.
  const uv = ground.geometry.getAttribute('uv');
  const position = ground.geometry.getAttribute('position');
  expect(uv, `${name}: uv`).toBeDefined();
  for (let i = 0; i < position.count; i += 97) {
    expect(uv.getX(i), `${name} u`).toBeCloseTo(position.getX(i), 4);
    expect(uv.getY(i), `${name} v`).toBeCloseTo(position.getZ(i), 4);
  }
  expect(map.repeat.x, `${name}: period`).toBeGreaterThan(0);
  const color = ground.geometry.getAttribute('color');
  let lowest = 1;
  for (let i = 0; i < color.count; i += 1) lowest = Math.min(lowest, color.getX(i), color.getY(i), color.getZ(i));
  expect(lowest, `${name}: white vertices`).toBeGreaterThan(0.999);
}

describe('P62 T6: interiér má podlahu i mimo arénu', () => {
  beforeAll(async () => {
    await loadRapier();
  });

  it.each(DEV)('$id „$sentence“: zem žánru je dlažba interiéru, ne zem sady s cestou', ({ sentence, look, control }) => {
    const { spec } = draftGameSpecWithMeta(sentence, 1);
    expect(spec.control).toBe(control);
    const scene = sceneLook(spec.theme);
    expect(scene.interior, 'interior').toEqual(LOOKS[look].interior);
    if (control === 'runner') {
      const ground = runnerGround(scene);
      expectIndoorFloor(sentence, scene, ground);
      // Ulička je podlaha haly: pás „cesty“ se nekreslí (ani v barvě dlažby), zbývají jen okraje uličky ve spáře dlažby.
      expect(ground.strips.map((strip) => strip.color)).toEqual([SURFACES[scene.interior!.floor].edge]);
    } else expectIndoorFloor(sentence, scene, shooterGround(scene));
  });

  it.each(INDOOR)('%s: běžec a zem polí kladou dlažbu sady, údolí je rovná podlaha', (id) => {
    const look = LOOKS[id];
    expectIndoorFloor(`${id} runner`, look, runnerGround(look));
    expectIndoorFloor(`${id} shooter`, look, shooterGround(look));
    expect(Math.max(...buildValley({ look, from: -20, to: 200 }).heights), `${id} flat`).toBe(0);
  });

  it.each(OUTDOOR)('%s: venku beze změny – údolí, pás cesty a zem jako na 6beb49d3', (id) => {
    const look = LOOKS[id];
    const runner = runnerGround(look);
    expect(runner.map, id).toBeNull();
    expect(runner.geometry.getAttribute('uv'), id).toBeUndefined();
    expect(runner.strips.map((strip) => strip.color), id).toContain(SURFACES[look.surface].color);
    const field = shooterGround(look);
    expect(field.map, id).toBeNull();
    const print = {
      valley: hashGeometry(runner.geometry),
      strips: runner.strips.map((strip) => `${strip.color}:${hashGeometry(strip.geometry)}`).join(','),
      field: hashGeometry(buildFieldGround(look, { x0: -70, x1: 70, z0: -30, z1: 110 })),
    };
    expect(print, id).toEqual(BEFORE[id]);
  });
});

function fnv(bytes: Uint8Array, seed = 0x811c9dc5): number {
  let h = seed;
  for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h;
}
const bytesOf = (array: ArrayLike<number> & { readonly buffer: ArrayBufferLike; readonly byteOffset: number; readonly byteLength: number }): Uint8Array => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
function hashGeometry(geometry: BufferGeometry): string {
  let h = 0x811c9dc5;
  for (const name of Object.keys(geometry.attributes).sort()) h = fnv(bytesOf(geometry.getAttribute(name).array as Float32Array), fnv(new TextEncoder().encode(name), h));
  if (geometry.index !== null) h = fnv(bytesOf(geometry.index.array as Uint32Array), h);
  return h.toString(16);
}

/** Otisky z 6beb49d3 (týž kód testu nad nezměněnou větví). */
const BEFORE: Readonly<Record<string, { readonly valley: string; readonly strips: string; readonly field: string }>> = {
  meadow: { valley: '3a6c1d8f', strips: '#94754f:af763ea5,#75593b:94024b41', field: 'b17bb52a' },
  city: { valley: '6af5cfe4', strips: '#5a5f66:de4aeb64,#e8e6df:1d32ad60', field: 'aba9fd28' },
  forest: { valley: 'f1f6bb44', strips: '#94754f:254c89a8,#75593b:50a548c', field: 'a3cdc975' },
  jungle: { valley: '990f8d9c', strips: '#94754f:672a97ac,#75593b:d61ff000', field: '116a04dd' },
  desert: { valley: 'e56a253e', strips: '#dcc193:787e8d89,#c3a476:55271732', field: '45427436' },
  beach: { valley: 'e25e7519', strips: '#dcc193:787e8d89,#c3a476:55271732', field: '88b9d0f9' },
  ocean: { valley: '1d2c8879', strips: '#a07a4e:6bc0ae61,#6e5034:9dc66635,#6e5034:56433411', field: 'ca3f2ca0' },
  underwater: { valley: 'f1e4a4a', strips: '#dcc193:c524109c,#c3a476:c0a737f3', field: '8574187b' },
  snow: { valley: 'e89b21fb', strips: '#e6edf4:de4aeb64,#bccbd9:d62e4120', field: '9d5077f9' },
  volcano: { valley: '23937d54', strips: '#94754f:672a97ac,#75593b:d61ff000', field: '8937d048' },
  space: { valley: '8f7d383a', strips: '#94754f:dd0ac91,#75593b:9a853b2a', field: '5a198448' },
  graveyard: { valley: '8f99e8cc', strips: '#94754f:ca2725f8,#75593b:5dda668f', field: '4b9642d9' },
};
