/**
 * Tvorba a editace jsou **dvě větve jednoho kontraktu**.
 *
 * Tvorba vydá celý `WorldDoc`, editace vydá patch proti revizi — a pokud je to
 * opravdu jeden kontrakt, musí obě cesty dojít do **bitově téhož** dokumentu.
 * To je celý oracle: `applyPatch(worldA, patch)` dá tentýž `simHash` jako přímo
 * sestavený `worldB`.
 *
 * Generátor je **syntetický**. Review v2 (Q3) na tom trvalo: se skutečnou generací
 * by rovnost nebyla deterministická a test by měřil model místo potrubí.
 */

import { describe, expect, it } from 'vitest';

import { commitPart } from '../revision';
import { canonical, canonicalHash, simHashOf, worldDocSchema } from '../worlddoc';
import { synthPair, synthWorld } from '../__fixtures__/synth';

const SEEDS = [20260812, 1, 424242, 7, 999983];

describe('patchovaná a přímo sestavená větev se sejdou', () => {
  it.each(SEEDS)('seed %i: hash po patchi se rovná hashi sestaveného světa', (seed) => {
    const { worldA, operations, worldB } = synthPair(seed);

    const result = commitPart(worldA, { part: 'sim', baseRevision: worldA.simRevision, operations });
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') return;

    expect(result.doc.simHash).toBe(worldB.simHash);
    // A nejen hash — celá část `sim` musí být kanonicky totožná, jinak by shoda
    // hashů mohla být kolizí místo rovnosti.
    expect(canonical(result.doc.sim)).toBe(canonical(worldB.sim));
    expect(result.doc.simRevision).toBe(worldB.simRevision);
  });

  it('a `worldB` je sestavený nezávisle — jinak by se test porovnával sám se sebou', () => {
    // Kdyby `worldB` vznikl aplikací patche, prošlo by i tehdy, kdyby patch
    // dělal něco úplně jiného, než co má. Ověřuje se to tak, že `worldB` už
    // před patchem NESE očekávanou hodnotu, kterou `worldA` nemá.
    const { worldA, worldB } = synthPair(20260812);
    expect(worldA.simHash).not.toBe(worldB.simHash);
    expect(worldB.sim.sockets).toHaveProperty('s_side');
    expect(worldA.sim.sockets).not.toHaveProperty('s_side');
  });

  it('různé seedy dávají různé světy — jinak by pět běhů měřilo jeden', () => {
    const hashes = new Set(SEEDS.map((seed) => synthWorld(seed).simHash));
    expect(hashes.size).toBeGreaterThan(1);
  });
});

describe('syntetický svět je platný dokument, ne jen tvar', () => {
  it.each(SEEDS)('seed %i projde schématem a jeho `simHash` sedí na obsah', (seed) => {
    const world = synthWorld(seed);
    expect(worldDocSchema.safeParse(world).success).toBe(true);
    expect(world.simHash).toBe(simHashOf(world));
  });

  it('generátor je deterministický — týž seed dá bitově týž svět', () => {
    // Bez toho by padající test nešlo zopakovat.
    for (const seed of SEEDS) expect(canonical(synthWorld(seed))).toBe(canonical(synthWorld(seed)));
  });
});

describe('kanonický hash nezávisí na pořadí klíčů', () => {
  it('týž obsah zapsaný jinak dá tentýž hash', () => {
    const world = synthWorld(20260812);
    const reordered = {
      look: world.look,
      sim: { ...world.sim },
      simHash: world.simHash,
      lookRevision: world.lookRevision,
      simRevision: world.simRevision,
      irVersion: world.irVersion,
    };
    expect(canonicalHash(reordered)).toBe(canonicalHash(world));
  });

  it('ale jiný obsah dá jiný hash', () => {
    const world = synthWorld(20260812);
    expect(canonicalHash({ ...world, simRevision: 9 })).not.toBe(canonicalHash(world));
  });
});
