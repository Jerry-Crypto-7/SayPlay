/**
 * Slepý běh brány (T706) – vyhodnocovací vstup, ze kterého nejde poznat varianta.
 *
 * ## Co tahle vrstva hlídá
 *
 * §7 P7 zakazuje, aby autor byl soudcem. Slepý běh je druhá polovina téhož
 * pravidla: i poctivý soudce soudí jinak, když ví, čí je to výstup. Vrstva proto
 * rozdělí označený vstup na dvě části – **vyhodnocovací vstup** bez jediného
 * identifikátoru varianty a **klíč**, který se drží stranou a přiloží se až
 * k hotovým verdiktům.
 *
 * ## Zaslepení je kontrola úniku, ne šifra – a říká to nahlas
 *
 * Rukojeť je pořadové číslo v zamíchaném pořadí, ne kryptogram. Kdo má sůl, umí
 * přiřazení zopakovat; o to jde, protože běh musí být reprodukovatelný. Sůl se
 * proto ukládá **jen do klíče** a nikdy se nebere ze zmrazeného protokolu –
 * kdyby se odvozovala z veřejného seedu, uměl by si přiřazení dopočítat každý,
 * kdo má repozitář, a zaslepení by bylo divadlo.
 *
 * **Co zaslepení nekryje ani tak:** početnosti ramen. Když má jedno rameno 15
 * a druhé 12 případů a vyhodnocovatel populaci zná, počty mu ramena prozradí bez
 * ohledu na rukojeti. Tohle je mez metody, ne vada implementace, a nedá se
 * zavřít jinak než vyvážením ramen.
 *
 * ## Únik se hledá v celé hloubce, ne v jednom poli
 *
 * Odstranit z položky pole `arm` a nechat uvnitř `payload.branch: "edit"` je
 * přesně ta chyba, kterou by nikdo nepřiznal a která zabíjí celý mechanismus.
 * `armLeaks` proto prochází payload rekurzivně a kontroluje **jména klíčů i
 * řetězcové hodnoty**; `blind` na jakýkoli nález padá.
 */

import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';

import { hashWords } from '../../src/sim/hash';
import { nextInt } from '../../src/sim/rng';
import type { KillGateReport } from '../harness/kill-gate';

// ---------------------------------------------------------------------------
// Tvary
// ---------------------------------------------------------------------------

export interface LabelledItem {
  /** Id ze zmrazeného korpusu. Do vyhodnocovacího vstupu se nedostane. */
  readonly caseId: string;
  /** Varianta – to jediné, co se vyhodnocovatel nesmí dozvědět. */
  readonly arm: string;
  /** Co se posuzuje. Musí být bez identifikátoru varianty, jinak `blind` padne. */
  readonly payload: unknown;
}

export interface BlindItem {
  readonly handle: string;
  readonly payload: unknown;
}

export interface BlindAssignment {
  readonly handle: string;
  readonly caseId: string;
  readonly arm: string;
}

export interface BlindKey {
  readonly salt: string;
  readonly arms: readonly string[];
  readonly assignments: readonly BlindAssignment[];
}

export interface BlindRun {
  /** Vyhodnocovací vstup. Tohle je to, co smí vidět soudce. */
  readonly items: readonly BlindItem[];
  /** Klíč. Drží se stranou a přikládá se až k hotovým verdiktům. */
  readonly key: BlindKey;
}

export interface BlindVerdict {
  readonly handle: string;
  readonly success: boolean;
}

export interface UnblindedOutcome {
  readonly id: string;
  readonly arm: string;
  readonly success: boolean;
}

export interface Leak {
  readonly handle: string;
  readonly path: string;
  readonly token: string;
}

export class ArmLeakError extends Error {
  constructor(readonly leaks: readonly Leak[]) {
    super(
      `vyhodnocovací vstup nese identifikátor varianty na ${leaks.length} místech: ` +
        leaks
          .slice(0, 5)
          .map((leak) => `${leak.handle} ${leak.path} → ${leak.token}`)
          .join(', '),
    );
    this.name = 'ArmLeakError';
  }
}

// ---------------------------------------------------------------------------
// Hledání úniku
// ---------------------------------------------------------------------------

function scan(value: unknown, path: string, tokens: readonly string[], handle: string, found: Leak[]): void {
  if (typeof value === 'string') {
    const haystack = value.toLowerCase();
    for (const token of tokens) if (haystack.includes(token)) found.push({ handle, path, token });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scan(entry, `${path}[${index}]`, tokens, handle, found));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      const here = `${path}.${key}`;
      const name = key.toLowerCase();
      for (const token of tokens) if (name.includes(token)) found.push({ handle, path: here, token });
      scan(entry, here, tokens, handle, found);
    }
  }
}

/**
 * Každé místo ve vyhodnocovacím vstupu, kde stojí jméno ramene.
 *
 * Shoda je **podřetězcová a nezávislá na velikosti písmen**, protože únik nemusí
 * mít tvar celé hodnoty: „vytvořeno 3 entity" prozradí rameno `create` stejně
 * spolehlivě jako pole `branch: "create"`.
 */
export function armLeaks(items: readonly BlindItem[], arms: readonly string[]): readonly Leak[] {
  const tokens = arms.map((arm) => arm.toLowerCase()).filter((token) => token.length > 0);
  const found: Leak[] = [];
  for (const item of items) scan(item.payload, 'payload', tokens, item.handle, found);
  return found;
}

// ---------------------------------------------------------------------------
// Zaslepení
// ---------------------------------------------------------------------------

/** Sůl na seed streamu. FNV-1a, tedy týž hash jako všude jinde v projektu. */
function seedFromSalt(salt: string): number {
  const words = new Uint32Array(salt.length);
  for (let index = 0; index < salt.length; index += 1) words[index] = salt.charCodeAt(index);
  return hashWords(words) | 0;
}

/**
 * Fisher–Yates nad vlastním streamem `pure-rand`.
 *
 * Zamíchat se musí, i když rukojeti samy nic neprozrazují: vstup chodí seskupený
 * po ramenech, takže v nezamíchaném pořadí by variantu prozradila **pozice**.
 */
function shuffled<T>(items: readonly T[], salt: string): readonly T[] {
  const order = [...items];
  const stream = xoroshiro128plus(seedFromSalt(salt));
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = nextInt(stream, 0, i);
    const swap = order[i];
    order[i] = order[j];
    order[j] = swap;
  }
  return order;
}

export function blind(items: readonly LabelledItem[], salt: string): BlindRun {
  if (salt.trim().length === 0)
    throw new RangeError('slepý běh bez soli: zamíchání by bylo konstantní a přiřazení uhodnutelné');
  if (items.length === 0) throw new RangeError('slepý běh nemá co zaslepit – vstup je prázdný');

  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.caseId)) throw new Error(`záznam ${item.caseId} je ve vstupu dvakrát`);
    seen.add(item.caseId);
  }

  const arms = [...new Set(items.map((item) => item.arm))].sort();
  if (arms.length < 2) throw new RangeError(`slepý běh nad jedinou variantou (${arms.join(', ')}) nezaslepuje nic`);

  const width = String(items.length).length;
  const order = shuffled(items, salt);
  const assignments: readonly BlindAssignment[] = order.map((item, index) => ({
    handle: `b${String(index + 1).padStart(width, '0')}`,
    caseId: item.caseId,
    arm: item.arm,
  }));
  const blinded: readonly BlindItem[] = order.map((item, index) => ({
    handle: assignments[index].handle,
    payload: item.payload,
  }));

  const found = armLeaks(blinded, arms);
  if (found.length > 0) throw new ArmLeakError(found);

  return { items: blinded, key: { salt, arms, assignments } };
}

/**
 * Přiloží klíč k hotovým verdiktům.
 *
 * **Neúplná sada verdiktů je odmítnutí, ne částečný výsledek.** Kdyby se
 * dopočítala z toho, co dorazilo, byl by z neúplného vyhodnocení agregát nad
 * neúplným jmenovatelem – přesně to, co `evalSet.incompleteRunRule` zakazuje.
 */
export function unblind(verdicts: readonly BlindVerdict[], key: BlindKey): readonly UnblindedOutcome[] {
  const byHandle = new Map(key.assignments.map((assignment) => [assignment.handle, assignment]));
  const seen = new Set<string>();
  const outcomes: UnblindedOutcome[] = [];

  for (const verdict of verdicts) {
    const assignment = byHandle.get(verdict.handle);
    if (assignment === undefined) throw new Error(`rukojeť ${verdict.handle} v klíči není`);
    if (seen.has(verdict.handle)) throw new Error(`rukojeť ${verdict.handle} je ve verdiktech dvakrát`);
    seen.add(verdict.handle);
    outcomes.push({ id: assignment.caseId, arm: assignment.arm, success: verdict.success });
  }

  const missing = key.assignments.filter((assignment) => !seen.has(assignment.handle));
  if (missing.length > 0)
    throw new Error(
      `slepé vyhodnocení je neúplné, chybí ${missing.length} verdiktů: ` +
        missing
          .slice(0, 5)
          .map((assignment) => assignment.handle)
          .join(', '),
    );

  return [...outcomes].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Populace kill gate
// ---------------------------------------------------------------------------

/**
 * Zaslepí naměřenou populaci brány po větvích.
 *
 * Payload je schválně hubený a je to nález, ne úspora: syrové odpovědi leží
 * v `evals/live/`, které je v `.gitignore` (RULES.md §2, repozitář bude
 * veřejný), takže sledovaný report nenese nic, co by šlo posoudit obsahově. Ze
 * stejného důvodu vykazuje zpráva brány `threeDistinctTopologies` jako
 * `NOT_MEASURED`.
 *
 * Ven jde **jen** hash odpovědi, počet oprav a strukturální selhání. Ven nejde
 * `id` ani `responsePath` (nesou `C…`/`E…`, tedy rovnou větev) a hlavně ne
 * `fulfilled` a `accepted` – vyhodnocovací vstup s verdiktem uvnitř by nebyl
 * slepý běh, ale opis.
 */
export function blindKillGate(report: KillGateReport, salt: string): BlindRun {
  return blind(
    report.cases.map((candidate) => ({
      caseId: candidate.id,
      arm: candidate.branch,
      payload: {
        rawHash: candidate.rawHash,
        repairs: candidate.repairs,
        structuralFailures: candidate.structuralFailures,
      },
    })),
    salt,
  );
}
