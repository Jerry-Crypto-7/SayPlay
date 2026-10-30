/**
 * Diorama ve VR (P65 T4): každý žánr mimo čtyři VR-nativní se vejde na desku a hrdina z ní nevyjede. Robot
 * ověřovače dohraje každou živou buňku a v každém tiku se hrdina promítne na desku a do pohledu hlavy. Test drží
 * zorné pole, ne jen „hra reaguje“: deska, která za hrdinou nejede, ho na trati ztratí – a to test pozná (kontrola
 * se zmrazeným oknem níž).
 *
 * Hrdina jde do okna v metrech scény podle těla (x zrcadlené, jako `World`); kde scéna kreslí jinde (ohyb trati
 * běžce), jede okno za kresleným hrdinou a ověří to e2e `vr-diorama.spec.ts` v kameře brýlí.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { baseControlOf } from '@/play/arcade/addons';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, BODY, HEADER, NO_INPUT, RUN_STATE, UNIT, bodyBase, nativeRule } from '@/play/arcade/contract';
import { instantiate, loadProgram, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { releasePhysics } from '@/play/arcade/physics/step';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot } from '@/play/arcade/verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { stageOf } from '@/play/compose/stage-registry';

import {
  DESK,
  type DioramaView,
  type Point,
  SCALE_MAX,
  TABLE,
  carried,
  createDiorama,
  deskOfWorld,
  deskPointOf,
  dioramaScale,
  inHeadView,
  onDesk,
  playAreaOf,
  worldOfDesk,
} from '../diorama-scale';

beforeAll(async () => {
  await loadRapier();
});

/** VR-nativní žánry (T3) stojí 1:1 nebo v dosahu ruky – na desku nejdou (`nativeOf` v `XrRig`). */
function native(world: ArcadeWorld): boolean {
  const input = stageOf(baseControlOf(world.control).id)?.input;
  return input === 'shooter-rig' || input === 'throw-rig' || (input === 'lanes' && nativeRule(world.rules, 'slice_cut', 'whack_hit') !== undefined);
}

const worlds: readonly (readonly [string, ArcadeWorld])[] = liveCells().flatMap((cell) => {
  const built = arcadeWorldOf(compileRecipe(assemblyOfCell(cell)), 1);
  return built.ok && !native(built.world) ? [[cell.id, built.world] as const] : [];
});
const worldOf = (id: string): ArcadeWorld => worlds.find(([cell]) => cell === id)![1];

/** Hrdina v metrech scény tik po tiku, jak ho hraje robot ověřovače až do konce běhu. */
function heroRun(world: ArcadeWorld): Point[] {
  const run = runBot(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const path: Point[] = [];
  let next = 0;
  for (let tick = 0; tick < run.tick && state[HEADER.runState] === RUN_STATE.running; tick += 1) {
    while (next < run.inputs.length && run.inputs[next]!.tick < tick) next += 1;
    const event = run.inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
    const hero = bodyBase(state[HEADER.player] as number);
    path.push({ x: -(state[hero + BODY.x] as number) / UNIT, y: (state[hero + BODY.y] as number) / UNIT, z: (state[hero + BODY.z] as number) / UNIT });
  }
  releasePhysics(state);
  return path;
}

const runs = new Map<string, Point[]>();
const runOf = (id: string): Point[] => {
  if (!runs.has(id)) runs.set(id, heroRun(worldOf(id)));
  return runs.get(id)!;
};

/** Tiky, kdy hrdina nebyl na desce nebo v pohledu hlavy, s místem na desce (m). */
function lost(path: readonly Point[], viewOf: (hero: Point) => DioramaView): string[] {
  const misses: string[] = [];
  path.forEach((hero, tick) => {
    const at = deskPointOf(viewOf(hero), hero);
    if (!onDesk(at) || !inHeadView(worldOfDesk(DESK, at))) misses.push(`tick ${String(tick)}: desk ${at.x.toFixed(2)}, ${at.y.toFixed(2)}, ${at.z.toFixed(2)} m`);
  });
  return misses;
}

/** Pět tratí z AC: svět se posouvá v dioramě, hlava stojí. */
const TRACKS = ['runner.default', 'voyage.race', 'crowd.default', 'flap.default', 'hop.default'] as const;
/** Hřiště, která se vejdou celá: okno stojí po celou hru. */
const ARENAS = ['arena.escape', 'arena.collect', 'arena.fight', 'quest.spatial', 'push.default', 'merge.default'] as const;

describe('the play area fits the desk', () => {
  it('covers every live cell except the four VR-native genres', () => {
    expect(worlds.length).toBeGreaterThanOrEqual(15);
    for (const id of [...TRACKS, ...ARENAS, 'platformer.default', 'timing.stack', 'rhythm.default', 'catch.default', 'defense.default', 'merge.default']) {
      expect(worlds.some(([cell]) => cell === id), id).toBe(true);
    }
    expect(worlds.some(([cell]) => cell.startsWith('shooter.') || cell.startsWith('throw.') || cell.startsWith('whack.') || cell.startsWith('slice.'))).toBe(false);
  });

  it.each(worlds)('%s: the whole width at 1:12 or smaller', (_id, world) => {
    const area = playAreaOf(world);
    const scale = dioramaScale(area);
    expect(scale).toBeLessThanOrEqual(SCALE_MAX);
    expect((area.maxX - area.minX) * scale).toBeLessThanOrEqual(TABLE.width + 1e-9);
  });

  it('an arena is measured by its walls, not by where things happen to lie', () => {
    // Aréna má stěny ±20 m (`ARENA.half`), věci leží jen v části: celá aréna = 40 m na 1,2 m.
    const area = playAreaOf(worldOf('arena.escape'));
    expect([area.minX, area.maxX, area.minZ, area.maxZ]).toEqual([-20, 20, -20, 20]);
    expect(dioramaScale(area)).toBeCloseTo(TABLE.width / 40, 6);
  });

  it('the head standing at the desk sees the whole desk and the space above its middle', () => {
    // Celá plocha desky a sloupec nad středem až po strop prostoru; blízké horní rohy jsou skoro u hlavy –
    // tam hrdina nesmí (pás `ahead` ho drží dál od bližšího kraje, výš než 0,6 m ho nepustí `lift`).
    const seen = [
      ...[-1, 1].flatMap((x) => [-1, 1].map((z) => ({ x: (x * TABLE.width) / 2, y: 0, z: (z * TABLE.depth) / 2 }))),
      ...[-1, 1].map((x) => ({ x: (x * TABLE.width) / 2, y: TABLE.height, z: -TABLE.depth / 2 })),
      { x: 0, y: TABLE.height, z: 0 },
    ];
    for (const at of seen) expect(inHeadView(worldOfDesk(DESK, at)), JSON.stringify(at)).toBe(true);
    // A hlídá i ven: bod metr za hlavou, 2 m nad deskou ani blízký horní roh vidět nejsou.
    expect(inHeadView({ x: 0, y: 1.6, z: 1 })).toBe(false);
    expect(inHeadView(worldOfDesk(DESK, { x: 0, y: 2, z: 0 }))).toBe(false);
    expect(inHeadView(worldOfDesk(DESK, { x: -TABLE.width / 2, y: TABLE.height, z: TABLE.depth / 2 }))).toBe(false);
  });
});

describe('the hero never leaves the desk', () => {
  it.each(worlds)('%s: on the desk and in view for the whole bot run', (id, world) => {
    const view = createDiorama(playAreaOf(world));
    const path = runOf(id);
    expect(path.length).toBeGreaterThan(60);
    expect(lost(path, (hero) => view.frame(hero))).toEqual([]);
  });

  it('a desk that stops following loses the runner – the check above bites', () => {
    const view = createDiorama(playAreaOf(worldOf('runner.default')));
    const frozen = view.frame(runOf('runner.default')[0]!);
    expect(lost(runOf('runner.default'), () => frozen).length).toBeGreaterThan(100);
  });

  it('the runner running down a valley of its drawn track stays on the desk; a fall below that ground still drops under it', () => {
    // Kopce trati běžce (`runnerPathOf`) jsou jen kresba: jádro běží po rovině, scéna kreslí hrdinu o `ground(z)` výš či níž.
    const ground = (z: number): number => -1.8 * Math.sin((Math.PI * Math.max(0, z)) / 40);
    const drawn = runOf('runner.default').map((hero) => ({ ...hero, y: hero.y + ground(hero.z) }));
    const view = createDiorama(playAreaOf(worldOf('runner.default')), ground);
    expect(lost(drawn, (hero) => view.frame(hero))).toEqual([]);
    // Okno s rovnou zemí hrdinu v údolí ztratí pod deskou – kontrola výš kousne.
    const flat = createDiorama(playAreaOf(worldOf('runner.default')));
    expect(lost(drawn, (hero) => flat.frame(hero)).length).toBeGreaterThan(10);
    // Pád do jámy: hrdina 2 m pod kreslenou zemí údolí zmizí pod deskou, okno za ním nejede.
    const pit = { x: 0, y: ground(20) - 2, z: 20 };
    expect(deskPointOf(view.frame(pit), pit).y).toBeLessThan(0);
  });

  it.each(TRACKS)('%s: the track scrolls inside the diorama while the desk stands', (id) => {
    const view = createDiorama(playAreaOf(worldOf(id)));
    const path = runOf(id);
    const start = view.frame(path[0]!);
    let end = start;
    for (const hero of path) end = view.frame(hero);
    // Okno ujede s hrdinou kus trati (metry scény), deska (a s ní hlava hráče) stojí, kde byla.
    expect(end.center.z - start.center.z).toBeGreaterThan(20);
    expect(end.scale).toBe(start.scale);
  });

  it.each(ARENAS)('%s: the arena fits whole, so the desk shows it without moving', (id) => {
    const view = createDiorama(playAreaOf(worldOf(id)));
    const path = runOf(id);
    const start = view.frame(path[0]!);
    for (const hero of path) expect(view.frame(hero).center).toEqual(start.center);
  });
});

describe('the left grip carries the desk – view only', () => {
  const hand = { x: 0.3, y: 1.1, z: -0.5, yaw: 0 };

  it('moves the desk with the hand', () => {
    const moved = carried(DESK, hand, { ...hand, x: hand.x + 0.2, y: hand.y - 0.1, z: hand.z + 0.05 });
    expect(moved.x).toBeCloseTo(DESK.x + 0.2, 9);
    expect(moved.top).toBeCloseTo(DESK.top - 0.1, 9);
    expect(moved.z).toBeCloseTo(DESK.z + 0.05, 9);
    expect(moved.yaw).toBe(0);
  });

  it('turns the desk around the hand, not around its own centre', () => {
    const turned = carried(DESK, hand, { ...hand, yaw: Math.PI / 2 });
    expect(turned.yaw).toBeCloseTo(Math.PI / 2, 9);
    // Bod desky pod rukou zůstane pod rukou; střed desky obejde ruku po kružnici.
    const held = deskOfWorld(DESK, hand);
    const after = worldOfDesk(turned, held);
    expect(after.x).toBeCloseTo(hand.x, 9);
    expect(after.z).toBeCloseTo(hand.z, 9);
    expect(Math.hypot(turned.x - hand.x, turned.z - hand.z)).toBeCloseTo(Math.hypot(DESK.x - hand.x, DESK.z - hand.z), 9);
  });

  it('a desk point and its place in the room convert both ways', () => {
    const desk = { x: 0.4, top: 0.7, z: -1.1, yaw: 0.6 };
    const at = { x: 0.25, y: 0.1, z: -0.3 };
    const back = deskOfWorld(desk, worldOfDesk(desk, at));
    expect(back.x).toBeCloseTo(at.x, 9);
    expect(back.y).toBeCloseTo(at.y, 9);
    expect(back.z).toBeCloseTo(at.z, 9);
  });
});
