/**
 * Měřidlo rozmanitosti P46D (T1). Měřidlo, které by počítalo jiný model nebo
 * barvu jako jiný tvar, ukáže rozmanitost, kterou hráč necítí – test drží, že
 * dnešní běžec dá na dvou semínkách téže věty vzdálenost ≈ 0, že výměna modelů
 * podpis nepohne a že ručně různé tratě dají 1.
 */

import { describe, expect, it } from 'vitest';

import type { ArcadeWorld } from '@/play/arcade/contract';
import { ROLE } from '@/play/arcade/contract';
import { arcadeWorldOf } from '@/play/arcade/compile';
import type { GameSpecV1 } from '@/play/spec';

import { SHAPE_THRESHOLD, type ShapeBody, bodiesOf, draftOf, handBuiltRunners, shapeDistance, signatureOf, signatureOfBodies, trackPathOf, varietySentences } from '../variety';

/**
 * Dnešní běžec (P45, `491079b7`): parametry, které žánr Běžec píše bez počtů z věty.
 * Pevně, ať test drží dnešní trať i poté, co nový tvar dostane nový parametr.
 */
const todayRunner = (spec: GameSpecV1, overhead = false): GameSpecV1 => ({
  ...spec,
  controlParams: { obstacles: overhead ? ['hurdle', 'slide-bar', 'cone', 'crate'] : ['hurdle', 'cone', 'crate'], feel: 2, sections: 3 },
});

function world(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const runners = varietySentences().filter((sentence) => sentence.genre === 'runner');

describe('track variety gauge', () => {
  it('gives two seeds of the same sentence on today\'s runner a distance of about 0', () => {
    expect(runners).toHaveLength(4);
    for (const sentence of runners) {
      const spec = todayRunner(draftOf(sentence.text));
      const [a, b, c] = [11, 4242, 90_001].map((seed) => signatureOf(world(spec, seed), 'runner'));
      expect(shapeDistance(a!, b!), sentence.id).toBeLessThanOrEqual(0.05);
      expect(shapeDistance(b!, c!), sentence.id).toBeLessThanOrEqual(0.05);
    }
  });

  it('does not count another model, kind name or obstacle footprint as another shape', () => {
    const made = world(todayRunner(draftOf(runners[0]!.text), true), 7);
    const renamed: ArcadeWorld = { ...made, kinds: made.kinds.map((kind, index) => `shopping-cart-${index}`) };
    expect(shapeDistance(signatureOf(made, 'runner'), signatureOf(renamed, 'runner'))).toBe(0);
    // Kužel za bednu (jiná stopa, táž překážka „jen jiným pruhem“), kámen za vozík.
    const bodies = bodiesOf(made);
    const swapped: ShapeBody[] = bodies.map((body) => (body.role === ROLE.obstacle && body.h > 1000 ? { ...body, w: 1400, d: 1400 } : body));
    expect(shapeDistance(signatureOfBodies('runner', bodies, made.length), signatureOfBodies('runner', swapped, made.length))).toBe(0);
  });

  it('gives hand-built tracks with no shared pattern a distance of 1 and reads their patterns', () => {
    const { a, b, length } = handBuiltRunners();
    const sa = signatureOfBodies('runner', a, length);
    const sb = signatureOfBodies('runner', b, length);
    expect(sa.motifs).toEqual(['zigzag', 'jump-chain', 'slide-alley']);
    expect(sb.motifs).toEqual(expect.arrayContaining(['bridge', 'fork', 'trail', 'sprint']));
    expect(sb.forks).toBe(1);
    expect(shapeDistance(sa, sb)).toBe(1);
    expect(shapeDistance(sa, sa)).toBe(0);
    expect(SHAPE_THRESHOLD).toBeGreaterThan(0.05);
    expect(SHAPE_THRESHOLD).toBeLessThan(1);
  });

  it('counts a bent or lifted runner track and ignores a straight, flat one', () => {
    const { a, length } = handBuiltRunners();
    const plain = signatureOfBodies('runner', a, length);
    const straight = signatureOfBodies('runner', a, length, () => ({ x: 0, y: 0 }));
    expect(straight).toEqual(plain);
    const bent = signatureOfBodies('runner', a, length, (z) => ({ x: Math.round(8000 * Math.sin(z / 40_000)), y: Math.round(3000 * Math.sin(z / 25_000)) }));
    expect(bent.curve).toContain('L');
    expect(bent.height).toContain('U');
    expect(shapeDistance(plain, bent)).toBeGreaterThan(SHAPE_THRESHOLD);
  });

  it('reads the bend and lift the scene draws on a runner, in world units, and none on a platform level', () => {
    const made = world(draftOf(runners[0]!.text), 11);
    const shape = signatureOf(made, 'runner', trackPathOf(made));
    expect(shape.curve.some((token) => token !== 'S')).toBe(true);
    expect(shape.height.some((token) => token !== 'F')).toBe(true);
    const platform = varietySentences().find((sentence) => sentence.genre === 'platform')!;
    expect(trackPathOf(world(draftOf(platform.text), 11))).toBeUndefined();
  });
});
