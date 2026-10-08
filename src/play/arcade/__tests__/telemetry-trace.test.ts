/**
 * Telemetrie běhu robota (P45A T3): stopa stav jen čte. Hash běhu s ní je
 * týž jako `replay` i jako běh robota, druhy událostí se nepletou a v kódu
 * není nic wall-clock ani náhodného.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, ROLE } from '@/play/arcade/contract';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { loadRapier } from '@/play/arcade/physics/world';
import { SAMPLE_TICKS, THREAT_ROLES, traceRun } from '@/play/arcade/telemetry';
import { type BotRun, runBot } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';

/** Tři žánry z panelu P45 (`evals/play/p45/panel.json`): sběr v aréně (f01), běžec (s003), souboj (h05). */
const GAMES = {
  arena: 'a dragon guards its gold hoard from greedy knights inside a volcano',
  runner: 'A hamster escaping a supermarket while a giant Roomba hunts me',
  duel: 'boxing a kangaroo in the australian outback',
} as const;

interface Played { world: ArcadeWorld; bot: BotRun }
const played: Partial<Record<keyof typeof GAMES, Played>> = {};

function worldOf(text: string): ArcadeWorld {
  const made = arcadeWorldOf(draftGameSpecWithMeta(text, 1).spec, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

beforeAll(async () => {
  await loadRapier();
  for (const [name, text] of Object.entries(GAMES)) {
    const world = worldOf(text);
    played[name as keyof typeof GAMES] = { world, bot: runBot(world, undefined, { profile: 'intermediate' }) };
  }
}, 60_000);

const game = (name: keyof typeof GAMES): Played => played[name] as Played;

describe('traceRun', () => {
  it.each(Object.keys(GAMES) as (keyof typeof GAMES)[])('leaves the %s run hash equal to replay and to the bot run', (name) => {
    const { world, bot } = game(name);
    const trace = traceRun(world, bot.inputs);
    expect(trace.hash).toBe(replay(world, bot.inputs, ARCADE_LIBRARY).hash);
    expect(trace.hash).toBe(bot.hash);
    expect(trace.outcome).toBe(bot.outcome);
    expect(trace.ticks).toBe(bot.tick);
  });

  it('is deterministic: two traces of one run are equal', () => {
    const { world, bot } = game('duel');
    expect(traceRun(world, bot.inputs)).toEqual(traceRun(world, bot.inputs));
  });

  it('tells a picked-up thing from a killed enemy', () => {
    const events = (['arena', 'runner', 'duel'] as const).flatMap((name) => traceRun(game(name).world, game(name).bot.inputs).events);
    expect(events.filter((e) => e.kind === 'pickup').length).toBeGreaterThan(0);
    expect(events.filter((e) => e.kind === 'kill' && e.role === ROLE.collectible)).toEqual([]);
    expect(events.filter((e) => e.kind === 'pickup' && e.role !== ROLE.collectible && e.role < 32)).toEqual([]);
  });

  it('records the end of the run once, as the bot saw it', () => {
    for (const name of Object.keys(GAMES) as (keyof typeof GAMES)[]) {
      const { world, bot } = game(name);
      const ends = traceRun(world, bot.inputs).events.filter((e) => e.kind === 'win' || e.kind === 'lose');
      expect(ends.map((e) => e.kind), name).toEqual(bot.outcome === 'won' ? ['win'] : bot.outcome === 'lost' ? ['lose'] : []);
      if (ends.length > 0) expect(ends[0]?.tick, name).toBe(bot.tick - 1);
    }
  });

  it('samples the player and the live threats every six ticks and at the end of the run', () => {
    const { world, bot } = game('duel');
    const trace = traceRun(world, bot.inputs);
    expect(trace.samples[0]?.tick).toBe(0);
    const regular = Array.from({ length: Math.floor(trace.ticks / SAMPLE_TICKS) + 1 }, (_, i) => i * SAMPLE_TICKS);
    expect(trace.samples.map((s) => s.tick)).toEqual(trace.ticks % SAMPLE_TICKS === 0 ? regular : [...regular, trace.ticks]);
    const bodies = trace.samples.flatMap((s) => s.bodies);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((b) => THREAT_ROLES.includes(b.role) && b.born >= 0)).toBe(true);
  });

  it('has no wall clock and no unseeded randomness in its source', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'play', 'arcade', 'telemetry.ts'), 'utf8');
    expect(source.match(/Date\.now|performance\.now|Math\.random/g)).toBeNull();
  });
});
