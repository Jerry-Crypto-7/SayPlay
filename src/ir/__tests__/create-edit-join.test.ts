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

import { commitPart, type Part } from '../revision';
import {
  LAYOUT_TYPES,
  WORLD_DOC_VERSION,
  canonical,
  canonicalHash,
  lookSchema,
  sealSimHash,
  simHashOf,
  simSchema,
  worldDocSchema,
  worldEmissionSchema,
  type WorldDoc,
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
 * Oracle je proto **zmrazený artefakt**: create tělo emitované do korpusu je svět,
 * editační patch je vydaný proti němu, a obě větve musí dojít do jednoho kontraktu.
 * Fixtura se tu nepoužívá k ničemu než k tomu, aby se ověřilo, že má tentýž tvar
 * jako korpus.
 */
describe('editační větev se proti zmrazenému korpusu skutečně spustí', () => {
  const edits = responses.filter((entry) => entry.branch === 'edit');
  const operationsOf = (entry: FrozenResponse) => entry.body as readonly Operation[];
  const pointersOf = (operation: Operation): readonly string[] =>
    'from' in operation ? [operation.path, operation.from] : [operation.path];

  /**
   * **Prefix se strhává TADY, ručně, a je to dluh vůči T22 — ne převod.**
   *
   * Všech 55 unikátních cest ve zmrazených editačních tělech je zakotvených
   * v dokumentu (`/sim/state/…`), zatímco `commitPart` klonuje `doc[part]`, takže
   * čeká cesty relativní k části (`/state/…`). Odvodit `part` z prefixu cesty je
   * náplň **T22** (router podle normalizovaných cest) a dělat to v produkční cestě
   * už teď by znamenalo napsat router dvakrát — jednou tady potichu a jednou tam
   * pořádně.
   *
   * Do té doby si ho tenhle test strhává sám a **říká to nahlas**: jakmile T22
   * stojí, tenhle helper zmizí a `commitPart` dostane cesty rovnou. Kdyby se místo
   * toho tiše schoval do produkčního kódu, měřilo by se potrubí, které nikdo
   * nenavrhl.
   *
   * `part` se odvozuje **z cesty, nikdy ze štítku** — a když cesta prefix nemá,
   * helper spadne, protože strhávat prefix, který tam není, je domněnka.
   */
  const DOCUMENT_ROOT = /^\/(sim|look)(?=\/)/;

  function partOfPointer(pointer: string, label: string): Part {
    const hit = DOCUMENT_ROOT.exec(pointer);
    if (hit === null)
      throw new Error(`${label}: "${pointer}" není zakotvená v dokumentu — strhnout prefix by tu byla domněnka`);
    return hit[1] as Part;
  }

  function rehomed(entry: FrozenResponse): { readonly part: Part; readonly operations: readonly Operation[] } {
    const parts = new Set<Part>();
    for (const operation of operationsOf(entry))
      for (const pointer of pointersOf(operation)) parts.add(partOfPointer(pointer, entry.forPrompt));

    // Smíšený patch se podle §7 dělí na dva; dokud ho korpus nenese, je jeho výskyt
    // signál, že se tenhle převod přestal trefovat, ne že se má domyslet.
    expect([...parts], `${entry.forPrompt}: patch míchá části dokumentu`).toHaveLength(1);
    const [part] = parts;

    const operations = operationsOf(entry).map((operation) => {
      const next = { ...(operation as unknown as Record<string, unknown>) };
      next.path = String(next.path).replace(DOCUMENT_ROOT, '');
      if (typeof next.from === 'string') next.from = next.from.replace(DOCUMENT_ROOT, '');
      return next as unknown as Operation;
    });
    return { part, operations };
  }

  /** Svět, proti kterému byl patch vydán — **zmrazená emise**, zapečetěná systémem. */
  function baseDocOf(entry: FrozenResponse): WorldDoc {
    const create = createEntries.find((candidate) => candidate.forPrompt === entry.baseWorld);
    if (create === undefined)
      throw new Error(`${entry.forPrompt}: baseWorld ${String(entry.baseWorld)} není ve zmrazeném korpusu`);

    // Emise `simHash` nenese — pečetí ho systém. Průchod `worldDocSchema` je
    // zároveň důkaz, že zmrazené tělo je skutečný dokument, ne jen podobný tvar.
    const sealed = sealSimHash(create.body as Record<string, unknown> & { sim: unknown });
    const parsed = worldDocSchema.safeParse(sealed);
    if (!parsed.success)
      throw new Error(`${String(entry.baseWorld)}: ${JSON.stringify(parsed.error.issues[0])}`);
    return parsed.data;
  }

  function commitEdit(entry: FrozenResponse) {
    const doc = baseDocOf(entry);
    const { part, operations } = rehomed(entry);
    const baseRevision = part === 'sim' ? doc.simRevision : doc.lookRevision;
    return { doc, part, result: commitPart(doc, { part, baseRevision, operations }) };
  }

  const fulfilled = edits.filter((entry) => entry.expectedVerdict === 'FULFILLED');

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
    // Kdyby jediná cesta přišla part-relativní, převod výš by ji nechal být a patch
    // by se aplikoval o úroveň vedle — tiše a se sedícím hashem.
    for (const pointer of pointers) expect(pointer, pointer).toMatch(/^\/sim\//);
  });

  it.each(fulfilled.map((entry) => [entry.forPrompt, entry] as const))(
    '%s (FULFILLED) se aplikuje na svůj `baseWorld` a commitne se do `sim`',
    (label, entry) => {
      const { doc, result } = commitEdit(entry);
      expect(result.verdict, `${label}: ${result.verdict === 'REJECTED' ? result.detail : ''}`).toBe('COMMITTED');
      if (result.verdict !== 'COMMITTED') return;

      // **Patch musel něco udělat.** Bez téhle aserce by prošel i patch, který se
      // aplikuje naprázdno — a „editace funguje" by znamenalo „nic se nerozbilo".
      expect(result.doc.simHash, label).not.toBe(doc.simHash);
      expect(result.doc.simRevision, label).toBe(doc.simRevision + 1);
      expect(result.doc.lookRevision, label).toBe(doc.lookRevision);
      // A výsledek je pořád dokument, ne jen aplikovaný diff.
      expect(simSchema.safeParse(result.doc.sim).success, label).toBe(true);
      expect(result.doc.simHash, label).toBe(simHashOf(result.doc));
    },
  );

  /**
   * Čtyři se neaplikují a **žádný z nich nemá deklarovaný verdikt `FULFILLED`**.
   * Důvody nejsou stejné a slévat je by zakrylo to zajímavější z nich:
   *
   * - **E06** (`FAULT`) a **E24** (`FAULT`) padají na **svém vlastním deklarovaném
   *   defektu** — `replace` na neexistující cestě, resp. `add` na cíl, jehož rodič
   *   ve světě není.
   * - **E19** (`ROBUST`) a **E20** (`NO_FIT`) padají na něčem jiném: jejich tělo
   *   počítá s kontejnerem tam, kde základní svět nese **skalár** (`add
   *   /sim/layout/levels/1` nad `layout.levels: 1`; `replace
   *   /sim/rules/patrol/actions/0/route` nad akcí bez `route`). Je to táž třída
   *   vady jako tvar `sim.rules`, kvůli které se korpus mrazil na v2 — jen zůstala
   *   neopravená, protože `CLAUDE.md` ji vede jako **nedořešený rozpor #4(a)**
   *   a AC T2b zakazuje měnit prompty i kontrakty. Ani bezchybná emise je nesplní.
   *
   * `evals/FROZEN_ANCHOR` u těch čtyř píše „zamítá je jejich vlastní deklarovaný
   * defekt" — pro E06 a E24 to sedí, pro E19 a E20 ne. Tenhle test je od toho, aby
   * ten rozdíl byl vidět a měřený, ne opsaný.
   */
  it('a právě čtyři se NEaplikují — ani jeden nemá deklarovaný verdikt `FULFILLED`', () => {
    const rejected = edits.filter((entry) => commitEdit(entry).result.verdict === 'REJECTED');
    expect(rejected.map((entry) => entry.forPrompt).sort()).toEqual(['E06', 'E19', 'E20', 'E24']);
    for (const entry of rejected) expect(entry.expectedVerdict, entry.forPrompt).not.toBe('FULFILLED');
  });

  it('a to znamená 21 z 25 aplikovatelných a 17 ze 17 u `FULFILLED`', () => {
    // Číslo, které `evals/FROZEN_ANCHOR` uvádí jako naměřený efekt přemrazení.
    // Do teď se dalo reprodukovat jen jednorázovým skriptem, který v repu nezůstal.
    const committed = edits.filter((entry) => commitEdit(entry).result.verdict === 'COMMITTED');
    expect(committed.length).toBe(21);
    expect(committed.filter((entry) => entry.expectedVerdict === 'FULFILLED').length).toBe(17);
  });

  /**
   * **Štítek o dráze nerozhoduje** — rozhoduje cesta.
   *
   * `DESIGN-BOOK.md` §7: nechat dráhu určit modelovým štítkem dělá z modelu
   * autoritu nad tím, co se bude verifikovat. Tady je to zatím jen konstatované
   * nad korpusem; vynucuje to router z **T22** a tohle jsou jeho offline kotvy.
   */
  it('štítek dráhy NErozhoduje — oba `look` patche míří celé pod `/sim`', () => {
    const mislabelled = edits.filter((entry) => entry.modelLabel === 'look');
    expect(mislabelled.map((entry) => entry.forPrompt)).toEqual(['E10', 'E24']);
    for (const entry of mislabelled) expect(rehomed(entry).part, entry.forPrompt).toBe('sim');

    // E10 je navíc `FULFILLED`, takže se ten špatně oštítkovaný patch musí
    // commitnout **do `sim`** — zvednout `simRevision`, ne `lookRevision`.
    const e10 = mislabelled.find((entry) => entry.forPrompt === 'E10');
    if (e10 === undefined) throw new Error('E10 zmizelo z korpusu');
    const { doc, result } = commitEdit(e10);
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') return;
    expect(result.part).toBe('sim');
    expect(result.doc.simRevision).toBe(doc.simRevision + 1);
    expect(result.doc.lookRevision).toBe(doc.lookRevision);
  });

  /**
   * **Fixtura se musí trefit do korpusu i tvarem `rules`.**
   *
   * Po přemrazení na `evals-frozen-v2` nese korpus `sim.rules` jako **záznam
   * klíčovaný stabilním `id`**. `synth.ts` ho do téhle úlohy stavěl jako **pole** —
   * poslední místo v repu, které si s kanonickým tvarem odporovalo. Schéma to
   * nechytí (vnitřek `sim` je záměrně `unknown`), takže rozdíl by přežil až do
   * chvíle, kdy by na fixtuře stál generátor patchů — a ten by adresoval indexy
   * tam, kde korpus adresuje jména.
   */
  it('a fixtura nese `sim.rules` v témže tvaru jako korpus — záznam, ne pole', () => {
    for (const create of createEntries) {
      const sim = create.body.sim as { rules?: unknown } | null;
      if (sim === null || sim === undefined) continue;
      expect(Array.isArray(sim.rules), `${create.forPrompt}: korpus`).toBe(false);
      expect(sim.rules, create.forPrompt).toBeTypeOf('object');
    }
    const fixture = synthWorld(20260812).sim as { rules: Record<string, { id: string }> };
    expect(Array.isArray(fixture.rules), 'synth.ts').toBe(false);
    // `id` uvnitř pravidla se rovná klíči — korpus to tak má a `references.ts` na tom stojí.
    for (const [key, rule] of Object.entries(fixture.rules)) expect(rule.id, key).toBe(key);
  });
});
