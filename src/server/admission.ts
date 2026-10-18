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
  | 'QUEUE_FULL'
  /**
   * Fronta se zavírá. Čekající dostane verdikt hned, místo aby čekal na svoje
   * vypršení — a proces se tím nedrží déle, než musí.
   */
  | 'SHUTTING_DOWN';

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
 * Kontrola politiky. **Nesmyslná politika neudělá nesmyslný verdikt — udělá
 * trvalé vytížené čekání, ze kterého se nikdo nevrátí.**
 *
 * Rozpočet přečtený jako `Number(process.env.X)` je u chybějící proměnné `NaN`.
 * Co se stane pak: `Math.max(1, NaN)` je `NaN`, Node ho u `setTimeout` ořízne na
 * 1 ms, predikát „vypršel?" (`NaN - x < minServiceMs`) je nepravda, takže se
 * neuvolní **nikdo** — a `#armExpiry()` se přeplánuje po milisekundě znovu.
 * Fronta tím tiká navždy, drží proces (časovač se od zrušení `unref()` už
 * neodrefuje) a čekající verdikt nedostane. Tedy přesně ta vada, kvůli které
 * tenhle soubor existuje, jen vyrobená konfigurací místo hlavičky.
 *
 * Proto se kontroluje **při stavbě**, ne za běhu: fronta s takovou politikou
 * nemůže fungovat vůbec, takže odmítnout ji postavit je striktně lepší než ji
 * nechat běžet naprázdno. Konfigurace je okraj a validace patří na okraj — táž
 * doktrína, jakou má `trustedReceipt` u času přijetí.
 */
export const MAX_DELAY_MS = 2_147_483_647;

export function checkPolicy(policy: AdmissionPolicy): void {
  const finite = (label: string, value: number, lowest: number): void => {
    if (!Number.isFinite(value) || value < lowest) {
      throw new RangeError(`AdmissionPolicy.${label} musí být konečné číslo od ${lowest}, dostalo ${value}`);
    }
  };

  // Nulový rozpočet je nulová propustnost, ne konzervativní nastavení.
  finite('budgetMs', policy.budgetMs, 1);

  // **Horní mez, a je stejně nosná jako ta dolní.** `setTimeout` delší odklad
  // neumí a přetočí ho na 1 ms, takže rozpočet 2 147 483 648 ms (necelých 25
  // dní) vyrobí přesně tu smyčku, kterou tahle kontrola má zavřít: odklad se
  // ořízne na milisekundu, nikdo nevyprší, `#armExpiry()` se přeplánuje znovu.
  // Konečné číslo tedy nestačí, musí být i dost malé.
  //
  // Commit `da7f62b` tenhle clamp z `#armExpiry()` smazal s odůvodněním, že
  // „když je ohraničený čas přijetí, nemůže nikdy zabrat". To odůvodnění krylo
  // jen `receivedAtMs`, nikdy `budgetMs`, a nikdo ho neměřil. **Nevrací se jako
  // clamp, ale jako mez na vstupu** — z `earliestReceipt <= now` plyne
  // `delayMs <= budgetMs - minServiceMs <= MAX_DELAY_MS`, takže po téhle
  // kontrole je odklad dokazatelně v rozsahu a clamp by byl mrtvý kód. Tentokrát
  // je to změřené, ne odvozené.
  if (policy.budgetMs > MAX_DELAY_MS) {
    throw new RangeError(
      `AdmissionPolicy.budgetMs (${policy.budgetMs}) přesahuje nejdelší odklad, který setTimeout umí (${MAX_DELAY_MS})`,
    );
  }
  finite('minServiceMs', policy.minServiceMs, 0);

  if (!Number.isInteger(policy.maxQueued) || policy.maxQueued < 0) {
    throw new RangeError(`AdmissionPolicy.maxQueued musí být celé nezáporné číslo, dostalo ${policy.maxQueued}`);
  }

  // Delší minimum než celý rozpočet odmítne **každý** požadavek bez výjimky,
  // fronta má nulovou propustnost a nikde o tom není řádek — táž třída jako čas
  // přijetí z roku 1970. **Rovnost se propouští schválně a mez je tím `>`, ne
  // `>=`:** při `minServiceMs === budgetMs` projde požadavek s nulovým čekáním,
  // takže propustnost nulová není. Je to degenerované nastavení, ne rozbité, a
  // odmítat ho by znamenalo zakázat i legitimní `budgetMs: 1, minServiceMs: 1`.
  if (policy.minServiceMs > policy.budgetMs) {
    throw new RangeError(
      `AdmissionPolicy.minServiceMs (${policy.minServiceMs}) nesmí přesáhnout budgetMs (${policy.budgetMs})`,
    );
  }
}

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
  // Táž kontrola jako ve frontě, a je tu proto, že tahle funkce je taky
  // exportovaná. Bez ní vrátí `admit(id, NaN, …)` verdikt `admitted: true`
  // s `deadlineMs: NaN` — tedy deadline, který nikdy nevyprší, předaný dál do
  // práce jako by byl v pořádku. Politika má tutéž díru z téhož důvodu:
  // `budgetMs: NaN` vyrobí `remainingMs: NaN`, porovnání je nepravda, a ven jde
  // zase `admitted: true` s `deadlineMs: NaN`.
  checkPolicy(policy);
  const receipt = trustedReceipt(receivedAtMs, nowMs);
  const waitedMs = nowMs - receipt;
  const remainingMs = policy.budgetMs - waitedMs;

  if (remainingMs < policy.minServiceMs) {
    return { admitted: false, id, waitedMs, reason: 'DEADLINE_EXCEEDED', remainingMs };
  }

  return { admitted: true, id, waitedMs, deadlineMs: receipt + policy.budgetMs };
}

export interface AdmissionOutcome<T> {
  readonly verdict: AdmissionVerdict;
  /** Výsledek práce, nebo `null`, když se nespustila. */
  readonly value: T | null;
}

/**
 * Jedno srovnání času přijetí, ohlášené ve chvíli, kdy k němu došlo.
 *
 * Jde do logu, ne do odpovědi — verdikt požadavku se tím nemění, protože
 * srovnání je bezpečné selhání. Mění se jen to, jestli se o něm dá vědět.
 */
export interface CoercedReceipt {
  readonly id: string;
  /** Co přišlo od volajícího. Nesmysl, proto se nepoužilo. */
  readonly claimedMs: number;
  /** Co fronta vzala místo toho. Vždycky „teď". */
  readonly usedMs: number;
}

export interface QueueDeps {
  /** Nástěnné hodiny. Fronta není na replay cestě. */
  readonly now: () => number;
  /** Kolik požadavků se zpracovává současně. */
  readonly concurrency: number;
  /**
   * Ohlásí srovnání času přijetí ve chvíli, kdy nastalo.
   *
   * **Povinné schválně, a je to celý rozdíl proti pouhému čítači.**
   * `coercedReceipts` musí někdo přečíst, a „kdo frontu zapojuje, tohle číslo
   * loguje" je přání, ne mechanismus: zapojení, které na něj zapomene, vypadá
   * naprosto zdravě — `waitedMs: 0` u každého požadavku a nikde ani řádek.
   * Povinná závislost je jediný tvar, který zapomenout nejde, protože bez ní
   * frontu nelze postavit.
   */
  readonly onCoercedReceipt: (coercion: CoercedReceipt) => void;
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

/**
 * Čas přijetí, kterému se dá věřit.
 *
 * `receivedAtMs` přichází z HTTP vrstvy, tedy zvenčí — typicky z hlavičky, kterou
 * postavil někdo jiný. Nesmysl v ní nesmí frontu rozbít, a nesmysl má **tři**
 * tvary, ne jeden:
 *
 * - **`NaN` nebo nekonečno.** Porovnání s `NaN` je vždycky nepravda, takže by
 *   takový požadavek prošel testem „vypršel?" jako živý a verdikt by nedostal
 *   nikdy. Sem patří i výsledek `Number(null)` u chybějící hlavičky — ten je ale
 *   `0`, tedy případ níž.
 * - **Čas v budoucnosti**, typicky záměnou vteřin za milisekundy. Odklad vyjde
 *   delší, než `setTimeout` umí, a přetočí se na 1 ms — z probuzení je vytížené
 *   čekání na celé dny.
 * - **Čas před tím, než tahle fronta vůbec vznikla.** Tenhle je nejzákeřnější a
 *   je opačný k předchozímu: `Number(null)` i `Number('')` dávají `0`, což je
 *   konečné číslo v minulosti, takže by prošlo. Požadavek přijatý roku 1970 má
 *   rozpočet vyčerpaný o padesát let, takže by se odmítl **každý požadavek**,
 *   fronta by měla nulovou propustnost a nikde by o tom nebyl řádek.
 *
 * Řeší se to u všech tří stejně: čemu se nedá věřit, bereme jako „dorazilo teď".
 * Je to bezpečné selhání — požadavek dostane celý rozpočet místo žádného.
 * **Mlčky se to ale neděje**, viz `coercedReceipts`.
 *
 * `earliestMs` je dolní mez, kterou zná jen volající. Čistá `admit()` ji nemá
 * odkud vzít, tak ji nedává; fronta ji zná (vznikla někdy) a dává ji vždycky.
 */
export function trustedReceipt(claimedMs: number, nowMs: number, earliestMs = Number.NEGATIVE_INFINITY): number {
  return Number.isFinite(claimedMs) && claimedMs <= nowMs && claimedMs >= earliestMs ? claimedMs : nowMs;
}

/**
 * Výchozí plánovač. **Časovač drží smyčku událostí schválně.**
 *
 * Dřív tu bylo `unref()` s odůvodněním „probuzení čekajícího nesmí být důvod,
 * proč proces nejde ukončit". To platí o časovači, který tiká pořád. Tenhle
 * stojí jen tehdy, když někdo čeká na verdikt: `#armExpiry()` ho po vyprázdnění
 * fronty nepřeplánuje, takže doba, po kterou proces drží, je shora omezená na
 * `budgetMs - minServiceMs`.
 *
 * S `unref()` nastane tohle: požadavek, jehož jediným čekajícím handlem je
 * tenhle časovač, smyčku neudrží — Node skončí kódem 0 a `submit()` se nedočká
 * verdiktu ani chyby. Za posluchajícím socketem se to nestane, protože smyčku
 * drží socket; ve skriptu, ve workeru nebo v jednorázové úloze ano. Fronta,
 * jejíž celý smysl je „každý požadavek dostane verdikt", si nesmí nechat cestu,
 * kde ho nedostane žádný. Ohraničené držení procesu je levnější než ztracená
 * odpověď.
 */
function timeoutSchedule(fn: () => void, delayMs: number): () => void {
  const handle = setTimeout(fn, delayMs);
  return () => clearTimeout(handle);
}

/** Proč se čekající probudil: uvolnil se slot, vypršel rozpočet, nebo se zavírá. */
type Wakeup = 'slot' | 'expired' | 'closed';

/**
 * Fronta s omezenou soubežností, která nad každým požadavkem rozhodne až ve
 * chvíli, kdy se pro něj uvolní slot — a rozhoduje podle času **přijetí**.
 */
export class AdmissionQueue {
  readonly #policy: AdmissionPolicy;
  readonly #now: () => number;
  readonly #concurrency: number;
  readonly #schedule: (fn: () => void, delayMs: number) => () => void;
  readonly #onCoercedReceipt: (coercion: CoercedReceipt) => void;
  /** Kdy fronta vznikla. Dřív než tohle žádný její požadavek dorazit nemohl. */
  readonly #createdAtMs: number;
  #closed = false;
  #coerced = 0;
  #running = 0;
  /** Zrušení naplánovaného probuzení, nebo `null`, když žádné nestojí. */
  #cancelExpiry: (() => void) | null = null;
  readonly #waiting: Array<{ readonly id: string; readonly receivedAtMs: number; readonly wake: (why: Wakeup) => void }> = [];

  constructor(policy: AdmissionPolicy, deps: QueueDeps) {
    checkPolicy(policy);

    // **Táž třída jako politika, jen o pole vedle.** `Number(process.env.X)` u
    // chybějící proměnné je `NaN`, a `this.#running < NaN` je vždycky nepravda:
    // do práce se nepustí nikdo, všechno se zařadí do fronty a všechno nakonec
    // vrátí `DEADLINE_EXCEEDED`. Nula a záporné číslo dělají totéž. Fronta, která
    // nikdy nic nespustí, se nemá postavit.
    if (!Number.isInteger(deps.concurrency) || deps.concurrency < 1) {
      throw new RangeError(`QueueDeps.concurrency musí být celé číslo od 1, dostalo ${deps.concurrency}`);
    }

    this.#policy = policy;
    this.#now = deps.now;
    this.#concurrency = deps.concurrency;
    this.#schedule = deps.schedule ?? timeoutSchedule;
    this.#onCoercedReceipt = deps.onCoercedReceipt;
    this.#createdAtMs = deps.now();
  }

  /**
   * Kolikrát fronta nedokázala uvěřit času přijetí a vzala místo něj „teď".
   *
   * **Tiché srovnání je horší než hlasitý pád.** Vada, která tenhle čítač
   * rozjede, je vždycky u volajícího — rozbitý parser hlavičky, jiný zdroj času,
   * záměna vteřin za milisekundy. Fronta se z ní zotaví, ale tím se z ní stane
   * naivní verze „od začátku našeho zpracování", které se celý tenhle soubor
   * snaží zabránit, a bez čítače by to vypadalo úplně zdravě: `waitedMs: 0` u
   * každého požadavku.
   *
   * **Čítač je souhrn, ne hlášení.** Někdo ho musí přečíst, a zapojení, které
   * na to zapomene, je zpátky v tichém režimu. Hlásí se proto navíc každé
   * jednotlivé srovnání, hned jak nastane — `QueueDeps.onCoercedReceipt`.
   */
  get coercedReceipts(): number {
    return this.#coerced;
  }

  /** Kolik požadavků právě čeká na slot. */
  get queued(): number {
    return this.#waiting.length;
  }

  /**
   * Pořadí čekajícího `id` od jedničky (1 = další na řadě), `null` = nečeká –
   * běží, skončil, nebo ho fronta nezná. Dva čekající s týmž `id` dají první.
   */
  position(id: string): number | null {
    const index = this.#waiting.findIndex((entry) => entry.id === id);
    return index === -1 ? null : index + 1;
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
    const receipt = trustedReceipt(receivedAtMs, this.#now(), this.#createdAtMs);

    // Hlásí se DŘÍV, než se řeší zavření. Požadavek, který dorazí do vypínající
    // se fronty s rozbitým časem, je pořád vada u volajícího — a „mlčky se to
    // neděje" platí i během vypínání, jinak je to tichá cesta, jak srovnání
    // schovat.
    if (receipt !== receivedAtMs) {
      this.#coerced += 1;
      this.#onCoercedReceipt({ id, claimedMs: receivedAtMs, usedMs: receipt });
    }

    // **Až tady, a to je celý rozdíl.** `onCoercedReceipt` je kód, který dodává
    // ten, kdo frontu zapojuje, a běží synchronně — smí tedy frontu zavřít, což
    // u obsluhy, která rozbité hodiny bere jako fatální, není nic divného. Kdyby
    // se `#closed` čtlo jen před ním, tenhle `submit()` by pokračoval do už
    // vyprázdněné čekárny, zařadil by se do ní a `close()` by ho už neprobudilo:
    // verdikt by přišel až z vlastního vypršení, tedy `budgetMs - minServiceMs`
    // po zavření. Naměřeno na re-entrantní obsluze — čekající verdikt nedostal a
    // fronta hlásila `queued: 1`.
    //
    // Návrat sem není podmínka v `#armExpiry()`. Ta by časovač nenaplánovala
    // vůbec, takže by čekající neprobudil nikdo a z ohraničeného držení procesu
    // by bylo nekonečné. Změřeno taky.
    if (this.#closed) return { verdict: this.#shuttingDown(id, receipt), value: null };

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

    const why = await this.#slot(id, receipt);

    // Probuzený kvůli vypršení slot nikdy nedostal, takže ho ani nevrací. Kdyby
    // prošel `finally` s `#release()`, snížil by `#running` za někoho jiného a
    // fronta by pustila víc práce, než dovoluje `concurrency`.
    if (why === 'closed') {
      // NE přes `admit()`: nevypršelému požadavku by vrátilo `admitted: true`,
      // a `admitted: true` s `value: null` je verdikt, který lže — práce se
      // nespustila. Zavření je vlastní důvod odmítnutí, ne vypršení.
      return { verdict: this.#shuttingDown(id, receipt), value: null };
    }

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

  /**
   * Zavře frontu: zruší naplánované probuzení a všem čekajícím dá verdikt hned.
   *
   * **Je to druhá polovina zrušeného `unref()`.** Časovač teď smyčku událostí
   * drží schválně, takže bez zavření by čekající po `SIGTERM` držel proces až do
   * svého vypršení — u rozpočtu 60 s, který si tenhle soubor sám cituje, tedy
   * minutu po tom, co posluchač zavřel. Terminační lhůta 30 s by ho mezitím
   * zabila uprostřed, takže by o verdikt přišel stejně, jen o vteřinu později a
   * bez stopy. Zavření ten hold zkrátí na nulu, **aniž by kdokoli přišel o
   * verdikt** — což je celý rozdíl proti `unref()`, které ho zkracovalo tím, že
   * o něj čekající připravilo.
   *
   * Běžící práce se nepřerušuje: drží skutečný slot a její `finally` ho vrátí.
   * Zavřená fronta jen nepřijímá nic nového a nikoho nenechává čekat.
   *
   * Volat se smí opakovaně — druhé zavolání nemá koho probudit.
   */
  close(): void {
    this.#closed = true;
    this.#cancelExpiry?.();
    this.#cancelExpiry = null;
    for (const entry of this.#waiting.splice(0)) entry.wake('closed');
  }

  #shuttingDown(id: string, receivedAtMs: number): Refused {
    const waitedMs = this.#now() - receivedAtMs;
    return {
      admitted: false,
      id,
      waitedMs,
      reason: 'SHUTTING_DOWN',
      remainingMs: this.#policy.budgetMs - waitedMs,
    };
  }

  async #slot(id: string, receivedAtMs: number): Promise<Wakeup> {
    if (this.#running < this.#concurrency) {
      this.#running += 1;
      return 'slot';
    }

    const why = await new Promise<Wakeup>((wake) => {
      this.#waiting.push({ id, receivedAtMs, wake });
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
    const delayMs = Math.max(1, expiresAtMs - this.#now());

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
