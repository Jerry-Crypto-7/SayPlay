/**
 * Ukázková hra vstupní stránky (P28D T7): když feed nemá co hrát, hraje se
 * tahle – deterministický návrh z pevné věty, zkompilovaný a commitnutý, bez
 * živého modelu. Test ji staví znovu a drží commitnutý soubor u kódu, který
 * ji umí postavit (`vitest -u` ji přepíše).
 */

import { describe, expect, it } from 'vitest';

import { compileArcade } from '@/play/arcade/compile';
import { draftGameSpec } from '@/play/draft';

import demo from '../demo-game.json';

const DEMO_SENTENCE = 'A fox runs through the city dodging taxis and collecting coins.';

function build() {
  const spec = draftGameSpec(DEMO_SENTENCE);
  for (let seed = 1; seed <= 8; seed += 1) {
    const compiled = compileArcade(spec, seed);
    if (compiled.ok) return { sentence: DEMO_SENTENCE, seed, spec, arcade: compiled.value.arcade };
  }
  throw new Error('the demo sentence does not compile to a winnable arcade game');
}

describe('ukázková hra', () => {
  it('je běžec z pevné věty a commitnutý soubor odpovídá dnešnímu kompilátoru', async () => {
    const built = build();
    expect(built.spec.control).toBe('runner');
    await expect(`${JSON.stringify(built, null, 1)}\n`).toMatchFileSnapshot('../demo-game.json');
    expect(demo.sentence).toBe(DEMO_SENTENCE);
  });
});
