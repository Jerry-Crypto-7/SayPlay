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

export const IR_VERSION = 'world-ir-v1';

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

/** Topologie scény podle §13.3. Model ji emituje, systém ji jen validuje. */
export const LAYOUT_TYPES = ['grid', 'ring', 'corridor', 'tower', 'cave'] as const;

const finiteInt = z.int();
const cell = z.tuple([finiteInt, finiteInt]);
const aabb = z.tuple([finiteInt, finiteInt, finiteInt, finiteInt]);

/**
 * `sim` — hloubka schématu je záměrně mělká.
 *
 * Zmrazený protokol mrazí **tvar**, ne implementaci: naplnění emisní cesty pro
 * `layout` je P5 T506. Vymýšlet tady hlubší strukturu, než jakou protokol
 * popisuje, by znamenalo zmrazit něco, co nikdo neodsouhlasil — a rozejít se
 * s dokumentem, který je nadřazený. Co protokol jmenuje, to se kontroluje;
 * co nechává na P5, zůstává otevřené uvnitř a **uzavřené v kořeni**.
 */
export const simSchema = z
  .object({
    layout: z.object({ type: z.enum(LAYOUT_TYPES) }).loose(),
    grid: z.object({ width: finiteInt.min(1), height: finiteInt.min(1) }).loose(),
    sockets: z.record(z.string(), cell),
    collisionAabb: z.record(z.string(), aabb),
    entities: z.array(z.object({ stableId: z.string() }).loose()),
    rules: z.array(z.object({ ruleId: z.string() }).loose()),
    state: z.object({}).loose(),
    witness: z.object({ ops: z.array(z.unknown()) }).loose(),
  })
  .strict();

export const lookSchema = z
  .object({
    modules: z.record(z.string(), z.unknown()),
    palette: z.array(z.string()),
    lightRig: z.object({}).loose(),
    atmosphere: z.object({}).loose(),
    materialRoles: z.record(z.string(), z.string()),
    camera: z.object({}).loose(),
    audio: z.object({}).loose(),
  })
  .strict();

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
export function validateLook(look: unknown): LookVerdict {
  const parsed = lookSchema.safeParse(look);
  if (!parsed.success)
    return { ok: false, issues: parsed.error.issues.map((issue) => `schema:/${issue.path.join('/')}: ${issue.message}`) };

  const issues: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) issues.push(`${path}: ${String(value)} is not finite`);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) walk(value[i], `${path}/${i}`);
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) walk(item, `${path}/${key}`);
  };
  walk(parsed.data, '');

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

  if (parsed.data.irVersion !== IR_VERSION)
    return {
      ok: false,
      doc: null,
      reason: `no migration path from ${parsed.data.irVersion} to ${IR_VERSION}; a migrated world needs a freshly verified witness`,
    };

  if (parsed.data.simHash !== simHashOf(parsed.data))
    return { ok: false, doc: null, reason: 'simHash does not match the sim part it claims to describe' };

  return { ok: true, doc: parsed.data, reason: 'already current' };
}
