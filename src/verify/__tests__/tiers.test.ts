/**
 * Tier politika — **horizont deklaruje systém, ne model**.
 *
 * `DESIGN-BOOK.md` §6: *„Kdyby si ho deklaroval model, projde verifikací
 * triviálně: prohlásí horizont tak dlouhý, že vyhraje i náhodná procházka."*
 * Testy se proto neptají, jestli tabulka obsahuje správná čísla — to je jen
 * opsání konstant. Ptají se, jestli **neexistuje cesta, kterou by si žádost
 * horizont zvedla**.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REQUEST,
  TIERS,
  TIER_POLICY,
  isTier,
  resolvePolicy,
  smallestTierFor,
} from '../tiers';

describe('tier tabulka je monotónní a odvozená z 20 Hz', () => {
  it('delší tier má delší horizont i vyšší strop vstupů', () => {
    for (let i = 1; i < TIERS.length; i += 1) {
      const shorter = TIER_POLICY[TIERS[i - 1]];
      const longer = TIER_POLICY[TIERS[i]];
      expect(longer.maxHorizonTicks).toBeGreaterThan(shorter.maxHorizonTicks);
      expect(longer.maxInputs).toBeGreaterThan(shorter.maxInputs);
    }
  });

  it('a klíč tabulky se shoduje s tierem uvnitř — jinak by se dala prohodit', () => {
    for (const tier of TIERS) expect(TIER_POLICY[tier].tier).toBe(tier);
  });

  it('výchozí žádost je nejkratší tier, ne nejdelší', () => {
    // Kdyby default byl `long`, každý svět bez vlastní žádosti by dostal
    // třikrát delší horizont, aniž by o něj kdo požádal.
    expect(DEFAULT_REQUEST.tier).toBe('short');
    expect(DEFAULT_REQUEST.horizonTicks).toBe(TIER_POLICY.short.maxHorizonTicks);
  });
});

describe('žádost si horizont nezvedne', () => {
  it('horizont přesně na stropu projde, o jeden vyšší je `NO_FIT`', () => {
    for (const tier of TIERS) {
      const max = TIER_POLICY[tier].maxHorizonTicks;
      expect(resolvePolicy({ tier, horizonTicks: max })?.tier, tier).toBe(tier);
      expect(resolvePolicy({ tier, horizonTicks: max + 1 }), tier).toBeNull();
    }
  });

  it('a `NO_FIT` se NEPOVÝŠÍ do delšího tieru, i když by tam vešel', () => {
    // 1 000 tiků by `standard` unesl. Žádost ale zněla na `short`, takže se
    // odmítne — povýšení podle přání dokumentu je přesně ta autorita, kterou §6
    // modelu upírá.
    expect(smallestTierFor(1_000)).toBe('standard');
    expect(resolvePolicy({ tier: 'short', horizonTicks: 1_000 })).toBeNull();
  });

  it('horizont nad stropem nejdelšího tieru nemá kam jít', () => {
    expect(smallestTierFor(TIER_POLICY.long.maxHorizonTicks + 1)).toBeNull();
    expect(resolvePolicy({ tier: 'long', horizonTicks: 10_000 })).toBeNull();
  });

  it('vrácená politika je vždy politika ŽÁDANÉHO tieru, ne dopočítaná', () => {
    for (const tier of TIERS)
      expect(resolvePolicy({ tier, horizonTicks: 1 })).toEqual(TIER_POLICY[tier]);
  });
});

describe('nesmyslná žádost je `NO_FIT`, ne tichá oprava', () => {
  const nonsense = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

  it.each(nonsense)('horizont %p', (horizonTicks) => {
    expect(resolvePolicy({ tier: 'short', horizonTicks })).toBeNull();
    expect(smallestTierFor(horizonTicks)).toBeNull();
  });

  it('neznámý tier taky — a `isTier` to pozná bez pomoci překladače', () => {
    expect(isTier('epic')).toBe(false);
    expect(isTier('short')).toBe(true);
    expect(resolvePolicy({ tier: 'epic' as never, horizonTicks: 10 })).toBeNull();
  });
});
