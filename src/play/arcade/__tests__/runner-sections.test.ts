/**
 * Knihovna úseků běžce (P46D T2): každý vzor drží svůj tvar a je průchodný,
 * trať ze vzorů se mění se semínkem a hra žánru Běžec zůstane pro začátečníka
 * férová. Uložené hry bez `patterns` staví tutéž trať (replay brána).
 */

import { describe, expect, it } from 'vitest';

import { createCompileRng } from '@/play/compile/rng';
import { compileRecipe } from '@/play/compose/compile';
import { draftGameSpecWithMeta } from '@/play/draft';

import { arcadeWorldOf } from '../compile';
import { type ArcadeLevel, type BodyInit, UNIT } from '../contract';
import { buildWorld } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { OBSTACLE_KINDS, RUNNER, RUNNER_DENSITIES, RUNNER_STRUCTURE_D, RUNNER_TRACK, checkRunnerLevel, runnerPatternTrack, runnerTrack } from '../pieces/runner';
import { RUNNER_PATTERNS, RUNNER_PATTERN_LIBRARY, STRUCTURES } from '../pieces/runner-sections';
import { type BotProfile, runBot, verifyArcade } from '../verify';

/** Parametry, jak je píše žánr Běžec (bez skluzové laťky, když překážka nevisí). */
const params = (extra: Record<string, unknown> = {}) => runnerTrack.params.parse({ sections: 3, patterns: 1, feel: 2, obstacles: OBSTACLE_KINDS.filter((kind) => kind !== 'slide-bar'), ...extra });
const ALL = { obstacles: [...OBSTACLE_KINDS] };

/** Robot běžce na hotové trati; jeden náraz prohrává. */
function play(level: ArcadeLevel, profile?: BotProfile) {
  const control = { id: 'runner', params: { speed: 'normal', ramp: level.sectionStarts, feel: 2 } };
  const rules = [{ id: 'hit', params: { role: 'obstacle', effect: 'lose' } }, { id: 'pickup', params: {} }, { id: 'finish', params: {} }];
  const built = buildWorld({ seed: 1, control, rules, bot: { id: 'runner_bot', params: {} }, level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return runBot(built.world, ARCADE_LIBRARY, profile === undefined ? {} : { profile });
}

const obstacle = (x: number, z: number, d: number, extra: Partial<BodyInit> = {}): BodyInit => ({ role: 'obstacle', kind: 'divider', x, y: 0, z, w: 1600, h: 1500, d, solid: true, ...extra });
const levelOf = (bodies: readonly BodyInit[], length = 200 * UNIT): ArcadeLevel => ({
  bodies: [{ role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: RUNNER.playerW, h: RUNNER.runH, d: RUNNER.playerD, solid: false }, ...bodies, { role: 'goal', kind: 'finish', x: 0, y: 0, z: length, w: 8000, h: 3000, d: 400, solid: false }],
  length,
});

describe('knihovna úseků běžce', () => {
  it('má osm vzorů a každý drží svůj tvar a průchodnost', () => {
    expect(RUNNER_PATTERN_LIBRARY.map((pattern) => pattern.id)).toEqual([...RUNNER_PATTERNS]);
    for (const pattern of RUNNER_PATTERN_LIBRARY) {
      for (let seed = 1; seed <= 40; seed += 1) {
        const rng = createCompileRng(seed);
        const steps = pattern.build(rng, OBSTACLE_KINDS, pattern.units[1] === 0 ? 0 : rng.int(pattern.units[0], pattern.units[1]));
        expect(pattern.check(steps), `${pattern.id}/${seed}`).toEqual([]);
      }
    }
  });

  it('vlastní kontrola vzoru chytí rozbitý tvar', () => {
    const zigzag = RUNNER_PATTERN_LIBRARY.find((pattern) => pattern.id === 'zigzag')!;
    expect(zigzag.check([{ row: [null, 'cone', 'cone'] }, { row: [null, 'cone', 'cone'] }])).toContain('row 1 does not switch sides');
    const chain = RUNNER_PATTERN_LIBRARY.find((pattern) => pattern.id === 'jump-chain')!;
    expect(chain.check([{ row: ['cone', 'crate', 'cone'] }]).join()).toMatch(/closes every lane/);
    const bridge = RUNNER_PATTERN_LIBRARY.find((pattern) => pattern.id === 'bridge')!;
    expect(bridge.check([{ structure: 'water', length: 40 * UNIT }])).not.toEqual([]);
  });

  it.each(RUNNER_PATTERNS)('vzor %s je průchodný pro robota (bez profilu vždy, intermediate skoro vždy)', (id) => {
    const only = RUNNER_PATTERN_LIBRARY.filter((pattern) => pattern.id === id);
    let intermediate = 0;
    for (let seed = 1; seed <= 6; seed += 1) {
      const { level, patterns } = runnerPatternTrack(seed * 7919, params(ALL), only);
      expect(patterns, `${id}/${seed}`).toContain(id);
      expect(checkRunnerLevel(level, 'normal'), `${id}/${seed}`).toEqual([]);
      expect(play(level).outcome, `${id}/${seed}`).toBe('won');
      if (play(level, 'intermediate').outcome === 'won') intermediate += 1;
    }
    expect(intermediate, id).toBeGreaterThanOrEqual(5);
  });
});

describe('trať ze vzorů', () => {
  it('20 semínek dá aspoň 6 různých sekvencí a žádný vzor dvakrát za sebou', () => {
    const sequences = new Set<string>();
    for (let seed = 1; seed <= 20; seed += 1) {
      const { patterns } = runnerPatternTrack(seed, params());
      patterns.forEach((id, index) => expect(id, `${seed}: ${patterns.join(' ')}`).not.toBe(patterns[index - 1]));
      sequences.add(patterns.join(' '));
    }
    expect(sequences.size).toBeGreaterThanOrEqual(6);
  });

  it('50 semínek × 3 hustoty × 2 rychlosti splní invarianty hratelnosti; první prvek zavře startovní pruh', () => {
    for (const density of RUNNER_DENSITIES) {
      for (const speed of ['slow', 'fast'] as const) {
        for (let seed = 1; seed <= 50; seed += 1) {
          const level = runnerTrack.generate(seed * 7919, params({ ...ALL, density, speed, lengthM: RUNNER_TRACK.maxLengthM }));
          expect(checkRunnerLevel(level, speed), `${density}/${speed}/${seed}`).toEqual([]);
          const obstacles = level.bodies.filter((body) => body.role === 'obstacle');
          const first = Math.min(...obstacles.map((body) => body.z));
          expect(obstacles.some((body) => body.z === first && Math.abs(body.x) * 2 < body.w + RUNNER.playerW), `${density}/${speed}/${seed}`).toBe(true);
        }
      }
    }
  });

  it('poslední úsek je hustší než první (P36A T4): 30 semínek, aspoň o půl pruhu na řadu', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const level = runnerTrack.generate(seed, params());
      const [, last] = level.sectionStarts!;
      const rows = new Map<number, number>();
      for (const body of level.bodies) if (body.role === 'obstacle') rows.set(body.z, (rows.get(body.z) ?? 0) + 1);
      const lanes = (inside: (z: number) => boolean): number => {
        const counts = [...rows].filter(([z]) => inside(z)).map(([, count]) => count);
        return counts.reduce((sum, count) => sum + count, 0) / counts.length;
      };
      expect(lanes((z) => z >= last!) - lanes((z) => z < level.sectionStarts![0]!), `${seed}`).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('stavby zavřou své pruhy po celé délce a nic uvnitř nestojí', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const { level } = runnerPatternTrack(seed, params());
      const long = level.bodies.filter((body) => body.role === 'obstacle' && body.d >= RUNNER_STRUCTURE_D);
      for (const body of long) {
        const shape = STRUCTURES[body.kind as keyof typeof STRUCTURES];
        expect(shape, body.kind).toBeDefined();
        const inside = level.bodies.filter((other) => other.role !== 'collectible' && other.role !== 'player' && other !== body && other.d < RUNNER_STRUCTURE_D && Math.abs(other.z - body.z) * 2 < body.d);
        expect(inside, `${seed}: ${body.kind} at ${body.z / UNIT} m`).toEqual([]);
        const coins = level.bodies.filter((coin) => coin.role === 'collectible' && Math.abs(coin.z - body.z) * 2 < body.d + coin.d);
        expect(coins, `${seed}: coins in ${body.kind}`).toEqual([]);
      }
    }
  });

  it('bez `patterns` trať jako dřív: žádná stavba', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const level = runnerTrack.generate(seed, runnerTrack.params.parse({ sections: 3, feel: 2 }));
      expect(level.bodies.some((body) => body.d >= RUNNER_STRUCTURE_D)).toBe(false);
    }
    const kinds = new Set(Array.from({ length: 20 }, (_, seed) => runnerPatternTrack(seed + 1, params()).level.bodies.map((body) => body.kind)).flat());
    expect([...kinds].filter((kind) => kind in STRUCTURES).sort()).toEqual(['ceiling', 'divider', 'water']);
  });
});

describe('checkRunnerLevel – stavby', () => {
  const at = 60 * UNIT;
  it('hlásí stavbu přes všechny tři pruhy', () => {
    const level = levelOf([obstacle(0, at, 10 * UNIT, { w: 8000 })]);
    expect(checkRunnerLevel(level, 'normal').join()).toMatch(/closes all 3 lanes/);
  });

  it('strop nad hlavou pruh nezavře, nízký strop ano', () => {
    const high = levelOf([obstacle(0, at, 10 * UNIT, { kind: 'ceiling', w: 8000, y: STRUCTURES.ceiling.y, h: 600 })]);
    expect(checkRunnerLevel(high, 'normal')).toEqual([]);
    const low = levelOf([obstacle(0, at, 10 * UNIT, { kind: 'ceiling', w: 8000, y: 1000, h: 600 })]);
    expect(checkRunnerLevel(low, 'normal').join()).toMatch(/closes all 3 lanes/);
  });

  it('hlásí řadu uvnitř stavby i řadu těsně za ní', () => {
    const inside = levelOf([obstacle(0, at, 10 * UNIT), { ...obstacle(2000, at + 2 * UNIT, 300), kind: 'hurdle', w: 1600, h: 600 }]);
    expect(checkRunnerLevel(inside, 'normal').join()).toMatch(/closer than/);
    const close = levelOf([obstacle(0, at, 10 * UNIT), { ...obstacle(2000, at + 5 * UNIT + 3 * UNIT, 300), kind: 'hurdle', w: 1600, h: 600 }]);
    expect(checkRunnerLevel(close, 'normal').join()).toMatch(/closer than/);
    const fine = levelOf([obstacle(0, at, 10 * UNIT), { ...obstacle(2000, at + 5 * UNIT + 12 * UNIT, 300), kind: 'hurdle', w: 1600, h: 600 }]);
    expect(checkRunnerLevel(fine, 'normal')).toEqual([]);
  });
});

describe('sestavená hra na trati ze vzorů', () => {
  // Bez středu mezery stály ryba ve zdi rozcestí a kámen těsně za řadou: kořist 18/20, kámen dokázaný 15/20.
  it('kořist i padající kámen leží ve volné mezeře: 20 semínek chycená kořist a dokázaný kámen', () => {
    for (const kind of ['catch', 'hazard'] as const) {
      const spec = compileRecipe({ preset: 'assembled', move: 'run', actions: [], objective: 'reach', threats: kind === 'hazard' ? ['hazard'] : [],
        content: { genre: 'runner', mode: 'default', hero: 'seal', setting: 'snow' },
        parts: [{ kind, role: 'part_0', label: kind === 'hazard' ? 'rock' : 'fish', phase: 0, motion: 'fall' }] });
      expect((spec.controlParams as { patterns?: number }).patterns).toBe(1);
      for (let seed = 1; seed <= 20; seed += 1) {
        const built = arcadeWorldOf(spec, seed);
        if (!built.ok) throw new Error(built.issues.join('; '));
        if (kind === 'catch') {
          const run = runBot(built.world, ARCADE_LIBRARY, { roleBindings: built.roleBindings });
          expect(run.outcome === 'won' && run.witnesses.some((witness) => witness.verb === 'catch'), `catch/${seed}`).toBe(true);
        } else expect(verifyArcade(built.world, ARCADE_LIBRARY, built.roleBindings).witnesses.some((witness) => witness.verb === 'hazard'), `hazard/${seed}`).toBe(true);
      }
    }
  }, 120_000);
});

describe('hra žánru Běžec', () => {
  it('začátečník vyhraje 0,3–0,7, intermediate aspoň 0,9 (60 semínek)', () => {
    const spec = draftGameSpecWithMeta('A fox runs through the city at night dodging traffic cones', 1).spec;
    expect((spec.controlParams as { patterns?: number }).patterns).toBe(1);
    const wins = (seeds: number, profile: BotProfile) => {
      let won = 0;
      for (let seed = 1; seed <= seeds; seed += 1) {
        const made = arcadeWorldOf(spec, seed);
        if (!made.ok) throw new Error(made.issues.join('; '));
        if (runBot(made.world, ARCADE_LIBRARY, { profile }).outcome === 'won') won += 1;
      }
      return won;
    };
    // 60 semínek místo 20: na 20 kolísal podíl 0,25–0,70 podle drobné změny vah, na 60 je 34/60.
    const novice = wins(60, 'novice') / 60;
    expect(novice).toBeGreaterThanOrEqual(0.3);
    expect(novice).toBeLessThanOrEqual(0.7);
    expect(wins(60, 'intermediate') / 60).toBeGreaterThanOrEqual(0.9);
  }, 300_000);
});
