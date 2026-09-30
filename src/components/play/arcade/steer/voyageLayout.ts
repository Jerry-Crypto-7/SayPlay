/**
 * Rozvržení scény Plavby (P32F T4) – čistě ze světa, bez relace: co je břeh,
 * brána, cíl, překážka a přistávací plocha, v metrech scény (x zrcadlené jako
 * v `World.tsx`). Jen obraz: jádro ani hash o ničem z toho neví.
 */

import { baseControlOf } from '@/play/arcade/addons';
import { BODY, HEADER, type ArcadeWorld, UNIT, bodyBase } from '@/play/arcade/contract';
import { type SteerCourse, centerAt } from '@/play/arcade/pieces/steer';

export type VoyageMode = 'race' | 'land';
export type VoyageTerrain = 'islands' | 'rocks' | 'buildings';
/** Jak se hrdina hýbe (mimo hash): loď se houpe, přistávač klopí a má tah, vozidlo jen jede. */
export type VoyageMotion = 'boat' | 'lander' | 'vehicle';

/** Kvádr těla ve scéně (m): x a z jsou střed, y spodní stěna. */
export interface VoyageBox {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

export interface VoyageLayout {
  readonly mode: VoyageMode;
  readonly terrain: VoyageTerrain;
  readonly motion: VoyageMotion;
  /** Osa trati závodu (z robota – ovládání plavby ji nenese); přistání žádnou nemá. */
  readonly course: SteerCourse | undefined;
  /** Mantinely úseků: vnitřní hrana (m) a strana (−1 / +1, ve scéně). */
  readonly walls: readonly (VoyageBox & { readonly inner: number; readonly side: -1 | 1 })[];
  readonly gates: readonly VoyageBox[];
  readonly hazards: readonly (VoyageBox & { readonly kind: 'shot' | 'snag' })[];
  readonly goal: VoyageBox | null;
  readonly pad: VoyageBox | null;
  readonly hero: VoyageBox;
  /** Nejdál od osy, kam sahá kanál nebo plocha (m) – odtud se staví moře a pobřeží. */
  readonly reach: number;
}

const TERRAIN_OF: Readonly<Record<string, VoyageTerrain>> = { island: 'islands', rock: 'rocks', building: 'buildings' };

/** Plavba, nebo `null` pro obyčejný závod (ten si kreslí asfalt jako dřív). */
export function voyageLayoutOf(world: ArcadeWorld): VoyageLayout | null {
  const land = (baseControlOf(world.control).params as { land?: unknown }).land !== undefined;
  const course = world.bot.params.course as SteerCourse | undefined;
  const state = world.initial;
  const boxes: (VoyageBox & { readonly kind: string })[] = [];
  for (let index = 0; index < (state[HEADER.bodyCount] as number); index += 1) {
    const base = bodyBase(index);
    const at = (slot: number): number => (state[base + slot] as number) / UNIT;
    boxes.push({ index, kind: world.kinds[state[base + BODY.kind] as number] ?? '', x: -at(BODY.x), y: at(BODY.y), z: at(BODY.z), w: at(BODY.w), h: at(BODY.h), d: at(BODY.d) });
  }
  const hero = boxes[state[HEADER.player] as number];
  const wallKind = boxes.find((box) => TERRAIN_OF[box.kind] !== undefined)?.kind;
  if (hero === undefined || (!land && (wallKind === undefined || course === undefined))) return null;
  const terrain = land ? 'rocks' : TERRAIN_OF[wallKind!]!;
  const walls = boxes
    .filter((box) => box.kind === wallKind)
    .map((box) => {
      // Strana od osy úseku (osa je v jednotkách jádra, scéna ji zrcadlí).
      const side: -1 | 1 = box.x < centerOf(course, box.z) ? -1 : 1;
      return { ...box, side, inner: box.x - (side * box.w) / 2 };
    });
  const pad = boxes.find((box) => box.kind === 'pad') ?? null;
  const reach = Math.max(...walls.map((wall) => Math.abs(wall.x) + wall.w / 2), pad === null ? 0 : Math.abs(pad.x) + pad.w / 2, 6);
  return {
    mode: land ? 'land' : 'race',
    terrain,
    motion: land ? 'lander' : terrain === 'islands' ? 'boat' : 'vehicle',
    course,
    walls,
    gates: boxes.filter((box) => box.kind === 'gate'),
    hazards: boxes.flatMap((box) => (box.kind === 'shot' || box.kind === 'snag' ? [{ ...box, kind: box.kind }] : [])),
    goal: boxes.find((box) => box.kind === 'goal') ?? null,
    pad,
    hero,
    reach,
  };
}

/** Střed trati ve scéně (m) v místě `z` (m). */
export const centerOf = (course: SteerCourse | undefined, z: number): number => (course === undefined ? 0 : -centerAt(course, z * UNIT) / UNIT);
