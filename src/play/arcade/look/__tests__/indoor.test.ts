/**
 * P62 T3: interiér arény má podlahu a stěny. Slepý soudce o obchoďáku napsal „řídké béžové prostředí“: aréna
 * kreslila otevřenou plochu v barvě země a kulisy až daleko za hranou. Test čte, co scéna arény opravdu nakreslí –
 * strom `ArenaFloor` (styl B: útěk, sběr, souboj) a `AgarWorld` (agar, dvorek pravidel) s háčky Reactu nahrazenými
 * jedním průchodem (vzor `hero-action-wiring.test.tsx`) – ne tabulku `LOOKS`: interiér, kterému tabulka dá povrch,
 * ale aréna dál kreslí kryt sady, tady spadne. Barvy podlahy se měří v síti, ne v popisku.
 *
 * Venkovní sady se nemění: otisk jejich stromu arény, sady a povrchu cesty je připíchnutý z `main` (495bbc77).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { type ReactElement, type ReactNode, Fragment, isValidElement } from 'react';
import { BufferGeometry, Color, PerspectiveCamera } from 'three';
import { describe, expect, it, vi } from 'vitest';

import catalog from '@/assets/catalog-index.json';
import { ArenaFloor } from '@/components/play/arcade/arena/ArenaFloor';
import { ArenaWorld } from '@/components/play/arcade/arena/ArenaScene';
import type { ArcadeSession } from '@/components/play/arcade/session';
import { type ArcadeWorld, UNIT } from '@/play/arcade/contract';
import { instantiate } from '@/play/arcade/kernel';
import { LOOK_IDS, LOOKS, type LookId, SURFACES, isSceneryModel, sceneLook } from '@/play/arcade/look';
import { ARENA } from '@/play/arcade/pieces/arena';

import { isPurple, toSrgb } from '../../../../../scripts/assets/cc0/palette.mjs';

// Jeden průchod komponentou: stav z inicializace, efekty a snímky se nepouštějí.
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
vi.mock('@react-three/fiber', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-three/fiber')>()),
  useFrame: () => undefined,
  useThree: (select: (three: { camera: PerspectiveCamera }) => unknown) => select({ camera: new PerspectiveCamera() }),
}));
// Těla agar čte ze stavu jádra; podlahu ani stěny to nemění, takže svět bez těl.
vi.mock('@/components/play/arcade/bodies', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/components/play/arcade/bodies')>()), bodiesOf: () => [] }));

type Element = ReactElement<Record<string, unknown>>;

const INDOOR = ['mall', 'supermarket', 'living_room', 'factory', 'castle', 'cave'] as const;
/** Místo z věty, jak ho scéna dostane (`sceneLook`): s kitem prostředí, je-li pro místo. */
const SETTINGS: Readonly<Record<(typeof INDOOR)[number], string>> = {
  mall: 'a busy shopping mall',
  supermarket: 'a supermarket',
  living_room: 'the living room',
  factory: 'an old factory',
  castle: 'a castle',
  cave: 'a dark cave',
};
const OUTDOOR = LOOK_IDS.filter((id) => !(INDOOR as readonly LookId[]).includes(id));

const PUBLIC = join(__dirname, '..', '..', '..', '..', '..', 'public');
const PATHS: ReadonlyMap<string, string> = new Map(catalog.assets.map((asset) => [asset.assetId, asset.path]));

const half = ARENA.half / UNIT;
const keep = [{ x: 0, z: 0, r: 1.2 }];
/** Strop kusu stěny na straně kamery (m): kamera pod 40–62° přes něj vidí na paty hrdiny u přední hrany. */
const FRONT_TALLEST = 1.2;
/** Strop druhů stěny: druh je instancovaná síť, tedy kreslicí volání na materiál. */
const WALL_KINDS = 6;

/** Kus stěny, jak ho `ArenaFloor` předá kresbě. */
interface WallPiece {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly height: number;
  readonly along: number;
  readonly across: number;
  readonly side: '+z' | '-x' | '+x' | '-z';
}

const typeName = (element: Element): string => (typeof element.type === 'string' ? element.type : element.type === Fragment ? 'Fragment' : ((element.type as { name?: string }).name ?? 'anonymous'));

/** Všechny elementy ve stromu (přes `children`, ne přes vnořené komponenty). */
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => elements(child));
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
const named = (node: ReactNode, name: string): Element[] => elements(node).filter((element) => typeName(element) === name);

/** Podlaha arény: síť s `terrain: 'arena'`, jak ji kreslí `ArenaFloor`. */
function floorOf(tree: ReactNode): Element {
  const floors = elements(tree).filter((element) => (element.props.userData as { terrain?: string } | undefined)?.terrain === 'arena');
  expect(floors).toHaveLength(1);
  return floors[0]!;
}

const wallsOf = (tree: ReactNode): WallPiece[] => named(tree, 'InteriorWall').flatMap((element) => element.props.pieces as WallPiece[]);

/**
 * Podíl plochy hrací plochy (bez metru u hrany), jehož barva je barva povrchu v odstínu 0,7–1,15×: dílce dlažby,
 * prkna, plechy. Spáry, tmavší kusy a druhá barva šachovnice se nepočítají.
 */
function surfaceShare(geometry: BufferGeometry, hex: string): number {
  const target = new Color(hex);
  const t = [target.r, target.g, target.b];
  const position = geometry.getAttribute('position');
  const color = geometry.getAttribute('color');
  let total = 0;
  let hit = 0;
  for (let i = 0; i < position.count; i += 3) {
    const xs = [position.getX(i), position.getX(i + 1), position.getX(i + 2)];
    const zs = [position.getZ(i), position.getZ(i + 1), position.getZ(i + 2)];
    if (Math.max(Math.abs(xs.reduce((a, b) => a + b) / 3), Math.abs(zs.reduce((a, b) => a + b) / 3)) > half - 1) continue;
    const area = Math.abs((xs[1]! - xs[0]!) * (zs[2]! - zs[0]!) - (xs[2]! - xs[0]!) * (zs[1]! - zs[0]!)) / 2;
    total += area;
    const c = [color.getX(i), color.getY(i), color.getZ(i)];
    const k = (c[0]! * t[0]! + c[1]! * t[1]! + c[2]! * t[2]!) / (t[0]! ** 2 + t[1]! ** 2 + t[2]! ** 2);
    if (k >= 0.7 && k <= 1.15 && Math.hypot(c[0]! - k * t[0]!, c[1]! - k * t[1]!, c[2]! - k * t[2]!) < 0.03) hit += area;
  }
  return hit / total;
}

/** Podlaha a stěny interiéru ve stromu arény: povrch z tabulky, opravdu položený, a řada kulis sady po obvodu. */
function expectIndoor(id: (typeof INDOOR)[number], tree: ReactNode): void {
  const look = LOOKS[id];
  expect(look.interior, `${id} interior`).toBeDefined();
  const surface = look.interior!.floor;
  const floor = floorOf(tree);
  expect(floor.props.userData, id).toMatchObject({ surface });
  expect(['grass', 'sand'], id).not.toContain(surface);
  expect(surfaceShare(floor.props.geometry as BufferGeometry, SURFACES[surface].color), `${id}: floor laid in ${surface}`).toBeGreaterThan(0.4);

  const walls = wallsOf(tree);
  expect(new Set(walls.map((piece) => piece.id)).size, `${id} wall kinds`).toBeLessThanOrEqual(WALL_KINDS);
  for (const piece of walls) {
    const name = `${id} ${piece.id} (${piece.x.toFixed(2)}, ${piece.z.toFixed(2)})`;
    // Kus sady (kit prostředí nebo kulisa z katalogu), který sada pro stěnu jmenuje.
    expect(isSceneryModel(piece.id as never), name).toBe(true);
    expect(look.interior!.walls, name).toContain(piece.id);
    // Půdorys stojí celý za hranou: jádro o kusu neví, kus na ploše by hrdina prošel.
    const out = piece.side === '+z' ? piece.z : piece.side === '-z' ? -piece.z : piece.side === '+x' ? piece.x : -piece.x;
    expect(out - piece.across / 2, `${name} on the floor`).toBeGreaterThanOrEqual(half - 1e-9);
    if (piece.side === '-z') expect(piece.height, `${name} hides the hero`).toBeLessThanOrEqual(FRONT_TALLEST + 1e-9);
  }
  // Řada: vzadu a po stranách kusy pokryjí aspoň polovinu strany – stěna, ne pár kusů v rohu.
  for (const side of ['+z', '-x', '+x'] as const) {
    const row = walls.filter((piece) => piece.side === side);
    expect(row.length, `${id} ${side}`).toBeGreaterThan(3);
    expect(row.reduce((sum, piece) => sum + piece.along, 0) / (2 * half), `${id} ${side} covered`).toBeGreaterThan(0.5);
  }
}

function sessionOf(world: ArcadeWorld): ArcadeSession {
  return { world, state: () => instantiate(world), prev: () => instantiate(world), snapshot: () => ({ tick: 0, runState: 'running' }), subscribe: () => () => undefined, paused: () => false } as unknown as ArcadeSession;
}
/** Agar: ovládání arény bez pevné velikosti hráče (`ArenaWorld` → `AgarWorld`). */
const agar = sessionOf({ seed: 7, control: { id: 'move_free', params: { half: ARENA.half } }, rules: [], kinds: [], initial: [0, 0, 0], length: 0 } as unknown as ArcadeWorld);
const cast = { player: '', enemy: '', chaser: '', props: {} };

function agarTree(id: LookId, look = LOOKS[id]): ReactNode {
  const props = { session: agar, half: ARENA.half, surface: { current: null }, look, cast, heroAction: 'none' } as const;
  const world = ArenaWorld(props) as Element;
  expect(typeName(world)).toBe('AgarWorld');
  return (world.type as (props: unknown) => ReactNode)(props);
}

const styledTree = (look: (typeof LOOKS)[LookId], seed = 7): ReactNode => ArenaFloor({ look, half, seed, keep, hero: 1.3 });

describe('P62 T3: interiér arény má podlahu a stěny', () => {
  it.each(INDOOR)('%s: styl B (útěk, sběr, souboj) položí podlahu interiéru a postaví stěnu z kulis sady', (id) => {
    expectIndoor(id, styledTree(sceneLook({ setting: SETTINGS[id], mood: '', look: id })));
  });

  it.each(INDOOR)('%s: agar kreslí tutéž podlahu a stěnu, ne plochu v barvě dráhy', (id) => {
    const tree = agarTree(id, sceneLook({ setting: SETTINGS[id], mood: '', look: id }));
    expect(named(tree, 'planeGeometry'), id).toEqual([]);
    const floors = named(tree, 'ArenaFloor');
    expect(floors, id).toHaveLength(1);
    // Výzdoba podlahy v agaru ne: barevná kostička by na ploše vypadala jako potrava.
    expect(floors[0]!.props.decor, id).toBe(false);
    expectIndoor(id, (floors[0]!.type as (props: unknown) => ReactNode)(floors[0]!.props));
  });

  it('stěna jde ze semínka hry: stejné semínko stejná, jiné jiná', () => {
    for (const id of INDOOR) {
      const a = wallsOf(styledTree(LOOKS[id], 7));
      expect(wallsOf(styledTree(LOOKS[id], 7)), id).toEqual(a);
      expect(wallsOf(styledTree(LOOKS[id], 8)), id).not.toEqual(a);
    }
  });

  it('každý model stěny je v katalogu, má GLB v public/ a žádný fialový vrchol', async () => {
    const ids = [...new Set(INDOOR.flatMap((id) => LOOKS[id].interior?.walls ?? []))];
    expect(ids.filter((id) => !PATHS.has(id))).toEqual([]);
    expect(ids.filter((id) => !existsSync(join(PUBLIC, PATHS.get(id)!)))).toEqual([]);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const purple: string[] = [];
    for (const id of ids) {
      const doc = await io.read(join(PUBLIC, PATHS.get(id)!));
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
          const factor = primitive.getMaterial()?.getBaseColorFactor() ?? [1, 1, 1, 1];
          const colour = primitive.getAttribute('COLOR_0');
          const count = primitive.getAttribute('POSITION')!.getCount();
          for (let i = 0; i < count; i += 1) {
            const linear = colour === null ? [1, 1, 1] : colour.getElement(i, []);
            if (isPurple(toSrgb([linear[0]! * factor[0]!, linear[1]! * factor[1]!, linear[2]! * factor[2]!]))) {
              purple.push(`${id} vrchol ${i}`);
              break;
            }
          }
        }
      }
    }
    expect(purple).toEqual([]);
  }, 90_000);

  it.each(OUTDOOR)('%s: venku beze změny – sada, povrch cesty a strom arény jako na main', (id) => {
    const look = LOOKS[id];
    expect(look.interior, id).toBeUndefined();
    expect(wallsOf(styledTree(look)), id).toEqual([]);
    const print = { look: hashText(JSON.stringify(look)), surface: hashText(JSON.stringify(SURFACES[look.surface])), styled: hashText(JSON.stringify(describeTree(styledTree(look)))), agar: hashText(JSON.stringify(describeTree(agarTree(id)))) };
    expect(print, id).toEqual(MAIN[id]);
  });
});

// ---------------------------------------------------------------------------
// Otisk stromu arény (venkovní sady proti main)

function fnv(bytes: Uint8Array, seed = 0x811c9dc5): number {
  let h = seed;
  for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h;
}
const hashText = (text: string): string => fnv(new TextEncoder().encode(text)).toString(16);
const bytesOf = (array: ArrayLike<number> & { readonly buffer: ArrayBufferLike; readonly byteOffset: number; readonly byteLength: number }): Uint8Array => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
function hashGeometry(geometry: BufferGeometry): string {
  const position = geometry.getAttribute('position').array as Float32Array;
  const color = geometry.getAttribute('color')?.array as Float32Array | undefined;
  return fnv(color === undefined ? new Uint8Array() : bytesOf(color), fnv(bytesOf(position))).toString(16);
}

/** Props, které otisk nečte: děti jdou zvlášť, sadu porovná `look`, relace a reference nic nekreslí. */
const SKIP = new Set(['children', 'key', 'ref', 'look', 'scene', 'flora', 'session', 'material', 'userData', 'ghost', 'cast', 'surface']);

function valueOf(value: unknown): unknown {
  if (value instanceof BufferGeometry) return `geometry:${hashGeometry(value)}`;
  if (value instanceof Color) return value.getHexString();
  if (typeof value === 'number') return Math.round(value * 1e6) / 1e6;
  if (Array.isArray(value)) return value.map(valueOf);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry !== 'function').map(([key, entry]) => [key, valueOf(entry)]));
  return value;
}

/** Strom elementů bez fragmentů a prázdných dětí: typ, props, které něco kreslí, a děti. */
function describeTree(node: ReactNode): unknown[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => describeTree(child));
  if (!isValidElement(node)) return [];
  const element = node as Element;
  const children = describeTree(element.props.children as ReactNode);
  if (element.type === Fragment) return children;
  const props = Object.fromEntries(Object.entries(element.props).filter(([key, value]) => !SKIP.has(key) && typeof value !== 'function').map(([key, value]) => [key, valueOf(value)]));
  return [{ type: typeName(element), props, children }];
}

/** Otisky z `main` 495bbc77 (týž kód testu nad nezměněnou větví). */
const MAIN: Readonly<Record<string, { readonly look: string; readonly surface: string; readonly styled: string; readonly agar: string }>> = {
  meadow: { look: '69289377', surface: 'a6f00295', styled: '33c03ec3', agar: 'af20e51a' },
  city: { look: 'b936c26a', surface: 'e23ce1ee', styled: '890b681e', agar: '7aad2795' },
  forest: { look: '36d842c6', surface: 'a6f00295', styled: '74d720f', agar: '94472e88' },
  jungle: { look: '6648afc2', surface: 'a6f00295', styled: '816a4c0e', agar: '12b41537' },
  desert: { look: 'a72ebdb', surface: '251f7da', styled: '368daf10', agar: 'fce62cb4' },
  beach: { look: 'a50367c5', surface: '251f7da', styled: 'bcac681d', agar: '8bf9e7a7' },
  ocean: { look: '5dac82ba', surface: '1ed3c138', styled: 'f7771623', agar: 'dbbcc4b6' },
  underwater: { look: '65900d87', surface: '251f7da', styled: 'a533db18', agar: '62d66877' },
  snow: { look: '1a8f3481', surface: '3486e152', styled: '5cde5d37', agar: '30849ad9' },
  volcano: { look: '832597ae', surface: 'a6f00295', styled: 'd5516082', agar: 'baf81103' },
  space: { look: '6fd62ac9', surface: 'a6f00295', styled: '5c98c7ab', agar: '63f2d812' },
  graveyard: { look: '38e63bad', surface: 'a6f00295', styled: '77ceebd6', agar: 'af20e51a' },
};
