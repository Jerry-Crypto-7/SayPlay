/**
 * Aréna ve vlnách (P36A T4, část 2): sběr, útěk i souboj trvají perfektnímu
 * robotovi 30–90 s, delší obsah věty („collect 20 batteries“ proti „collect 3
 * batteries“, „three robots“ proti „a robot“) dá delší běh, každá další vlna je
 * těžší než předchozí a nečinný hráč prohraje i ve sběru.
 *
 * Co by vypadalo dobře a bylo špatně: vlny existují, ale robot je projde za
 * pár sekund (útěk „collect three keys“ za 3 s); každá věta trvá stejně dlouho
 * (počet z věty se zahodí); další vlna je jen „další“, ne těžší; sběr nemá čím
 * prohrát, takže nečinný hráč stojí do konce horizontu. A uložená hra bez vln
 * by se po změně přehrála jinak. Hra se staví stejnou cestou jako z `/play` –
 * rychlý návrh, semínka publikace, robot a nečinný hráč.
 */

import { describe, expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { compileArcade } from '@/play/arcade/compile';
import { ARCADE_HZ, type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, NO_INPUT, ROLE, bodyBase, bodyHp } from '@/play/arcade/contract';
import { instantiate, loadProgram, replay, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { runBot } from '@/play/arcade/verify';
import { draftGameSpecWithMeta, draftGenreFor } from '@/play/draft';
import { classifyGenre } from '@/play/genre/classify';
import { compileGenre } from '@/play/genre';
import type { GameSpecV1 } from '@/play/spec';

interface Published {
  readonly mode: string;
  readonly spec: GameSpecV1;
  readonly seed: number;
  readonly world: ArcadeWorld;
  readonly winSeconds: number;
  readonly idle: { readonly outcome: string; readonly seconds: number };
}

/** Jako dveře publikace: první semínko, na kterém robot vyhraje a nečinný hráč ne. */
function publish(sentence: string, edit: (spec: GameSpecV1) => GameSpecV1 = (spec) => spec): Published {
  const spec = edit(legacySpec(sentence));
  for (const seed of derivedSeeds(seedFrom(sentence))) {
    const compiled = compileArcade(spec, seed);
    if (!compiled.ok) continue;
    const { arcade: world, winsAtTick } = compiled.value;
    if (world == null || winsAtTick === null) continue;
    const idle = replay(world, [], ARCADE_LIBRARY);
    return { mode: `${spec.genre?.id ?? ''}.${spec.genre?.mode ?? ''}`, spec, seed, world, winSeconds: winsAtTick / ARCADE_HZ, idle: { outcome: idle.outcome, seconds: idle.tick / ARCADE_HZ } };
  }
  throw new Error(`${sentence}: no seed publishes`);
}

/** Číslo vlny ve stavu: pořadí běžící vlny (0 = první); stav je hashovaný, takže i vlna. */
const WAVE_SLOT = HEADER.counters + COUNTER.ammo;

interface Wave {
  /** Kolik nebezpečí na začátku vlny stojí: pronásledovatelé, nebo soupeři s HP. */
  readonly threats: number;
  /** Součet HP soupeřů na začátku vlny (souboj), s bossem vlny (P45C T12). */
  readonly hp: number;
  /** Nejvyšší rychlost pronásledovatele během vlny (jednotek za tik). */
  readonly speed: number;
  /** Ve vlně přišel boss (finále P45C T12: tělo nebezpečí s HP). */
  readonly boss: boolean;
}

/**
 * Přehraje robotův záznam a pro každou vlnu zapíše, co hráči hrozí. Boss
 * finále (P45C T12) přijde tik po začátku vlny (průběh čte vlnu až v dalším
 * tiku), proto se HP vlny bere jako nejvyšší součet za její první půlsekundu.
 */
function wavesOf(world: ArcadeWorld): Wave[] {
  const inputs = runBot(world).inputs;
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const waves: { threats: number; hp: number; speed: number; boss: boolean }[] = [];
  let next = 0;
  let wave = -1;
  let since = 0;
  for (let tick = 0; tick < 90 * ARCADE_HZ && state[HEADER.runState] === 0; tick += 1) {
    while (next < inputs.length && inputs[next]!.tick < tick) next += 1;
    const event = inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
    const at = state[WAVE_SLOT] as number;
    const count = state[HEADER.bodyCount] as number;
    if (at !== wave) {
      wave = at;
      since = tick;
      let threats = 0;
      for (let i = 0; i < count; i += 1) {
        const base = bodyBase(i);
        if (((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
        if (state[base + BODY.role] === ROLE.chaser) threats += 1;
        if (state[base + BODY.role] === ROLE.enemy && bodyHp(state, i) > 0) threats += 1;
      }
      waves.push({ threats, hp: 0, speed: 0, boss: false });
    }
    const current = waves[waves.length - 1]!;
    let hp = 0;
    for (let i = 0; i < count; i += 1) {
      const base = bodyBase(i);
      if (((state[base + BODY.flags] as number) & FLAG.alive) === 0 || bodyHp(state, i) === 0) continue;
      if (state[base + BODY.role] === ROLE.enemy) hp += bodyHp(state, i);
      if (state[base + BODY.role] === ROLE.hazard) {
        hp += bodyHp(state, i);
        current.boss = true;
      }
    }
    if (tick - since < ARCADE_HZ / 2) current.hp = Math.max(current.hp, hp);
    for (let i = 0; i < count; i += 1) {
      const base = bodyBase(i);
      if (state[base + BODY.role] !== ROLE.chaser || ((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
      current.speed = Math.max(current.speed, Math.hypot(state[base + BODY.vx] as number, state[base + BODY.vz] as number));
    }
  }
  return waves;
}

const PAIRS = [
  ['arena.collect', 'a robot collects 3 batteries on Mars', 'a robot collects 20 batteries on Mars'],
  ['arena.escape', 'A knight must collect three keys in a haunted castle while dodging ghosts.', 'A knight must collect 20 keys in a haunted castle while dodging ghosts.'],
  ['arena.escape', 'escape from one ghost in a haunted house', 'escape from 4 ghosts in a haunted house'],
  ['arena.fight', 'a ninja fights a robot on a rooftop', 'a ninja fights three robots on a rooftop'],
] as const;

describe('arena waves (P36A T4)', () => {
  it.each(PAIRS)('%s: „%s“ and „%s“ – the robot wins both in 30–90 s, the longer content runs longer and a player who does nothing loses', (mode, short, long) => {
    const a = publish(short);
    const b = publish(long);
    for (const run of [a, b]) {
      expect(run.mode).toBe(mode);
      expect(run.winSeconds).toBeGreaterThanOrEqual(30);
      expect(run.winSeconds).toBeLessThanOrEqual(90);
      expect(run.idle.outcome).toBe('lost');
    }
    // Odchylka P45C T12: v útěku s věcmi nese poslední vlnu boss a lovci s ním odejdou (boss s lovcem robot
    // nepřemohl), zbytek poslední vlny robot posbírá bez nich – dvě vlny po 20 klíčích pak trvají jako čtyři
    // po třech (53,8 / 53,9 s). Délku podle obsahu u nich dál dává plán vln, který průběh nemění: táž věta
    // uložená před průběhem (`genre.v1`).
    const finale = mode === 'arena.escape' && [a, b].some((run) => run.world.rules.some((rule) => rule.id === 'boss_beat'));
    const stored = (spec: GameSpecV1): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v1' } });
    const [x, y] = finale ? [publish(short, stored), publish(long, stored)] : [a, b];
    expect(y.winSeconds, `${String(x.winSeconds)} s vs ${String(y.winSeconds)} s`).toBeGreaterThan(x.winSeconds + 5);
  });

  it.each([
    ['a robot collects 3 batteries on Mars'],
    ['A knight must collect three keys in a haunted castle while dodging ghosts.'],
    ['escape from one ghost in a haunted house'],
  ])('„%s“: every next wave sends more chasers or faster ones', (sentence) => {
    const { world } = publish(sentence);
    const waves = wavesOf(world);
    // Hra s věcmi má od P45C T12 finále: poslední vlnu nese boss a pronásledovatelé s ním odejdou
    // (boss s pronásledovatelem robot nepřemohl) – stupňování té vlny je boss, ne další pronásledovatel.
    const finale = world.rules.some((rule) => rule.id === 'boss_beat');
    expect(waves.length, JSON.stringify(waves)).toBeGreaterThanOrEqual(3);
    for (let k = 1; k < waves.length; k += 1) {
      const [before, now] = [waves[k - 1]!, waves[k]!];
      if (finale && k === waves.length - 1) {
        expect(now.boss, `wave ${String(k + 1)} brings the boss: ${JSON.stringify(waves)}`).toBe(true);
        expect(waves.slice(0, -1).some((wave) => wave.boss), JSON.stringify(waves)).toBe(false);
        continue;
      }
      expect(now.threats, `wave ${String(k + 1)}: ${JSON.stringify(waves)}`).toBeGreaterThanOrEqual(before.threats);
      expect(now.threats > before.threats || now.speed > before.speed, `wave ${String(k + 1)}: ${JSON.stringify(waves)}`).toBe(true);
    }
  });

  it('a fight comes in waves, every next one with more HP to knock out', () => {
    // Od P45C T12 je poslední vlnou boss: jeho HP se počítá k těm, které je třeba vyřadit (`fight_end` na něj čeká).
    const waves = wavesOf(publish('a ninja fights a robot on a rooftop').world);
    expect(waves.length, JSON.stringify(waves)).toBeGreaterThanOrEqual(3);
    for (let k = 1; k < waves.length; k += 1) expect(waves[k]!.hp, JSON.stringify(waves)).toBeGreaterThan(waves[k - 1]!.hp);
    expect(waves.at(-1)!.boss, JSON.stringify(waves)).toBe(true);
  });

  it('the robot wins a collecting game on almost every seed – remix checks a chip on one seed only', () => {
    // Věc uprostřed arény robot (i hráč) před pronásledovatelem nesebere, krouží do konce hodin.
    const { spec } = draftGameSpecWithMeta('Collect five glowing mushrooms in a moonlit forest', 1);
    const lost: number[] = [];
    for (let seed = 1; seed <= 40; seed += 1) {
      const compiled = compileArcade(spec, seed * 7919);
      if (!compiled.ok || compiled.value.winsAtTick === null) lost.push(seed);
    }
    expect(lost).toEqual([]);
  }, 60_000);

  it('a collecting game has no chaser in its first wave and a clock the robot beats with room to spare', () => {
    const run = publish('a robot collects 3 batteries on Mars');
    expect(wavesOf(run.world)[0]?.threats).toBe(0);
    const clock = run.world.rules.find((rule) => rule.id === 'time_limit')?.params.seconds as number | undefined;
    expect(clock).toBeDefined();
    expect(clock!).toBeLessThanOrEqual(88);
    expect(clock! - run.winSeconds).toBeGreaterThanOrEqual(15);
    // Hodiny dojdou na posledním tiku limitu, prohra se zapíše o tik později. Od P45C T12 roste
    // tlak i nečinnému hráči (postup má spodní mez v uběhlém čase): nová chování ho můžou dostat dřív.
    expect(run.idle.outcome).toBe('lost');
    expect(run.idle.seconds).toBeLessThanOrEqual(clock! + 0.05);
  });
});

/**
 * Uložená hra bez `waves` (spec z doby před P36A T4 část 2) staví tentýž svět:
 * čísla změřená na `play-compiler-v7` – semínko publikace, tik výhry robota a
 * kanonický hash světa.
 */
const STORED = [
  ['a robot collects batteries on Mars', 177461931, 503, '49896096'],
  ['A knight must collect three keys in a haunted castle while dodging ghosts.', 1291481298, 184, '1c64c68f'],
  ['A hamster escaping a supermarket while a giant Roomba hunts me', 1924202525, 2400, 'a51475ae'],
  ['boxing a kangaroo in the australian outback', 727311170, 89, '2848c446'],
] as const;

describe('stored arena games without waves', () => {
  it.each(STORED)('„%s“ keeps its old world and win tick', (sentence, seed, ticks, hash) => {
    // Uložená hra neměla ani `scoring` (T5).
    const { scoring: _scoring, ...spec } = legacySpec(sentence);
    const { tuning, ...own } = spec.controlParams as Record<string, unknown> & { readonly tuning: Record<string, unknown> };
    const { waves: _waves, ...old } = tuning;
    // Uložená hra je `genre.v2`, bez power-upů (P46C).
    const compiled = compileArcade({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v2' }, controlParams: { ...own, tuning: old } as GameSpecV1['controlParams'] }, seed);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.winsAtTick).toBe(ticks);
    expect(compiled.value.worldHash).toBe(hash);
  });
});

/** Frozen pre-P41 mechanics: routing to new movement families is tested separately. */
function legacySpec(sentence: string): GameSpecV1 {
  const pick = classifyGenre(sentence, null).ranked[0];
  const genre = draftGenreFor(sentence, pick.genre, pick.mode);
  if (genre === null) throw new Error(`missing legacy fixture: ${sentence}`);
  return compileGenre(genre);
}
