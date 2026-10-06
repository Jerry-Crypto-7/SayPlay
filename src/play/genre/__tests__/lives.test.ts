/**
 * Tři životy s vteřinou milosti v každém žánru (P36A T2).
 *
 * Co by vypadalo dobře a bylo špatně: HUD ukáže tři srdce, ale první náraz
 * hru ukončí; jeden dlouhý kontakt (běžec v překážce, hráč v pronásledovateli)
 * vezme všechny tři životy během pár tiků; skákačka po hrotu pokračuje dál,
 * jako by se nic nestalo. Proto se tu zásahy vynucují přímo ve stavu jádra
 * (hráč postavený na překážku) a počítají se životy, stav běhu a poloha:
 * dva zásahy → hra běží s jedním životem, třetí → `lost`, zásah v milosti
 * nebere nic. Číslo z věty („with 5 lives“) musí dojít až do čítače jádra.
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import {
  type ArcadeState,
  type ArcadeWorld,
  BODY,
  COUNTER,
  FLAG,
  HEADER,
  HIT_GRACE,
  NO_INPUT,
  ROLE,
  RUN_STATE,
  START_LIVES,
  bodyBase,
  bodyHp,
  graceOf,
  setBodyHp,
} from '@/play/arcade/contract';
import { type ArcadeProgram, buildWorld, instantiate, loadProgram, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { graceLeft } from '@/play/arcade/pieces/arena';
import { FIGHT, FIGHT_PHASE } from '@/play/arcade/pieces/fight';
import { readsMechanic, unreadItems } from '@/play/capabilities';
import { draftGameSpecWithMeta } from '@/play/draft';
import { SENTENCE_LIVES, readLives } from '@/play/draft/lexicon';
import { MECHANICS } from '@/play/registry';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

import type { GenreSpec } from '../contract';
import { compileGenre } from '../index';

const SPECS = {
  runner: { genre: 'runner', mode: 'default', hero: 'penguin', cast: [{ label: 'rock', does: 'avoid' }, { label: 'snowflake', does: 'collect' }], setting: 'icy mountain' },
  platformer: { genre: 'platformer', mode: 'default', hero: 'frog', setting: 'pond' },
  'arena.escape': { genre: 'arena', mode: 'escape', hero: 'cat', cast: [{ label: 'polar bear', does: 'chase_me' }, { label: 'fish', does: 'collect' }], setting: 'frozen lake' },
  'arena.collect': { genre: 'arena', mode: 'collect', hero: 'cat', cast: [{ label: 'fish', does: 'collect' }], setting: 'beach' },
  'arena.fight': { genre: 'arena', mode: 'fight', hero: 'knight', setting: 'castle' },
  'quest.spatial': { genre: 'quest', mode: 'spatial', hero: 'wizard', cast: [{ label: 'ghost', does: 'chase_me' }, { label: 'candle', does: 'reach', verb: 'light', states: 2 }], setting: 'castle', params: { chasers: 2 } },
  'quest.station': { genre: 'quest', mode: 'station', hero: 'chef', cast: [{ label: 'pancake', does: 'reach', verb: 'cook', states: 3 }], setting: 'kitchen' },
  'voyage.race': { genre: 'voyage', mode: 'race', hero: 'pirate ship', setting: 'ocean' },
  'voyage.land': { genre: 'voyage', mode: 'land', hero: 'rocket', setting: 'mars' },
} as const satisfies Readonly<Record<string, GenreSpec>>;

interface Game {
  readonly world: ArcadeWorld;
  readonly state: ArcadeState;
  readonly program: ArcadeProgram;
}

function specOf(genre: GenreSpec): GameSpecV1 {
  const read = readGameSpec(compileGenre(genre));
  if (!read.ok) throw new Error(`${read.reason}: ${read.issues.join('; ')}`);
  return read.value;
}

/** Svět z prvního semínka, na kterém se postaví (generátor smí semínko odmítnout). */
function worldOf(spec: GameSpecV1): ArcadeWorld {
  for (let seed = 1; seed <= 20; seed += 1) {
    const made = arcadeWorldOf(spec, seed);
    if (made.ok) return made.world;
  }
  throw new Error(`no seed builds ${spec.title}`);
}

function gameOf(world: ArcadeWorld): Game {
  return { world, state: instantiate(world), program: loadProgram(world, ARCADE_LIBRARY) };
}

const game = (key: keyof typeof SPECS): Game => gameOf(worldOf(specOf(SPECS[key])));

const PLAYER = 0;
const P = bodyBase(PLAYER);
const tick = (g: Game): void => void step(g.state, NO_INPUT, g.program);
const lives = (g: Game): number => g.state[HEADER.counters + COUNTER.health] as number;
const runState = (g: Game): number => g.state[HEADER.runState] as number;
const aliveAt = (state: ArcadeState, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
const at = (state: ArcadeState, body: number, slot: keyof typeof BODY): number => state[bodyBase(body) + BODY[slot]] as number;

/** Živá těla role, seřazená po trati. */
function bodiesOf(g: Game, role: keyof typeof ROLE): number[] {
  const found: number[] = [];
  for (let i = 1; i < (g.state[HEADER.bodyCount] as number); i += 1) if (aliveAt(g.state, i) && g.state[bodyBase(i) + BODY.role] === ROLE[role]) found.push(i);
  return found.sort((a, b) => at(g.state, a, 'z') - at(g.state, b, 'z') || a - b);
}

/** Hráč stojí na místě `(x, y, z)` bez rychlosti. */
function place(g: Game, x: number, y: number, z: number): void {
  g.state[P + BODY.x] = x;
  g.state[P + BODY.y] = y;
  g.state[P + BODY.z] = z;
  g.state[P + BODY.vx] = 0;
  g.state[P + BODY.vy] = 0;
  g.state[P + BODY.vz] = 0;
}

/** Milost hráče doběhne; mezitím stojí na bezpečném místě `safe`. */
function waitOutGrace(g: Game, safe: () => void): void {
  for (let guard = 0; graceOf(g.state, PLAYER) > 0; guard += 1) {
    if (guard > HIT_GRACE) throw new Error('grace never ran out');
    safe();
    tick(g);
  }
}

describe('every genre mode starts with three lives', () => {
  it.each(Object.keys(SPECS) as (keyof typeof SPECS)[])('%s: the spec carries health 3 and the world counts 3 lives with a rule that ends on the last', (key) => {
    const spec = specOf(SPECS[key]);
    expect(spec.mechanics.filter((mechanic) => mechanic.id === 'health')).toEqual([{ id: 'health', params: { max: START_LIVES } }]);
    const world = worldOf(spec);
    expect(world.initial[HEADER.counters + COUNTER.health]).toBe(START_LIVES);
    expect(world.rules.some((rule) => rule.id === 'out_of_health')).toBe(true);
    // Kritik ani oprava režiséra životy nevyhodí jako mechaniku, kterou hra nehraje (plavba je `steer`).
    expect(unreadItems(spec).filter((item) => item.kind === 'mechanic')).toEqual([]);
  });

  it('only the voyage generators make steer read lives – the old steer race still does not', () => {
    expect(readsMechanic('steer', 'health')).toBe(false);
    expect(readsMechanic('steer', 'health', 'steer_track')).toBe(false);
    expect(readsMechanic('steer', 'health', 'voyage_race')).toBe(true);
    expect(readsMechanic('steer', 'health', 'voyage_land')).toBe(true);
    expect(readsMechanic('steer', 'health', 'constructor')).toBe(false);
  });
});

describe('runner – a crash costs a life and the run goes on', () => {
  const crashInto = (g: Game, obstacle: number): void => {
    const x = at(g.state, obstacle, 'x');
    place(g, x, 0, at(g.state, obstacle, 'z'));
    // Pruh ovládání = pruh překážky, ať ho běžec z ní hned nestáhne.
    g.state[P + BODY.aux0] = Math.round(x / 2000);
    tick(g);
  };
  const atStart = (g: Game) => () => {
    place(g, 0, 0, 0);
    g.state[P + BODY.aux0] = 0;
  };

  it('two crashes leave one life and a running game, a crash inside the grace second costs nothing, the third crash loses', () => {
    const g = game('runner');
    const [a, b, c, d] = bodiesOf(g, 'obstacle') as [number, number, number, number];
    crashInto(g, a);
    expect([lives(g), runState(g), aliveAt(g.state, a)]).toEqual([START_LIVES - 1, RUN_STATE.running, false]);
    expect(graceOf(g.state, PLAYER)).toBe(HIT_GRACE);
    // Běh pokračuje: další tiky jede hrdina dál po trati.
    const z = at(g.state, PLAYER, 'z');
    tick(g);
    expect(at(g.state, PLAYER, 'z')).toBeGreaterThan(z);
    // V milosti: náraz život nevezme.
    crashInto(g, b);
    expect([lives(g), runState(g)]).toEqual([START_LIVES - 1, RUN_STATE.running]);
    waitOutGrace(g, atStart(g));
    crashInto(g, c);
    expect([lives(g), runState(g)]).toEqual([1, RUN_STATE.running]);
    waitOutGrace(g, atStart(g));
    crashInto(g, d);
    expect([lives(g), runState(g)]).toEqual([0, RUN_STATE.lost]);
  });
});

describe('platformer – spikes cost a life and send the hero back to the checkpoint', () => {
  const onto = (g: Game, body: number): void => {
    place(g, 0, at(g.state, body, 'y'), at(g.state, body, 'z'));
    tick(g);
  };
  const home = (g: Game): [number, number, number] => [g.state[HEADER.respawnX] as number, g.state[HEADER.respawnY] as number, g.state[HEADER.respawnZ] as number];
  const position = (g: Game): [number, number, number] => [at(g.state, PLAYER, 'x'), at(g.state, PLAYER, 'y'), at(g.state, PLAYER, 'z')];

  it('two spikes leave one life, a spike inside the grace second is passed, the third spike loses', () => {
    const g = game('platformer');
    const spikes = bodiesOf(g, 'hazard');
    expect(spikes.length).toBeGreaterThanOrEqual(2);
    const [first, second] = spikes as [number, number];
    const start = home(g);
    onto(g, first);
    expect([lives(g), runState(g)]).toEqual([START_LIVES - 1, RUN_STATE.running]);
    expect(position(g)).toEqual(start);
    // Hrot zůstává – je to překážka, kterou jde příště přeskočit.
    expect(aliveAt(g.state, first)).toBe(true);
    // V milosti: hrotem projde, život ani návrat.
    onto(g, second);
    expect(lives(g)).toBe(START_LIVES - 1);
    expect(position(g)[2]).not.toBe(start[2]);
    const stand = () => place(g, ...start);
    waitOutGrace(g, stand);
    onto(g, second);
    expect([lives(g), runState(g)]).toEqual([1, RUN_STATE.running]);
    waitOutGrace(g, stand);
    onto(g, first);
    expect([lives(g), runState(g)]).toEqual([0, RUN_STATE.lost]);
  });

  it('after a checkpoint the spike sends the hero to the checkpoint, not to the start', () => {
    const g = game('platformer');
    const [checkpoint] = bodiesOf(g, 'checkpoint') as [number];
    const spike = bodiesOf(g, 'hazard').find((body) => at(g.state, body, 'z') > at(g.state, checkpoint, 'z')) as number;
    onto(g, checkpoint);
    const saved = home(g);
    expect(saved[2]).toBe(at(g.state, checkpoint, 'z'));
    onto(g, spike);
    expect(lives(g)).toBe(START_LIVES - 1);
    expect(position(g)).toEqual(saved);
  });
});

describe('arena and quest – a catch costs a life, throws the hero back and buys grace', () => {
  /** Chycení: hráč kousek vedle pronásledovatele, ať odhoz má směr (od pronásledovatele po +x). */
  const caughtBy = (g: Game, chaser: number): void => {
    place(g, at(g.state, chaser, 'x') + 300, 0, at(g.state, chaser, 'z'));
    tick(g);
  };
  const chasers = (g: Game): number[] => bodiesOf(g, 'chaser');
  /** Místo arény nejdál od pronásledovatelů a mimo pevná tělesa (kameny úkolu). */
  const safeSpot = (g: Game): [number, number] => {
    let best: [number, number] = [0, 0];
    let bestGap = -1;
    for (let x = -16_000; x <= 16_000; x += 4000) {
      for (let z = -16_000; z <= 16_000; z += 4000) {
        const blocked = [...Array(g.state[HEADER.bodyCount] as number).keys()].some(
          (i) => i !== PLAYER && aliveAt(g.state, i) && ((at(g.state, i, 'flags') & FLAG.solid) !== 0) && Math.abs(at(g.state, i, 'x') - x) < 2500 && Math.abs(at(g.state, i, 'z') - z) < 2500,
        );
        const gap = Math.min(...chasers(g).map((c) => Math.hypot(at(g.state, c, 'x') - x, at(g.state, c, 'z') - z)));
        if (!blocked && gap > bestGap) {
          best = [x, z];
          bestGap = gap;
        }
      }
    }
    return best;
  };
  /** Ochrana arény doběhne; hráč na ni čeká daleko od pronásledovatelů (v ochraně stojí). */
  const waitArenaGrace = (g: Game): void => {
    const [x, z] = safeSpot(g);
    place(g, x, 0, z);
    for (let guard = 0; graceLeft(g.state) > 0; guard += 1) {
      if (guard > 10 * HIT_GRACE) throw new Error('arena grace never ran out');
      tick(g);
    }
  };

  it.each(['arena.escape', 'quest.spatial'] as const)('%s: two catches leave one life, a touch inside the grace costs nothing, the third catch loses', (key) => {
    const g = game(key);
    waitArenaGrace(g);
    tick(g);
    caughtBy(g, chasers(g)[0] as number);
    expect([lives(g), runState(g)]).toEqual([START_LIVES - 1, RUN_STATE.running]);
    // Odhoz od pronásledovatele (stojí po −x od hráče).
    expect(at(g.state, PLAYER, 'vx')).toBeGreaterThan(0);
    expect(graceLeft(g.state)).toBeGreaterThan(0);
    caughtBy(g, chasers(g)[0] as number);
    expect(lives(g)).toBe(START_LIVES - 1);
    waitArenaGrace(g);
    caughtBy(g, chasers(g)[0] as number);
    expect([lives(g), runState(g)]).toEqual([1, RUN_STATE.running]);
    waitArenaGrace(g);
    caughtBy(g, chasers(g)[0] as number);
    expect([lives(g), runState(g)]).toEqual([0, RUN_STATE.lost]);
  });

  // Úkol na místě bere životy přetečením od T3 (`quest-danger.test.ts`); sběr v aréně čeká na vlny T4.
  it.each(['arena.collect'] as const)('%s: nothing in the mode takes a life yet (danger comes with T4) – the lives stay', (key) => {
    const g = game(key);
    for (let t = 0; t < 30 * 60 && runState(g) === RUN_STATE.running; t += 1) tick(g);
    expect(lives(g)).toBe(START_LIVES);
  });
});

describe('arena.fight – lives are knockouts', () => {
  /** Nepřítel 1 stojí 2 m před hráčem (+z) na konci telegrafu se směrem na hráče: úder dopadne v tomto tiku. */
  const strikeNow = (g: Game): void => {
    const e = bodyBase(1);
    g.state[e + BODY.x] = at(g.state, PLAYER, 'x');
    g.state[e + BODY.z] = at(g.state, PLAYER, 'z') + 2000;
    g.state[e + BODY.vx] = 0;
    g.state[e + BODY.vz] = 0;
    g.state[e + BODY.aux0] = FIGHT_PHASE.telegraph | (16 << 4);
    g.state[e + BODY.aux1] = 1;
    tick(g);
  };
  /** Poslední úder dopadl: HP hráče na nule, knockout soudí `fight_end` v příštím tiku. */
  const knockout = (g: Game): void => {
    setBodyHp(g.state, PLAYER, 0);
    tick(g);
  };
  const stay = () => undefined;

  it('two knockouts leave one life with full HP, a strike inside the grace takes no HP, the third knockout loses', () => {
    const g = game('arena.fight');
    const hp = bodyHp(g.state, PLAYER);
    expect(hp).toBe(FIGHT.playerHp.default);
    strikeNow(g);
    expect(bodyHp(g.state, PLAYER)).toBe(hp - 1);
    knockout(g);
    expect([lives(g), runState(g), bodyHp(g.state, PLAYER)]).toEqual([START_LIVES - 1, RUN_STATE.running, hp]);
    strikeNow(g);
    expect(bodyHp(g.state, PLAYER)).toBe(hp);
    waitOutGrace(g, stay);
    strikeNow(g);
    expect(bodyHp(g.state, PLAYER)).toBe(hp - 1);
    knockout(g);
    expect([lives(g), runState(g), bodyHp(g.state, PLAYER)]).toEqual([1, RUN_STATE.running, hp]);
    waitOutGrace(g, stay);
    knockout(g);
    expect([lives(g), runState(g)]).toEqual([0, RUN_STATE.lost]);
  });
});

describe('voyage – shots cost lives, a crashed landing starts again from the top', () => {
  it('voyage.race: two shots leave one life, a shot inside the grace passes, the third shot sinks the ship', () => {
    const g = game('voyage.race');
    const [a, b, c, d] = bodiesOf(g, 'hazard') as [number, number, number, number];
    const onto = (shot: number): void => {
      place(g, at(g.state, shot, 'x'), 0, at(g.state, shot, 'z'));
      tick(g);
    };
    const start = () => place(g, 0, 0, 0);
    onto(a);
    expect([lives(g), runState(g), aliveAt(g.state, a)]).toEqual([START_LIVES - 1, RUN_STATE.running, false]);
    onto(b);
    expect([lives(g), aliveAt(g.state, b)]).toEqual([START_LIVES - 1, true]);
    waitOutGrace(g, start);
    onto(c);
    expect([lives(g), runState(g)]).toEqual([1, RUN_STATE.running]);
    waitOutGrace(g, start);
    onto(d);
    expect([lives(g), runState(g)]).toEqual([0, RUN_STATE.lost]);
  });

  it('voyage.land: a crash costs a life and the craft starts again at the top; the third crash loses', () => {
    const g = game('voyage.land');
    const top = at(g.state, PLAYER, 'y');
    const crash = (): void => {
      const before = lives(g);
      for (let t = 0; t < 90 * 60 && lives(g) === before; t += 1) tick(g);
    };
    crash();
    expect([lives(g), runState(g), at(g.state, PLAYER, 'y')]).toEqual([START_LIVES - 1, RUN_STATE.running, top]);
    crash();
    expect([lives(g), runState(g)]).toEqual([1, RUN_STATE.running]);
    crash();
    expect([lives(g), runState(g)]).toEqual([0, RUN_STATE.lost]);
  });
});

describe('saved worlds keep their rules', () => {
  it('a world compiled before the grace (hit without grace) still loses a life on every contact', () => {
    const fresh = worldOf(specOf(SPECS.runner));
    const old = fresh.rules.map((rule) => (rule.id === 'hit' ? { id: 'hit', params: { role: 'obstacle', effect: 'damage' } } : rule));
    const g = gameOf({ ...fresh, rules: old });
    const [a, b] = bodiesOf(g, 'obstacle') as [number, number];
    for (const obstacle of [a, b]) {
      place(g, at(g.state, obstacle, 'x'), 0, at(g.state, obstacle, 'z'));
      g.state[P + BODY.aux0] = Math.round(at(g.state, obstacle, 'x') / 2000);
      tick(g);
    }
    expect(lives(g)).toBe(START_LIVES - 2);
    expect(graceOf(g.state, PLAYER)).toBe(0);
  });

  it('a damage effect without grace never starts a grace – an old world keeps the player flags it always had', () => {
    const built = buildWorld(
      {
        seed: 1,
        control: { id: 'runner', params: {} },
        rules: [{ id: 'hit', params: { role: 'obstacle', effect: 'damage' } }],
        bot: { id: 'runner_bot', params: {} },
        level: {
          bodies: [
            { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 600, h: 1600, d: 500, solid: false },
            { role: 'obstacle', kind: 'cone', x: 0, y: 0, z: 300, w: 900, h: 1500, d: 700, solid: true },
          ],
          length: 0,
        },
        health: 3,
      },
      ARCADE_LIBRARY,
    );
    if (!built.ok) throw new Error(built.issues.join('; '));
    const g = gameOf(built.world);
    tick(g);
    expect(lives(g)).toBe(2);
    expect(graceOf(g.state, PLAYER)).toBe(0);
  });
});

describe('the number of lives a sentence says', () => {
  it.each([
    ['a runner with 5 lives', 5],
    ['you have one life', 1],
    ['a frog with no lives left', 1],
    ['a cat with nine lives', 9],
    ['three hearts to reach the moon', 3],
    ['a tank with 2 extra lives', 2],
    ['a knight with 20 lives', SENTENCE_LIVES.max],
    ['a robot with 0 lives', SENTENCE_LIVES.min],
    ['a lively fox runs through the forest', null],
    ['a penguin slides down an icy mountain', null],
  ] as const)('%s → %s', (sentence, expected) => {
    expect(readLives(sentence)).toBe(expected);
  });

  it('the sentence bound is the bound of the health mechanic', () => {
    const params = MECHANICS.health.params;
    expect(params.safeParse({ max: SENTENCE_LIVES.max }).success).toBe(true);
    expect(params.safeParse({ max: SENTENCE_LIVES.max + 1 }).success).toBe(false);
    expect(params.safeParse({ max: SENTENCE_LIVES.min }).success).toBe(true);
    expect(params.safeParse({ max: SENTENCE_LIVES.min - 1 }).success).toBe(false);
  });

  it.each([
    ['A penguin slides down an icy mountain with 5 lives', 5],
    ['A fox jumps over spikes to reach the flag with one life', 1],
    ['Two knights fight in a castle and you have no lives', 1],
    ['A pirate ship sails between islands with seven lives', 7],
    ['A cat collects fish while a polar bear chases it', START_LIVES],
  ] as const)('the quick draft carries it into the game: %s → %s', (sentence, expected) => {
    const { spec, genre } = draftGameSpecWithMeta(sentence);
    expect(genre).not.toBeNull();
    expect(spec.mechanics.find((mechanic) => mechanic.id === 'health')?.params).toEqual({ max: expected });
    expect(worldOf(spec).initial[HEADER.counters + COUNTER.health]).toBe(expected);
  });
});
