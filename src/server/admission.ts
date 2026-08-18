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
  /**
   * Naplánuje probuzení za `delayMs` a vrátí funkci, která ho zruší.
   *
   * **Musí měřit týmž časem jako `now`.** Výchozí `setTimeout` měří nástěnnými
   * hodinami, takže sedí k výchozímu `Date.now`; test s ručními hodinami sem
   * musí poslat plánovač, který se hýbe s nimi, jinak by fronta čekala na
   * skutečné vteřiny, zatímco její vlastní čas stojí.
   */
  readonly schedule?: (fn: () => void, delayMs: number) => () => void;
}

/** Nejdelší odklad, který `setTimeout` umí. Přes něj se přetáčí na 1 ms. */
const MAX_DELAY_MS = 2_147_483_647;

/**
 * Čas přijetí, kterému se dá věřit.
 *
 * `receivedAtMs` přichází z HTTP vrstvy, tedy zvenčí — typicky z hlavičky, kterou
 * postavil někdo jiný. Nesmysl v ní nesmí frontu rozbít:
 *
 * - **`NaN` nebo nekonečno** projde porovnáním ve `#wakeExpired()` jako
 *   „nevypršel" (porovnání s `NaN` je vždycky nepravda), takže by takový
 *   požadavek nedostal verdikt vůbec nikdy;
 * - **čas v budoucnosti** — záměna vteřin za milisekundy je nejběžnější — vyrobí
 *   odklad delší, než `setTimeout` umí, a ten se přetočí na 1 ms. Z probuzení se
 *   stane vytížené čekání na celé dny.
 *
 * Obojí se řeší stejně: čemu se nedá věřit, bereme jako „dorazilo teď". Je to
 * bezpečné selhání — požadavek dostane celý rozpočet místo žádného.
 */
function trustedReceipt(claimedMs: number, nowMs: number): number {
  return Number.isFinite(claimedMs) && claimedMs <= nowMs ? claimedMs : nowMs;
}

/**
 * Výchozí plánovač. `unref()` je tu schválně: probuzení čekajícího nesmí být
 * důvod, proč proces nejde ukončit.
 */
function timeoutSchedule(fn: () => void, delayMs: number): () => void {
  const handle = setTimeout(fn, delayMs) as ReturnType<typeof setTimeout> & { unref?: () => void };
  handle.unref?.();
  return () => clearTimeout(handle);
}

/** Proč se čekající probudil: uvolnil se slot, nebo mu vypršel rozpočet. */
type Wakeup = 'slot' | 'expired';

/**
 * Fronta s omezenou soubežností, která nad každým požadavkem rozhodne až ve
 * chvíli, kdy se pro něj uvolní slot — a rozhoduje podle času **přijetí**.
 */
export class AdmissionQueue {
  readonly #policy: AdmissionPolicy;
  readonly #now: () => number;
  readonly #concurrency: number;
  readonly #schedule: (fn: () => void, delayMs: number) => () => void;
  #running = 0;
  /** Zrušení naplánovaného probuzení, nebo `null`, když žádné nestojí. */
  #cancelExpiry: (() => void) | null = null;
  readonly #waiting: Array<{ readonly receivedAtMs: number; readonly wake: (why: Wakeup) => void }> = [];

  constructor(policy: AdmissionPolicy, deps: QueueDeps) {
    this.#policy = policy;
    this.#now = deps.now;
    this.#concurrency = deps.concurrency;
    this.#schedule = deps.schedule ?? timeoutSchedule;
  }

  /** Kolik požadavků právě čeká na slot. */
  get queued(): number {
    return this.#waiting.length;
  }

  /** Kolik se jich právě zpracovává. Nikdy víc než `concurrency`. */
  get running(): number {
    return this.#running;
  }

  /**
   * Podá požadavek do fronty.
   *
   * **`receivedAtMs` patří volajícímu, ne frontě.** Výchozí hodnota je `now()`,
   * ale HTTP vrstva sem má poslat čas, kdy požadavek DORAZIL. Všechno mezi tím
   * — načtení těla, moderace, a hlavně čekání ve smyčce událostí, kterou fronta
   * pod zátěží ve skutečnosti je — by jinak bylo zadarmo, a deadline by zůstal
   * „od začátku našeho zpracování", jen o patro výš. Tedy přesně ta vada, kterou
   * hlavička tohohle souboru popisuje jako důvod své existence.
   */
  async submit<T>(
    id: string,
    work: (deadlineMs: number) => Promise<T>,
    receivedAtMs: number = this.#now(),
  ): Promise<AdmissionOutcome<T>> {
    const receipt = trustedReceipt(receivedAtMs, this.#now());

    // Odsouzené požadavky se uvolní DŘÍV, než se na jejich místo někdo odmítne.
    // Požadavek, kterému rozpočet vypršel ve frontě, `DEADLINE_EXCEEDED` stejně
    // dostane — až se dostane na řadu. Kdyby si do té doby držel místo, byla by
    // fronta plná odsouzených a odmítal by se čerstvý požadavek, který má celý
    // rozpočet před sebou. Tedy přesně ta patologie, kterou tenhle soubor
    // popisuje nahoře jako důvod své existence.
    this.#wakeExpired();

    if (this.#waiting.length >= this.#policy.maxQueued && this.#running >= this.#concurrency) {
      // Čekání se počítá i tady. Nula by byla pravda jen pro požadavek podaný
      // v tomtéž okamžiku, kdy dorazil — a to je právě ten předpoklad, který
      // `receivedAtMs` ruší.
      const waitedMs = this.#now() - receipt;
      return {
        verdict: {
          admitted: false,
          id,
          waitedMs,
          reason: 'QUEUE_FULL',
          remainingMs: this.#policy.budgetMs - waitedMs,
        },
        value: null,
      };
    }

    const why = await this.#slot(receipt);

    // Probuzený kvůli vypršení slot nikdy nedostal, takže ho ani nevrací. Kdyby
    // prošel `finally` s `#release()`, snížil by `#running` za někoho jiného a
    // fronta by pustila víc práce, než dovoluje `concurrency`.
    if (why === 'expired') {
      return { verdict: admit(id, receipt, this.#now(), this.#policy), value: null };
    }

    try {
      // Tady je celý rozdíl proti naivní verzi: `receivedAtMs` je z podání,
      // `this.#now()` je z tohohle okamžiku, a rozhoduje se z jejich rozdílu.
      const verdict = admit(id, receipt, this.#now(), this.#policy);
      if (!verdict.admitted) return { verdict, value: null };

      return { verdict, value: await work(verdict.deadlineMs) };
    } finally {
      // Běží i když `work` vyhodí — výjimka propadne volajícímu, ale slot se
      // vrátí. Bez toho by jedna vadná odpověď poskytovatele frontu zadusila.
      this.#release();
    }
  }

  async #slot(receivedAtMs: number): Promise<Wakeup> {
    if (this.#running < this.#concurrency) {
      this.#running += 1;
      return 'slot';
    }

    const why = await new Promise<Wakeup>((wake) => {
      this.#waiting.push({ receivedAtMs, wake });
      this.#armExpiry();
    });
    if (why === 'slot') this.#running += 1;
    return why;
  }

  /**
   * Naplánuje probuzení na okamžik, kdy vyprší nejstarší čekající.
   *
   * **Bez tohohle se `#wakeExpired()` volá jen z `submit()`, tedy jen když
   * dorazí další provoz.** Po nárazu a následném tichu tak čekající sedí ve
   * frontě, dokud někdo nepřijde — u naměřeného rozpočtu 60 s to je celá minuta
   * po tom, co jeho odpověď přestala mít smysl. Odmítnutí, které přijde, až
   * když má kdo se ho zeptat, je totéž jako žádné.
   *
   * **Odklad má podlahu jedné milisekundy, a ta podlaha je nosná.** Časovač,
   * který dosedne přesně na hranici, nikoho neuvolní — v tu chvíli `minServiceMs`
   * ještě zbývá. Bez podlahy by se naplánoval znovu s nulovým odkladem a bylo by
   * z toho vytížené čekání místo probuzení; s ní se posune o milisekundu dál a
   * uvolní na další otočce. To druhé probuzení plánuje `#wakeExpired()`, i když
   * neuvolnilo nikoho — bez toho by čekající po dosednutí na hranici zůstal ve
   * frontě navždy.
   */
  #armExpiry(): void {
    this.#cancelExpiry?.();
    this.#cancelExpiry = null;
    if (this.#waiting.length === 0) return;

    const earliestReceivedAtMs = Math.min(...this.#waiting.map((entry) => entry.receivedAtMs));
    const expiresAtMs = earliestReceivedAtMs + this.#policy.budgetMs - this.#policy.minServiceMs;
    const delayMs = Math.min(MAX_DELAY_MS, Math.max(1, expiresAtMs - this.#now()));

    this.#cancelExpiry = this.#schedule(() => {
      this.#cancelExpiry = null;
      // `#wakeExpired()` si nové probuzení naplánuje samo, i když tohle nikoho
      // neuvolnilo.
      this.#wakeExpired();
    }, delayMs);
  }

  /** Uvolní z fronty ty, kterým rozpočet vypršel dřív, než se na ně dostalo. */
  #wakeExpired(): void {
    const nowMs = this.#now();
    const expired = (entry: { readonly receivedAtMs: number }): boolean =>
      this.#policy.budgetMs - (nowMs - entry.receivedAtMs) < this.#policy.minServiceMs;

    for (const entry of this.#waiting.filter(expired)) {
      this.#waiting.splice(this.#waiting.indexOf(entry), 1);
      entry.wake('expired');
    }

    this.#armExpiry();
  }

  #release(): void {
    this.#running -= 1;
    const next = this.#waiting.shift();
    if (next !== undefined) next.wake('slot');
    // Jednotné pravidlo „kdo sáhne na frontu, přeplánuje", ne samostatné
    // chování: stará plánovaná chvíle patřila tomu, kdo právě odešel, takže je
    // dřív než u zbylých a `#wakeExpired()` by se z ní zotavilo samo.
    this.#armExpiry();
  }
}
