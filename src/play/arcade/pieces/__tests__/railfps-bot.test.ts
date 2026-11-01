/**
 * Robot, slabý a nečinný hráč střelnice z očí a herní aserce ze stopy (P68-F T3).
 *
 * Robot, který vyhraje vyslaným `win` bez míření, by prošel publikační branou a vypadal jako hotová hra; pozná se jen
 * ze záznamu. Proto každá výhra robota musí mít v `traceRailfps` mířené zásahy: každý zásah v tiku rány, v sektoru,
 * kam natočení míří, tolik zásahů, kolik je cílů, a výhru až v tiku posledního zásahu. Tytéž aserce zásahů platí
 * i pro stopy slabého a nečinného hráče. Běží na 3 semínkách × výchozí meze a mezní meze generátoru.
 */

import { describe, expect, it } from 'vitest';

import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeWorld, type InputEvent, START_LIVES } from '../../contract';
import { completeHooks } from '../../hooks';
import { buildWorld, replay } from '../../kernel';
import { ARCADE_LIBRARY } from '../../library';
import { type BotRun, runBot } from '../../verify';
import { RAILFPS, type RailfpsRoundParams, railfpsRail } from '../railfps';
import { RAILFPS_WEAK, railfpsBot, railfpsWeakInputs } from '../railfps-bot';
import { type RailfpsTrace, traceRailfps } from '../railfps-trace';

const SEEDS = [1, 2, 3] as const;
const BOUNDS = [
  { name: 'default', params: {} },
  { name: 'targets min', params: { targets: RAILFPS.targets.min } },
  { name: 'targets max', params: { targets: RAILFPS.targets.max } },
  { name: 'waves min', params: { waves: RAILFPS.waves.min } },
  { name: 'waves max', params: { waves: RAILFPS.waves.max } },
] as const;

function worldOf(seed: number, params: object): ArcadeWorld {
  const parts = railfpsRail.parts(seed, railfpsRail.params.parse(params), undefined);
  if ((parts.issues ?? []).length > 0) throw new Error((parts.issues ?? []).join('; '));
  const built = buildWorld({ seed, control: parts.control, rules: completeHooks(parts.rules), bot: parts.bot, level: parts.level, health: parts.health ?? START_LIVES }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Cílů úrovně: všechny příchody všech vln (terče, nepřátelé, boss). */
const foesOfLevel = (world: ArcadeWorld): number => (world.rules.find((ref) => ref.id === 'railfps_round')!.params as RailfpsRoundParams).waves.flat().length;

interface Case {
  readonly what: string;
  readonly world: ArcadeWorld;
  readonly bot: BotRun;
  readonly trace: RailfpsTrace;
}

let built: readonly Case[] | undefined;
/** Robot hraje přes `runBot` (tatáž cesta jako publikační brána: zpožděné vnímání, robot světa), stopa z jeho záznamu. */
const cases = (): readonly Case[] =>
  (built ??= SEEDS.flatMap((seed) =>
    BOUNDS.map(({ name, params }) => {
      const world = worldOf(seed, params);
      const bot = runBot(world, ARCADE_LIBRARY);
      return { what: `seed ${String(seed)}, ${name}`, world, bot, trace: traceRailfps(world, bot.inputs, ARCADE_LIBRARY) };
    }),
  ));

/** Každý zásah má ránu v témž tiku a zasažené tělo stálo v sektoru, kam v tom tiku mířilo natočení. */
function expectAimedHits(trace: RailfpsTrace, what: string): void {
  const shotAt = new Map(trace.shots.map((shot) => [shot.tick, shot.sector]));
  for (const hit of trace.hits) {
    const where = `${what}: body ${String(hit.body)} hit at tick ${String(hit.tick)}`;
    expect(shotAt.has(hit.tick), `${where} without a shot in that tick`).toBe(true);
    expect(hit.sector, `${where} stands in another sector than the view`).toBe(trace.sectors[hit.tick]);
  }
}

describe('railfps bot (P68-F T3)', () => {
  it('is the bot the generator hands out', () => {
    expect(ARCADE_LIBRARY.bots.railfps_bot).toBe(railfpsBot);
    for (const { world } of cases()) expect(world.bot.id).toBe('railfps_bot');
  });

  it('wins every level within 90 s without losing a life', () => {
    for (const { what, bot, trace } of cases()) {
      expect(bot.outcome, what).toBe('won');
      expect(bot.tick, what).toBeLessThanOrEqual(ARCADE_LIMITS.maxTicks);
      expect(trace.outcome, what).toBe('won');
      expect(trace.losses, what).toEqual([]);
    }
  });

  it('paces the default level near the promised length: the bot needs 35 to 60 s, the slowest level leaves 15 s of the limit (T9)', () => {
    const seconds = cases().map(({ what, bot }) => ({ what, at: bot.tick / ARCADE_HZ }));
    console.log(`railfps bot win (s): ${seconds.map(({ what, at }) => `${what} ${at.toFixed(1)}`).join('; ')}`);
    for (const { what, at } of seconds) {
      if (what.endsWith('default')) expect(at, what).toBeGreaterThanOrEqual(35);
      if (what.endsWith('default')) expect(at, what).toBeLessThanOrEqual(60);
      expect(at, what).toBeLessThanOrEqual(RAILFPS.seconds - 15);
    }
  });

  it('really aims: the view visits at least 5 sectors and at least 3 hits land off-center', () => {
    for (const { what, trace } of cases()) {
      expect(new Set(trace.sectors).size, what).toBeGreaterThanOrEqual(5);
      expect(trace.hits.filter((hit) => hit.sector !== 0).length, what).toBeGreaterThanOrEqual(3);
    }
  });

  it('every hit has a shot in the same tick and lands in the sector of the view', () => {
    for (const { what, trace } of cases()) {
      expect(trace.hits.length, what).toBeGreaterThan(0);
      expectAimedHits(trace, what);
    }
  });

  it('hits every target of the level once, and the win comes in the tick of the last hit, never before', () => {
    for (const { what, world, trace } of cases()) {
      expect(trace.hits.length, what).toBe(foesOfLevel(world));
      expect(new Set(trace.hits.map((hit) => `${String(hit.tick)}:${String(hit.body)}`)).size, what).toBe(trace.hits.length);
      // Poslední odehraný tik je tik výhry.
      expect(trace.tick - 1, what).toBe(trace.hits.at(-1)!.tick);
    }
  });

  it('two replays of the same record give the same hash, and it is the hash of the bot run and of the kernel replay', () => {
    for (const { what, world, bot, trace } of cases()) {
      const again = traceRailfps(world, bot.inputs, ARCADE_LIBRARY);
      expect(again.hash, what).toBe(trace.hash);
      expect(again.hits, what).toEqual(trace.hits);
      expect(trace.hash, what).toBe(bot.hash);
      expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash, what).toBe(trace.hash);
    }
  });
});

describe('railfps losing players (P68-F T3)', () => {
  const players: readonly { readonly name: string; readonly inputs: (world: ArcadeWorld) => readonly InputEvent[] }[] = [
    { name: 'idle', inputs: () => [] },
    { name: 'weak', inputs: railfpsWeakInputs },
  ];

  for (const player of players) {
    it(`the ${player.name} player loses every level, and its hits are aimed hits too`, () => {
      for (const { what, world } of cases()) {
        const trace = traceRailfps(world, player.inputs(world), ARCADE_LIBRARY);
        expect(trace.outcome, `${what}, ${player.name}`).toBe('lost');
        expect(trace.hits.length, `${what}, ${player.name}`).toBeLessThan(foesOfLevel(world));
        expectAimedHits(trace, `${what}, ${player.name}`);
      }
    });
  }

  it('the idle player shoots nothing and loses its lives to enemies', () => {
    for (const { what, world } of cases()) {
      const trace = traceRailfps(world, [], ARCADE_LIBRARY);
      expect(trace.shots, what).toEqual([]);
      expect(trace.hits, what).toEqual([]);
      expect(trace.losses.length, what).toBeGreaterThan(0);
    }
  });

  it('the weak player only ever aims at the center and its neighbours, on a fixed beat', () => {
    for (const { what, world } of cases()) {
      const inputs = railfpsWeakInputs(world);
      expect(inputs.length, what).toBeGreaterThan(0);
      inputs.forEach((input, n) => expect(input.tick, what).toBe(RAILFPS_WEAK.first + n * RAILFPS_WEAK.every));
      const trace = traceRailfps(world, inputs, ARCADE_LIBRARY);
      expect(trace.shots.length, what).toBeGreaterThan(0);
      for (const shot of trace.shots) expect(Math.abs(shot.sector), what).toBeLessThanOrEqual(1);
      expect(Math.max(...trace.sectors.map(Math.abs)), what).toBeLessThanOrEqual(1);
    }
  });
});
