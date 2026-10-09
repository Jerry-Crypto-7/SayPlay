/**
 * Čísla zábavy ze stopy běhu (P45A T4–T6) na ručně složených stopách: čísla
 * spočtená v testu, ne opsaná z výstupu. P45B/C/D se podle nich slučují bez
 * lidského oka – posunutá hodnota, která vypadá rozumně, tu musí zčervenat.
 */

import { describe, expect, it } from 'vitest';

import { ROLE, UNIT } from '@/play/arcade/contract';
import { type RunTrace, SAMPLE_TICKS, type TraceBody, type TraceEvent, type TraceEventKind, type TraceSample, funMetrics } from '@/play/arcade/telemetry';

const HZ = 60;
const PLAYER = 0;

/** Hráč stojí v počátku; každá hrozba jde po ose x přes vzdálenosti v metrech, jeden vzorek po `SAMPLE_TICKS`. */
function samples(threats: readonly { body: number; role?: number; born?: number; metres: readonly (number | null)[] }[]): TraceSample[] {
  const length = Math.max(...threats.map((t) => t.metres.length));
  return Array.from({ length }, (_, i) => ({
    tick: i * SAMPLE_TICKS,
    player: { x: 0, y: 0, z: 0, h: UNIT },
    bodies: threats.flatMap((t): TraceBody[] => {
      const m = t.metres[i];
      return m === null || m === undefined ? [] : [{ body: t.body, role: t.role ?? ROLE.chaser, born: t.born ?? 0, x: Math.round(m * UNIT), y: 0, z: 0, h: UNIT, vx: 0, vz: 0, hp: 0 }];
    }),
  }));
}

function withSamples(s: TraceSample[], events: readonly [tick: number, kind: TraceEventKind][] = [], outcome: RunTrace['outcome'] = 'won'): RunTrace {
  return {
    ticks: (s.length - 1) * SAMPLE_TICKS,
    outcome,
    hash: 'test',
    player: PLAYER,
    events: events.map(([tick, kind]): TraceEvent => ({ tick, kind, body: kind === 'kill' ? 1 : PLAYER, role: kind === 'kill' ? ROLE.enemy : ROLE.player })),
    samples: s,
  };
}

function trace(ticks: number, events: readonly [tick: number, kind: TraceEventKind][], outcome: RunTrace['outcome'] = 'won'): RunTrace {
  return {
    ticks,
    outcome,
    hash: 'test',
    player: 0,
    events: events.map(([tick, kind]): TraceEvent => ({ tick, kind, body: 1, role: ROLE.collectible })),
    samples: [],
  };
}

describe('funMetrics – pacing', () => {
  it('counts events per second of run, not per tick', () => {
    // 30 s běhu, 15 sebrání.
    const t = trace(30 * HZ, Array.from({ length: 15 }, (_, i) => [i * 2 * HZ + HZ, 'pickup'] as [number, TraceEventKind]));
    expect(funMetrics(t).eventsPerS).toBe(0.5);
  });

  it('folds a score into the event of the same tick', () => {
    const t = trace(10 * HZ, [[HZ, 'pickup'], [HZ, 'score'], [5 * HZ, 'score']]);
    // Sebrání se skóre v témže tiku je jedna událost, samotné skóre (rytmus) je událost.
    expect(funMetrics(t).eventsPerS).toBe(0.2);
  });

  it('measures the gaps from the start of the run to its end', () => {
    // Události v 2 s a 4 s, běh 20 s: mezery 2, 2, 16.
    const t = trace(20 * HZ, [[2 * HZ, 'pickup'], [4 * HZ, 'kill']]);
    const m = funMetrics(t);
    expect(m.longestGapS).toBe(16);
    expect(m.medianGapS).toBe(2);
  });

  it('counts the start of the run as the edge of the first gap', () => {
    // První událost až v 9 s: nejdelší mezera je úvod, ne konec.
    const t = trace(12 * HZ, [[9 * HZ, 'pickup'], [10 * HZ, 'pickup'], [11 * HZ, 'pickup']]);
    expect(funMetrics(t).longestGapS).toBe(9);
  });

  it('does not let the win itself close the last gap', () => {
    const t = trace(20 * HZ, [[2 * HZ, 'pickup'], [20 * HZ - 1, 'win']]);
    expect(funMetrics(t).longestGapS).toBe(18);
  });

  it('gives a run with no event one gap as long as the run', () => {
    const m = funMetrics(trace(30 * HZ, []));
    expect(m.longestGapS).toBe(30);
    expect(m.medianGapS).toBe(30);
    expect(m.eventsPerS).toBe(0);
  });

  it('compares the last third of the run with the first third of the same run', () => {
    // 60 s běhu: první třetina (0–20 s) 2 události, poslední (40–60 s) 6.
    const first = [[5 * HZ, 'pickup'], [15 * HZ, 'pickup']] as [number, TraceEventKind][];
    const last = Array.from({ length: 6 }, (_, i) => [41 * HZ + i * 3 * HZ, 'kill'] as [number, TraceEventKind]);
    const m = funMetrics(trace(60 * HZ, [...first, [30 * HZ, 'hit'], ...last]));
    expect(m.intensityRatio).toBe(3);
    expect(m.rising).toBe(true);
  });

  it('reads the thirds from the run length, not from the 90 s horizon', () => {
    // 30 s běhu: první třetina 0–10 s má 1 událost, poslední 20–30 s má 2. Při horizontu 90 s by obě padly do první třetiny.
    const m = funMetrics(trace(30 * HZ, [[5 * HZ, 'pickup'], [25 * HZ, 'pickup'], [28 * HZ, 'pickup']]));
    expect(m.intensityRatio).toBe(2);
    expect(m.rising).toBe(true);
  });

  it('has no ratio when the first third is empty, and a falling run is not rising', () => {
    const empty = funMetrics(trace(30 * HZ, [[25 * HZ, 'pickup']]));
    expect(empty.intensityRatio).toBeNull();
    expect(empty.rising).toBe(true);
    const falling = funMetrics(trace(30 * HZ, [[1 * HZ, 'pickup'], [2 * HZ, 'pickup'], [25 * HZ, 'pickup']]));
    expect(falling.intensityRatio).toBe(0.5);
    expect(falling.rising).toBe(false);
    expect(funMetrics(trace(30 * HZ, [])).rising).toBe(false);
  });
});

describe('funMetrics – danger', () => {
  it('counts a threat that comes within 1.5 m and leaves without a hit as one near miss', () => {
    expect(funMetrics(withSamples(samples([{ body: 1, metres: [4, 3, 1, 3, 4] }]))).nearMisses).toBe(1);
  });

  it('does not count an episode in which the player is hit', () => {
    // Hrozba je uvnitř ve vzorku 2 (tik 12), ven ve vzorku 3 (tik 18); zásah v tiku 14.
    expect(funMetrics(withSamples(samples([{ body: 1, metres: [4, 3, 1, 3, 4] }]), [[14, 'damage']])).nearMisses).toBe(0);
  });

  it('counts a threat that stays inside for a second once, and once again for a second entry', () => {
    const stays = [4, ...Array.from({ length: 10 }, () => 1), 4];
    expect(funMetrics(withSamples(samples([{ body: 1, metres: stays }]))).nearMisses).toBe(1);
    expect(funMetrics(withSamples(samples([{ body: 1, metres: [4, 1, 4, 1, 4] }]))).nearMisses).toBe(2);
  });

  it('measures the radius in kernel units: 1.2 m is close, 2 m is not', () => {
    expect(funMetrics(withSamples(samples([{ body: 1, metres: [4, 1.2, 4] }]))).nearMisses).toBe(1);
    expect(funMetrics(withSamples(samples([{ body: 1, metres: [4, 2, 4] }]))).nearMisses).toBe(0);
  });

  it('does not count a body born inside the radius or one that vanished inside it', () => {
    // Vlastní střela hráče vznikne u něj a odletí; nepřítel zabitý v dosahu ven nevyšel.
    const s = samples([{ body: 2, role: ROLE.projectile, born: 6, metres: [null, 0.5, 3, 6] }, { body: 1, metres: [4, 1, null, null] }]);
    expect(funMetrics(withSamples(s)).nearMisses).toBe(0);
  });

  it('tells two bodies in one reused slot apart', () => {
    // Slot 1: první tělo vejde a zmizí uvnitř, nové tělo (zrozené v tiku 18) vejde a vyjde.
    const s = samples([{ body: 1, metres: [4, 1, null, null, null, null] }]);
    const reborn = samples([{ body: 1, born: 18, metres: [null, null, null, 4, 1, 4] }]);
    const merged = s.map((sample, i) => ({ ...sample, bodies: [...sample.bodies, ...(reborn[i]?.bodies ?? [])] }));
    expect(funMetrics(withSamples(merged)).nearMisses).toBe(1);
  });

  it('counts lives lost, kills and whether the player died', () => {
    const s = samples([{ body: 1, metres: [4, 4, 4, 4] }]);
    const m = funMetrics(withSamples(s, [[3, 'damage'], [9, 'damage'], [10, 'kill'], [12, 'kill'], [15, 'kill']], 'lost'));
    expect(m.livesLost).toBe(2);
    expect(m.kills).toBe(3);
    expect(m.playerDied).toBe(true);
    expect(funMetrics(withSamples(s)).playerDied).toBe(false);
  });
});

/** Tělo s dráhou v metrech `[x, z]` po vzorcích (null = ve vzorku chybí); hráč stojí v počátku. */
type Path = { body: number; role?: number; born?: number; hp?: readonly number[]; v?: readonly [number, number]; at: readonly ([number, number] | null)[] };

function paths(bodies: readonly Path[]): TraceSample[] {
  const length = Math.max(...bodies.map((b) => b.at.length));
  return Array.from({ length }, (_, i) => ({
    tick: i * SAMPLE_TICKS,
    player: { x: 0, y: 0, z: 0, h: UNIT },
    bodies: bodies.flatMap((b): TraceBody[] => {
      const p = b.at[i];
      if (p === null || p === undefined) return [];
      return [{ body: b.body, role: b.role ?? ROLE.chaser, born: b.born ?? 0, x: Math.round(p[0] * UNIT), y: 0, z: Math.round(p[1] * UNIT), h: UNIT, vx: (b.v?.[0] ?? 0) * UNIT, vz: (b.v?.[1] ?? 0) * UNIT, hp: b.hp?.[i] ?? 0 }];
    }),
  }));
}

/** Přímá dráha z `from` do `to` po `n` vzorcích. */
const line = (from: [number, number], to: [number, number], n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / (n - 1), from[1] + ((to[1] - from[1]) * i) / (n - 1)]);

function run(s: TraceSample[], events: readonly TraceEvent[] = [], outcome: RunTrace['outcome'] = 'won', ticks = (s.length - 1) * SAMPLE_TICKS): RunTrace {
  return { ticks, outcome, hash: 'test', player: PLAYER, events, samples: s };
}

const hitOn = (body: number, tick: number, role: number = ROLE.enemy): TraceEvent => ({ tick, kind: 'hit', body, role });

describe('funMetrics – behaviours', () => {
  it('gives two chasers of the same role one behaviour', () => {
    const s = paths([{ body: 1, at: line([10, 0], [2, 0], 9) }, { body: 2, at: line([0, 10], [0, 2], 9) }]);
    const m = funMetrics(run(s));
    expect(m.behaviours).toEqual(['chaser:chase']);
    expect(m.behaviourCount).toBe(1);
  });

  it('tells a static, a roaming and a chasing body apart', () => {
    const s = paths([
      { body: 1, role: ROLE.hazard, at: line([5, 5], [5.2, 5], 9) },
      { body: 2, role: ROLE.enemy, at: line([5, -5], [5, 5], 9) },
      { body: 3, role: ROLE.enemy, at: line([-8, 0], [-2, 0], 9) },
    ]);
    const m = funMetrics(run(s));
    expect(m.behaviours).toEqual(['enemy:chase', 'enemy:roam', 'hazard:static']);
    expect(m.behaviourCount).toBe(3);
  });

  it('marks a body born after the start as spawned', () => {
    const s = paths([{ body: 1, at: line([10, 0], [2, 0], 9) }, { body: 4, born: 12, at: [null, null, ...line([10, 0], [4, 0], 7)] }]);
    expect(funMetrics(run(s)).behaviours).toEqual(['chaser:chase', 'chaser:chase+spawned']);
  });

  it("counts an enemy projectile as a shot and leaves the player's own shot out", () => {
    // Nepřátelská střela přiletí z dálky k hráči; vlastní vznikne u hráče a letí od něj.
    const enemyShot = { body: 5, role: ROLE.projectile, born: 6, v: [-0.5, 0] as [number, number], at: [null, ...line([12, 0], [4, 0], 5)] };
    const ownShot = { body: 6, role: ROLE.projectile, born: 6, v: [0, 0.5] as [number, number], at: [null, ...line([0, 1], [0, 9], 5)] };
    expect(funMetrics(run(paths([ownShot]))).behaviours).toEqual([]);
    expect(funMetrics(run(paths([enemyShot, ownShot]))).behaviours).toEqual(['projectile:shot+spawned']);
  });
});

describe('funMetrics – finale', () => {
  const boss = (hits: number, end: 'kill' | 'hp0' | 'gone' | 'alive'): RunTrace => {
    const n = 20;
    const hp = Array.from({ length: n }, () => 3);
    if (end === 'hp0') hp[n - 1] = 0;
    const at = Array.from({ length: n }, (): [number, number] | null => [3, 0]);
    if (end === 'gone' || end === 'kill') at[n - 1] = null;
    const events: TraceEvent[] = Array.from({ length: hits }, (_, i) => hitOn(1, 10 + i * 6));
    if (end === 'kill') events.push({ tick: (n - 1) * SAMPLE_TICKS - 1, kind: 'kill', body: 1, role: ROLE.enemy });
    return run(paths([{ body: 1, role: ROLE.enemy, hp, at }]), events, 'lost');
  };

  it('finds a boss: a threat hit three times that is gone by the end', () => {
    expect(funMetrics(boss(3, 'kill')).finale).toEqual({ present: true, why: 'boss' });
    expect(funMetrics(boss(3, 'gone')).finale).toEqual({ present: true, why: 'boss' });
    // Souboj v aréně: poražený zůstane ve hře s HP 0.
    expect(funMetrics(boss(3, 'hp0')).finale).toEqual({ present: true, why: 'boss' });
  });

  it('does not take a threat hit twice, or one still standing, for a boss', () => {
    expect(funMetrics(boss(2, 'kill')).finale).toEqual({ present: false, why: null });
    expect(funMetrics(boss(5, 'alive')).finale).toEqual({ present: false, why: null });
  });

  it('does not add up hits on two bodies that shared a slot', () => {
    // Slot 1: první tělo dostane 2 zásahy a zmizí, nové (zrozené v tiku 30) 1 zásah a zmizí.
    const s = paths([{ body: 1, at: [[3, 0], [3, 0], [3, 0], [3, 0], null, null, null, null] }]);
    const reborn = paths([{ body: 1, born: 30, at: [null, null, null, null, null, [3, 0], [3, 0], null] }]);
    const merged = s.map((sample, i) => ({ ...sample, bodies: [...sample.bodies, ...(reborn[i]?.bodies ?? [])] }));
    const events = [hitOn(1, 2, ROLE.chaser), hitOn(1, 8, ROLE.chaser), hitOn(1, 32, ROLE.chaser)];
    expect(funMetrics(run(merged, events, 'won')).finale.why).not.toBe('boss');
  });

  /** Běh `seconds` s se zásahy po celou dobu jednou za 2 s a v posledních 10 s navíc `burst` sebrání. */
  const paced = (seconds: number, burst: number, outcome: RunTrace['outcome']): RunTrace => {
    const steady = Array.from({ length: Math.floor(seconds / 2) }, (_, i) => [i * 2 * HZ + 1, 'pickup'] as [number, TraceEventKind]);
    const late = Array.from({ length: burst }, (_, i) => [(seconds - 10) * HZ + 7 + i * 20, 'pickup'] as [number, TraceEventKind]);
    return trace(seconds * HZ, [...steady, ...late], outcome);
  };

  it('finds a climax in a won run whose last 10 s are 1.5x denser than the run', () => {
    // 60 s: 30 + 12 událostí, průměr 0,7/s; posledních 10 s: 5 + 12 = 1,7/s ≥ 1,05.
    expect(funMetrics(paced(60, 12, 'won')).finale).toEqual({ present: true, why: 'climax' });
    // Bez nárůstu: posledních 10 s 0,5/s proti průměru 0,5/s.
    expect(funMetrics(paced(60, 0, 'won')).finale.present).toBe(false);
  });

  it('gives a lost run no climax, and a run of 10 s or less none', () => {
    expect(funMetrics(paced(60, 12, 'lost')).finale.present).toBe(false);
    expect(funMetrics(paced(10, 12, 'won')).finale.present).toBe(false);
  });
});
