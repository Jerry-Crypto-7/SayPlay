import { describe, expect, it } from 'vitest';

import { type ArcadeState, type ArcadeWorld, type BodyInit, FLAG, type InputEvent, NO_INPUT, bodyHp } from '../contract';
import { replay } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { type BehaviourPhase, behaviourMemoOf, behaviourPhaseOf } from '../pieces/behaviours';
import { HEALTH, behaviourHarness, healthAfter, play, read, refsOf, telegraphCheck } from '../pieces/behaviours/__tests__/harness';
import { BOSS, bossOpen } from '../pieces/behaviours/boss';
import { bossBeatHit } from '../pieces/boss';
import { runBot } from '../verify';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
/** Kolik posledních věcí sběru nese boss. */
const DROP = 2;

/**
 * Sběr v aréně, kde poslední dvě věci k výhře nese boss: věci nad `points − 2`
 * jsou jen předlohy (indexy těl se nehnou), padlý boss vydá dvě kopie první z nich.
 */
function bossWorld(seed: number): { world: ArcadeWorld; body: number } {
  return behaviourHarness('plane', 'boss', seed, {
    extra: (parts) => {
      const boss = (refsOf({ control: parts.control } as ArcadeWorld)[0] as { template: number }).template;
      const points = (parts.rules.find((rule) => rule.id === 'grow_to')?.params as { points: number }).points;
      const items = parts.level.bodies.flatMap((body, index) => (body.role === 'collectible' && body.template !== true ? [index] : []));
      const kept = new Set(items.slice(0, points - DROP));
      const bodies = parts.level.bodies.map((body, index): BodyInit => (body.role === 'collectible' && !kept.has(index) ? { ...body, template: true } : body));
      return {
        ...parts,
        level: { ...parts.level, bodies, spawnSlots: (parts.level.spawnSlots ?? 0) + DROP },
        rules: [...parts.rules, { id: 'boss_beat', params: { boss, drop: { template: items[points - DROP] as number, count: DROP } } }],
      };
    },
  });
}

interface Trace {
  /** HP a fáze bosse po každém tiku. */
  readonly hp: number[];
  readonly phase: BehaviourPhase[];
  /** Tik, kdy boss zmizel, nebo −1. */
  readonly fell: number;
  /** Porušení: zásah hráče bez útoku po varování. */
  readonly violations: string[];
  readonly damage: number;
}

function trace(world: ArcadeWorld, body: number, inputs: readonly InputEvent[]): Trace {
  const hp: number[] = [];
  const phase: BehaviourPhase[] = [];
  const violations: string[] = [];
  let fell = -1;
  let damage = 0;
  play(world, inputs, (state, tick, effects) => {
    hp[tick] = bodyHp(state, body);
    phase[tick] = behaviourPhaseOf(state, body);
    if (fell < 0 && (read(state, body, 'flags') & FLAG.alive) === 0) fell = tick;
    if (!effects.some((effect) => effect.kind === 'damage')) return;
    damage += 1;
    // Mimo útok smí hráče zranit jen výstřel (ten hlídá `telegraphCheck`); útok jen po celém varování.
    if (phase[tick] !== 'act') {
      if (!effects.some((effect) => effect.kind === 'despawn' && effect.body !== body)) violations.push(`tick ${String(tick)}: hit in ${String(phase[tick])}`);
      return;
    }
    let warned = 0;
    for (let t = Math.max(0, tick - 180); t < tick; t += 1) if (phase[t] === 'telegraph') warned += 1;
    if (warned < BOSS.telegraphMin) violations.push(`tick ${String(tick)}: attack after ${String(warned)} telegraph ticks`);
  });
  return { hp, phase, fell, violations, damage };
}

/** Nepřerušené úseky fáze `phase`: [začátek, délka]. */
function runs(seen: readonly BehaviourPhase[], phase: BehaviourPhase): [number, number][] {
  const found: [number, number][] = [];
  for (let t = 0; t < seen.length; t += 1) {
    if (seen[t] !== phase) continue;
    if (t > 0 && seen[t - 1] === phase) (found.at(-1) as [number, number])[1] += 1;
    else found.push([t, 1]);
  }
  return found;
}

const inputsOf = (world: ArcadeWorld, body: number): (readonly InputEvent[])[] => [[], runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' }).inputs, runBot(world, ARCADE_LIBRARY, { probeBody: body }).inputs];

describe('boss', () => {
  it('(a) the threat probe walks into it and gets hit', () => {
    for (const seed of [1, 2]) {
      const { world, body } = bossWorld(seed);
      expect(healthAfter(world, runBot(world, ARCADE_LIBRARY, { probeBody: body }).inputs)).toBeLessThan(HEALTH);
    }
  });

  it('(b) the intermediate bot beats the boss and wins at least 7 of 8 seeds, idle wins none', () => {
    const outcomes = SEEDS.map((seed) => {
      const { world, body } = bossWorld(seed);
      const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
      return { won: bot.outcome === 'won', fell: trace(world, body, bot.inputs).fell >= 0, idle: replay(world, [], ARCADE_LIBRARY).outcome };
    });
    expect(outcomes.filter((run) => run.won && run.fell).length).toBeGreaterThanOrEqual(7);
    expect(outcomes.filter((run) => run.idle === 'won')).toEqual([]);
  });

  it('(c) every attack and every shot lands only after a full warning', () => {
    let damage = 0;
    for (const seed of SEEDS) {
      const { world, body } = bossWorld(seed);
      for (const inputs of inputsOf(world, body)) {
        expect(telegraphCheck(world, inputs).violations).toEqual([]);
        const seen = trace(world, body, inputs);
        expect(seen.violations).toEqual([]);
        damage += seen.damage;
      }
    }
    // Ne prázdně: nečinného hráče a sondu zasáhne v každém semínku.
    expect(damage).toBeGreaterThanOrEqual(2 * SEEDS.length);
  });

  it('(d) loses HP only in recover, once per window, and falls after exactly its HP in hits', () => {
    let fallen = 0;
    for (const seed of SEEDS) {
      const { world, body } = bossWorld(seed);
      for (const inputs of inputsOf(world, body)) {
        const seen = trace(world, body, inputs);
        const drops = seen.hp.flatMap((hp, tick) => (hp < (tick === 0 ? BOSS.hp : (seen.hp[tick - 1] as number)) ? [tick] : []));
        for (const tick of drops) expect(seen.phase[tick]).toBe('recover');
        for (const [start, length] of runs(seen.phase, 'recover')) expect(drops.filter((tick) => tick >= start && tick < start + length).length).toBeLessThanOrEqual(1);
        if (seen.fell < 0) expect(drops.length).toBeLessThan(BOSS.hp);
        else {
          expect(drops.length).toBe(BOSS.hp);
          expect(seen.fell).toBe(drops.at(-1));
          fallen += 1;
        }
      }
    }
    expect(fallen).toBeGreaterThanOrEqual(7);
  });

  it('(e) every hit shortens the next warning by 8 ticks, never below the floor', () => {
    let shortened = 0;
    for (const seed of SEEDS) {
      const { world, body } = bossWorld(seed);
      const seen = trace(world, body, runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' }).inputs);
      const warnings = runs(seen.phase, 'telegraph').filter(([start, length]) => start + length < seen.phase.length);
      for (const [start, length] of warnings) {
        const hits = BOSS.hp - (start === 0 ? BOSS.hp : (seen.hp[start - 1] as number));
        expect(length).toBe(Math.max(BOSS.telegraphMin, BOSS.telegraph - BOSS.shorten * hits));
        if (hits > 0) shortened += 1;
      }
    }
    expect(shortened).toBeGreaterThan(0);
  });

  it('(f) a player shot hurts it only in the open window', () => {
    const { world, body } = bossWorld(3);
    const params = { boss: (refsOf(world)[0] as { template: number }).template };
    let open: ArcadeState | null = null;
    let shut: ArcadeState | null = null;
    play(world, [], (state) => {
      const phase = behaviourPhaseOf(state, body);
      if (open === null && bossOpen(state, body, phase, behaviourMemoOf(state, body))) open = state.slice();
      if (shut === null && phase === 'telegraph') shut = state.slice();
    });
    const shot = (state: ArcadeState | null) => bossBeatHit.fire({ state: state as ArcadeState, player: 0, other: body, source: 1, input: NO_INPUT }, params);
    expect(shot(open)).toEqual([{ kind: 'hit', body, by: 1, amount: 1 }]);
    expect(shot(shut)).toEqual([]);
  });

  it('(g) replays the bot record to the same hash', () => {
    const { world } = bossWorld(3);
    const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
  });
});
