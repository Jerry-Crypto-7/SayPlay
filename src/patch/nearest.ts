/**
 * Nejbližší legální varianta patche — **doletět, ne odmítnout** (P11 T13).
 *
 * ## Co to řeší
 *
 * Model napíše patch, který míří na správné místo a nese správnou hodnotu, ale
 * v cestě má tvar, který RFC 6902 na tomhle dokumentu neumí provést:
 * `add /state/counters/streak/-` do čítače, který ještě neexistuje, nebo
 * `replace` členu, který se teprve má objevit. Dnes je z toho odmítnutí a hráč
 * kouká na svět, se kterým se nic nestalo. Přitom **existuje právě jedno
 * legální čtení téhož záměru** a stačí ho použít.
 *
 * Naměřená základna, proti které to stojí: `evals/reject-causes.json`.
 *
 * ## Dvě přepsání, a ani jedno nevymýšlí význam
 *
 * 1. **`add /a/b/-` (nebo `/a/b/0`), kde člen `/a/b` neexistuje → `add /a/b`.**
 *    Pozice za posledním prvkem pole, které tam žádné není, má jediné čtení:
 *    ten člen se má založit. Hodnota je modelova a nesahá se na ni.
 * 2. **`replace /a/b`, kde `/a` je objekt a člen `b` v něm není → `add /a/b`.**
 *    RFC 6902 §4.3 chce `replace` nad existujícím členem; zápis členu, který
 *    tam ještě není, se jmenuje `add`. Cesta ani hodnota se nemění.
 *
 * Operace, pro kterou žádné takové čtení není, se **zahodí** a zbytek patche
 * jde dál v původním pořadí. Menší změna je pořád změna; celý patch zahozený
 * kvůli jedné operaci je prázdná obrazovka.
 *
 * ## Co tohle NIKDY nedělá — a je to celá obrana přijímací brány
 *
 * - **Nemění hodnotu.** Ani jednu, nikdy.
 * - **Nepřejmenovává cíl.** Pravidlo, soket ani zóna, kterou si model vymyslel,
 *   se nehledá „podobná mezi existujícími". To by byl systém hádající význam a
 *   jediná dokázaná vlastnost projektu (*nic vadného neprojde přijetím*) by tím
 *   padla. Osiřelý odkaz zůstává odmítnutím.
 * - **Nesahá na ověřovač.** Výsledek jde beze změny do `certifySim` — svět,
 *   který se nedá dohrát, se pořád odmítne, a `add` připojený na konec pořadí
 *   pravidel nic neobchází.
 * - **Neproleze tam, kam se cesta nesmí dostat.** Tokeny, které `rfc6902`
 *   přeskakuje (`__proto__`, `constructor`, `prototype`), jsou nepřepsatelné
 *   v každé pozici — tatáž kontrola jako v `reject.ts`, ze stejného důvodu.
 *
 * ## Pořadí operací je stav, ne seznam
 *
 * Jestli je operace legální, rozhoduje dokument **po** předchozích operacích
 * téhož patche: `add /a/b` a hned za ním `add /a/b/-` je dvojice, kde druhá
 * operace legální je a před tou první nebyla. Přepsání se proto počítá nad
 * postupně upravovaným draftem, ne nad vstupním dokumentem.
 */

import { applyPatch, type Operation } from 'rfc6902';

import { isUnaddressableToken, pointerFault, pointerOf, pointerTokens } from './reject';

export interface Landing {
  /** `reshaped` = operace se provedla v jiném legálním tvaru, `dropped` = zahodila se. */
  readonly kind: 'reshaped' | 'dropped';
  /** Pořadí operace ve vstupním patchi. */
  readonly index: number;
  /** Jak operace zněla — `op` a cesta, v souřadnicích části. */
  readonly from: string;
  /** Čím se stala. `null` u zahozené. */
  readonly to: string | null;
  readonly reason: string;
}

export interface NearestPatch {
  /** Operace, které se provedou. Pořadí je pořadí vstupu, jen bez zahozených. */
  readonly operations: readonly Operation[];
  /** Co se cestou stalo. Prázdné, když se patch nedotkl. */
  readonly landings: readonly Landing[];
}

const ARRAY_POSITION = /^(-|0|[1-9][0-9]*)$/;

function describe(operation: Operation): string {
  return `${operation.op} ${operation.path}`;
}

/** Hluboká kopie draftu. Patch přichází jako JSON, takže JSON kopie stačí a nic nezamlčí. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Hodnota na cestě, a jestli tam vůbec člen je. Vlastní chůze, ne `rfc6902`. */
function memberAt(doc: unknown, tokens: readonly string[]): { readonly present: boolean; readonly value: unknown } {
  let node: unknown = doc;
  for (const token of tokens) {
    if (isUnaddressableToken(token)) return { present: false, value: undefined };
    if (Array.isArray(node)) {
      if (!ARRAY_POSITION.test(token) || token === '-') return { present: false, value: undefined };
      const index = Number(token);
      if (index >= node.length) return { present: false, value: undefined };
      node = node[index];
      continue;
    }
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, token))
      return { present: false, value: undefined };
    node = (node as Record<string, unknown>)[token];
  }
  return { present: true, value: node };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Přepsání 1 — `add` na pozici pole, jehož člen ještě neexistuje.
 *
 * Podmínka je úzká schválně: člen chybí, jeho rodič je objekt, a poslední token
 * je pozice v poli. Když ten člen existuje a jen není pole (`levels: 1`), čtení
 * jsou dvě — přepiš skalár, nebo z něj udělej pole — takže se nepřepisuje nic.
 */
function reshapeAppend(operation: Operation, draft: unknown): Operation | null {
  if (operation.op !== 'add') return null;
  const tokens = pointerTokens(operation.path);
  if (tokens.length < 2) return null;
  if (!ARRAY_POSITION.test(tokens[tokens.length - 1])) return null;

  const memberTokens = tokens.slice(0, -1);
  if (memberAt(draft, memberTokens).present) return null;

  const parent = memberAt(draft, memberTokens.slice(0, -1));
  if (!parent.present || !isPlainObject(parent.value)) return null;
  if (isUnaddressableToken(memberTokens[memberTokens.length - 1])) return null;

  return { op: 'add', path: pointerOf(memberTokens), value: (operation as { value: unknown }).value };
}

/**
 * Přepsání 2 — `replace` členu, který v objektu ještě není.
 *
 * `pointerFault` tohle nehlásí: poslední token na objektu smí teprve vzniknout,
 * takže rozbor cesty projde a zastaví se až `rfc6902` (`MissingError`). Rozdíl
 * mezi „přepiš" a „zapiš" je přitom u členu, který tam není, jen jméno operace.
 */
function reshapeWrite(operation: Operation, draft: unknown): Operation | null {
  if (operation.op !== 'replace') return null;
  const tokens = pointerTokens(operation.path);
  if (tokens.length === 0) return null;

  const last = tokens[tokens.length - 1];
  if (isUnaddressableToken(last)) return null;

  const parent = memberAt(draft, tokens.slice(0, -1));
  if (!parent.present || !isPlainObject(parent.value)) return null;
  if (Object.hasOwn(parent.value, last)) return null;

  return { op: 'add', path: operation.path, value: (operation as { value: unknown }).value };
}

/**
 * Provede operaci na kopii draftu. Vrací nový draft, nebo `null` s důvodem.
 *
 * `applyPatch` mutuje, takže se pracuje na kopii a přijímá se teprve ta, která
 * prošla — jinak by zahozená operace nechala draft rozpracovaný.
 */
function attempt(draft: unknown, operation: Operation): { readonly draft: unknown } | { readonly error: string } {
  const fault = pointerFault(draft, operation);
  if (fault !== null) return { error: fault.reason };

  const next = clone(draft);
  try {
    const errors = applyPatch(next as object, [operation]).filter((error) => error !== null);
    if (errors.length > 0) return { error: (errors[0] as Error).message };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { draft: next };
}

/**
 * Nejbližší legální varianta patche nad **částí** dokumentu.
 *
 * `part` je `doc.sim` nebo `doc.look`, tedy táž souřadnice, ve které router
 * operace vydává a ve které je `commitPart` aplikuje. Volat to nad celým
 * dokumentem by znamenalo posuzovat cesty o úroveň vedle.
 */
export function nearestLegal(part: unknown, operations: readonly Operation[]): NearestPatch {
  const kept: Operation[] = [];
  const landings: Landing[] = [];
  let draft = clone(part);

  operations.forEach((operation, index) => {
    const direct = attempt(draft, operation);
    if ('draft' in direct) {
      kept.push(operation);
      draft = direct.draft;
      return;
    }

    for (const reshape of [reshapeAppend, reshapeWrite]) {
      const candidate = reshape(operation, draft);
      if (candidate === null) continue;
      const landed = attempt(draft, candidate);
      if (!('draft' in landed)) continue;

      kept.push(candidate);
      draft = landed.draft;
      landings.push({
        kind: 'reshaped',
        index,
        from: describe(operation),
        to: describe(candidate),
        reason: direct.error,
      });
      return;
    }

    landings.push({ kind: 'dropped', index, from: describe(operation), to: null, reason: direct.error });
  });

  return { operations: kept, landings };
}
