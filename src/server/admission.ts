/**
 * Admission control — **deadline od PŘIJETÍ požadavku, ne od začátku práce.**
 *
 * Naivní verze si čas změří ve chvíli, kdy se požadavek dostane na řadu. Dokud
 * je volno, chová se stejně jako tahle. Rozejdou se přesně tam, kde na tom
 * záleží: pod zátěží.
 *
 * Řekněme rozpočet 10 s a požadavek, který stráví 9 s ve frontě.
 *
 * | | Naivní (od začátku práce) | Tahle (od přijetí) |
 * |---|---|---|
 * | co změří | 0 s — teprve začínáme | 9 s — tolik už čeká |
 * | co udělá | pustí ho a odpoví po 12 s | odmítne ho hned |
 * | kdo to zaplatí | volající, který dávno odešel | nikdo |
 *
 * Naivní verze tedy odpoví **po vypršení rozpočtu, na požadavek, který už nikdo
 * nečte** — a slot, který na to spálila, chyběl požadavku přijatému právě teď.
 * Pod zátěží se to nastřádá: fronta roste, každý požadavek v ní čeká déle,
 * každá odpověď dorazí ještě později, a všechny jsou k ničemu. Odmítnutí je to
 * jediné, co ten kruh přeruší.
 *
 * ## Odmítnutí je levné, pozdní odpověď ne
 *
 * `minServiceMs` je nejkratší doba, za kterou má zpracování šanci doběhnout.
 * Když do deadlinu zbývá míň, nemá smysl začínat: výsledek nestihne dorazit, a
 * jediné, co se stane, je že mezitím obsadí slot. Sonda tedy odmítá **dřív, než
 * práci pustí**, ne po ní.
 *
 * ## Deadline se posílá dál, nezůstává tady
 *
 * `work` dostane **absolutní deadline**, ne rozpočet. Kdyby dostalo rozpočet,
 * odpočítávalo by si ho od svého začátku — a tím by se ta samá vada vrátila o
 * úroveň níž, u volání směrem k poskytovateli.
 */

export interface AdmissionPolicy {
  /** Celý rozpočet požadavku, počítaný **od jeho přijetí**. */
  readonly budgetMs: number;
  /** Nejkratší doba, za kterou má zpracování šanci doběhnout. */
  readonly minServiceMs: number;
  /** Kolik požadavků smí čekat ve frontě. Přes to se odmítá hned při podání. */
  readonly maxQueued: number;
}

export type AdmissionRefusal =
  /** Do deadlinu zbývá míň, než kolik zpracování potřebuje. */
  | 'DEADLINE_EXCEEDED'
  /** Fronta je plná. Odmítá se při podání, ne po čekání. */
  | 'QUEUE_FULL';

export interface Admitted {
  readonly admitted: true;
  readonly id: string;
  /** Kolik času požadavek strávil ve frontě. */
  readonly waitedMs: number;
  /** Absolutní čas, do kterého musí být hotovo. */
  readonly deadlineMs: number;
}

export interface Refused {
  readonly admitted: false;
  readonly id: string;
  readonly waitedMs: number;
  readonly reason: AdmissionRefusal;
  /** Kolik z rozpočtu zbývalo. Záporné číslo znamená, že už vypršel. */
  readonly remainingMs: number;
}

export type AdmissionVerdict = Admitted | Refused;

/**
 * Rozhodnutí nad jedním požadavkem. Čistá funkce — fronta ji volá ve chvíli,
 * kdy se uvolní slot, a předává jí čas přijetí, ne čas volání.
 */
export function admit(
  id: string,
  receivedAtMs: number,
  nowMs: number,
  policy: AdmissionPolicy,
): AdmissionVerdict {
  const waitedMs = nowMs - receivedAtMs;
  const remainingMs = policy.budgetMs - waitedMs;

  if (remainingMs < policy.minServiceMs) {
    return { admitted: false, id, waitedMs, reason: 'DEADLINE_EXCEEDED', remainingMs };
  }

  return { admitted: true, id, waitedMs, deadlineMs: receivedAtMs + policy.budgetMs };
}

export interface AdmissionOutcome<T> {
  readonly verdict: AdmissionVerdict;
  /** Výsledek práce, nebo `null`, když se nespustila. */
  readonly value: T | null;
}

export interface QueueDeps {
  /** Nástěnné hodiny. Fronta není na replay cestě. */
  readonly now: () => number;
  /** Kolik požadavků se zpracovává současně. */
  readonly concurrency: number;
}

/**
 * Fronta s omezenou soubežností, která nad každým požadavkem rozhodne až ve
 * chvíli, kdy se pro něj uvolní slot — a rozhoduje podle času **přijetí**.
 */
export class AdmissionQueue {
  readonly #policy: AdmissionPolicy;
  readonly #now: () => number;
  readonly #concurrency: number;
  #running = 0;
  #queued = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(policy: AdmissionPolicy, deps: QueueDeps) {
    this.#policy = policy;
    this.#now = deps.now;
    this.#concurrency = deps.concurrency;
  }

  /** Kolik požadavků právě čeká na slot. */
  get queued(): number {
    return this.#queued;
  }

  /** Kolik se jich právě zpracovává. */
  get running(): number {
    return this.#running;
  }

  async submit<T>(id: string, work: (deadlineMs: number) => Promise<T>): Promise<AdmissionOutcome<T>> {
    const receivedAtMs = this.#now();

    if (this.#queued >= this.#policy.maxQueued && this.#running >= this.#concurrency) {
      return {
        verdict: { admitted: false, id, waitedMs: 0, reason: 'QUEUE_FULL', remainingMs: this.#policy.budgetMs },
        value: null,
      };
    }

    await this.#slot();

    try {
      // Tady je celý rozdíl proti naivní verzi: `receivedAtMs` je z podání,
      // `this.#now()` je z tohohle okamžiku, a rozhoduje se z jejich rozdílu.
      const verdict = admit(id, receivedAtMs, this.#now(), this.#policy);
      if (!verdict.admitted) return { verdict, value: null };

      return { verdict, value: await work(verdict.deadlineMs) };
    } finally {
      this.#release();
    }
  }

  async #slot(): Promise<void> {
    if (this.#running < this.#concurrency) {
      this.#running += 1;
      return;
    }

    this.#queued += 1;
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#queued -= 1;
    this.#running += 1;
  }

  #release(): void {
    this.#running -= 1;
    const next = this.#waiting.shift();
    if (next !== undefined) next();
  }
}
