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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { commitPart } from '../revision';
import {
  LAYOUT_TYPES,
  WORLD_DOC_VERSION,
  canonical,
  canonicalHash,
  lookSchema,
  simHashOf,
  simSchema,
  worldDocSchema,
  worldEmissionSchema,
} from '../worlddoc';
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

/**
 * **Konformance proti ZMRAZENÉMU korpusu, ne proti vlastní fixtuře.**
 *
 * Tohle je ten test, který tady chyběl, a jeho absence stála celé kolo review:
 * první znění schématu žádalo `layout.type`, `grid.width/height` a `entities`
 * jako pole, zatímco zmrazené odpovědi nesou `layout.kind`, `grid.cell`
 * a `entities` jako záznam. **Ani jedna z patnácti** neprošla — a nikdo si toho
 * nevšiml, protože se validovala jen fixtura autorovaná ve stejném commitu.
 *
 * Fixtura, kterou si autor napsal k svému schématu, o schématu nedokazuje nic.
 * Zmrazený korpus je artefakt, který schéma nepsal.
 */
describe('zmrazený korpus projde schématem', () => {
  interface FrozenResponse {
    readonly branch: string;
    readonly forPrompt: string;
    readonly expectedVerdict: string;
    readonly body: Record<string, unknown>;
  }

  const responses: readonly FrozenResponse[] = readFileSync(
    join(process.cwd(), 'evals', 'frozen', 'responses', 'index.jsonl'),
    'utf8',
  )
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as FrozenResponse);

  const creates = responses.filter((entry) => entry.branch === 'create');
  const byVerdict = (verdict: string) => creates.filter((entry) => entry.expectedVerdict === verdict);

  it('korpus má tři třídy a jejich počty sedí', () => {
    // Kdyby se rozpad tříd změnil, dělily by se testy níž na jiné množině, než
    // pro kterou byly napsané.
    expect(creates.length).toBe(15);
    expect(byVerdict('FULFILLED').length).toBe(7);
    expect(byVerdict('ROBUST').length).toBe(6);
    expect(byVerdict('NO_FIT').length).toBe(2);
  });

  it.each(byVerdict('FULFILLED').map((entry) => [entry.forPrompt, entry] as const))(
    '%s (FULFILLED) projde emisním schématem i oběma částmi',
    (label, entry) => {
      const emission = worldEmissionSchema.safeParse(entry.body);
      expect(emission.success, `${label}: ${JSON.stringify(emission.error?.issues[0])}`).toBe(true);
      expect(simSchema.safeParse(entry.body.sim).success, label).toBe(true);
      expect(lookSchema.safeParse(entry.body.look).success, label).toBe(true);
    },
  );

  it('`NO_FIT` naopak NEPROJDE — nenese žádný svět, `sim` je `null`', () => {
    for (const entry of byVerdict('NO_FIT')) {
      expect(entry.body.sim, entry.forPrompt).toBeNull();
      expect(worldEmissionSchema.safeParse(entry.body).success, entry.forPrompt).toBe(false);
    }
  });

  /**
   * Dva `ROBUST` záznamy neprojdou a **je to informace, ne vada**: nesou klíče,
   * které přidává potrubí kolem světa, ne model uvnitř něj — C12 `refusedBeforeModel`
   * (prázdný prompt odmítnutý PŘED voláním modelu, tělo je systémový default,
   * §13.4), C13 `sim.entityCap`.
   *
   * Zmrazený protokol má `additionalPropertiesAllowed: false` na obou částech,
   * takže **schéma se kvůli nim rozvolnit nesmí** — pak by přestalo hlídat to,
   * kvůli čemu existuje. Pin je tady proto, aby ta volba byla vidět a aby si
   * nikdo nepletl „schéma je špatně" s „tenhle záznam není čistá emise".
   */
  it('dva `ROBUST` záznamy nesou anotace potrubí, a schéma se kvůli nim nerozvolní', () => {
    const rejected = byVerdict('ROBUST')
      .filter((entry) => !worldEmissionSchema.safeParse(entry.body).success)
      .map((entry) => entry.forPrompt);
    expect(rejected.sort()).toEqual(['C12', 'C13']);

    // A zbytek `ROBUST` projde — kdyby ne, byla by to vada schématu, ne anotace.
    for (const entry of byVerdict('ROBUST')) {
      if (rejected.includes(entry.forPrompt)) continue;
      expect(worldEmissionSchema.safeParse(entry.body).success, entry.forPrompt).toBe(true);
    }
  });

  it('a nesou verzi dokumentu, ne verzi sníženého IR', () => {
    // `types.ts` má `IR_VERSION = 'world-ir-v1'`, což verzuje snížené IR. Splést
    // je znamená odmítnout každou zmrazenou emisi.
    for (const entry of creates) expect(entry.body.irVersion, entry.forPrompt).toBe(WORLD_DOC_VERSION);
  });

  it('emise NEnese `simHash` — ten pečetí systém, ne model', () => {
    for (const entry of creates) expect(entry.body, entry.forPrompt).not.toHaveProperty('simHash');
  });

  it('a každý deklarovaný typ layoutu je v `LAYOUT_TYPES`, včetně `maze`', () => {
    // `maze` je v `layoutTypeIs` a v kontraktu C08, ale ne ve `fieldNotes`.
    // Zmrazený soubor si odporuje; rozhodují živé artefakty — a `maze` se
    // v korpusu skutečně vyskytuje.
    const kinds = new Set<string>();
    for (const entry of creates) {
      const sim = entry.body.sim as { layout?: { kind?: unknown } } | null;
      const kind = sim?.layout?.kind;
      if (typeof kind !== 'string') continue;
      kinds.add(kind);
      expect(LAYOUT_TYPES as readonly string[], entry.forPrompt).toContain(kind);
    }
    expect(kinds.has('maze'), 'korpus `maze` nepoužívá — pak by ten spor nebyl doložený').toBe(true);
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
