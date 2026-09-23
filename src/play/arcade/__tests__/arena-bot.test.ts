import { describe, expect, it } from 'vitest';

import { reportFor } from '@/app/api/play/_report';
import { compileGame } from '@/play/compile';
import { blockingIssues, critique } from '@/play/director/critic';
import { draftGameSpec } from '@/play/draft';
import { readGameSpec } from '@/play/spec';

import arenaFixture from '../__fixtures__/arena.json';
import { type ArcadeLevel, type ArcadeWorld } from '../contract';
import { buildWorld } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { ARENA, ARENA_DENSITIES, type ArenaDensity, arenaBotRef, arenaControlRef, arenaLevel, arenaRules } from '../pieces/arena';
import { arenaBot } from '../pieces/arena-bot';
import { verifyArcade } from '../verify';

const params = (density: ArenaDensity, extra: Record<string, unknown> = {}) => arenaLevel.params.parse({ density, ...extra });

function worldOf(level: ArcadeLevel, goal: 'grow' | 'survive' = 'grow', health?: number): ArcadeWorld {
  const built = buildWorld(
    { seed: 1, control: arenaControlRef(), rules: arenaRules(level, { goal, seconds: 40 }, health), bot: arenaBotRef(), level, ...(health === undefined ? {} : { health }) },
    ARCADE_LIBRARY,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

describe('aréna – robot a ověření', () => {
  it('30 semínek × 3 hustoty projde: robot vyroste, nečinného sní, přehrání sedí', () => {
    for (const density of ARENA_DENSITIES) {
      for (let seed = 1; seed <= 30; seed += 1) {
        const verdict = verifyArcade(worldOf(arenaLevel.generate(seed * 104_729, params(density))));
        expect(verdict.failures, `${density}/${seed}`).toEqual([]);
        expect(verdict.idle.outcome, `${density}/${seed}`).toBe('lost');
      }
    }
  });

  it('projde i cíl přežít a hra se životy', () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      expect(verifyArcade(worldOf(arenaLevel.generate(seed, params('dense')), 'survive')).failures, `survive/${seed}`).toEqual([]);
      expect(verifyArcade(worldOf(arenaLevel.generate(seed, params('normal')), 'grow', 3)).failures, `lives/${seed}`).toEqual([]);
    }
  });

  it('robot reaguje se zpožděním 8 tiků', () => {
    expect(arenaBot.reactionTicks).toBe(8);
  });

  it('aréna bez větších buněk na přežití vyhraje i nečinný hráč – ověření ji odmítne', () => {
    const level = arenaLevel.generate(3, params('normal'));
    const tame: ArcadeLevel = { ...level, bodies: level.bodies.filter((b) => !(b.role === 'enemy' && b.w > ARENA.startSize)) };
    const verdict = verifyArcade(worldOf(tame, 'survive'));
    expect(verdict.idle.outcome).toBe('won');
    expect(verdict.failures.some((failure) => failure.startsWith('idle_loses:'))).toBe(true);
    expect(verdict.publishEligible).toBe(false);
  });

  it('fixtura arény se zkompiluje do arkádového světa a projde ověřením', () => {
    const read = readGameSpec(arenaFixture);
    if (!read.ok) throw new Error(read.issues.join('; '));
    const compiled = compileGame(read.value, 1);
    if (!compiled.ok) throw new Error(compiled.issues.join('; '));
    expect(compiled.value.arcade?.control.id).toBe('move_free');
    expect(compiled.value.arcade?.bot.id).toBe('arena_bot');
    // Časovač končící prohrou = vyrůst včas.
    expect(compiled.value.arcade?.rules.map((rule) => rule.id)).toEqual(['arena_eat', 'grow_to', 'time_limit']);
    const report = reportFor(compiled.value);
    expect(report.keypoints.filter((keypoint) => !keypoint.passed)).toEqual([]);
    expect(report.publishEligible).toBe(true);
    expect(readGameSpec({ ...arenaFixture, controlParams: { density: 'dense', drift: true } }).ok).toBe(false);
  });

  // Nález revize fáze P25F: cíl arény se bral jen z `goal`, časovač výhry kompilátor zahodil.
  it('časovač končící výhrou = přežít tak dlouho; rozpor cíle a časovače spec odmítne', () => {
    const timer = (seconds: number, onEnd: string) => ({ id: 'timer', params: { id: 'clock', seconds, onEnd } });
    const survive = { ...arenaFixture, controlParams: { density: 'normal' }, mechanics: [timer(30, 'win'), arenaFixture.mechanics[1]!] };
    const read = readGameSpec(survive);
    if (!read.ok) throw new Error(read.issues.join('; '));
    const compiled = compileGame(read.value, 1);
    if (!compiled.ok) throw new Error(compiled.issues.join('; '));
    expect(compiled.value.arcade?.rules).toContainEqual({ id: 'survive_time', params: { seconds: 30 } });
    const reject = (spec: unknown) => {
      const result = readGameSpec(spec);
      return result.ok ? '' : result.issues.join();
    };
    expect(reject({ ...survive, controlParams: { goal: 'grow' } })).toMatch(/cannot also win on a timer/);
    expect(reject({ ...survive, controlParams: { goal: 'survive', seconds: 20 } })).toMatch(/20 s but the winning timer says 30 s/);
    expect(reject({ ...survive, mechanics: [timer(120, 'win')] })).toMatch(/20–80 s, not 120/);
    // Druhá revize: přežití s časovačem končícím prohrou by vyhrálo po jiném čísle, než hráč čte.
    expect(reject({ ...arenaFixture, controlParams: { goal: 'survive' } })).toMatch(/needs its timer to end with win/);
  });

  // Druhá revize: kritik režiséra blokoval každou arénu „vyrůst včas“ (NO_TERMINATION).
  it('kritik režiséra pustí arénu s časovačem končícím prohrou a návrh věty o aréně', () => {
    const read = readGameSpec(arenaFixture);
    if (!read.ok) throw new Error(read.issues.join('; '));
    expect(blockingIssues(critique(read.value))).toEqual([]);
    const drafted = draftGameSpec('an agar.io game where a fish eats smaller fish');
    expect(drafted.control).toBe('move_free');
    expect(blockingIssues(critique(drafted))).toEqual([]);
    // Mřížková hra bez výhry blokuje dál.
    const grid = readGameSpec({ ...arenaFixture, control: undefined, controlParams: undefined });
    if (!grid.ok) throw new Error(grid.issues.join('; '));
    expect(blockingIssues(critique(grid.value)).map((issue) => issue.code)).toContain('NO_TERMINATION');
  });

  it('hráč od začátku nejmenší a bez potravy neprojde', () => {
    const level = arenaLevel.generate(7, params('normal'));
    const starved: ArcadeLevel = { ...level, bodies: level.bodies.filter((b) => b.role !== 'collectible').map((b) => (b.role === 'enemy' ? { ...b, w: Math.max(b.w, ARENA.startSize + 200), d: Math.max(b.d, ARENA.startSize + 200) } : b)) };
    const verdict = verifyArcade(worldOf(starved));
    expect(verdict.publishEligible).toBe(false);
    expect(verdict.failures.join()).toMatch(/^bot_wins: the bot lost at tick \d+/);
  });
});
