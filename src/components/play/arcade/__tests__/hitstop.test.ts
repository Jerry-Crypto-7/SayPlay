/**
 * Hit-stop souboje (P32E T6) je jen v kresbě: 60 ms po zásahu stojí kreslené
 * polohy, jádro tiká dál. Co by vypadalo dobře a přitom bylo špatně: hit-stop,
 * který zastaví hodiny relace. Na obrazovce by vypadal stejně, ale každý stisk
 * po zásahu by padl do jiného tiku a záznam hráče by přehrání jádrem dalo jiný
 * hash. Tenhle test hraje týž záznam podle hodin (stisk v čase svého tiku)
 * jednou s hlídkou zásahů a hit-stopem a jednou bez nich a porovná hash.
 */

import { describe, expect, it } from 'vitest';

import { type ArcadeWorld, HEADER, type InputEvent, bodyHp } from '@/play/arcade/contract';
import { buildWorld, hashArcade } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { fightArena } from '@/play/arcade/pieces/fight';
import { runBot } from '@/play/arcade/verify';

import { type FightWatch, HIT_STOP_MS, advanceFrame, createFightWatch } from '../arena/FightFx';
import { TICK_MS, createArcadeSession } from '../session';

function fightWorld(seed: number): ArcadeWorld {
  const parts = fightArena.parts(seed, fightArena.params.parse({}), undefined);
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

interface ClockRun {
  readonly hash: string;
  readonly runState: string;
  readonly tick: number;
  /** Snímky, které hit-stop držel celé (váha 1). */
  readonly held: number;
  readonly hits: number;
}

/**
 * Záznam „rukou“ podle hodin: vstup tiku `t` hráč stiskne v čase `t · TICK_MS`,
 * snímek trvá jeden tik – bez hit-stopu tedy každý stisk padne přesně do svého tiku.
 */
function playByClock(world: ArcadeWorld, inputs: readonly InputEvent[], watch: FightWatch | null): ClockRun {
  const session = createArcadeSession(world);
  const byTick = new Map(inputs.map((event) => [event.tick, event]));
  const last = inputs.reduce((most, event) => Math.max(most, event.tick), 0);
  let held = 0;
  for (let frame = 0; frame <= last + 600 && session.snapshot().runState === 'running'; frame += 1) {
    const now = frame * TICK_MS;
    const event = byTick.get(frame);
    session.hold(event?.axis ?? 0);
    session.press(event?.buttons ?? 0);
    advanceFrame(session, watch, TICK_MS, now);
    if (watch !== null && watch.hold(now) === 1) held += 1;
  }
  const end = session.snapshot();
  return { hash: hashArcade(session.state()), runState: end.runState, tick: end.tick, held, hits: watch?.hits() ?? 0 };
}

describe('fight hit-stop lives only in the drawing', () => {
  it.each([1, 7, 20_260_930])('seed %i: the same clock-timed input gives the same hash with the visual hit-stop and without it', (seed) => {
    const world = fightWorld(seed);
    const bot = runBot(world);
    const plain = playByClock(world, bot.inputs, null);
    const watched = playByClock(world, bot.inputs, createFightWatch());
    // Hlídka opravdu zasahy viděla a kresbu držela – jinak by rovnost hashů nic nedokazovala.
    expect(watched.hits).toBeGreaterThanOrEqual(1);
    expect(watched.held).toBeGreaterThanOrEqual(Math.floor(HIT_STOP_MS / TICK_MS));
    expect(watched.hash).toBe(plain.hash);
    expect(watched.tick).toBe(plain.tick);
    // A oba běhy jsou záznam robota, jak ho ověřovač publikoval.
    expect(plain.runState).toBe(bot.outcome);
    expect(plain.hash).toBe(bot.hash);
  });

  it('holds the drawing for 60 ms after a hit, then lets go', () => {
    const world = fightWorld(1);
    const session = createArcadeSession(world);
    const watch = createFightWatch();
    const inputs = new Map(runBot(world).inputs.map((event) => [event.tick, event]));
    let frame = 0;
    const hpOf = (): number[] => {
      const state = session.state();
      return Array.from({ length: state[HEADER.bodyCount] as number }, (_, body) => bodyHp(state, body));
    };
    let before = hpOf();
    // Do prvního zásahu podle záznamu robota.
    for (; frame < 3000 && watch.hits() === 0; frame += 1) {
      before = hpOf();
      const event = inputs.get(frame);
      session.hold(event?.axis ?? 0);
      session.press(event?.buttons ?? 0);
      advanceFrame(session, watch, TICK_MS, frame * TICK_MS);
    }
    expect(watch.hits()).toBe(1);
    expect(hpOf().some((hp, body) => hp < (before[body] as number))).toBe(true);
    const hitAt = watch.lastHit();
    expect(watch.hold(hitAt)).toBe(1);
    expect(watch.hold(hitAt + HIT_STOP_MS - 1)).toBe(1);
    expect(watch.hold(hitAt + HIT_STOP_MS + 30)).toBeGreaterThan(0);
    expect(watch.hold(hitAt + HIT_STOP_MS + 30)).toBeLessThan(1);
    expect(watch.hold(hitAt + 1000)).toBe(0);
  });
});
