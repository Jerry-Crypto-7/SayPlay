/**
 * Lano a příšera v načasování (P71C T3): věta „cut the rope…“ se hraje, jak ji
 * hra pustí v prohlížeči – relace s čekáním na první ťuk a jeho spolknutím, robot
 * zahraný „rukou“ jako `handPlay('end')` sondy v `ArcadePlay.tsx`.
 */

import { describe, expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { compileArcade } from '@/play/arcade/compile';
import { ARCADE_LIMITS, type ArcadeWorld } from '@/play/arcade/contract';
import { propModels } from '@/play/arcade/models';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

import { type ArcadeSession, createArcadeSession } from '../session';

const SENTENCES = [
  'cut the rope at the right moment to feed the monster',
  'tap at the right time to stop the moving platform',
  'stack pancakes as high as you can',
] as const;

/** Jako dveře publikace: první semínko, na kterém robot ověřovače vyhraje. */
function published(sentence: string): ArcadeWorld {
  const spec = draftGameSpecWithMeta(sentence, 1).spec;
  for (const seed of derivedSeeds(seedFrom(sentence))) {
    const compiled = compileArcade(spec, seed);
    if (compiled.ok && compiled.value.arcade != null && compiled.value.winsAtTick !== null) return compiled.value.arcade;
  }
  throw new Error(`${sentence}: no seed publishes`);
}

/** `handPlay('end')`: restart a záznam robota tik po tiku cestou klávesnice. */
function byHand(session: ArcadeSession): string {
  const inputs = session.botInputs();
  session.restart();
  let next = 0;
  while (session.snapshot().runState === 'running' && session.snapshot().tick < ARCADE_LIMITS.maxTicks) {
    const tick = session.snapshot().tick;
    while (next < inputs.length && inputs[next]!.tick < tick) next += 1;
    const event = inputs[next]?.tick === tick ? inputs[next] : undefined;
    session.hold(event?.axis ?? 0);
    session.press(event?.buttons ?? 0);
    session.stepOnce();
  }
  return session.snapshot().runState;
}

describe('timing in the browser session (P71C T3)', () => {
  it.each(SENTENCES)('"%s": the robot played by hand wins', (sentence) => {
    const session = createArcadeSession(published(sentence), { waitForInput: true, swallowFirst: true });
    expect(byHand(session)).toBe('won');
  });
});

describe('cut the rope draws what it feeds (P71C T3)', () => {
  const roleOf = (spec: GameSpecV1, id: string) => spec.roles.find((role) => role.id === id)?.label;

  it.each([
    ['cut the rope at the right moment to feed the monster', 'candy', 'monster'],
    ['cut the rope to feed the candy to the frog', 'candy', 'frog'],
  ])('"%s": a %s hangs over the %s, both with a model', (sentence, piece, eater) => {
    const { spec } = draftGameSpecWithMeta(sentence, 1);
    expect(roleOf(spec, 'block')).toBe(piece);
    expect(roleOf(spec, 'finish')).toBe(eater);
    // TimingScene kreslí lano a příšeru jen s oběma modely (`hang`).
    expect(propModels(spec)).toEqual(expect.objectContaining({ block: expect.any(String), finish: expect.any(String) }));
    expect(spec.tutorial?.controlsHint).toBe('Tap or Space to cut the rope.');
  });

  it.each(['tap at the right time to stop the moving platform', 'build a bridge at the right time'])('"%s": no rope without a thing to deliver', (sentence) => {
    const { spec } = draftGameSpecWithMeta(sentence, 1);
    expect(spec.tutorial?.controlsHint).not.toContain('rope');
    expect(propModels(spec).finish).toBeUndefined();
  });
});
