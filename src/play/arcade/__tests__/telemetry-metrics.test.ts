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
