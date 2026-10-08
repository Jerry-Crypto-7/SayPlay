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

import type { Operation } from 'rfc6902';
import { describe, expect, it } from 'vitest';

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

interface FrozenResponse {
  readonly branch: string;
  readonly forPrompt: string;
  readonly expectedVerdict: string;
  /** Tvorba nese celý dokument, editace pole RFC 6902 operací. */
  readonly body: unknown;
  /** Jen u editace: `forPrompt` tvorby, proti které byl patch vydán. */
  readonly baseWorld?: string;
  /** Jen u editace: dráha, kterou si **model myslí**. Nerozhoduje o ničem. */
  readonly modelLabel?: string;
}

const responses: readonly FrozenResponse[] = readFileSync(
  join(process.cwd(), 'evals', 'frozen', 'responses', 'index.jsonl'),
  'utf8',
)
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line) as FrozenResponse);

describe('patchovaná a přímo sestavená větev se sejdou', () => {
  it('a `worldB` je sestavený nezávisle — jinak by se test porovnával sám se sebou', () => {
    // Kdyby `worldB` vznikl aplikací patche, prošlo by i tehdy, kdyby patch
    // dělal něco úplně jiného, než co má. Ověřuje se to tak, že `worldB` už
    // před patchem NESE očekávanou hodnotu, kterou `worldA` nemá.
    const { worldA, worldB } = synthPair(20260812);
    expect(worldA.simHash).not.toBe(worldB.simHash);
    expect(worldB.sim.sockets).toHaveProperty('side');
    expect(worldA.sim.sockets).not.toHaveProperty('side');
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

  /**
   * **Fixtura se musí jmenovat stejně jako korpus.**
   *
   * Schéma má vnitřek otevřený, takže rozdíl v názvech polí neshodí nic — a přesně
   * tak fixtura celé jedno kolo nesla vymyšlené `layout.type` a `grid.width`,
   * zatímco korpus má `layout.kind` a `grid.cell`. Fixtura je to, co příští autor
   * zkopíruje; když se rozejde s korpusem, rozejde se i on. Tenhle test je ta
   * regresní pojistka, která u realignmentu chyběla.
   */
  it('a jmenuje pole stejně jako zmrazený korpus, ne po svém', () => {
    const world = synthWorld(20260812);
    const sim = world.sim as Record<string, Record<string, unknown>>;
    const look = world.look as Record<string, unknown>;

    expect(Object.keys(sim.layout)).toContain('kind');
    expect(Object.keys(sim.layout)).not.toContain('type');
    expect(Object.keys(sim.grid)).toEqual(['cell']);
    // `entities` je ZÁZNAM podle `stableId`, ne pole.
    expect(Array.isArray(sim.entities)).toBe(false);
    // Svědek nese tier a meze, ne jen operace.
    expect(Object.keys(sim.witness)).toEqual(
      expect.arrayContaining(['tier', 'H_cert', 'L_witness', 'K_input', 'ops']),
    );
    // `look`: paleta, světlo a atmosféra jsou v korpusu ŘETĚZCE, ne struktury.
    expect(typeof look.palette).toBe('string');
    expect(typeof look.lightRig).toBe('string');
    expect(typeof look.atmosphere).toBe('string');
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
type CreateResponse = FrozenResponse & { readonly body: Record<string, unknown> };

const createEntries = responses.filter(
  (entry): entry is CreateResponse => entry.branch === 'create',
);

describe('zmrazený korpus projde schématem', () => {
  const creates = createEntries;
  const byVerdict = (verdict: string) => creates.filter((entry) => entry.expectedVerdict === verdict);
  const bodyOf = (label: string): Record<string, unknown> => {
    const entry = creates.find((candidate) => candidate.forPrompt === label);
    if (!entry) throw new Error(`create záznam ${label} v korpusu není`);
    return entry.body;
  };

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
   * §13.4), C13 `sim.entityCap` **i kořenové `clampedFrom`**; každý z těch dvou
   * klíčů by C13 shodil sám, takže se pinují oba.
   *
   * Pin je **odebráním, ne přítomností**: `toBeDefined()` by řeklo jen že klíč
   * v těle je, ne že odmítnutí způsobil on. Test proto klíč odstraní z kopie
   * a čeká opačný verdikt — to je jediná forma, kterou tvrzení výš unese.
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

    // C12 shodí jediný klíč: bez něj tělo schématem projde.
    const c12 = structuredClone(bodyOf('C12'));
    expect(c12.refusedBeforeModel).toBeDefined();
    delete c12.refusedBeforeModel;
    expect(worldEmissionSchema.safeParse(c12).success, 'C12 bez refusedBeforeModel').toBe(true);

    // C13 shodí každý z těch dvou klíčů sám — po odebrání jednoho se pořád
    // odmítá, projde teprve bez obou.
    const withoutCap = structuredClone(bodyOf('C13'));
    delete (withoutCap.sim as Record<string, unknown>).entityCap;
    expect(worldEmissionSchema.safeParse(withoutCap).success, 'C13 bez sim.entityCap').toBe(false);

    const withoutClamped = structuredClone(bodyOf('C13'));
    delete withoutClamped.clampedFrom;
    expect(worldEmissionSchema.safeParse(withoutClamped).success, 'C13 bez clampedFrom').toBe(false);

    const withoutBoth = structuredClone(bodyOf('C13'));
    delete (withoutBoth.sim as Record<string, unknown>).entityCap;
    delete withoutBoth.clampedFrom;
    expect(worldEmissionSchema.safeParse(withoutBoth).success, 'C13 bez obou').toBe(true);

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

/**
 * **Editační větev proti ZMRAZENÉMU korpusu — uzavírací podmínka T12.**
 *
 * Až sem se tenhle soubor ptal jen na tvorbu (`branch === 'create'`) a spojení
 * obou větví dokazoval přes `synthPair`, tedy přes fixturu autorovanou ve stejném
 * commitu. Všechna kritéria T12 tím procházela a úloha přitom **míjela vlastní
 * účel**: „spojit tvorbu a editaci" se na datech, která ten kód nepsal, neprokázalo
 * ani jednou. Je to doslova ta past, kterou tenhle projekt zaplatil už dvakrát —
 * jednou u T8b a jednou tak, jak to popisuje `worlddoc.ts` („0 z 15 … protože se
 * validovaly jen fixtury autorované ve stejném commitu").
 *
 * Commit editace (`commitPart`) odešel se starým studiem (P44D T7); zůstává tvar
 * editačních záznamů zmrazeného korpusu a shoda fixtury s korpusem.
 */
describe('editační větev se proti zmrazenému korpusu skutečně spustí', () => {
  const edits = responses.filter((entry) => entry.branch === 'edit');
  const operationsOf = (entry: FrozenResponse) => entry.body as readonly Operation[];
  const pointersOf = (operation: Operation): readonly string[] =>
    'from' in operation ? [operation.path, operation.from] : [operation.path];

  it('editační záznam nese POUZE patch — proto se rovnost světů dokazovat nedá', () => {
    // Docblock bloku tvrdí, že korpus nemá cílové tělo, proti kterému by šlo
    // porovnávat. Tady je to měřené: tělo editačního záznamu je pole operací.
    for (const entry of edits) expect(Array.isArray(entry.body), entry.forPrompt).toBe(true);
  });

  it('korpus má 25 editačních záznamů a jejich verdikty sedí', () => {
    // Kdyby se rozpad tříd změnil, dělily by se testy níž na jiné množině, než
    // pro kterou byly napsané — tatáž pojistka jako u create větve.
    expect(edits.length).toBe(25);
    const byVerdict = (verdict: string) => edits.filter((entry) => entry.expectedVerdict === verdict).length;
    expect(byVerdict('FULFILLED')).toBe(17);
    expect(byVerdict('ROBUST')).toBe(3);
    expect(byVerdict('FAULT')).toBe(3);
    expect(byVerdict('NO_FIT')).toBe(2);
  });

  it('všech 68 operací je zakotvených v DOKUMENTU — proto si test prefix strhává sám', () => {
    const pointers = edits.flatMap((entry) => operationsOf(entry).flatMap(pointersOf));
    expect(edits.reduce((count, entry) => count + operationsOf(entry).length, 0)).toBe(68);
    // Korpus je celý `/sim`.
    for (const pointer of pointers) expect(pointer, pointer).toMatch(/^\/sim\//);
    expect(new Set(pointers).size).toBe(55);
  });

  /**
   * **Fixtura se musí trefit do korpusu i tvarem `rules`.**
   *
   * Po přemrazení na `evals-frozen-v2` nese korpus `sim.rules` jako **záznam
   * klíčovaný stabilním `id`**. `synth.ts` ho do téhle úlohy stavěl jako **pole**,
   * stejně jako čtyři fixtury v `references.test.ts` — obojí převedeno. Schéma
   * rozdíl nechytí (vnitřek `sim` je záměrně `unknown`), takže by přežil až do
   * chvíle, kdy by na fixtuře stál generátor patchů — a ten by adresoval indexy
   * tam, kde korpus adresuje jména.
   */
  it('a fixtura nese `sim.rules` v témže tvaru jako korpus — záznam, ne pole', () => {
    let bodiesWithRules = 0;
    let rulesChecked = 0;
    for (const create of createEntries) {
      // C14 a C15 jsou `NO_FIT` a nesou `sim: null` — klíč tam JE, hodnota je
      // `null` (asertováno výš u `NO_FIT`). Proto `=== null`, ne `=== undefined`.
      const sim = create.body.sim as { rules?: unknown } | null;
      if (sim === null || sim === undefined || sim.rules === undefined) continue;
      expect(Array.isArray(sim.rules), `${create.forPrompt}: korpus`).toBe(false);
      expect(sim.rules, create.forPrompt).toBeTypeOf('object');

      // **`id == klíč` se nad korpusem MĚŘÍ, ne opisuje.** Předchozí znění tvrdilo
      // „13 z 13, nula neshod" v komentáři a asertovalo to jen nad fixturou
      // o jednom pravidle — tedy zrovna ten invariant, o který jde, byl jediné
      // místo, kde blok opisoval místo aby měřil.
      bodiesWithRules += 1;
      for (const [id, rule] of Object.entries(sim.rules as Record<string, { id?: unknown }>)) {
        expect(rule.id, `${create.forPrompt}.rules.${id}`).toBe(id);
        rulesChecked += 1;
      }
    }
    // Počítá se to, co jméno říká: těla, která `rules` SKUTEČNĚ nesou. 15 emisí,
    // 13 s pravidly. Druhý čítač hlídá, že smyčka uvnitř nejela naprázdno —
    // bez něj by `13` prošlo i nad třinácti prázdnými záznamy pravidel.
    expect(bodiesWithRules).toBe(13);
    expect(rulesChecked).toBe(31);
    const fixture = synthWorld(20260812).sim as { rules: Record<string, { id: string }> };
    expect(Array.isArray(fixture.rules), 'synth.ts').toBe(false);

    // **`id` uvnitř pravidla se rovná klíči, protože to tak má KORPUS** — všech 13
    // create těl nesoucích `sim.rules`, nula neshod. Produkční konzument na tom
    // nestojí: `ruleEntries` (`references.ts`) bere u záznamu klíč přes
    // `Object.entries` a `rule.id` čte **jen** ve větvi pro pole. Fixtura se tedy
    // drží korpusu, ne implementace — což je celý smysl tohohle testu.
    for (const [key, rule] of Object.entries(fixture.rules)) expect(rule.id, key).toBe(key);
  });
});
