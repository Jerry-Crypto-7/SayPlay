/**
 * Dvoudílný `WorldDoc` — **uvnitř hashe je jen to, co může rozhodnout o výhře**.
 *
 * `DESIGN-BOOK.md` §13.1 a zmrazený `protocol.v1.json` dělí dokument na `sim`
 * (topologie, mřížka, sockety, deklarované AABB, entity, pravidla, stav, svědek)
 * a `look` (moduly, paleta, světlo, atmosféra, materiálové role, kamera, zvuk).
 * `sim` je uvnitř hashe a ověřuje ho replay svědka; `look` je mimo hash a ověřuje
 * ho **rozpočtový validátor, nikdy verifikátor svědka**.
 *
 * Kdyby `look` do hashe vstupoval, tvar meshe by ovlivnil dosažitelnost výhry a
 * každá vzhledová úprava by zneplatnila certifikát. Proto se hash počítá
 * **výhradně ze `sim`** a je to tvrzení, které má vlastní test.
 *
 * **Kořen IR není `sim`.** Tuhle otázku odložilo T8b a T9 na „rozhodnout před
 * T12"; rozhoduje ji sám zmrazený protokol: `look.doesNotLowerToIr: true` dává
 * smysl jen tehdy, když `sim` do IR **snižuje**. Jsou to tedy dvě reprezentace
 * téhož — povrchové `sim`, které emituje model, a snížené IR, které čte
 * verifikátor — a seznam polí `sim` kořen IR nesvazuje. Zmrazený seznam platí
 * pro povrch, a přesně ten popisuje tenhle soubor.
 */

import { z } from 'zod';

/**
 * Verze **dokumentu**, ne sníženého IR.
 *
 * Zmrazený korpus nese `irVersion: "v1"` — jsou to dvě různé věci a splést je
 * znamená odmítnout každou zmrazenou emisi: `types.ts` má `IR_VERSION =
 * 'world-ir-v1'`, což verzuje **snížené** IR, které čte verifikátor. Povrchový
 * dokument, který emituje model, se verzuje tímhle.
 */
export const WORLD_DOC_VERSION = 'v1';

/** Pole `sim`, doslova ze zmrazeného protokolu. Pořadí je jeho, ne naše. */
export const SIM_FIELDS = [
  'layout',
  'grid',
  'sockets',
  'collisionAabb',
  'entities',
  'rules',
  'state',
  'witness',
] as const;

/** Pole `look`, doslova ze zmrazeného protokolu. */
export const LOOK_FIELDS = [
  'modules',
  'palette',
  'lightRig',
  'atmosphere',
  'materialRoles',
  'camera',
  'audio',
] as const;

/**
 * Topologie scény podle §13.3. Model ji emituje, systém ji jen validuje.
 *
 * **Zmrazený soubor si tu odporuje a je to zapsané, ne zahlazené:**
 * `sim.fieldNotes.layout` jmenuje pět typů, `layoutTypeIs` jich jmenuje šest —
 * navíc `maze`. Rozhodují **živé artefakty**: kontrakt C08 má požadavek
 * `layoutTypeIs: "maze"` s `nonVacuous: true` a jeho zmrazená odpověď má
 * `expectedVerdict: FULFILLED`. Užší varianta by tedy udělala C08 nesplnitelným
 * a offline distribuční bránu nedosažitelnou konstrukcí. Platí šest.
 */
export const LAYOUT_TYPES = ['grid', 'ring', 'corridor', 'tower', 'cave', 'maze'] as const;

const finiteInt = z.int();

/**
 * `sim` a `look` — **kořen je uzavřený, vnitřek otevřený**.
 *
 * Zmrazený protokol mrazí seznam **kořenových polí** a `additionalProperties:
 * false`; hlubší tvar výslovně odkládá (`layout` naplňuje P5 T506, `look`
 * generátor rodin taky). Typovat vnitřek podle vlastní představy znamená rozejít
 * se se zmrazeným korpusem — a přesně to se tady jednou stalo: první znění
 * žádalo `layout.type`, `grid.width/height` a `entities` jako pole, zatímco
 * korpus nese `layout.kind`, `grid.cell` a `entities` jako záznam. **0 z 15**
 * zmrazených emisí prošlo, aniž si toho kterýkoli test všiml, protože se
 * validovaly jen fixtury autorované ve stejném commitu.
 *
 * Proto `z.unknown()` uvnitř a `.strict()` v kořeni — a proto konformanční test
 * nad **zmrazeným korpusem**, ne nad vlastní fixturou. Ten je tu tím skutečným
 * oraclem; schéma samo umí jen jména.
 */
/**
 * Pole musí být **přítomné a nesmí být `undefined`**.
 *
 * Samotné `z.unknown()` je v objektu volitelné, takže `{op:'replace', path:
 * '/witness', value: undefined}` projde — a `canonical` položky s `undefined`
 * vyfiltruje, takže i hash sedne. Dokument bez svědka by se tak zapečetil,
 * zmigroval a tvářil se aktuální, přestože svědek je ten artefakt, který replay
 * ověřuje. Otevřít vnitřek je správně; zapomenout přitom na přítomnost není.
 */
const present = z.unknown().nonoptional();

export const simSchema = z
  .object({
    layout: present,
    grid: present,
    sockets: present,
    collisionAabb: present,
    entities: present,
    rules: present,
    state: present,
    witness: present,
  })
  .strict();

export const lookSchema = z
  .object({
    modules: present,
    palette: present,
    lightRig: present,
    atmosphere: present,
    materialRoles: present,
    camera: present,
    audio: present,
  })
  .strict();

/**
 * Dokument, jak ho **emituje model** — bez `simHash`.
 *
 * Hash počítá systém ze `sim`, ne model; kdyby ho emitoval, prohlásil by si sám
 * identitu své vlastní části. Zmrazené odpovědi ho proto nenesou.
 */
export const worldEmissionSchema = z
  .object({
    irVersion: z.string(),
    simRevision: finiteInt.min(0),
    lookRevision: finiteInt.min(0),
    sim: simSchema,
    look: lookSchema,
  })
  .strict();

/** Dokument, jak ho drží systém — se zapečetěným `simHash`. */
export const worldDocSchema = z
  .object({
    irVersion: z.string(),
    simRevision: finiteInt.min(0),
    lookRevision: finiteInt.min(0),
    simHash: z.string(),
    sim: simSchema,
    look: lookSchema,
  })
  .strict();

export type SimPart = z.infer<typeof simSchema>;
export type LookPart = z.infer<typeof lookSchema>;
export type WorldDoc = z.infer<typeof worldDocSchema>;

// ---------------------------------------------------------------------------
// Hash — výhradně ze `sim`
// ---------------------------------------------------------------------------

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Kanonická serializace: klíče objektů **seřazené**, žádné mezery.
 *
 * Bez toho by hash závisel na pořadí, ve kterém klíče vznikly, takže dokument
 * s týmž obsahem by měl dva různé hashe podle toho, kudy se do paměti dostal.
 * Pole si pořadí drží — u nich je pořadí součástí obsahu.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

/**
 * FNV-1a nad kanonickou serializací. Tentýž algoritmus jako `sim/hash.ts` nad
 * zabaleným stavem — jedna hashovací rodina, ať se neudržují dvě.
 */
export function canonicalHash(value: unknown): string {
  const text = canonical(value);
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    hash = Math.imul(hash ^ (code & 0xff), FNV_PRIME);
    hash = Math.imul(hash ^ ((code >>> 8) & 0xff), FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Hash dokumentu — **jen ze `sim`**.
 *
 * Bere `doc.sim` a nic jiného. Ne `doc`, ne `doc` bez `look`: kdyby se hashovalo
 * odečítáním, každé nové pole v kořeni by se do hashe dostalo samo a tvrzení
 * „vzhled hash nemění" by tiše přestalo platit.
 */
export function simHashOf(doc: { readonly sim: unknown }): string {
  return canonicalHash(doc.sim);
}

/** Dokument s dopočítaným `simHash`. Jediná cesta, jak ho nastavit. */
export function sealSimHash<T extends { readonly sim: unknown }>(doc: T): T & { simHash: string } {
  return { ...doc, simHash: simHashOf(doc) };
}

// ---------------------------------------------------------------------------
// Validace `look` — validátor, NIKDY verifikátor
// ---------------------------------------------------------------------------

export interface LookVerdict {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/**
 * `look` prochází schématem a **konečností všech čísel**, ne verifikátorem.
 *
 * §7: *„Sémanticky neodmítá, technicky ano."* Vzhled se nesmí odmítnout proto,
 * že se nelíbí; musí se odmítnout, když je technicky vadný. `NaN` a `Infinity`
 * jsou přesně ten případ — projdou typem `number`, ale rozbijí stavbu geometrie
 * až za hranicí, kde už se nedá vrátit nic než prázdná obrazovka.
 *
 * Rozpočty z §13.2 tady **nejsou** a je to záměr, ne opomenutí: `p1Status` je
 * má až v P5. Tenhle validátor v P1 dělá schéma a konečnost.
 */
/**
 * Nekonečná a `NaN` čísla, kdekoli ve stromu.
 *
 * Platí pro **obě** části a pro `sim` to platí naléhavěji: `JSON.stringify` je
 * převádí na `null`, takže `NaN`, `Infinity` i skutečné `null` **kolabují na
 * tentýž kanonický zápis a tedy na tentýž `simHash`**. Dokument by prošel
 * migrací jako platný (hash by seděl na svou vlastní `sim`), a po průchodu
 * uložištěm nebo sítí by se sémantika změnila, zatímco kotva certifikátu by
 * zůstala stejná. To není kolize po narozeninovém paradoxu — je to determinis­tický
 * kolaps dosažitelný jednou operací.
 */
export function nonFiniteNumbers(value: unknown, path = ''): string[] {
  if (typeof value === 'number')
    return Number.isFinite(value) ? [] : [`${path}: ${String(value)} is not finite`];
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => nonFiniteNumbers(item, `${path}/${i}`));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    nonFiniteNumbers(item, `${path}/${key}`),
  );
}

export function validateLook(look: unknown): LookVerdict {
  const parsed = lookSchema.safeParse(look);
  if (!parsed.success)
    return { ok: false, issues: parsed.error.issues.map((issue) => `schema:/${issue.path.join('/')}: ${issue.message}`) };

  const issues = nonFiniteNumbers(parsed.data, '');
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Verzování a migrace — mezera §11.3
// ---------------------------------------------------------------------------

export interface MigrationVerdict {
  readonly ok: boolean;
  readonly doc: WorldDoc | null;
  readonly reason: string;
}

/**
 * Migrace dokumentu na aktuální `irVersion`.
 *
 * §11.3 je mezera a tohle je její **poctivá** podoba: migrace buď vyrobí svět
 * s nově ověřeným svědkem, nebo svět **explicitně odmítne**. Co nesmí, je přijmout
 * ho mlčky — certifikát vydaný nad starou sémantikou o nové netvrdí nic, a svět,
 * který se tváří platně a nikdo ho neověřil, je horší než svět odmítnutý.
 *
 * V P1 existuje **jediná** verze, takže žádná migrační cesta neexistuje a psát ji
 * dopředu by byla fikce. Implementované je proto rozhodovací místo: shoda projde,
 * neshoda se odmítne jménem verze. Až druhá verze vznikne, přibude sem převod —
 * a spolu s ním povinnost vyrobit nového svědka, ne převzít starého.
 */
export function migrateWorldDoc(input: unknown): MigrationVerdict {
  const parsed = worldDocSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, doc: null, reason: `not a world doc: ${parsed.error.issues[0].message}` };

  if (parsed.data.irVersion !== WORLD_DOC_VERSION)
    return {
      ok: false,
      doc: null,
      reason: `no migration path from ${parsed.data.irVersion} to ${WORLD_DOC_VERSION}; a migrated world needs a freshly verified witness`,
    };

  // Nekonečno ve `sim` kolabuje na `null` v kanonickém zápisu, takže hash by
  // seděl a přesto by dokument po průchodu uložištěm znamenal něco jiného.
  //
  // A **obě části**, ne jen `sim`: u `look` je konečnost dokonce jediné místo,
  // kde ji zmrazený protokol žádá výslovně (`look.failurePolicy`: *„kontrolou
  // konečnosti VŠECH číselných hodnot"*), a migrace je ten atomický vstup, před
  // kterým to má platit. Kontrolovat ji jen tam, kde je hash, a vynechat ji tam,
  // kde ji předepisuje kontrakt, je přesně opačná asymetrie, než jaká dává smysl.
  const nonFinite = [
    ...nonFiniteNumbers(parsed.data.sim, '/sim'),
    ...nonFiniteNumbers(parsed.data.look, '/look'),
  ];
  if (nonFinite.length > 0) return { ok: false, doc: null, reason: nonFinite[0] };

  if (parsed.data.simHash !== simHashOf(parsed.data))
    return { ok: false, doc: null, reason: 'simHash does not match the sim part it claims to describe' };

  return { ok: true, doc: parsed.data, reason: 'already current' };
}
