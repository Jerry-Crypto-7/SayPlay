/**
 * Zahazování akcí po jedné (P47B T7). Recept se dvěma akcemi, z nichž robot dokáže jen
 * jednu, dá hru s tou jednou – ne hru bez obou. Ověření tu má dvojníka, který skutečný
 * verdikt (svět i robot skutečné) jen u jedné akce prohlásí za nedokázanou; věta bez akcí
 * projde stejným počtem pokusů jako před T7.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { extractIntent } from '@/play/intent/extract';

import { compose } from '../compose';

const double = vi.hoisted(() => ({ unprove: undefined as string | undefined, calls: 0 }));

vi.mock('@/play/arcade/verify', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/play/arcade/verify')>();
  return {
    ...real,
    verifyArcade: (...args: Parameters<typeof real.verifyArcade>) => {
      double.calls += 1;
      const verdict = real.verifyArcade(...args);
      const verb = double.unprove;
      if (verb === undefined || !verdict.verbs.some((proof) => proof.verb === verb)) return verdict;
      return {
        ...verdict,
        publishEligible: false,
        verbs: verdict.verbs.map((proof) => (proof.verb === verb ? { ...proof, fired: false, changed: false } : proof)),
        failures: [...verdict.failures, `verbs_proved: VERB_UNPROVED:${verb} – no rule with the verb "${verb}" fired while the bot played`],
      };
    },
  };
});

beforeAll(async () => {
  await loadRapier();
});

beforeEach(() => {
  double.unprove = undefined;
  double.calls = 0;
});

describe('P47B T7: compose drops an unprovable ability alone', () => {
  // Věta testu P46A T8 (aréna se sběrem): krádež a dash.
  const TWO = 'A raccoon grabs pizza slices while dodging trash trucks';

  it('two abilities with dash unprovable give the game with grab only', () => {
    expect(compose(extractIntent(TWO)).spec.abilities).toEqual(['grab', 'dash']);
    double.unprove = 'dash';
    const made = compose(extractIntent(TWO), 2);
    expect(made.spec.abilities).toEqual(['grab']);
    // Vyřazený pokus s oběma akcemi zůstane v `issues`.
    expect(made.issues.some((issue) => issue.includes('VERB_UNPROVED:dash'))).toBe(true);
  }, 300_000);

  it('with grab unprovable the dash stays', () => {
    double.unprove = 'grab';
    expect(compose(extractIntent(TWO), 3).spec.abilities).toEqual(['dash']);
  }, 300_000);

  it('a sentence without abilities takes as many attempts as before T7', () => {
    const made = compose(extractIntent('A bee collects pollen in a garden'), 4);
    expect(made.spec.abilities).toBeUndefined();
    expect(double.calls).toBe(1);
  }, 300_000);
});
