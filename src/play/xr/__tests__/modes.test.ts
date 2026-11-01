/**
 * Režimy rigu VR (P67 T6): každý žánr má režim a pózu, neznámý žánr jde na stůl, a režim se pozná ze samotného
 * světa hry – spec do XR vrstvy nedojde. Čtyři VR-nativní žánry zůstávají přesně ty, které poznával `nativeOf`
 * před tabulkou. Svět `room` stojí kolem hráče v měřítku 1:1 až 1:3 a za hry se nehne.
 */

import { describe, expect, it } from 'vitest';

import { baseControlOf } from '@/play/arcade/addons';
import arenaFixture from '@/play/arcade/__fixtures__/arena.json';
import runnerFixture from '@/play/arcade/__fixtures__/runner.json';
import shooterFixture from '@/play/arcade/__fixtures__/shooter.json';
import throwFixture from '@/play/arcade/__fixtures__/throw.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, BODY, HEADER, UNIT, bodyBase, nativeRule } from '@/play/arcade/contract';
import { LANES, laneX } from '@/play/arcade/pieces/lanes';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { stageOf } from '@/play/compose/stage-registry';
import { ROUTE_PENDING } from '@/play/genre/classify';
import { GENRES } from '@/play/genre/contract';
import { readGameSpec } from '@/play/spec';

import { playAreaOf } from '../diorama-scale';
import { DESK_MODE, ROOM, type RoomPlacement, XR_MODES, genreOfWorld, modeOf, roomOf } from '../modes';

/** `nativeOf` z `XrRig` před tabulkou režimů (P65 T3): střílečka, hod, a pruhy, které seká nebo bouchá ruka. */
function legacyNative(world: ArcadeWorld): boolean {
  const input = stageOf(baseControlOf(world.control).id)?.input;
  return input === 'shooter-rig' || input === 'throw-rig' || (input === 'lanes' && nativeRule(world.rules, 'slice_cut', 'whack_hit') !== undefined);
}

const cells = liveCells().flatMap((cell) => {
  const built = arcadeWorldOf(compileRecipe(assemblyOfCell(cell)), 1);
  return built.ok ? [{ id: cell.id, genre: cell.preset.genre, world: built.world }] : [];
});
const worldOf = (id: string): ArcadeWorld => cells.find((cell) => cell.id === id)!.world;

const fromFixture = (raw: unknown): ArcadeWorld => {
  const spec = readGameSpec(raw);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
};

/** Bod scény (m, osy scény) ve skutečném prostoru: obal otočený o půl kruhu, bod `anchor` u nohou hráče. */
const realOf = ({ scale, anchor }: RoomPlacement, at: { readonly x: number; readonly z: number }) => ({ x: scale * (anchor.x - at.x), z: scale * (anchor.z - at.z) });

/** Start hrdiny v metrech scény (x zrcadlené jako ve scéně). */
function heroStart(world: ArcadeWorld) {
  const hero = bodyBase(world.initial[HEADER.player] as number);
  return { x: -(world.initial[hero + BODY.x] as number) / UNIT, z: (world.initial[hero + BODY.z] as number) / UNIT };
}

describe('every genre has a mode and a pose', () => {
  it('one entry per genre in GENRES, nothing else', () => {
    expect(Object.keys(XR_MODES).sort()).toEqual([...GENRES].sort());
    for (const genre of GENRES) expect(modeOf(genre), genre).toBe(XR_MODES[genre]);
  });

  it('an unknown genre plays on the desk', () => {
    expect(modeOf(null)).toEqual({ mode: 'desk', pose: 'table' });
    expect(modeOf('golf')).toBe(DESK_MODE);
    expect(modeOf('constructor')).toBe(DESK_MODE);
  });

  it('native are the four hand genres, room is arena, defense and catch', () => {
    const of = (mode: string) => GENRES.filter((genre) => XR_MODES[genre].mode === mode).sort();
    expect(of('native')).toEqual(['shooter', 'slice', 'throw', 'whack']);
    expect(of('room')).toEqual(['arena', 'catch', 'defense']);
    expect(XR_MODES.arena.pose).toBe('center');
    expect(XR_MODES.defense.pose).toBe('base');
    expect(XR_MODES.catch.pose).toBe('front');
  });
});

describe('the mode comes from the world itself', () => {
  it('recognises a live cell of every genre', () => {
    // Kostra P68 v bráně aktivace živou buňku nemá; zapojení hry ji odsud pustí a test pak buňku chce. Hra vrácená
    // za bránu po branách hry (T11 `buildshift`, T8 `stunt`) buňku v `PRESETS` drží pro nový pokus – smí ji mít.
    const seen = new Set(cells.map((cell) => genreOfWorld(cell.world)));
    for (const genre of GENRES.filter((id) => !ROUTE_PENDING.has(id))) expect(seen.has(genre), genre).toBe(true);
    for (const genre of seen) expect(genre === null || GENRES.includes(genre), String(genre)).toBe(true);
    expect(seen.has(null)).toBe(true);
  });

  it.each(cells.map((cell) => [cell.id, cell] as const))('%s: its genre, and native exactly as before the table', (_id, { genre, world }) => {
    const found = genreOfWorld(world);
    // Buňky skládané ze staršího ovládání (`glide`, `walker`, `ball`) nesou žánr jen jménem: hrají se jako dřív na stole.
    if (found === null) expect(['glide', 'walker', 'ball']).toContain(baseControlOf(world.control).id);
    else expect(found).toBe(genre);
    expect(modeOf(found).mode === 'native').toBe(legacyNative(world));
  });

  it('games saved before genres keep their way of playing', () => {
    expect(genreOfWorld(fromFixture(shooterFixture))).toBe('shooter');
    expect(genreOfWorld(fromFixture(throwFixture))).toBe('throw');
    expect(genreOfWorld(fromFixture(runnerFixture))).toBe('runner');
    expect(genreOfWorld(fromFixture(arenaFixture))).toBe('arena');
    for (const raw of [shooterFixture, throwFixture, runnerFixture, arenaFixture]) {
      const world = fromFixture(raw);
      expect(modeOf(genreOfWorld(world)).mode === 'native').toBe(legacyNative(world));
    }
  });
});

describe('room: the world stands around the player', () => {
  it.each(['arena.escape', 'arena.collect', 'arena.fight'])('%s: the player stands in the middle, walls at most 8 m away, 1:1 to 1:3', (id) => {
    const world = worldOf(id);
    const room = roomOf('center', world);
    const area = playAreaOf(world);
    expect(room.scale).toBeGreaterThanOrEqual(ROOM.minScale);
    expect(room.scale).toBeLessThanOrEqual(1);
    expect(room.anchor).toEqual({ x: (area.minX + area.maxX) / 2, z: (area.minZ + area.maxZ) / 2 });
    // Každá stěna podél os nejvýš 8 m od hráče, a aspoň jedna právě 8 m (měřítko se nezmenší víc, než musí).
    const walls = [realOf(room, { x: area.minX, z: room.anchor.z }).x, realOf(room, { x: area.maxX, z: room.anchor.z }).x, realOf(room, { x: room.anchor.x, z: area.minZ }).z, realOf(room, { x: room.anchor.x, z: area.maxZ }).z];
    expect(Math.max(...walls.map(Math.abs))).toBeLessThanOrEqual(ROOM.reach + 1e-9);
    expect(room.reach).toBeCloseTo(Math.max(...walls.map(Math.abs)), 9);
  });

  it('arena.escape: the 40 m arena stands at 1:2.5', () => {
    expect(roomOf('center', worldOf('arena.escape')).scale).toBeCloseTo(8 / 20, 9);
  });

  it('defense: 1:1, the hero starts 1.5 m in front of the player, the lanes march at him', () => {
    const world = worldOf('defense.default');
    const room = roomOf('base', world);
    expect(room.scale).toBe(1);
    const hero = realOf(room, heroStart(world));
    expect(hero.x).toBeCloseTo(0, 9);
    expect(hero.z).toBeCloseTo(-ROOM.baseBack, 9);
    // Pruhy jsou 2 m od sebe přímo před hráčem: jádro +x je skutečné +x (obal otočený o půl kruhu zrcadlení vrátí).
    expect(realOf(room, { x: -laneX(4) / UNIT, z: 0 }).x).toBeCloseTo(laneX(4) / UNIT, 9);
  });

  it('catch: 1:3, the lanes 1.2 m in front, the outer lane starts 1 m from the middle', () => {
    const world = worldOf('catch.default');
    const room = roomOf('front', world);
    expect(room.scale).toBeCloseTo(1 / 3, 9);
    const hero = realOf(room, heroStart(world));
    expect(hero.x).toBeCloseTo(0, 9);
    expect(hero.z).toBeCloseTo(-ROOM.catchAhead, 9);
    // Hranice mezi pruhy 3 a 4 (jádro x = 1,5 rozestupu) je v dosahu natažené ruky s půlkrokem.
    const edge = realOf(room, { x: -(1.5 * LANES.width) / UNIT, z: 0 });
    expect(edge.x).toBeCloseTo(ROOM.catchSide, 9);
  });

  it('is computed from the start of the level only, so it never moves during play', () => {
    const world = worldOf('arena.escape');
    const moved = { ...world, initial: world.initial.map((value, index) => (index === bodyBase(world.initial[HEADER.player] as number) + BODY.x ? value + 5000 : value)) };
    // Hrdina jinde na startu posune jen bod pod hráčem u póz, které se řídí hrdinou; aréna stojí podle stěn.
    expect(roomOf('center', moved).anchor).toEqual(roomOf('center', world).anchor);
    expect(roomOf('base', moved).anchor.x).toBeCloseTo(roomOf('base', world).anchor.x - 5, 9);
  });
});
