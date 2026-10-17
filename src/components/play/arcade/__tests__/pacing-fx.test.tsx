/**
 * Varování průběhu ve scéně (P45C T15). Co by vypadalo dobře a bylo špatně:
 * varování, které se ukáže o tik později, nebo zůstane viset po úderu – na
 * snímku vypadá stejně a hráči nepomůže; a kresba, která do stavu zapíše, by
 * rozbila přehrání. Test proto hraje skutečné světy s chováním a po každém
 * tiku porovná, co kresba ukazuje (viditelné kousky ve skupině), s fází těl
 * (`telegraphOf`) – tik po tiku, včetně prvního a posledního tiku varování –
 * a hash běhu s kresbou a sběrnicí efektů s hashem bez nich.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Quaternion } from 'three';
import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeState, type ArcadeWorld, BODY, type BodyInit, COUNTER, HEADER, type InputEvent, type PieceRef, UNIT, bodyBase } from '@/play/arcade/contract';
import { hashArcade } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { type BehaviourId, type TelegraphKind, behaviourBodies, behaviourPhaseOf, shotBodies, telegraphOf } from '@/play/arcade/pieces/behaviours';
import { behaviourHarness, play, refsOf } from '@/play/arcade/pieces/behaviours/__tests__/harness';
import { BOSS, DROPPER } from '@/play/arcade/pieces/behaviours/boss';
import { BRUTE } from '@/play/arcade/pieces/behaviours/brute';
import { runBot } from '@/play/arcade/verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { arenaGenre } from '@/play/genre/arena';
import { compileGenre, readGenreSpec } from '@/play/genre/index';

import { NEAR_MISS, type VisualEvent, createEffectsBus, createNearMissWatch, pacingBossOf, pacingRefsOf } from '../effects/bus';
import { NEAR_MISS_FLASH_MS, type PacingCue, type PacingDrawing, createPacingDrawing, latestNearMiss, nearMissFlash } from '../effects/PacingFx';
import { BUS_SFX } from '../effects/sound';
import { TICK_MS, createArcadeSession } from '../session';

const SEEDS = [1, 2, 3, 4];
const FACING = new Quaternion();
const bot = (world: ArcadeWorld): readonly InputEvent[] => runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' }).inputs;

/** Sběr v aréně, kde poslední dvě věci nese boss (jako `boss.test.ts`). */
function bossWorld(seed: number): ArcadeWorld {
  return behaviourHarness('plane', 'boss', seed, {
    extra: (parts) => {
      const boss = (refsOf({ control: parts.control } as ArcadeWorld)[0] as { template: number }).template;
      const points = (parts.rules.find((rule) => rule.id === 'grow_to')?.params as { points: number }).points;
      const items = parts.level.bodies.flatMap((body, index) => (body.role === 'collectible' && body.template !== true ? [index] : []));
      const kept = new Set(items.slice(0, points - 2));
      const bodies = parts.level.bodies.map((body, index) => (body.role === 'collectible' && !kept.has(index) ? { ...body, template: true } : body));
      return { ...parts, level: { ...parts.level, bodies, spawnSlots: (parts.level.spawnSlots ?? 0) + 2 }, rules: [...parts.rules, { id: 'boss_beat', params: { boss, drop: { template: items[points - 2] as number, count: 2 } } }] };
    },
  }).world;
}

/** Svět chování `id`; přepadník stojí 3 m od hráče – v rohu by na něj nečinný hráč nikdy nenarazil. */
function worldFor(id: BehaviourId, seed: number): ArcadeWorld {
  if (id === 'boss') return bossWorld(seed);
  const near = id === 'ambusher' ? { place: (bodies: readonly BodyInit[]) => [{ x: bodies[0]!.x + 3 * UNIT, z: bodies[0]!.z }] } : {};
  return behaviourHarness('plane', id, seed, near).world;
}

/** Těžké testy (robot na celé hře) pod cizí zátěží stroje. */
const SLOW = 300_000;

/** Kočičí aréna z věty (e2e `p35-perf`, rychlá verze): sběr s průběhem – strážce, přepadník a boss. */
function catWorld(seed: number): ArcadeWorld {
  const sentences = (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p32/sentences.json'), 'utf8')) as { sentences: { id: string; text: string; hero: string }[] }).sentences;
  const cat = sentences.find((entry) => entry.id === 'cat')!;
  const read = readGenreSpec({ hero: cat.hero, ...arenaGenre.draftFill(cat.text, null) });
  if (!read.ok) throw new Error(read.issues.join('; '));
  const made = arcadeWorldOf(compileGenre(read.value), seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const frame = (state: ArcadeState, now = 0, reduced = false) => ({ state, prev: state, alpha: 0, now, facing: FACING, reduced });

/** Týž stav slovo po slově (levněji než hluboké `toEqual` každý tik). */
function same(a: ArcadeState, b: ArcadeState): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Varování, která stav chce: tělo chování ve fázi `telegraph` a jeho druh. */
function wanted(world: ArcadeWorld, state: ArcadeState): Map<number, TelegraphKind> {
  const out = new Map<number, TelegraphKind>();
  for (const body of behaviourBodies(state, state[HEADER.player] as number, pacingRefsOf(world.rules))) {
    const telegraph = telegraphOf(state, body);
    if (telegraph !== null) out.set(body, telegraph.kind);
  }
  return out;
}

/** Varování, která kresba opravdu ukazuje: viditelné kousky skupiny s popisem `cue`. */
function shown(drawing: PacingDrawing): Map<number, TelegraphKind> {
  const out = new Map<number, TelegraphKind>();
  for (const child of drawing.root.children) {
    const cue = child.userData.cue as PacingCue | undefined;
    if (child.visible && cue !== undefined) for (const body of cue.bodies) out.set(body, cue.kind);
  }
  return out;
}

const sorted = (map: Map<number, TelegraphKind>): [number, TelegraphKind][] => [...map].sort((a, b) => a[0] - b[0]);

describe('pacing telegraphs in the scene', () => {
  const CASES: readonly [BehaviourId, readonly TelegraphKind[]][] = [
    ['sniper', ['line']],
    ['ambusher', ['shake']],
    ['guardian', ['ring']],
    ['swarm', ['cluster']],
    ['flanker', ['dash']],
    ['boss', ['ring', 'line']],
  ];

  it.each(CASES)('%s: the warning is drawn in exactly the ticks the body is in telegraph – from the first to the last', (id, kinds) => {
    const seen = new Set<TelegraphKind>();
    let starts = 0;
    let ends = 0;
    // Hejno je pomalé (pět těl, robot každý tik) – stačí dvě semínka.
    for (const seed of id === 'swarm' ? SEEDS.slice(0, 2) : SEEDS) {
      const world = worldFor(id, seed);
      const drawing = createPacingDrawing(pacingRefsOf(world.rules));
      for (const inputs of [bot(world), []]) {
        let before = new Map<number, TelegraphKind>();
        play(world, inputs, (state, tick) => {
          const copy = state.slice();
          drawing.update(frame(state, tick * TICK_MS));
          // Kresba stav jen čte.
          expect(same(state, copy)).toBe(true);
          const want = wanted(world, state);
          expect(sorted(shown(drawing)), `seed ${seed} tick ${tick}`).toEqual(sorted(want));
          for (const [body, kind] of want) {
            seen.add(kind);
            if (!before.has(body)) starts += 1;
          }
          for (const body of before.keys()) if (!want.has(body)) ends += 1;
          before = want;
        });
      }
      drawing.dispose();
    }
    // Ne prázdně: varování opravdu přišla i skončila, a každý druh chování.
    expect([...seen].sort()).toEqual([...kinds].sort());
    expect(starts).toBeGreaterThan(1);
    expect(ends).toBeGreaterThan(1);
  }, SLOW);

  it('the line runs along the locked aim, past the target, and thickens towards the strike', () => {
    const world = behaviourHarness('plane', 'sniper', 1).world;
    const drawing = createPacingDrawing(pacingRefsOf(world.rules));
    const widths: [number, number][] = [];
    let checked = 0;
    play(world, [], (state) => {
      const body = behaviourBodies(state, state[HEADER.player] as number, pacingRefsOf(world.rules))[0]!;
      drawing.update(frame(state));
      const telegraph = telegraphOf(state, body);
      if (telegraph === null) return;
      const line = drawing.root.children.find((child) => child.visible && (child.userData.cue as PacingCue | undefined)?.kind === 'line')!;
      const band = line.children[0]!;
      // Pás začíná u střelce a míří na zamčený cíl (scéna zrcadlí x).
      const x = -(state[bodyBase(body) + BODY.x] as number) / 1000;
      const z = (state[bodyBase(body) + BODY.z] as number) / 1000;
      expect(line.position.x).toBeCloseTo(x, 5);
      expect(line.position.z).toBeCloseTo(z, 5);
      const dx = -telegraph.aim.x / 1000 - x;
      const dz = telegraph.aim.z / 1000 - z;
      expect(line.rotation.y).toBeCloseTo(Math.atan2(dx, dz), 5);
      // Po nástupu (160 ms) vede pás přes cíl dál, kudy výstřel poletí.
      if (telegraph.ticksLeft <= 30) expect(band.scale.z).toBeGreaterThan(Math.hypot(dx, dz) + 5);
      // Houstne: v rámci jednoho varování je pás každý tik aspoň tak široký jako předtím.
      if (widths.length > 0 && telegraph.ticksLeft < (widths.at(-1)?.[0] ?? 0)) expect(band.scale.x).toBeGreaterThanOrEqual(widths.at(-1)![1]);
      widths.push([telegraph.ticksLeft, band.scale.x]);
      checked += 1;
    });
    expect(checked).toBeGreaterThan(30);
    expect(Math.max(...widths.map(([, width]) => width))).toBeGreaterThan(Math.min(...widths.map(([, width]) => width)) * 3);
    drawing.dispose();
  });

  it('the boss ring is the stomp reach and the boss carries one HP pip per starting life above its head', () => {
    const world = bossWorld(1);
    const drawing = createPacingDrawing(pacingRefsOf(world.rules));
    const hp = new Set<number>();
    let rings = 0;
    play(world, bot(world), (state) => {
      const drawn = drawing.update(frame(state));
      const bar = drawing.root.children.find((child) => child.visible && child.userData.bossHp !== undefined);
      if (drawn.bosses.length === 0) {
        expect(bar).toBeUndefined();
        return;
      }
      const boss = drawn.bosses[0]!;
      expect(boss.max).toBe(BOSS.hp);
      hp.add(boss.hp);
      const pips = bar!.children.slice(1).filter((pip) => pip.visible);
      expect(pips).toHaveLength(BOSS.hp);
      expect(bar!.position.y).toBeGreaterThan((state[bodyBase(boss.body) + BODY.h] as number) / 1000);
      const ring = drawing.root.children.find((child) => child.visible && (child.userData.cue as PacingCue | undefined)?.kind === 'ring');
      const telegraph = telegraphOf(state, boss.body);
      if (ring === undefined || telegraph === null) return;
      rings += 1;
      // Okraj kruhu po nástupu (160 ms) = dosah dupnutí, kolem bosse.
      if (telegraph.ticksLeft <= 20) expect(ring.children[0]!.scale.x).toBeCloseTo(BOSS.stomp / 1000, 6);
      expect(ring.position.x).toBeCloseTo(-(state[bodyBase(boss.body) + BODY.x] as number) / 1000, 6);
    });
    // Boss přišel, dupal a ubíral se mu život.
    expect(rings).toBeGreaterThan(0);
    expect(hp.size).toBeGreaterThan(1);
    drawing.dispose();
  }, SLOW);

  // P46B T7: boss řízení je shazovač a boss skákačky rváč – chování, které boss nemusí mít; soupeři úseků řízení jsou shazovači taky.
  it.each([['drive.race', DROPPER.bossHp], ['platformer.default', BRUTE.hp]] as const)('%s: the finale boss carries its HP pips, segment foes of the same behaviour none', (id, max) => {
    const cell = liveCells().find((candidate) => candidate.id === id)!;
    const made = arcadeWorldOf(compileRecipe(assemblyOfCell(cell)), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const world = made.world;
    const refs = pacingRefsOf(world.rules);
    const boss = pacingBossOf(world.rules)!;
    const drawing = createPacingDrawing(refs, boss);
    const hp = new Set<number>();
    let foes = 0;
    play(world, bot(world), (state) => {
      const drawn = drawing.update(frame(state));
      const player = state[HEADER.player] as number;
      expect(drawn.bosses.map((entry) => entry.body)).toEqual(behaviourBodies(state, player, [boss]));
      for (const entry of drawn.bosses) {
        expect(entry.max).toBe(max);
        hp.add(entry.hp);
      }
      expect(drawing.root.children.filter((child) => child.visible && child.userData.bossHp !== undefined)).toHaveLength(drawn.bosses.length);
      foes += behaviourBodies(state, player, refs.filter((ref) => ref !== boss)).length;
    });
    // Boss přišel a ubíral se mu život; u řízení byli na ploše i soupeři úseků – a pipy neměli.
    expect(hp.size).toBeGreaterThan(1);
    if (id === 'drive.race') expect(foes).toBeGreaterThan(0);
    drawing.dispose();
  }, SLOW);

  it('reduced motion stills the shake but keeps the line and the ring; the edge flash is off', () => {
    const world = worldFor('ambusher', 1);
    const still = createPacingDrawing(pacingRefsOf(world.rules));
    const moving = createPacingDrawing(pacingRefsOf(world.rules));
    const marks = { still: new Set<number>(), moving: new Set<number>() };
    play(world, [], (state, tick) => {
      still.update(frame(state, tick * TICK_MS, true));
      moving.update(frame(state, tick * TICK_MS, false));
      const bang = (drawing: PacingDrawing) => drawing.root.children.find((child) => child.visible && (child.userData.cue as PacingCue | undefined)?.kind === 'shake');
      const a = bang(still);
      const b = bang(moving);
      expect(a === undefined).toBe(b === undefined);
      if (a !== undefined) marks.still.add(Number(a.children[0]!.position.x.toFixed(6)));
      if (b !== undefined) marks.moving.add(Number(b.children[0]!.position.x.toFixed(6)));
    });
    expect(marks.still).toEqual(new Set([0]));
    expect(marks.moving.size).toBeGreaterThan(5);
    // Pás a kruh zůstanou: s „méně pohybu“ kresba ukazuje totéž co bez něj.
    for (const id of ['sniper', 'guardian'] as const) {
      const other = behaviourHarness('plane', id, 2).world;
      const drawing = createPacingDrawing(pacingRefsOf(other.rules));
      let drawn = 0;
      play(other, bot(other), (state) => {
        drawing.update(frame(state, 0, true));
        expect(sorted(shown(drawing))).toEqual(sorted(wanted(other, state)));
        drawn += shown(drawing).size;
      });
      expect(drawn).toBeGreaterThan(0);
    }
    expect(nearMissFlash(0, false)).toBe(1);
    expect(nearMissFlash(NEAR_MISS_FLASH_MS / 2, false)).toBeGreaterThan(0);
    expect(nearMissFlash(NEAR_MISS_FLASH_MS, false)).toBe(0);
    expect(nearMissFlash(0, true)).toBe(0);
    still.dispose();
    moving.dispose();
  });

  it('a game without pacing draws nothing and hears no near miss', () => {
    const legacy = { ...behaviourHarness('plane', 'sniper', 1).world, rules: [] as PieceRef[] };
    expect(pacingRefsOf(legacy.rules)).toEqual([]);
    const watch = createNearMissWatch(legacy.rules);
    const world = behaviourHarness('plane', 'sniper', 1).world;
    play(world, [], (state) => expect(watch.see(state)).toEqual([]));
  });
});

/** Mezera hran dvou těl (jednotky), nezávisle na sběrnici: po osách, pak přepona. */
function gap(state: ArcadeState, a: number, b: number): number {
  const at = (body: number, slot: keyof typeof BODY): number => state[bodyBase(body) + BODY[slot]] as number;
  const gx = Math.max(0, Math.abs(at(a, 'x') - at(b, 'x')) - (at(a, 'w') + at(b, 'w')) / 2);
  const gz = Math.max(0, Math.abs(at(a, 'z') - at(b, 'z')) - (at(a, 'd') + at(b, 'd')) / 2);
  return Math.hypot(gx, gz);
}

/** Mezera hráče ke kruhu dupnutí (střed od středu, jako `boss.effects`). */
function stompGap(state: ArcadeState, boss: number, player: number): number {
  const at = (body: number, slot: keyof typeof BODY): number => state[bodyBase(body) + BODY[slot]] as number;
  return Math.max(0, Math.hypot(at(player, 'x') - at(boss, 'x'), at(player, 'z') - at(boss, 'z')) - BOSS.stomp);
}

describe('near miss', () => {
  /**
   * Oracle tik po tiku, napsaný ze zadání: průlet těla chování = varování + úder (mezera v `act`, u dupnutí bosse ke
   * kruhu), průlet výstřelu = jeho život; blízké minutí, když nejmenší mezera byla v (0; 1,5 m] a hráč neztratil život.
   */
  it('a threat that passes within 1.5 m without a hit is a near miss; a hit or a wide pass is not', () => {
    const tally = { near: 0, hit: 0, wide: 0 };
    const passed = new Map<BehaviourId, number>();
    for (const id of ['sniper', 'flanker', 'ambusher', 'guardian', 'boss'] as const) for (const seed of SEEDS) {
      const world = worldFor(id, seed);
      const refs = pacingRefsOf(world.rules);
      for (const inputs of [bot(world), []]) {
        const watch = createNearMissWatch(world.rules);
        const passes = new Map<number, { closest: number; health: number; stomp: boolean }>();
        play(world, inputs, (state) => {
          const player = state[HEADER.player] as number;
          const health = state[HEADER.counters + COUNTER.health] as number;
          const open = new Set<number>();
          for (const body of behaviourBodies(state, player, refs)) {
            const phase = behaviourPhaseOf(state, body);
            if (phase !== 'telegraph' && phase !== 'act') continue;
            open.add(body);
            const pass = passes.get(body) ?? { closest: Infinity, health, stomp: false };
            if (phase === 'telegraph') pass.stomp = id === 'boss' && telegraphOf(state, body)?.kind === 'ring';
            else pass.closest = Math.min(pass.closest, pass.stomp ? stompGap(state, body, player) : gap(state, body, player));
            passes.set(body, pass);
          }
          for (const shot of shotBodies(state, player, refs)) {
            open.add(shot);
            const pass = passes.get(shot) ?? { closest: Infinity, health, stomp: false };
            passes.set(shot, { ...pass, closest: Math.min(pass.closest, gap(state, shot, player)) });
          }
          const expected: number[] = [];
          for (const [body, pass] of passes) {
            if (open.has(body)) continue;
            passes.delete(body);
            passed.set(id, (passed.get(id) ?? 0) + 1);
            const closest = pass.stomp ? pass.closest : Math.min(pass.closest, gap(state, body, player));
            if (closest > 0 && closest <= NEAR_MISS && health >= pass.health) {
              expected.push(body);
              tally.near += 1;
            } else if (closest === 0 || health < pass.health) tally.hit += 1;
            else tally.wide += 1;
          }
          expect(watch.see(state).sort()).toEqual(expected.sort());
        });
      }
    }
    // Ne prázdně: každé chování průlety mělo a blízká minutí, zásahy i daleké průlety opravdu nastaly.
    expect([...passed.keys()].sort()).toEqual(['ambusher', 'boss', 'flanker', 'guardian', 'sniper']);
    expect(tally.near).toBeGreaterThan(0);
    expect(tally.hit).toBeGreaterThan(0);
    expect(tally.wide).toBeGreaterThan(0);
  }, SLOW);

  it('the bus announces a near miss only in a human run, with a whoosh, and the drawing flashes the edge for it', () => {
    expect(BUS_SFX.nearMiss).toBe('slide');
    const world = behaviourHarness('plane', 'sniper', 1).world;
    const inputs = bot(world);
    const session = createArcadeSession(world);
    const bus = createEffectsBus(session);
    const heard: VisualEvent[] = [];
    bus.subscribe((events) => heard.push(...events.filter((event) => event.kind === 'nearMiss')));
    const byTick = new Map(inputs.map((event) => [event.tick, event]));
    for (let tick = 0; tick < 4000 && session.snapshot().runState === 'running'; tick += 1) {
      session.hold(byTick.get(tick)?.axis ?? 0);
      session.press(byTick.get(tick)?.buttons ?? 0);
      session.advance(TICK_MS);
      if (heard.length > 0 && latestNearMiss(bus.live()) !== null) break;
    }
    expect(heard.length).toBeGreaterThan(0);
    expect(latestNearMiss(bus.live())).toBe(`${heard.at(-1)!.tick}:${heard.at(-1)!.body}`);
    // Přehrání záznamu (sonda, ukázka) nic nevydá.
    heard.length = 0;
    session.playInputs(inputs, 4000);
    expect(heard).toEqual([]);
    bus.dispose();
  }, SLOW);
});

describe('the drawing never touches the run', () => {
  /** Záznam hraný podle hodin jako člověk; s kresbou a sběrnicí po každém snímku, nebo bez nich. */
  function playByClock(world: ArcadeWorld, inputs: readonly InputEvent[], watched: boolean): { hash: string; tick: number; cues: number } {
    const session = createArcadeSession(world);
    const drawing = watched ? createPacingDrawing(pacingRefsOf(world.rules)) : null;
    const bus = watched ? createEffectsBus(session) : null;
    const byTick = new Map(inputs.map((event) => [event.tick, event]));
    const last = inputs.reduce((most, event) => Math.max(most, event.tick), 0);
    let cues = 0;
    for (let frame = 0; frame <= last + 600 && session.snapshot().runState === 'running'; frame += 1) {
      session.hold(byTick.get(frame)?.axis ?? 0);
      session.press(byTick.get(frame)?.buttons ?? 0);
      // Půl tiku na snímek: kresba i s rozběhnutým tikem (interpolace) a dvěma snímky na tik.
      for (const half of [0, 1]) {
        session.advance(TICK_MS / 2);
        if (drawing === null) continue;
        const state = session.state();
        const copy = state.slice();
        cues += drawing.update({ state, prev: session.prev(), alpha: session.alpha(), now: (frame + half / 2) * TICK_MS, facing: FACING, reduced: false }).cues.length;
        expect(same(state, copy)).toBe(true);
      }
    }
    bus?.dispose();
    drawing?.dispose();
    return { hash: hashArcade(session.state()), tick: session.snapshot().tick, cues };
  }

  it.each([
    ['cat arena from a sentence', () => catWorld(1)],
    ['boss collect', () => bossWorld(2)],
    ['sniper', () => behaviourHarness('plane', 'sniper', 3).world],
  ] as const)('%s: the same input gives the same hash with the drawing and the near-miss bus mounted', (_name, make) => {
    const world = make();
    const run = runBot(world, ARCADE_LIBRARY);
    const plain = playByClock(world, run.inputs, false);
    const watched = playByClock(world, run.inputs, true);
    // Kresba opravdu kreslila – jinak by rovnost hashů nic nedokazovala.
    expect(watched.cues).toBeGreaterThan(0);
    expect(watched.hash).toBe(plain.hash);
    expect(watched.tick).toBe(plain.tick);
    expect(plain.hash).toBe(run.hash);
  }, SLOW);
});
