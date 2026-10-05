/**
 * Útěk a sběr (P32E T1): férový start a hratelnost z konstrukce.
 *
 * 29. 9. čaroděj prohrál za 3,2 s a v UI auditu pes chytil lišku za 3,5 s dřív,
 * než hráč pochopil ovládání. Nefér start vypadá jako těžká hra, takže ho
 * hlídá tenhle test: nečinného hráče první pronásledovatel nedostihne dřív
 * než za 5 s, na 200 semínkách a i s nejrychlejšími pronásledovateli.
 */

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';
import { createCompileRng } from '@/play/compile/rng';
import { type GenreSpec } from '@/play/genre/contract';
import { compileGenre } from '@/play/genre/index';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

import arenaFixture from '../__fixtures__/arena.json';
import { arcadeWorldOf, compileArcade } from '../compile';
import { ARCADE_HZ, type ArcadeEffect, type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, type ModeGeneratorPiece, NO_INPUT, ROLE, bodyBase } from '../contract';
import { buildWorld, instantiate, loadProgram, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { ARENA, ESCAPE, arenaCollect, arenaEscape, checkEscapeLevel } from '../pieces/arena';
import { runBot } from '../verify';

/** 200 semínek z `pure-rand` (přes `createCompileRng`, jedinou povolenou cestu). */
const SEEDS = (() => {
  const rng = createCompileRng(20_260_929);
  return Array.from({ length: 200 }, () => rng.int(1, 2 ** 31 - 2));
})();

function worldOf(mode: ModeGeneratorPiece, seed: number, raw: Record<string, unknown> = {}, health?: number): ArcadeWorld {
  const parts = mode.parts(seed, mode.params.parse(raw), health);
  if (parts.issues !== undefined && parts.issues.length > 0) throw new Error(`${mode.id}/${seed}: ${parts.issues.join('; ')}`);
  const lives = 'health' in parts ? parts.health : health;
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, ...(lives === undefined ? {} : { health: lives }) }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(`${mode.id}/${seed}: ${built.issues.join('; ')}`);
  return built.world;
}

const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Dotyk hráče s živým pronásledovatelem – týž průnik AABB jako jádro. */
function touching(state: Int32Array): boolean {
  const p = bodyBase(state[HEADER.player] as number);
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const b = bodyBase(i);
    if (state[b + BODY.role] !== ROLE.chaser || !alive(state, i)) continue;
    const dx = Math.abs((state[p + BODY.x] as number) - (state[b + BODY.x] as number)) * 2;
    const dz = Math.abs((state[p + BODY.z] as number) - (state[b + BODY.z] as number)) * 2;
    if (dx < (state[p + BODY.w] as number) + (state[b + BODY.w] as number) && dz < (state[p + BODY.d] as number) + (state[b + BODY.d] as number)) return true;
  }
  return false;
}

/** Tik prvního dotyku nečinného hráče, nebo −1 do horizontu. */
function idleContact(world: ArcadeWorld, horizon: number): { contact: number; outcome: number } {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  for (let tick = 0; tick < horizon && state[HEADER.runState] === 0; tick += 1) {
    step(state, NO_INPUT, program);
    if (touching(state)) return { contact: tick, outcome: state[HEADER.runState] as number };
  }
  return { contact: -1, outcome: state[HEADER.runState] as number };
}

const wins = (mode: ModeGeneratorPiece, raw: Record<string, unknown>): { won: number; lost: string[] } => {
  const lost: string[] = [];
  let won = 0;
  for (const seed of SEEDS) {
    const bot = runBot(worldOf(mode, seed, raw));
    if (bot.outcome === 'won') won += 1;
    else lost.push(`${seed}: ${bot.outcome} at ${bot.tick}`);
  }
  return { won, lost };
};

describe('arena escape – a fair start', () => {
  it.each([
    ['default', {}],
    ['four fastest chasers', { chasers: 4, chaserSpeed: ESCAPE.chaserSpeed.max }],
    ['items and three chasers', { items: 10, chasers: 3 }],
  ] as const)('%s: an idle player is first touched no sooner than 5 s, on 200 seeds', (_name, raw) => {
    for (const seed of SEEDS) {
      const { contact } = idleContact(worldOf(arenaEscape, seed, raw), ESCAPE.idleContactTicks + ARCADE_HZ);
      expect(contact === -1 || contact >= ESCAPE.idleContactTicks, `seed ${seed}: first contact at tick ${contact}`).toBe(true);
    }
  });

  it('chasers start behind the player (−z, away from the camera), at least 40 % of the arena radius off, inside the arena', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      for (const raw of [{}, { chasers: 4, chaserSpeed: ESCAPE.chaserSpeed.max }]) {
        const params = arenaEscape.params.parse(raw);
        const level = arenaEscape.generate(seed, params);
        expect(checkEscapeLevel(level, params), `seed ${seed}`).toEqual([]);
        const player = level.bodies[0]!;
        const chasers = level.bodies.filter((body) => body.role === 'chaser');
        expect(chasers).toHaveLength(params.chasers);
        for (const chaser of chasers) {
          expect(chaser.z).toBeLessThan(player.z);
          expect(Math.hypot(chaser.x - player.x, chaser.z - player.z)).toBeGreaterThanOrEqual((ARENA.half * ESCAPE.minDistancePct) / 100);
          expect(Math.abs(chaser.x) + chaser.w / 2).toBeLessThanOrEqual(ARENA.half);
          expect(Math.abs(chaser.z) + chaser.d / 2).toBeLessThanOrEqual(ARENA.half);
        }
      }
    }
  });

  it('the check catches a chaser placed next to the player', () => {
    const params = arenaEscape.params.parse({});
    const level = arenaEscape.generate(7, params);
    const near = { ...level, bodies: level.bodies.map((body) => (body.role === 'chaser' ? { ...body, x: 0, z: -3000 } : body)) };
    expect(checkEscapeLevel(near, params).join(' ')).toMatch(/chaser/);
  });

  it('chasers stand through the 2 s grace, then wake with a spawn effect where they stood', () => {
    const world = worldOf(arenaEscape, SEEDS[0]!, { chasers: 3 });
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const sleepers = [...Array(state[HEADER.bodyCount] as number).keys()].filter((i) => state[bodyBase(i) + BODY.role] === ROLE.chaser);
    expect(sleepers).toHaveLength(3);
    const at = sleepers.map((i) => [state[bodyBase(i) + BODY.x], state[bodyBase(i) + BODY.z]]);
    const effects: ArcadeEffect[][] = [];
    for (let tick = 0; tick < ESCAPE.graceTicks + 10; tick += 1) effects.push([...step(state, NO_INPUT, program)]);
    const wakeTick = effects.findIndex((list) => list.some((effect) => effect.kind === 'spawn'));
    expect(wakeTick).toBe(ESCAPE.graceTicks - 1);
    const spawns = effects[wakeTick]!.filter((effect) => effect.kind === 'spawn');
    expect(spawns.map((effect) => [effect.x, effect.z])).toEqual(at);
    // Spící zmizeli, jejich kopie stojí od `spawnBase` a honí.
    for (const i of sleepers) expect(alive(state, i)).toBe(false);
    const awake = [...Array(state[HEADER.bodyCount] as number).keys()].filter((i) => i >= (state[HEADER.spawnBase] as number) && alive(state, i));
    expect(awake).toHaveLength(3);
    const moved = awake.some((i) => state[bodyBase(i) + BODY.vx] !== 0 || state[bodyBase(i) + BODY.vz] !== 0);
    expect(moved).toBe(true);
  });

  it('an idle player is caught in the end, so survival never plays itself', () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const { contact, outcome } = idleContact(worldOf(arenaEscape, seed), 40 * ARCADE_HZ);
      expect(contact, `seed ${seed}`).toBeGreaterThan(0);
      expect(outcome, `seed ${seed}`).toBe(2);
    }
  });

  it('with lives a catch costs one life and buys 2 s of grace; the last life loses', () => {
    const world = worldOf(arenaEscape, SEEDS[1]!, { chasers: 1 }, 2);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const health = (): number => state[HEADER.counters + COUNTER.health] as number;
    let tick = 0;
    while (health() === 2 && tick < 40 * ARCADE_HZ) {
      step(state, NO_INPUT, program);
      tick += 1;
    }
    const caught = tick;
    expect(health()).toBe(1);
    expect(state[HEADER.runState]).toBe(0);
    // Ochrana: celé 2 s se nic dalšího nestane, i když pronásledovatel stojí na hráči.
    for (let t = 0; t < ESCAPE.graceTicks - 2; t += 1, tick += 1) step(state, NO_INPUT, program);
    expect(health()).toBe(1);
    while (state[HEADER.runState] === 0 && tick < 40 * ARCADE_HZ) {
      step(state, NO_INPUT, program);
      tick += 1;
    }
    expect(health()).toBe(0);
    expect(state[HEADER.runState]).toBe(2);
    expect(tick - caught).toBeGreaterThanOrEqual(ESCAPE.graceTicks);
  });
});

/** 200 celých her robota: přežití 40 s trvá samo ~15 s, pod plnou sadou víc. */
const BOT_RUNS_MS = 120_000;

describe('arena escape and collect – the bot wins', () => {
  it('escape by collecting 8 items: the bot wins at least 95 % of 200 seeds', { timeout: BOT_RUNS_MS }, () => {
    const { won, lost } = wins(arenaEscape, { items: 8 });
    expect(won, lost.slice(0, 10).join('; ')).toBeGreaterThanOrEqual(190);
  });

  it('escape with items is won by the item that reaches the target, long before the survival clock', () => {
    // Útěk s věcmi by vyhrál i přežitím – robot přežije 40 s taky. Výhra tedy musí padnout přesně na tiku N-té věci.
    for (const seed of SEEDS.slice(0, 20)) {
      const world = worldOf(arenaEscape, seed, { items: 8 });
      const bot = runBot(world);
      expect(bot.outcome, `seed ${seed}`).toBe('won');
      const program = loadProgram(world, ARCADE_LIBRARY);
      const state = instantiate(world);
      const score = (): number => state[HEADER.counters + COUNTER.score] as number;
      let next = 0;
      let before = 0;
      for (let tick = 0; state[HEADER.runState] === 0; tick += 1) {
        while (next < bot.inputs.length && bot.inputs[next]!.tick < tick) next += 1;
        const event = bot.inputs[next];
        before = score();
        step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
      }
      expect(state[HEADER.runState], `seed ${seed}`).toBe(1);
      expect([before, score()], `seed ${seed}: score before and after the winning tick`).toEqual([7, 8]);
      expect(state[HEADER.tick] as number, `seed ${seed}`).toBeLessThan(arenaEscape.params.parse({}).seconds * ARCADE_HZ);
    }
  });

  it('escape by surviving 40 s: the bot wins at least 95 % of 200 seeds', { timeout: BOT_RUNS_MS }, () => {
    const { won, lost } = wins(arenaEscape, { seconds: 40 });
    expect(won, lost.slice(0, 10).join('; ')).toBeGreaterThanOrEqual(190);
  });

  it('collect 10 items without chasers: the bot wins at least 95 % of 200 seeds', { timeout: BOT_RUNS_MS }, () => {
    const { won, lost } = wins(arenaCollect, { items: 10 });
    expect(won, lost.slice(0, 10).join('; ')).toBeGreaterThanOrEqual(190);
  });

  it('collect has no chasers, and its items all sit inside the arena, clear of the start', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const params = arenaCollect.params.parse({ items: 12 });
      const level = arenaCollect.generate(seed, params);
      expect(level.bodies.some((body) => body.role === 'chaser')).toBe(false);
      const items = level.bodies.filter((body) => body.role === 'collectible');
      expect(items.length).toBeGreaterThanOrEqual(12);
      for (const item of items) {
        expect(Math.abs(item.x) + item.w / 2, `seed ${seed}`).toBeLessThan(ARENA.half);
        expect(Math.abs(item.z) + item.d / 2, `seed ${seed}`).toBeLessThan(ARENA.half);
        expect(Math.hypot(item.x, item.z), `seed ${seed}`).toBeGreaterThanOrEqual(ESCAPE.itemClearance.start);
      }
    }
  });

  it('an escape spec delegated through readGameSpec compiles, the bot wins and an idle player loses', () => {
    const sample: GenreSpec = { genre: 'arena', mode: 'escape', hero: 'cat', enemy: 'polar bear', collectible: 'glowing fish', setting: 'frozen lake' };
    const base = compileGenre(sample);
    const read = readGameSpec({ ...base, controlParams: { ...base.controlParams, generator: 'arena_escape', tuning: { chasers: 2 } } });
    if (!read.ok) throw new Error(read.issues.join('; '));
    const compiled = compileArcade(read.value as GameSpecV1, 1);
    expect(compiled.ok ? 'ok' : compiled.issues.join('; ')).toBe('ok');
  });
});

describe('arena – saved agar games do not move', () => {
  const agar = (extra: Record<string, unknown>): GameSpecV1 => {
    const read = readGameSpec({ ...(arenaFixture as object), ...extra });
    if (!read.ok) throw new Error(read.issues.join('; '));
    return read.value;
  };
  const noTimer = (arenaFixture as { mechanics: { id: string }[] }).mechanics.filter((mechanic) => mechanic.id !== 'timer');
  // Otisky z `features/p32` @ 5b23a253, před P32E: [svět, konec robotova běhu, tik výhry].
  it.each([
    ['agar', {}, [['7d6a7083', '5e5e5084', 86], ['6d5882ce', '3b7941bb', 125], ['5e0870c5', 'fbebe940', 135]]],
    ['agar + chaser', { addons: ['chaser'] }, [['caefe3ed', 'b3599cbc', 86], ['919cb790', '00187b63', 125], ['c6448633', 'feff3efa', 135]]],
    ['agar + lives', { mechanics: [...noTimer, { id: 'health', params: { max: 3 } }] }, [['f7dd205f', '2df5320b', 86], ['4eab798a', '4f9ffb64', 125], ['14f80ab9', 'd6cee923', 135]]],
  ] as const)('%s: world hash and bot run unchanged on seeds 1–3', (_name, extra, pins) => {
    const spec = agar(extra);
    pins.forEach(([world, run, tick], index) => {
      const made = arcadeWorldOf(spec, index + 1);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const bot = runBot(made.world);
      expect([canonicalHash(made.world), bot.hash, bot.tick]).toEqual([world, run, tick]);
    });
  });
});
