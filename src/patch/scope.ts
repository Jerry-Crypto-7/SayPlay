/**
 * Skutečný dosah patche — **diffem stavu, nikdy čtením operací**.
 *
 * Zmrazený protokol to má jako vlastní pravidlo (`editContract.changedLeafRule`)
 * a formuluje ho i s důvodem: *„Množina skutečně změněných LISTOVÝCH JSON
 * pointerů se počítá DIFFEM STAVU PŘED A PO aplikaci, nikdy čtením operací
 * patche. Jinak `replace` na povoleném předkovi přepíše nepovolené potomky
 * a formálně projde."*
 *
 * ## Proč čtení operací nestačí, konkrétně
 *
 * Review v3 nejdřív navrhlo strop **počtu** operací. Jedna operace ale umí
 * přepsat libovolně velký podstrom, takže počítání nedokazuje nic. Review v4
 * ukázalo, že ani kontrola cest v operacích nestačí: kontrola typu „cesta
 * operace je prefixem některé povolené cesty" propustí `replace /sim`, protože
 * `/sim` je prefixem úplně každé povolené cesty — a přitom přepíše celý svět.
 *
 * Rozvinutá množina listů tuhle díru zavírá tím, že se **neptá, co patch řekl,
 * ale co se v dokumentu doopravdy pohnulo**. Ať se `/sim/state/timers/flood`
 * přepíše celý nebo se sáhne rovnou na `durationTicks`, výsledek je tatáž
 * odpověď: změnil se `durationTicks`, a pokud se změnil i `init`, je vidět i on.
 *
 * ## Co je list
 *
 * Skalár, prázdný objekt nebo prázdné pole — tedy místo, pod kterým už není nic,
 * co by šlo adresovat. Prázdné kontejnery se počítají jako listy schválně: jinak
 * by se změna `{}` → `{a:1}` na jedné straně vykázala a opačná změna
 * `{a:1}` → `{}` by po sobě nenechala žádný pointer.
 *
 * Změna tvaru (objekt → skalár, pole → objekt) vykáže listy **obou** stran:
 * zmizelé i vzniklé. Vykázat jen jednu by znamenalo, že se přepsáním podstromu
 * na číslo dosah patche opticky zmenší.
 *
 * ## Co se u listu ještě měří: jak se pohnul
 *
 * Kontrakt nedeklaruje jen cesty, ale **dvojice operace–cesta**. Aby se dala
 * ověřit i ta druhá půlka, nese každý změněný list svůj `effect` — `add`,
 * `remove`, nebo `replace`. Počítá se ze stavu, ne ze čtení patche, takže platí
 * tentýž důvod jako u samotných listů: patch nemá jak o svém dosahu lhát tím,
 * jak se pojmenuje.
 *
 * Rozhoduje se **na adrese, kde se tvary rozešly**: chybí vlevo → `add`, chybí
 * vpravo → `remove`, je na obou stranách → `replace`. Listy pod tou adresou
 * účinek dědí. Odvozovat ho z členství v množinách listů by pletlo `replace`
 * skaláru objektem s dvojicí `remove` + `add`.
 *
 * ## Pořadí a stabilita
 *
 * Vrací se **seřazená** množina. Dosah je vlastnost výsledku, ne pořadí, ve
 * kterém se do něj přišlo — a stabilní pořadí je to, co dovoluje množinu
 * porovnat mezi dvěma běhy (T17 řetězí hashe stadií).
 */

import { canonical } from '../ir/worlddoc';
import { pointerOf, pointerTokens } from './reject';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Všechny listy hodnoty. `undefined` nemá žádné — neexistuje, tedy ani nezmizelo. */
function collectLeaves(value: unknown, tokens: readonly string[], out: Set<string>): void {
  if (value === undefined) return;

  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out.add(pointerOf(tokens));
      return;
    }
    for (const key of keys) collectLeaves(value[key], [...tokens, key], out);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.add(pointerOf(tokens));
      return;
    }
    value.forEach((item, index) => collectLeaves(item, [...tokens, String(index)], out));
    return;
  }

  out.add(pointerOf(tokens));
}

/** Jak se list pohnul. Odvozeno **ze stavu**, nikdy ze čtení operací patche. */
export type LeafEffect = 'add' | 'remove' | 'replace';

export interface ChangedLeaf {
  readonly path: string;
  readonly effect: LeafEffect;
}

function diff(before: unknown, after: unknown, tokens: readonly string[], out: Map<string, LeafEffect>): void {
  // **Přítomnost se rozhoduje před `canonical`, ne jím.** `canonical(undefined)`
  // i `canonical(null)` vracejí `"null"`, protože `JSON.stringify(undefined)` je
  // `undefined` a spadne do `?? 'null'` (`ir/worlddoc.ts`). Smazání klíče, který
  // nesl `null`, by se tedy vyhodnotilo jako „nezměnilo se nic" — a zmrazené
  // create světy nesou 23 takových listů, všechny `/sim/rules/<id>/condition`.
  // Dosah `remove` nad nimi by vyšel prázdný, přestože se dokument prokazatelně
  // pohnul: jiná revize, jiný `simHash`, jiný výsledek certifikace. Zápis mimo
  // `allowedPaths` by tou dírou prošel neviděn, což je přesně to, co má rozvinutá
  // množina listů znemožnit.
  //
  // Rovnost hashů tu proto záměrně **není** rovnost dosahu: hash obě hodnoty
  // sjednocuje (a smí, `null` a chybějící klíč popisují týž stav světa), zatímco
  // adresa listu je rozlišuje (a musí, protože kontrakt mluví o adresách).
  const beforeAbsent = before === undefined;
  const afterAbsent = after === undefined;

  if (beforeAbsent === afterAbsent && canonical(before) === canonical(after)) return;

  if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      diff(before[key], after[key], [...tokens, key], out);
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    // Pole se porovnává **po indexech**, ne jako množina: index je součást
    // adresy, takže vložení prvku doprostřed opravdu pohne vším za ním a dosah
    // to musí přiznat. Párování podle podobnosti by ho uměle zmenšilo.
    for (let i = 0; i < Math.max(before.length, after.length); i += 1)
      diff(before[i], after[i], [...tokens, String(i)], out);
    return;
  }

  // Tvar se rozešel, nebo je to skalár proti skaláru. Obě strany, viz docblock.
  //
  // **Účinek se rozhoduje TADY, na adrese rozchodu — ne členstvím v množinách.**
  // Rozdíl je vidět na `replace` skaláru objektem: `/…/condition` bylo `null`
  // a je z něj objekt o pěti klíčích. Adresa existuje na obou stranách, takže
  // se **nahradila**. Kdyby se účinek odvozoval z toho, že stará listová adresa
  // v nové množině listů chybí (je z ní vnitřní uzel), vyšel by `remove` — a
  // kontrakt deklarující `replace` nad toutéž cestou by se ohlásil jako porušený.
  // Naměřeno na `E25`, kde je to legální tah, ne vada korpusu.
  const effect: LeafEffect = beforeAbsent ? 'add' : afterAbsent ? 'remove' : 'replace';
  const touched = new Set<string>();
  collectLeaves(before, tokens, touched);
  collectLeaves(after, tokens, touched);
  for (const path of touched) out.set(path, effect);
}

/**
 * Listové JSON pointery, které se mezi `before` a `after` doopravdy pohnuly.
 *
 * `prefix` ukotví výsledek do souřadnic dokumentu (`/sim`, `/look`). Bez něj by
 * dosah mluvil v souřadnicích části, zatímco kontrakt (`allowedPaths`) i patch
 * mluví v souřadnicích dokumentu — a porovnávaly by se dvě různé adresy.
 */
export function changedLeafEffects(before: unknown, after: unknown, prefix = ''): readonly ChangedLeaf[] {
  const out = new Map<string, LeafEffect>();
  diff(before, after, prefix === '' ? [] : [prefix.replace(/^\//, '')], out);
  return [...out.keys()].sort().map((path) => ({ path, effect: out.get(path) as LeafEffect }));
}

/** Samotné adresy. Projekce `changedLeafEffects`, aby existoval jeden výpočet. */
export function changedLeaves(before: unknown, after: unknown, prefix = ''): readonly string[] {
  return changedLeafEffects(before, after, prefix).map((leaf) => leaf.path);
}

/* ------------------------------------------------------------------ *
 * Dosah věty, která zakládá nový objekt (P21 T8).
 * ------------------------------------------------------------------ */

/**
 * Tabulky `sim`, do kterých smí nový objekt psát, a **pod jakým klíčem**.
 *
 * `own` — klíč je id nového objektu: entita a její půdorys.
 * `fresh` — klíč je nový, tedy před změnou v tabulce nebyl: socket, pravidlo.
 *
 * Nic jiného. `state` sem nepatří schválně: příznaky, časovače a čítače jsou
 * počáteční stav světa, který si porotce rozehrál, a nový předmět do něj nemá
 * co mluvit. Až věta, která zákon potřebuje s příznakem, ukáže naměřený případ,
 * rozšíří se tabulka tady — na jednom místě, které soudí preview i commit.
 */
const ADDITION_TABLES: Readonly<Record<string, 'own' | 'fresh'>> = {
  entities: 'own',
  collisionAabb: 'own',
  sockets: 'fresh',
  rules: 'fresh',
};

export interface AdditionScopeIssue {
  /** List, který kontrakt porušil — první v seřazené množině. */
  readonly pointer: string;
  readonly detail: string;
}

/**
 * Sáhla změna jen na nový objekt?
 *
 * Soudí se **diffem `sim` před a po**, ze stejného důvodu jako celý tenhle
 * soubor: cesty v operacích o dosahu lžou, listy ne. Věta, která zakládá
 * objekt, smí světu jen **přidávat** — každý změněný list má účinek `add`
 * a leží pod tabulkou z `ADDITION_TABLES` pod klíčem, který novému objektu
 * patří. `replace` nebo `remove` kdekoli znamená, že se hnul stav nebo
 * identita něčeho, co už stálo; `add` pod cizím klíčem (`/sim/entities/
 * surveyor/motion`) totéž.
 *
 * Vrací první porušení, ne všechna: na rozdíl od kontroly odkazů tohle nejde
 * do sebeopravy — odmítnutá druhá věta se porotci vrací celá a on píše novou.
 */
export function additionScopeIssue(
  beforeSim: unknown,
  afterSim: unknown,
  stableId: string,
): AdditionScopeIssue | null {
  const before = isRecord(beforeSim) ? beforeSim : {};
  const judgedRules = new Set<string>();

  for (const leaf of changedLeafEffects(beforeSim, afterSim, '/sim')) {
    const [, table, key] = pointerTokens(leaf.path);

    if (leaf.effect !== 'add')
      return {
        pointer: leaf.path,
        detail: `adding ${stableId} may only add, but ${leaf.path} was ${leaf.effect}d`,
      };

    const rule = table === undefined ? undefined : ADDITION_TABLES[table];
    if (rule === undefined || key === undefined)
      return {
        pointer: leaf.path,
        detail: `${leaf.path} is outside the tables a new object may write (${Object.keys(ADDITION_TABLES).map((name) => `/sim/${name}`).join(', ')})`,
      };

    if (rule === 'own' && key !== stableId)
      return {
        pointer: leaf.path,
        detail: `${leaf.path} belongs to ${key}, and adding ${stableId} may not touch another object`,
      };

    const existing = before[table];
    if (rule === 'fresh' && isRecord(existing) && Object.hasOwn(existing, key))
      return {
        pointer: leaf.path,
        detail: `${leaf.path} writes into ${key}, which already existed before ${stableId} was added`,
      };

    // Čerstvé pravidlo je v diffu vždycky jen `add`, i když rozhodne hru
    // (nález revize 19. 9. 2026: „a trophy that wins the game at once" přepsalo
    // výherní podmínku bez dotyku jediného starého listu). Reagovat na staré
    // objekty a hýbat s nimi smí — to je věta o pravidle (A10) a svědek se
    // přeověřuje; `win` a `lose` ne, protože nový předmět nemá co rozhodovat,
    // kdy svět končí.
    if (table === 'rules' && !judgedRules.has(key)) {
      judgedRules.add(key);
      const decided = decidingAction(afterSim, key);
      if (decided !== null)
        return {
          pointer: decided.pointer,
          detail: `${decided.pointer} ends the game with ${decided.kind}; adding ${stableId} may react to the world but never decide when it is won or lost`,
        };
    }
  }

  return null;
}

/** První akce `win` / `lose` v pravidle `key` dokumentu `sim`, nebo `null`. */
function decidingAction(sim: unknown, key: string): { pointer: string; kind: string } | null {
  const rules = isRecord(sim) ? sim.rules : undefined;
  const rule = isRecord(rules) ? rules[key] : undefined;
  const actions = isRecord(rule) && Array.isArray(rule.actions) ? rule.actions : [];
  for (const [index, action] of actions.entries()) {
    const kind = isRecord(action) ? action.kind : undefined;
    if (kind === 'win' || kind === 'lose') return { pointer: `/sim/rules/${key}/actions/${String(index)}`, kind };
  }
  return null;
}
