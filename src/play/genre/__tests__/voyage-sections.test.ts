/**
 * Plavba ve třetinách (P36A T4, část 3b): závod nové hry trvá perfektnímu
 * robotovi 30–90 s a ke konci houstne – v poslední třetině trati stojí
 * překážky blíž u sebe a dělové koule letí rychleji než v první.
 *
 * Co by vypadalo dobře a bylo špatně: trať je delší, ale stejně řídká až do
 * cíle (jen víc téhož); nebo hustší konec robot neprojede a hra nevyjde. A
 * uložená hra bez úseků by se po změně přehrála jinak.
 */

import { describe, expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { compileArcade } from '@/play/arcade/compile';
import { ARCADE_HZ, type ArcadeWorld, BODY, HEADER, ROLE, bodyBase } from '@/play/arcade/contract';
import { instantiate, replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

function publish(spec: GameSpecV1, sentence: string): { world: ArcadeWorld; winSeconds: number; idle: string } {
  for (const seed of derivedSeeds(seedFrom(sentence))) {
    const compiled = compileArcade(spec, seed);
    if (!compiled.ok) continue;
    const { arcade: world, winsAtTick } = compiled.value;
    if (world == null || winsAtTick === null) continue;
    return { world, winSeconds: winsAtTick / ARCADE_HZ, idle: replay(world, [], ARCADE_LIBRARY).outcome };
  }
  throw new Error(`${sentence}: no seed publishes`);
}

describe('voyage race in thirds', () => {
  // Houstnutí je vidět jen na rovince, kam se vejdou dvě překážky: na trati „boat race through a jungle river…“
  // má poslední třetina jen krátké rovinky s jednou překážkou, takže tam se rozestup změřit nedá.
  it.each(['fly a paper plane through a house'])('%s: 30–90 s for the robot, an idle player loses, the last third is denser and faster', (sentence) => {
    const spec = draftGameSpecWithMeta(sentence, 1).spec;
    expect(spec.genre?.id).toBe('voyage');
    const { world, winSeconds, idle } = publish(spec, sentence);
    expect(winSeconds).toBeGreaterThanOrEqual(30);
    expect(winSeconds).toBeLessThanOrEqual(90);
    expect(idle).toBe('lost');

    const { length } = world;
    const state = instantiate(world);
    const hazards = Array.from({ length: state[HEADER.bodyCount] as number }, (_, i) => bodyBase(i))
      .filter((base) => state[base + BODY.role] === ROLE.hazard)
      .map((base) => ({ z: state[base + BODY.z] as number, vx: state[base + BODY.vx] as number }))
      .sort((a, b) => a.z - b.z);
    const third = (z: number) => Math.min(2, Math.floor((3 * z) / length));
    const inThird = (k: number) => hazards.filter((body) => third(body.z) === k);
    // Rozestup sousedních překážek na téže rovince (bez skoků přes zatáčku) a nejrychlejší koule třetiny.
    const gaps = (k: number) => inThird(k).flatMap((body, i, all) => (i === 0 || body.z - all[i - 1]!.z > 25_000 ? [] : [body.z - all[i - 1]!.z]));
    const fastest = (k: number) => Math.max(...inThird(k).filter((body) => body.vx !== 0).map((body) => Math.abs(body.vx)));
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    expect(gaps(0).length).toBeGreaterThan(0);
    expect(gaps(2).length).toBeGreaterThan(0);
    expect(median(gaps(2))).toBeLessThan(median(gaps(0)));
    expect(fastest(2)).toBeGreaterThan(fastest(0));
  });
});

/**
 * Uložené závody z `play-compiler-v9` (bez úseků, výchozích 350 m): semínko
 * a tik výhry robota změřené tehdy v `evals/play/p36/depth.json`.
 */
const STORED = [
  { sentence: 'only up but in a candy land', seed: 583061281, tick: 1374 },
  { sentence: 'boat race through a jungle river full of crocodiles', seed: 2142346050, tick: 1374 },
] as const;

describe('stored voyage races without sections', () => {
  it.each(STORED)('$sentence: same seed, the robot wins on the same tick', ({ sentence, seed, tick }) => {
    const spec = draftGameSpecWithMeta(sentence, 1).spec;
    const { lengthM: _length, tuning, ...rest } = spec.controlParams as { lengthM?: number; tuning: Record<string, unknown> };
    const { sections: _sections, ...oldTuning } = tuning;
    const compiled = compileArcade({ ...spec, controlParams: { ...rest, tuning: oldTuning } } as GameSpecV1, seed);
    if (!compiled.ok) throw new Error(compiled.issues.join('; '));
    expect(compiled.value.winsAtTick).toBe(tick);
  });
});
