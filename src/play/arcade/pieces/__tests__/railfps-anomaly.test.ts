/**
 * Najdi anomálii z očí (P68-F T11): robot vyhraje, nečinný a náhodně ťukající hráč prohrají, přehrání je
 * deterministické a změna leží vždy v sektoru −4..+4.
 *
 * Hlídá to, co by na pohled vypadalo jako hotová hádanka: kolo splněné bez ťuku na sektor změny. Proto každé splněné
 * kolo ve stopě (`traceRailfps().clears` – začátek přestávky háčků nebo výhra) musí mít ránu v témž tiku do sektoru
 * změny toho kola – u robota i u náhodného hráče. Kusy nejsou ve sdílené knihovně, test si je přidá sám.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type ArcadeWorld, BUTTON, type InputEvent, START_LIVES } from '../../contract';
import { completeHooks } from '../../hooks';
import { type ArcadeLibrary, buildWorld, replay } from '../../kernel';
import { ARCADE_LIBRARY } from '../../library';
import { runBot } from '../../verify';
import { YAW, sectorToAxis } from '../railfps';
import { RAILFPS_SPOT_PIECES, SPOT, SPOT_CHANGE, type RailfpsSpotRuleParams, railfpsSpotRoom, spotChanges, spotRoom } from '../railfps-anomaly';
import { type RailfpsTrace, traceRailfps } from '../railfps-trace';

const LIBRARY: ArcadeLibrary = {
  controls: { ...ARCADE_LIBRARY.controls, ...RAILFPS_SPOT_PIECES.controls },
  rules: { ...ARCADE_LIBRARY.rules, ...RAILFPS_SPOT_PIECES.rules },
  generators: { ...ARCADE_LIBRARY.generators, ...RAILFPS_SPOT_PIECES.generators },
  bots: { ...ARCADE_LIBRARY.bots, ...RAILFPS_SPOT_PIECES.bots },
};

const SEEDS = [1, 2, 3, 4, 5] as const;
const ROUND_COUNTS = [SPOT.rounds.min, SPOT.rounds.default, SPOT.rounds.max] as const;

function worldOf(seed: number, rounds: number = SPOT.rounds.default): ArcadeWorld {
  const parts = railfpsSpotRoom.parts(seed, railfpsSpotRoom.params.parse({ rounds }), undefined);
  const built = buildWorld({ seed, control: parts.control, rules: completeHooks(parts.rules), bot: parts.bot, level: parts.level, health: parts.health ?? START_LIVES }, LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const changesOf = (world: ArcadeWorld): RailfpsSpotRuleParams['rounds'] => (world.rules.find((ref) => ref.id === 'railfps_spot')!.params as RailfpsSpotRuleParams).rounds;

/** Každé splněné kolo `k` má v témž tiku ránu do sektoru změny kola `k`. */
function expectFoundByShot(trace: RailfpsTrace, world: ArcadeWorld, what: string): void {
  const changes = changesOf(world);
  trace.clears.forEach((tick, k) => {
    const shot = trace.shots.find((s) => s.tick === tick);
    expect(shot, `${what}: round ${String(k)} cleared at tick ${String(tick)} without a shot`).toBeDefined();
    expect(shot!.sector, `${what}: round ${String(k)}`).toBe(changes[k]![1]);
  });
}

/**
 * Náhodně ťukající hráč: od první změny každých 15–45 tiků ťuk do sektoru ze semínka (LCG, ne `Math.random`). Dřív
 * neťuká – jinak by přišel o životy, než se cokoli změní, a aserce nalezení by u něj nic nehlídala.
 */
function randomTaps(seed: number, from: number, horizon: number): InputEvent[] {
  let s = seed * 2654435761 >>> 0;
  const next = (n: number): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
  const out: InputEvent[] = [];
  for (let tick = from + next(30); tick < horizon; tick += 15 + next(31)) out.push({ tick, buttons: BUTTON.FIRE, axis: sectorToAxis(next(YAW.sectors) - YAW.maxSector) });
  return out;
}

describe('railfps spot-the-anomaly kernel', () => {
  it('the bot finds every change with a shot in its sector and wins without losing a life', () => {
    for (const seed of SEEDS) {
      for (const rounds of ROUND_COUNTS) {
        const what = `seed ${String(seed)}, ${String(rounds)} rounds`;
        const world = worldOf(seed, rounds);
        const bot = runBot(world, LIBRARY);
        expect(bot.outcome, what).toBe('won');
        const trace = traceRailfps(world, bot.inputs, LIBRARY);
        expect(trace.outcome, what).toBe('won');
        expect(trace.clears, what).toHaveLength(rounds);
        expect(trace.losses, what).toEqual([]);
        expect(trace.shots, `${what}: one shot per round`).toHaveLength(rounds);
        expectFoundByShot(trace, world, what);
      }
    }
  });

  it('an idle player loses when the first change goes unfound', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const trace = traceRailfps(world, [], LIBRARY);
      expect(trace.outcome).toBe('lost');
      expect(trace.clears).toEqual([]);
      expect(trace.tick).toBe(changesOf(world)[0]![0] + SPOT.window + 1);
    }
  });

  it('a player tapping random sectors loses, and any round it clears was a shot in the changed sector', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const trace = traceRailfps(world, randomTaps(seed, changesOf(world)[0]![0], 5400), LIBRARY);
      expect(trace.outcome, `seed ${String(seed)}`).toBe('lost');
      expect(trace.losses.length, `seed ${String(seed)}`).toBeGreaterThan(0);
      expectFoundByShot(trace, world, `seed ${String(seed)}`);
    }
  });

  it('a tap on the right sector before the change costs a life and clears nothing', () => {
    const world = worldOf(1);
    const [changeAt, sector] = changesOf(world)[0]!;
    const early = traceRailfps(world, [{ tick: 0, buttons: BUTTON.FIRE, axis: sectorToAxis(sector) }], LIBRARY, changeAt - 1);
    expect(early.shots).toHaveLength(1);
    expect(early.losses).toEqual([{ tick: early.shots[0]!.tick, lives: 1 }]);
    expect(early.clears).toEqual([]);
  });

  it('two replays of one record give the same hash', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const inputs = runBot(world, LIBRARY).inputs;
      expect(replay(world, inputs, LIBRARY).hash).toBe(replay(world, inputs, LIBRARY).hash);
      expect(traceRailfps(world, inputs, LIBRARY).hash).toBe(replay(world, inputs, LIBRARY).hash);
    }
  });

  it('every change sits in a sector −4..+4, each round in a different one, on an item the room has', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const room = spotRoom(seed);
      expect(room).toHaveLength(YAW.sectors * SPOT.perSector);
      const changes = spotChanges(seed, SPOT.rounds.max, room);
      expect(new Set(changes.map(([, s]) => s)).size).toBe(SPOT.rounds.max);
      for (const [at, s, item, kind] of changes) {
        expect(s).toBeGreaterThanOrEqual(-YAW.maxSector);
        expect(s).toBeLessThanOrEqual(YAW.maxSector);
        expect(at).toBeGreaterThanOrEqual(SPOT.changeFrom);
        expect(at).toBeLessThanOrEqual(SPOT.changeTo);
        if (kind === SPOT_CHANGE.extra) expect(item).toBe(SPOT.perSector);
        else expect(room.some(([is, index]) => is === s && index === item)).toBe(true);
      }
    }
  });

  it('the same seed builds the same game and the source has no ambient randomness or clock', () => {
    expect(changesOf(worldOf(7))).toEqual(changesOf(worldOf(7)));
    const source = readFileSync(join(__dirname, '..', 'railfps-anomaly.ts'), 'utf8');
    expect(source).not.toMatch(/Math\.random|Date\.now|performance\.now/);
  });
});
