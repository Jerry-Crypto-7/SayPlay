/**
 * Místní Dare round trip střelnice z očí (P68-F T3): záznam robota projde balením výzvy (`packInputs`), rozbalením
 * na hranici (`unpackInputs`) a přehráním, jak ho přehraje server (`scoredReplay`), se stejným hashem a výsledkem.
 * Střed se posílá osou 1 (osa 0 = žádný vstup) a balení ji nesmí ztratit; balík se vejde do stropu těla 64 kB
 * i u nejhoršího záznamu, který adaptér pošle (robot a k tomu tah prstem každý tik).
 */

import { describe, expect, it } from 'vitest';

import { RAILFPS_AXES } from '../../../genre/p68-contract';
import { packInputs, unpackInputs } from '../../../score/dare';
import { scoredReplay } from '../../../score/replay';
import { ARCADE_LIMITS, type ArcadeWorld, BUTTON, type InputEvent, START_LIVES } from '../../contract';
import { completeHooks } from '../../hooks';
import { buildWorld } from '../../kernel';
import { ARCADE_LIBRARY } from '../../library';
import { type BotRun, runBot } from '../../verify';
import { axisToSector, railfpsRail } from '../railfps';
import { traceRailfps } from '../railfps-trace';

const BODY_CAP = 64 * 1024;

function worldOf(seed: number, params: object = {}): ArcadeWorld {
  const parts = railfpsRail.parts(seed, railfpsRail.params.parse(params), undefined);
  if ((parts.issues ?? []).length > 0) throw new Error((parts.issues ?? []).join('; '));
  const built = buildWorld({ seed, control: parts.control, rules: completeHooks(parts.rules), bot: parts.bot, level: parts.level, health: parts.health ?? START_LIVES }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Balení a rozbalení jako cesta výzvy (klient → JSON → route). */
function roundTrip(inputs: readonly InputEvent[]): InputEvent[] {
  const unpacked = unpackInputs(JSON.parse(JSON.stringify(packInputs(inputs))) as unknown);
  if (typeof unpacked === 'string') throw new Error(unpacked);
  return unpacked;
}

let runs: readonly { readonly seed: number; readonly world: ArcadeWorld; readonly bot: BotRun }[] | undefined;
/** Robot na výchozích mezích, tři semínka, přes `runBot` jako publikační brána. */
const botRuns = (): NonNullable<typeof runs> =>
  (runs ??= [1, 2, 3].map((seed) => {
    const world = worldOf(seed);
    return { seed, world, bot: runBot(world, ARCADE_LIBRARY) };
  }));

describe('railfps Dare round trip (P68-F T3)', () => {
  it('the bot record survives packInputs → unpackInputs and replays to the same hash and result', () => {
    for (const { seed, world, bot } of botRuns()) {
      expect(bot.outcome, `seed ${String(seed)}`).toBe('won');
      const back = roundTrip(bot.inputs);
      expect(back, `seed ${String(seed)}`).toEqual(bot.inputs);
      const server = scoredReplay(world, back, []);
      expect(server.hash, `seed ${String(seed)}`).toBe(bot.hash);
      expect(server.outcome, `seed ${String(seed)}`).toBe('won');
      expect(server.tick, `seed ${String(seed)}`).toBe(bot.tick);
      expect(server.score, `seed ${String(seed)}`).toBe(bot.score);
      expect(traceRailfps(world, back, ARCADE_LIBRARY).hash, `seed ${String(seed)}`).toBe(bot.hash);
    }
  });

  it('a shot at the center travels as axis 1 and still aims at the center after packing', () => {
    const center = botRuns().flatMap(({ bot }) => bot.inputs.filter((input) => input.axis === 1));
    expect(center.length).toBeGreaterThan(0);
    for (const { bot } of botRuns()) {
      const back = roundTrip(bot.inputs);
      expect(back.filter((input) => input.axis === 1)).toEqual(bot.inputs.filter((input) => input.axis === 1));
      expect(back.some((input) => input.axis === 0)).toBe(false);
    }
    // Ručně: jediný ťuk do středu.
    const tap: InputEvent[] = [{ tick: 3, buttons: BUTTON.FIRE, axis: 1 }];
    expect(roundTrip(tap)).toEqual(tap);
    expect(axisToSector(roundTrip(tap)[0]!.axis)).toBe(0);
  });

  it('the worst record (the bot plus a drag on every tick) packs under the 64 kB body cap and replays the same', () => {
    // Tah: každý tik jiná osa z mřížky adaptéru, střídavě dvě nejdelší (−1000, −937), ať se žádné dva tiky nesloučí.
    const longest = [...RAILFPS_AXES].sort((a, b) => String(b).length - String(a).length || a - b).slice(0, 2);
    for (const { seed, world, bot } of botRuns()) {
      const byTick = new Map(bot.inputs.map((input) => [input.tick, input]));
      const worst: InputEvent[] = Array.from({ length: ARCADE_LIMITS.maxTicks }, (_, tick) => byTick.get(tick) ?? { tick, buttons: 0, axis: longest[tick % 2] as number });
      const packed = packInputs(worst);
      expect(packed.length / 4, `seed ${String(seed)}`).toBe(ARCADE_LIMITS.maxTicks);
      expect(JSON.stringify({ inputs: packed }).length, `seed ${String(seed)}`).toBeLessThan(BODY_CAP);
      const back = roundTrip(worst);
      expect(back, `seed ${String(seed)}`).toEqual(worst);
      const direct = traceRailfps(world, worst, ARCADE_LIBRARY);
      const server = scoredReplay(world, back, []);
      expect(server.hash, `seed ${String(seed)}`).toBe(direct.hash);
      expect(server.outcome, `seed ${String(seed)}`).toBe(direct.outcome);
    }
  });
});
