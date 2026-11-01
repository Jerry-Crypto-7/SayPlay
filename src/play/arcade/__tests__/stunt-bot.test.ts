/**
 * Závod s triky – robot, slabý robot a důkaz hry (P68V T3).
 *
 * Herní aserce (plán T3, zmrazené definice P68-I `evals/play/p68/assertions.json`) na 10 semínkách a 3 obtížnostech
 * hry z modulu žánru: robot vyhraje a záznam, přehraný od tiku 0 (`stuntEvidence`), ze stavu dokazuje řízení, brzdu,
 * skok (≥ 0,5 m nad povrchem ≥ 12 tiků), náraz do hromady s posunutými troskami a průjezd cílem do 90 s; slabý robot
 * prohraje aspoň na 8/10 v každé obtížnosti, nečinný hráč 10/10. Řádky jsou v `stunt-evidence.json` (test je drží).
 *
 * **Pin** (Test level pin): robot, který vyhraje objetím ramp a hromad, projde bránou s `win` a hra se kaskadérským
 * závodem jen jmenuje – důkaz ze stavu ho chytí (laboratorní trať s rampou a hromadou stranou osy); a průjezd cílem
 * důkaz čte z polohy, ne z efektu výhry (svět bez pravidla `finish`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { compileWith } from '../../compose/compile';
import type { GenreModule } from '../../genre/contract';
import { readGenreSpec } from '../../genre/index';
import { P68_MAX_TICKS, STUNT_DEBRIS_MAX } from '../../genre/p68-contract';
import { stuntLiveGenre } from '../../genre/stunt';
import type { GameSpecV1 } from '../../spec';
import { arcadeWorldOf } from '../compile';
import type { ArcadeLevel, ArcadeWorld, BodyInit } from '../contract';
import { buildWorld, replay } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { STEER } from '../pieces/steer';
import { STUNT_WEAK, stuntBot } from '../pieces/stunt-bot';
import { STUNT, type StuntLayout, stuntParts } from '../pieces/stunt';
import { STUNT_EVIDENCE, type StuntEvidence, stuntEvidence } from '../pieces/stunt-trace';
import { runBot } from '../verify';

const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);
const DIFFICULTIES = [1, 2, 3] as const;
const module = stuntLiveGenre as unknown as GenreModule;

/** Hra z modulu žánru (jako ruční spec e2e): monster truck, bedny, poušť; obtížnost 1–3. */
function specOf(difficulty: number): GameSpecV1 {
  const read = readGenreSpec({ genre: 'stunt', mode: 'default', hero: 'monster truck', setting: 'desert', cast: [{ label: 'crate', does: 'avoid' }], params: { difficulty } });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileWith(module, read.value);
}

function worldOf(seed: number, spec: GameSpecV1): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const weakened = (world: ArcadeWorld): ArcadeWorld => ({ ...world, bot: { ...world.bot, params: { ...world.bot.params, weak: true } } });

type Proof = Omit<StuntEvidence, 'hash'>;
const proofOf = ({ hash: _hash, ...proof }: StuntEvidence): Proof => proof;

interface Row {
  readonly difficulty: number;
  readonly seed: number;
  readonly bot: Proof;
  readonly weak: { readonly outcome: string; readonly ticks: number; readonly crashes: number };
  readonly idle: { readonly outcome: string; readonly ticks: number; readonly finished: boolean };
}

interface Run {
  readonly row: Row;
  readonly botHash: string;
  readonly evidenceHash: string;
  readonly replays: readonly string[];
}

const EVIDENCE = join(process.cwd(), 'evals/play/p68/vozidla-sport/stunt-evidence.json');

let runs: Run[] = [];

beforeAll(async () => {
  await loadRapier();
  runs = DIFFICULTIES.flatMap((difficulty) => {
    const spec = specOf(difficulty);
    return SEEDS.map((seed): Run => {
      const world = worldOf(seed, spec);
      const bot = runBot(world);
      const evidence = stuntEvidence(world, bot.inputs);
      const weak = runBot(weakened(world));
      const weakEvidence = stuntEvidence(weakened(world), weak.inputs);
      const idle = stuntEvidence(world, []);
      return {
        row: {
          difficulty,
          seed,
          bot: proofOf(evidence),
          weak: { outcome: weak.outcome, ticks: weak.tick, crashes: weakEvidence.crashes },
          idle: { outcome: idle.outcome, ticks: idle.ticks, finished: idle.finished },
        },
        botHash: bot.hash,
        evidenceHash: evidence.hash,
        replays: [replay(world, bot.inputs, ARCADE_LIBRARY).hash, replay(world, bot.inputs, ARCADE_LIBRARY).hash],
      };
    });
  });
}, 600_000);

describe('the stunt bot on 10 seeds × 3 difficulties (P68V T3)', () => {
  it('wins every run, and the replayed record proves steering, braking, a jump, a pile hit with moved debris and the finish – from state', () => {
    expect(runs).toHaveLength(30);
    for (const { row } of runs) {
      const at = `difficulty ${String(row.difficulty)} seed ${String(row.seed)}`;
      const { bot } = row;
      expect(bot.outcome, at).toBe('won');
      expect(bot.finished, at).toBe(true);
      expect(bot.ticks, at).toBeLessThan(P68_MAX_TICKS);
      expect(bot.steerTicks, at).toBeGreaterThanOrEqual(60);
      expect(bot.brakeTicks, at).toBeGreaterThanOrEqual(1);
      // Aserce P68-I „one-jump“: ≥ 0,5 m nad povrchem po ≥ 12 tiků za sebou.
      expect(bot.jumps, at).toBeGreaterThanOrEqual(1);
      expect(bot.longestJump, at).toBeGreaterThanOrEqual(STUNT_EVIDENCE.jumpTicks);
      // Aserce P68-I „debris-hit“: náraz krabice odebere a trosky odletí; fyzikálních těl nejvýš `STUNT_DEBRIS_MAX`.
      expect(bot.impacts, at).toBeGreaterThanOrEqual(1);
      expect(bot.boxesGone, at).toBeGreaterThanOrEqual(1);
      expect(bot.debrisMoved, at).toBeGreaterThanOrEqual(2);
      expect(bot.maxPhysics, at).toBeLessThanOrEqual(STUNT_DEBRIS_MAX);
    }
  });

  it('proves the bot run itself: the evidence replay ends in the bot hash, and two replays of the record agree', () => {
    for (const run of runs) {
      expect(run.evidenceHash).toBe(run.botHash);
      expect(run.replays).toEqual([run.botHash, run.botHash]);
    }
  });

  it('the weak bot loses on at least 8 of 10 seeds per difficulty, the idle player on 10 of 10 without crossing the finish', () => {
    for (const difficulty of DIFFICULTIES) {
      const rows = runs.map((run) => run.row).filter((row) => row.difficulty === difficulty);
      const weakLost = rows.filter((row) => row.weak.outcome === 'lost' && row.weak.ticks < P68_MAX_TICKS);
      expect(weakLost.length, `difficulty ${String(difficulty)}`).toBeGreaterThanOrEqual(8);
      for (const row of rows) {
        expect(row.idle.outcome).toBe('lost');
        expect(row.idle.finished).toBe(false);
        expect(row.idle.ticks).toBeLessThan(P68_MAX_TICKS);
      }
    }
    expect(STUNT_WEAK.lagTicks).toBeLessThanOrEqual(stuntBot.reactionTicks);
  });

  it('stunt-evidence.json holds exactly these rows', () => {
    const file = JSON.parse(readFileSync(EVIDENCE, 'utf8')) as { rows: Row[] };
    expect(file.rows, `regenerate stunt-evidence.json rows: ${JSON.stringify(runs.map((run) => run.row))}`).toEqual(runs.map((run) => run.row));
  });
});

// ---------------------------------------------------------------------------
// Pin: výhra bez triků důkazem neprojde

/** Rovná trať po třech úsecích (osa 0, šířka 10 m), cíl na 300 m – rampa a hromada leží stranou osy. */
function labBase(): ArcadeLevel {
  const width = 10_000;
  const walls = (near: number, far: number): BodyInit[] =>
    [-1, 1].map((side) => ({ role: 'obstacle', kind: 'tire-barrier', x: (side * (width + STEER.wallW)) / 2, y: 0, z: (near + far) / 2, w: STEER.wallW, h: STEER.wallH, d: far - near, solid: true }));
  return {
    bodies: [
      { role: 'player', kind: 'car', x: 0, y: 0, z: 0, w: STEER.carW, h: STEER.carH, d: STEER.carD, solid: false },
      ...walls(-20_000, 100_000),
      ...walls(100_000, 200_000),
      ...walls(200_000, 340_000),
      { role: 'goal', kind: 'finish', x: 0, y: 0, z: 300_000, w: width, h: 3000, d: 400, solid: false },
    ],
    length: 300_000,
  };
}

const OFF_AXIS: StuntLayout = {
  ramps: [{ x: 2500, z0: 60_000, z1: 60_000 + STUNT.ramp.d, w: STUNT.ramp.w, h: STUNT.ramp.h }],
  piles: [{ x: -3000, z: 150_000, count: 3, kind: 'crate' }],
};

function labWorld(withFinish = true): ArcadeWorld {
  const parts = stuntParts(labBase(), OFF_AXIS, { seed: 5 });
  const rules = withFinish ? parts.rules : parts.rules.filter((rule) => rule.id !== 'finish');
  const built = buildWorld({ seed: 5, control: parts.control, rules, bot: parts.bot, level: parts.level, health: parts.health }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

describe('pin: a win without stunts fails the evidence (P68V T3)', () => {
  it('a driver who stays on the axis wins, but jumps nothing and hits no pile; the stunt bot on the same track does both', () => {
    const world = labWorld();
    const axis = stuntEvidence(world, []);
    expect(axis.outcome).toBe('won');
    expect(axis.finished).toBe(true);
    expect(axis.jumps).toBe(0);
    expect(axis.impacts).toBe(0);
    expect(axis.debrisMoved).toBe(0);
    const bot = runBot(world);
    const proof = stuntEvidence(world, bot.inputs);
    expect(proof.outcome).toBe('won');
    expect(proof.jumps).toBeGreaterThanOrEqual(1);
    expect(proof.impacts).toBe(1);
    expect(proof.debrisMoved).toBeGreaterThanOrEqual(2);
  });

  it('the finish comes from the car position, not from the win effect: without the finish rule the run is lost and still crossed the line', () => {
    const world = labWorld(false);
    const proof = stuntEvidence(world, []);
    expect(proof.outcome).toBe('lost');
    expect(proof.finished).toBe(true);
  });
});
