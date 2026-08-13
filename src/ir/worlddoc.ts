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

import { isUnaddressableToken } from '../patch/reject';

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
 * Nejhlubší zanoření, které `canonical` ještě projde — a je to **strop hodnoty,
 * ne obrana proti útoku**.
 *
 * `canonical` je rekurzivní a na dokumentu zanořeném ~2000 úrovní přeteče
 * zásobník uvnitř `simHashOf`. Výjimka odtamtud je nejhorší možný výsledek:
 * přijde až za všemi kontrolami, u smíšeného požadavku **po** commitnutém `look`,
 * a volající místo odmítnutí dostane pád.
 *
 * Strop je proto v `unhashableValues`, tedy v té kontrole, která se ptá „dá se
 * tahle hodnota kanonizovat" — a která se pouští **před** každým hashováním.
 * Tím se hloubka odmítne jako vada hodnoty na všech vstupech naráz (patch,
 * migrace, validace `look`), místo aby se chytala jako výjimka na jednom z nich.
 *
 * 256 je řádově nad čímkoli, co dokument potřebuje (nejhlubší cesta ve zmrazeném
 * korpusu má jednotky úrovní), a řádově pod hloubkou, kde `canonical` padá.
 */
export const MAX_CANONICAL_DEPTH = 256;

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
 * Hodnoty, které kanonizace **tiše zahladí** — kdekoli ve stromu, ne jen v kořeni.
 *
 * Jsou dvě a obě dělají totéž: dva sémanticky různé dokumenty dostanou jeden
 * `simHash`.
 *
 * - **Nekonečno a `NaN`.** `JSON.stringify` je převádí na `null`, takže `NaN`,
 *   `Infinity` i skutečné `null` mají tentýž kanonický zápis.
 * - **`undefined`.** `canonical` položky s `undefined` **vyfiltruje**, takže
 *   `replace /witness/ops undefined` a `remove /witness/ops` dají **bitově
 *   totožný** hash. Svědek bez `ops` je přitom stejně neověřitelný jako svědek
 *   žádný — a dokument by prošel migrací jako aktuální, protože hash by seděl
 *   na svou vlastní vadnou `sim`.
 *
 * `.nonoptional()` na kořenových polích tohle **neřeší** — chrání osm jmen,
 * zatímco strom je hlubší. Kontrola proto patří sem, kde se chodí celý.
 *
 * Ani jedna hodnota nemůže přijít z `JSON.parse`; obě přijdou z patche
 * složeného v procesu a obě přežijí `structuredClone` i IndexedDB. To je tentýž
 * argument o dosažitelnosti, jaký už platí pro `Infinity`.
 */
export interface UnhashableIssue {
  /** RFC 6901 pointer na to místo. Skládá se z escapovaných tokenů, ne z holých klíčů. */
  readonly pointer: string;
  /** Čitelný popis včetně cesty. To, co jde do `detail` odmítnutí. */
  readonly detail: string;
}

function issue(pointer: string, message: string): UnhashableIssue {
  return { pointer, detail: `${pointer}: ${message}` };
}

/** Escapování podle RFC 6901: `~` je `~0`, `/` je `~1`. V tomhle pořadí. */
function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unhashableValues(
  value: unknown,
  path = '',
  open = new WeakSet<object>(),
  depth = 0,
): UnhashableIssue[] {
  if (depth > MAX_CANONICAL_DEPTH)
    return [issue(path, `nested deeper than ${MAX_CANONICAL_DEPTH} — canonicalization would overflow the stack`)];
  if (value === undefined) return [issue(path, 'undefined is dropped by canonicalization')];
  if (value === null) return [];

  const kind = typeof value;
  if (kind === 'number') {
    if (!Number.isFinite(value as number)) return [issue(path, `${String(value)} is not finite`)];
    // **`-0` je táž vada jako `null` prototyp, jen se hůř vidí.** `Number.isFinite`
    // ho propustí a `JSON.stringify` z něj napíše `0` — takže hash je hash nuly.
    // Přitom `JSON.parse` i `structuredClone` `-0` **zachovají**, takže dokument
    // v paměti nese `-0`, jeho hash mluví o `0`, a po průchodu uložištěm se
    // z něj `0` stane doopravdy. Dva různé dokumenty, jedna kotva certifikátu —
    // a na rozdíl od prototypu ho model umí poslat přímo v JSON patche.
    if (Object.is(value, -0)) return [issue(path, 'negative zero is written as 0 by canonicalization')];
    return [];
  }
  if (kind === 'string' || kind === 'boolean') return [];
  // `bigint` vyhodí uvnitř `JSON.stringify`, `function` i `symbol` z něj vypadnou
  // beze stopy. Ani jedno nemá JSON tvar, takže ani jedno nesmí do dokumentu.
  if (kind !== 'object') return [issue(path, `${kind} has no JSON form`)];

  const object = value as object;
  // Cyklus se `structuredClone` přenese a `canonical` by na něm nedoběhl. Sleduje
  // se **cesta**, ne všechno viděné, aby sdílený odkaz (DAG) nebyl falešný nález.
  if (open.has(object)) return [issue(path, 'cycle — canonicalization would not terminate')];
  open.add(object);

  const issues: UnhashableIssue[] = [];
  const isArray = Array.isArray(object);

  // **Pole a objekt tudy chodí JEDNOU cestou, a je to oprava metody, ne dalších
  // dveří.** Sedm kol brány našlo sedm vad téže třídy a pokaždé to bylo místo, kde
  // se ty dvě větve rozcházely: větev pro pole se neptala na prototyp, neptala se
  // na vlastní klíče, a tím pádem nevěděla o ničem, co se do pole dá propašovat.
  // Dokud existují dvě větve, existuje i rozdíl mezi nimi, který nikdo neuhlídá.
  //
  // Jediné, čím se pole a objekt liší, jsou proto **dvě data**: očekávaný prototyp
  // a seznam klíčů, které `canonical` doopravdy serializuje. Zbytek je společný.
  //
  // - `Date`, `Map`, `Set` a spol. `canonical` zploští na `{}`, takže pět různých
  //   dokumentů dostane jeden `simHash` — a po `JSON` round-tripu se `Date` změní
  //   na řetězec, takže znovu načtená kopie už tomu hashi neodpovídá.
  // - **`__proto__` v cestě patche.** `add /entities/__proto__` nepřidá klíč, ale
  //   **přepíše prototyp**; `Object.entries` ho nevidí, takže hash zůstane bitově
  //   stejný, zatímco runtime přes `entities[id]` vidí entitu navíc, kterou
  //   certifikát nepokrývá.
  // - **Ani `null` prototyp neprojde**, ačkoli `Object.entries` nad ním funguje a
  //   hash by seděl: `structuredClone` takovému objektu `Object.prototype` mlčky
  //   vrátí, takže commitnutý dokument by po uložení nebyl týž, který se commitl.
  if (Object.getPrototypeOf(object) !== (isArray ? Array.prototype : Object.prototype)) {
    open.delete(object);
    return [issue(path, 'only plain objects and arrays survive canonicalization')];
  }

  // `canonical` u pole prochází `.map`, tedy pozice `0 … length-1`; u objektu
  // vlastní enumerovatelné klíče. `own` je to, co na hodnotě SKUTEČNĚ je —
  // a rozdíl mezi těmi dvěma množinami je přesně to, co se kanonizací ztratí.
  const own = new Set(Object.keys(object));

  const inspect = (key: string): void => {
    // Token se escapuje, protože `pointer` je podle `patch/reject.ts` **RFC 6901**,
    // ne popisná cesta: klíč `a/b` by jinak ukázal na `/a/b`, tedy na jiné a
    // neexistující místo dokumentu.
    const at = `${path}/${escapeToken(key)}`;
    if (!own.delete(key)) {
      // Díra v poli: `canonical` ji vyrenderuje jako prázdno (`[1,,3]`),
      // `JSON.stringify` jako `null` (`[1,null,3]`). Dva zápisy téhož dokumentu.
      issues.push(issue(at, 'a hole in an array is dropped by canonicalization'));
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    // Getter by se zavolal až v `canonical` a mohl by vyhodit; hodnotou není.
    if (descriptor === undefined || descriptor.get !== undefined) {
      issues.push(issue(at, 'accessor properties have no JSON form'));
      return;
    }
    issues.push(...unhashableValues(descriptor.value, at, open, depth + 1));
  };

  // **Zastavuje se na PRVNÍM nálezu, a je to mez, ne úspora.** `length` pole je
  // zapisovatelná (`replace /witness/ops/length` s `4294967295` projde `rfc6902`
  // bez mrknutí), takže smyčka po pozicích je řízená číslem z patche. Bez téhle meze
  // by vyrobila jeden objekt nálezu na díru, což u velkého `length` skončí jako
  // `heap out of memory` — a to je **abort procesu, ne výjimka**, takže by ho
  // nechytil ani záchyt, který slibuje „nikdy nevyhodí". Volající navíc čte
  // `issues[0]`, takže první důvod je celá odpověď (`rejectionFromZod` to má
  // stejně).
  if (isArray) {
    const array = object as unknown[];
    for (let i = 0; i < array.length && issues.length === 0; i += 1) inspect(String(i));
  } else {
    for (const key of [...own]) {
      if (issues.length > 0) break;
      inspect(key);
    }
  }

  // Co v `own` zbylo, `canonical` nikdy neuvidí. U objektu nezbyde nic — smyčka
  // výš prošla přesně jeho klíče. U pole je to **neindexová vlastní vlastnost**:
  // `rfc6902` hlídá zápis do pole jen podmínkou `parseInt(key,10) >= length`,
  // takže nečíselný token dá `NaN >= length === false` a propadne až na
  // `parent[key] = value`. Takový klíč přežije `structuredClone`, ale `JSON`
  // ho zahodí — commitnutý dokument pak není ten, který se znovu načte, a oba
  // mají bitově týž hash.
  //
  // Čte se **jen když se výš nic nenašlo**: po předčasném zastavení je `own`
  // teprve zpola vyprázdněná, takže by její obsah neznamenal to, co tenhle
  // nález tvrdí.
  const [leftover] = own;
  if (issues.length === 0 && leftover !== undefined)
    issues.push(issue(`${path}/${escapeToken(leftover)}`, 'a property canonicalization never serializes'));

  open.delete(object);
  return issues;
}

/**
 * Pravidlo musí být uložené **pod svým vlastním `id`** — jinak ho příští patch
 * nenajde, přestože existuje.
 *
 * **Rozhodnutí předané z T12 do T22, varianta (b).** `add /sim/rules/-` i
 * `add /sim/rules/0` dnes projdou rozborem cesty a je to správně: podle RFC 6901
 * je `-` na objektu obyčejné jméno členu, takže `resolve` ani `rfc6902` nemají
 * co namítat. Vadné je až to, co z toho plyne o **adresování** — vznikne pravidlo
 * s klíčem `"-"` a `id: "lose"`, načež patch na `/sim/rules/lose` selže na
 * pravidle, které tam je. To je přesně to selhání, kvůli kterému se korpus mrazil
 * na v2 (§15 vede vložení i smazání pravidla jako vlastní třídy editace).
 *
 * Zúžení proto míří na **ten invariant**, ne na tvar cesty: zakázat `-` a číselný
 * token nad objektem obecně by odmítlo i legální `add /sim/state/counters/keys/-`,
 * kde se žádné adresování nerozbíjí. Naměřeno na zmrazeném korpusu: 31 pravidel
 * ve 13 tělech splňuje `id == klíč`, a **žádný** z 21 aplikovatelných editačních
 * patchů ho neporuší — tahle kontrola tedy nezamítá nic, co korpus deklaruje.
 *
 * Kontrola je **podmíněná**, a to schválně. `simSchema` typuje `rules` jako
 * `unknown`, protože vymyslet si hloubku znamenalo, že neprošlo 0 z 15 zmrazených
 * emisí. Tady se proto netvrdí, jak `rules` vypadá — jen že POKUD je to záznam
 * a POKUD položka nese řetězcové `id`, musí se ty dva rovnat.
 */
export function ruleKeyFault(sim: unknown): UnhashableIssue | null {
  return ruleKeyFaults(sim)[0]?.issue ?? null;
}

/**
 * **Jen ta poškození, která patch PŘINESL** — ne ta, která ve světě už ležela.
 *
 * Kontrola nad samotným draftem ten rozdíl nezná, a je zásadní: svět uložený
 * s rozejitým klíčem by jinak odmítl **každý** `sim` patch — včetně toho, který ho
 * opravuje (`move /rules/- → /rules/win`). `commitPart` je jediná zapisovací cesta
 * do `sim`, takže by z něj takový svět udělal slepou uličku bez cesty ven, a to za
 * stav, který ten patch nezpůsobil. Blokovat nesouvisející úpravy adresovatelnost
 * stejně nevrátí — vrátit ji umí jedině oprava, a ta musí projít.
 *
 * **Identita vady je klíč plus CELÁ položka, ne klíč a `id`.** Dvě slabší znění
 * to nezvládla a obě padla na témže vzorci — patch, který vypadá jako by vadu jen
 * zdědil, ji ve skutečnosti přinesl:
 *
 * - samotný pointer pustil `move /rules/unlock → /rules/-` nad světem, kde `-` už
 *   něco drží: množina klíčů se nezmění a `unlock` přestane existovat;
 * - dvojice `(klíč, id)` pustila totéž ve dvou operacích — `move` uloží `unlock`
 *   pod `-` a `replace /rules/-/id` mu vrátí zděděné `id`, takže i dvojice sedí.
 *
 * Kanonický zápis položky obojí zavře: tělo pravidla se přepisem `id` nezmění na
 * to původní. Oprava pořád vyrobí **nula** nálezů a projde, nesouvisející patch
 * pořád reprodukuje bitově shodnou položku, takže slepá ulička nevzniká.
 *
 * **U celotabulkové vady je identitou TVAR tabulky, ne její obsah** — rozhodnutí
 * člověka z 13. 8. 2026 nad bránou 5. Kanonický zápis celé tabulky sem nepatří:
 * pod ním měnila identitu každá úprava kteréhokoli pravidla, takže svět zděděně
 * uložený jako pole vracel `REJECTED` na `/sim/rules` i patchi, který ten pointer
 * vůbec nejmenoval. To je táž třída falešného odmítnutí, kvůli které vznikl
 * `97f4741`, jen ve tvaru pole — a model, který ji dostane, nemá co opravit.
 * Pod polem navíc žádné pravidlo adresovatelné není, takže se úpravou uvnitř
 * nic adresovatelného neztrácí.
 *
 * **Značka je JEDNA pro všechny tvary, které nejsou záznam** — pole, primitiv
 * i `null`. Dvě značky (zvlášť pole, zvlášť primitiv) tady jedno kolo stály a byly
 * chyba: ze zděděného pole pak `replace /sim/rules` hodnotou `7` odmítlo, zatímco
 * `null`, `[]` i `[{"id":"jine"}]` prošly. Táž škoda, opačný verdikt — a odůvodnit
 * to škodou nejde, protože **ze samotného stavu ty dva případy nejsou rozlišitelné**:
 * `remove /sim/rules/0` nad `[a]` a `replace /sim/rules` hodnotou `[]` vyrobí
 * bitově týž dokument. Protokol přitom počítá změněné listy diffem stavu, ne
 * čtením operací, takže „úprava uvnitř" a „výměna celé tabulky" jsou tady jedna věc.
 *
 * Invariant, který tahle kontrola vlastní, je **adresovatelnost pravidla jeho
 * `id`** — a pod žádným z těch tvarů není adresovatelné ani jedno pravidlo, ať
 * v tabulce zbylo cokoli. Přechod ze záznamu do kteréhokoli z nich se proto pořád
 * odmítá (identita se změní), zatímco pohyb mezi nimi se toleruje jednotně.
 */
export function introducedRuleKeyFault(stored: unknown, draft: unknown): UnhashableIssue | null {
  const before = new Set(ruleKeyFaults(stored).map(identityOf));
  return ruleKeyFaults(draft).find((fault) => !before.has(identityOf(fault)))?.issue ?? null;
}

/**
 * Jediná identita celotabulkové vady. Je to konstanta, ne popis tvaru: pole,
 * primitiv i `null` jsou pro adresování pravidel táž vada, takže pohyb mezi nimi
 * nesmí vypadat jako zavlečení nové. Do hlášky jde `describeTable`, do identity ne.
 */
const TABLE_NOT_A_RECORD = 'not-a-record';

/** Jen do textu hlášky. Nikdy do identity — tam by z toho byly zase dvě značky. */
function describeTable(rules: unknown): string {
  if (rules === null) return 'null';
  return Array.isArray(rules) ? 'an array' : `a ${typeof rules}`;
}

interface RuleKeyFault {
  readonly pointer: string;
  /**
   * `TABLE_NOT_A_RECORD` u vady celé tabulky, `null` u vady jedné položky.
   * Nenese ani tvar, ani obsah — proto ji úprava uvnitř zděděně vadné tabulky
   * nezmění a nečte se jako zavlečená.
   */
  readonly marker: string | null;
  /** Provinilá položka. Kanonizuje se až v `identityOf`, viz `ruleFault`. */
  readonly entry: unknown;
  readonly issue: UnhashableIssue;
}

/**
 * `JSON.stringify` místo spojovacího znaku — dvojice se nedá srazit obsahem klíče.
 * Rozlišovač je vlastní prvek pole, takže se značka tvaru nemůže potkat
 * s kanonickým zápisem položky, ať do něj přijde cokoli.
 */
function identityOf(fault: RuleKeyFault): string {
  return fault.marker === null
    ? JSON.stringify(['entry', fault.pointer, canonical(fault.entry)])
    : JSON.stringify(['table', fault.pointer, fault.marker]);
}

/**
 * **`canonical` se odsud nevolá, a je to podmínka totality `ruleKeyFault`.**
 * `canonical` je nehlídaná rekurze, takže cyklická nebo ~20k hluboká položka z ní
 * vyhodí `RangeError`. Uvnitř `introducedRuleKeyFault` to nevadí — obě strany
 * prošly `unhashableValues` (`commitChecked` uloženou část, `sealPart` draft),
 * který cyklus i hloubku odmítne dřív. `ruleKeyFault` je ale exportovaný **bez**
 * té předběžné podmínky a už dnes se volá nad syrovými zmrazenými těly, a bude
 * ho tak volat scorer z T16 nad živými emisemi. Musí tedy vrátit verdikt na
 * čemkoli, což platí právě proto, že se položka kanonizuje až v `identityOf`.
 */
function ruleFault(pointer: string, entry: unknown, detail: string): RuleKeyFault {
  return { pointer, marker: null, entry, issue: issue(pointer, detail) };
}

/** Vada celé tabulky. Do identity jde jen konstanta — tvar ani obsah do ní nesmí. */
function tableFault(detail: string): RuleKeyFault {
  return {
    pointer: '/sim/rules',
    marker: TABLE_NOT_A_RECORD,
    entry: undefined,
    issue: issue('/sim/rules', detail),
  };
}

function ruleKeyFaults(sim: unknown): RuleKeyFault[] {
  const rules = (sim as { readonly rules?: unknown } | null)?.rules;

  // Chybějící `rules` je bez nálezu, a stojí to na `simSchema`, ne na téhle větvi:
  // `rules: present` je povinné, takže dokument s vyříznutou tabulkou se odmítne
  // o krok dřív a sem se nedostane. `null` povinnost splňuje, proto tady zůstává.
  if (rules === undefined) return [];

  // **Cokoli, co není záznam, je vada CELÉ tabulky** — pole, primitiv i `null`.
  //
  // Pole je ten tvar v1, kvůli kterému se korpus mrazil na v2: každé pravidlo pod
  // ním leží pod indexem, takže `replace /sim/rules/lose/priority` selže na
  // pravidle, které existuje. Primitiv a `null` jsou širší podoba téhož — jediná
  // operace `replace /sim/rules` hodnotou `"gone"`, `7` nebo `null` smaže všechna
  // pravidla naráz a invariant nad výsledkem dřív hlásil čisto. Zotavení je u všech
  // tří stejné: další celotabulkový `replace` záznamem. `add /sim/rules/win` po nich
  // padne na „path runs through a primitive", resp. „is not an index of the array".
  //
  // Naměřeno na zmrazeném korpusu, ne odhadnuto: 13 create těl nese `rules` jako
  // záznam a **žádné** jako pole, a **žádný** z 25 editačních patchů celé
  // `/sim/rules` nepřepisuje. Tohle odmítnutí tedy nestojí ani jeden zmrazený
  // záznam.
  if (rules === null || typeof rules !== 'object' || Array.isArray(rules))
    return [
      tableFault(
        `the rule table is ${describeTable(rules)} instead of a keyed record, so no rule in it is reachable by its stable id`,
      ),
    ];

  const faults: RuleKeyFault[] = [];

  // **Vypadnout z id-prostoru jde i jinak než rozejitím klíče**, a dřív to tudy
  // šlo tiše: `typeof id !== 'string' → přeskoč` znamenalo, že pravidlo, kterému
  // se `id` přepíše na číslo nebo smaže, se nepočítá za vadu — klíč se neměl
  // s čím rozejít. Výsledek je přitom přesně to, čemu invariant brání: pravidlo
  // v dokumentu leží a žádný id-adresovaný patch ho nenajde. Stejně dopadne
  // položka, která pravidlo vůbec není (pole, `null`, číslo).
  //
  // Naměřeno na zmrazeném korpusu: 31 z 31 pravidel v create tělech nese
  // řetězcové `id`, a přestože se **20 z 25** editačních patchů dotýká cest POD
  // `/sim/rules`, celou tabulku nepřepisuje ani jeden. Zúžení tedy nestojí žádný
  // zmrazený záznam — ověřuje to sada nad korpusem, ne tenhle komentář.
  for (const [key, rule] of Object.entries(rules as Record<string, unknown>)) {
    const pointer = `/sim/rules/${escapeToken(key)}`;

    // **Klíč, který rozbor cesty odmítá, je neadresovatelný i když se `id` rovná
    // jemu.** `resolve` zakazuje `__proto__`, `constructor` a `prototype` v každé
    // pozici, protože je `rfc6902` přeskakuje a sáhlo by místo nich na rodiče.
    // Pravidlo pod takovým klíčem tedy invariant formálně splní a přesto se k němu
    // žádný patch nedostane — doslova ten stav, kterému má invariant bránit.
    // Jednotlivá operace se odmítne už na cestě; dovnitř se to dostane přepisem
    // celé tabulky, kde se žádný takový token neadresuje.
    if (isUnaddressableToken(key)) {
      faults.push(
        ruleFault(
          pointer,
          rule,
          `the rule under key "${key}" sits on a token the path parser refuses in every position, so nothing can reach it by its stable id`,
        ),
      );
      continue;
    }

    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      faults.push(
        ruleFault(
          pointer,
          rule,
          `the entry under key "${key}" is not a rule object, so it carries no stable id to be addressed by`,
        ),
      );
      continue;
    }

    const id = (rule as { readonly id?: unknown }).id;
    if (typeof id !== 'string') {
      faults.push(
        ruleFault(
          pointer,
          rule,
          `the rule under key "${key}" has no string id, so it has dropped out of the stable id space entirely`,
        ),
      );
      continue;
    }

    if (id === key) continue;
    faults.push(
      ruleFault(
        pointer,
        rule,
        `rule "${id}" is filed under key "${key}" — a patch addressing it by its stable id would miss a rule that exists`,
      ),
    );
  }
  return faults;
}

export function validateLook(look: unknown): LookVerdict {
  const parsed = lookSchema.safeParse(look);
  if (!parsed.success)
    return { ok: false, issues: parsed.error.issues.map((issue) => `schema:/${issue.path.join('/')}: ${issue.message}`) };

  const issues = unhashableValues(parsed.data, '').map((found) => found.detail);
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
    ...unhashableValues(parsed.data.sim, '/sim'),
    ...unhashableValues(parsed.data.look, '/look'),
  ];
  if (nonFinite.length > 0) return { ok: false, doc: null, reason: nonFinite[0].detail };

  if (parsed.data.simHash !== simHashOf(parsed.data))
    return { ok: false, doc: null, reason: 'simHash does not match the sim part it claims to describe' };

  return { ok: true, doc: parsed.data, reason: 'already current' };
}
