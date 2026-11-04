/**
 * P54C T3: „No playable assembly: assembled.ball“ ze sondy 19. 10. Na živé cestě
 * (`POST /api/play/games` nad `next start`) všech šest vět hraje míč – chyba
 * byla jen v synchronní sondě bez načteného Rapieru (`evals/play/p54c/ball-path.json`).
 * Každá cesta serveru, která návrh staví, Rapier napřed čeká (`games/route.ts`,
 * `director/index.ts`); bez něj návrh nahlas odmítne, nikdy tiše nehraje jinou hru.
 */

import { describe, expect, it } from 'vitest';

import { loadRapier, rapierIfLoaded } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft/draft';

// Golfové věty sondy hrají od P70B T2 minigolf (`genre/__tests__/p70b-golf.test.ts`); míč drží zbylé tři.
const SENTENCES = [
  'basketball free throws',
  'a hedgehog rolls down a mushroom hill',
  'play football and score goals',
];

describe('ball sentences on the draft path', () => {
  it('without the physics engine the draft refuses loudly instead of playing another game', () => {
    expect(rapierIfLoaded()).toBeNull();
    expect(() => draftGameSpecWithMeta(SENTENCES[0]!, 1)).toThrow(/No playable assembly/);
  });

  it('with Rapier loaded, as every server path does, every sentence drafts a ball game', async () => {
    await loadRapier();
    for (const sentence of SENTENCES) expect(draftGameSpecWithMeta(sentence, 1).spec.control, sentence).toBe('ball');
  });
});
