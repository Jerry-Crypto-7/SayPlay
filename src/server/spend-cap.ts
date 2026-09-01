/**
 * **Tvrdý strop útraty pro živý endpoint.** Odmítne další volání dřív, než
 * vznikne — nezaznamená ho zpětně.
 *
 * `REUSE.md` ř. 128 popisuje, co portfolio má: *„kredity jsou kvóta na
 * uživatele, cost trackery měří zpětně, nic neodmítne další volání."* Tohle je
 * ta chybějící věc, a proto je to jediný soubor v P3, který se nepřenáší.
 *
 * ## Rezervace, ne účtenka
 *
 * Účtenka po volání je pozdě: model, který odpoví desetinásobkem očekávaného
 * počtu tokenů, strop překročí a tracker to jen zapíše. Strop proto **rezervuje
 * nejhorší případ dopředu** a po volání ho vymění za skutečnou cenu. Dokud
 * volání běží, jeho nejhorší případ blokuje rozpočet ostatním — jinak by deset
 * souběžných požadavků prošlo všech deset, protože v okamžiku rozhodnutí nikdo
 * z nich ještě nic neutratil.
 *
 * ## Vypínač je soubor na disku, ne HTTP routa
 *
 * AC úlohy žádá, aby se strop dal změnit **za běhu bez redeploye**, a zároveň
 * zakazuje přihlašování. Administrátorská routa bez přihlášení je horší než
 * žádný strop: kdokoli ho vypne dřív, než pošle tisíc promptů. Ovládá se proto
 * souborem, který si čte tenhle modul při **každém** rozhodnutí — změna platí od
 * dalšího požadavku, přístup k souboru má jen kdo má přístup ke stroji, a
 * HTTP povrch nevzniká žádný.
 *
 * Čte se pokaždé znovu schválně. Cache by potřebovala invalidaci a smysl celé
 * věci je, že změna platí hned; jeden `readFileSync` nad souborem o dvou
 * klíčích je proti volání modelu neměřitelný.
 *
 * ## Kdy se selhává zavřeně
 *
 * | Stav ovládacího souboru | Chování |
 * |---|---|
 * | neexistuje | výchozí hodnoty — normální stav, nikdo vypínačem nehnul |
 * | nečitelný nebo vadný | **odmítnutí** — někdo vypínačem hnul a rozbil ho |
 *
 * Vadný soubor nesmí znamenat „bez stropu". Byl by to přesně ten tichý průchod,
 * který `ops/cleanroom-provisioning.md` popisuje u prázdného seznamu: v logu
 * vypadá jako splněná brána.
 *
 * ## Hranice proti `evals/harness/preflight.ts`
 *
 * V repu je druhý dolarový strop, pro offline měřicí běhy, a **není to kopie
 * tohohle**. Ani jeden nesmí importovat druhý a tenhle nesmí číst proměnné
 * prostředí toho druhého — jinak by strop demo cesty šel vypnout tím, co bylo
 * nastavené pro měření. Hranici drží lexikální test v
 * `src/server/__tests__/pipeline.test.ts`.
 */

import { readFileSync } from 'node:fs';

/** Spotřeba tokenů tak, jak ji hlásí poskytovatel. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Ceník větve. Dolary za milion tokenů, zvlášť vstup a výstup. */
export interface Pricing {
  readonly usdPerMTokIn: number;
  readonly usdPerMTokOut: number;
}

export function costUsd(usage: Usage, pricing: Pricing): number {
  return (
    (usage.inputTokens * pricing.usdPerMTokIn + usage.outputTokens * pricing.usdPerMTokOut) / 1_000_000
  );
}

/** Co říká vypínač. Přesně tenhle tvar má i ovládací soubor. */
export interface CapControl {
  readonly enabled: boolean;
  readonly capUsd: number;
  /**
   * Strop na počet volání. Nevyplněný znamená `DEFAULT_CALL_CAP`.
   *
   * Je **volitelný schválně**: ovládací soubory a volání konstruktoru, které
   * vznikly dřív, musí dál platit. Vyplněný ale musí být celé kladné číslo —
   * nesmysl se odmítne stejně jako u zbytku souboru, tedy zavřeně.
   */
  readonly callCap?: number;
}

export interface CapSnapshot extends CapControl {
  readonly spentUsd: number;
  readonly reservedUsd: number;
  readonly remainingUsd: number;
  readonly callsMade: number;
  readonly callsRemaining: number;
}

export type RefusalReason =
  /** Rozpočet by rezervací přetekl. Volání se neuskuteční. */
  | 'CAP_EXHAUSTED'
  /**
   * Vyčerpaný strop na **počet** volání.
   *
   * Nezávisí na žádné ceně, a v tom je celý smysl. Dolarový strop stojí na
   * ceníku, který operátor opisuje ručně, takže překlep o tři řády (`0.000015`
   * místo `15`) ho tiše roztáhne milionkrát a nic si toho nevšimne — cena se
   * nedá ověřit na správnost, jen na tvar. Počet volání se ověřit dá.
   */
  | 'CALL_CAP_EXHAUSTED'
  /** Ovládací soubor existuje a nedá se přečíst nebo mu nesedí tvar. */
  | 'CONTROL_UNREADABLE'
  /**
   * Odhad nejhoršího případu není konečné nezáporné číslo.
   *
   * Není to obrana proti nemožnému: `NaN` v porovnání vždycky vyjde `false`,
   * takže by tiše prošlo **každé** volání a strop by se choval jako vypnutý.
   */
  | 'INVALID_ESTIMATE';

export interface Reserved {
  readonly ok: true;
  /** Kolik dolarů drží tahle rezervace, dokud se nevyrovná. */
  readonly reservedUsd: number;
  /**
   * Vymění rezervaci za skutečnou cenu.
   *
   * `'unknown'` znamená „volání skončilo a nevíme, kolik spálilo" — účtuje se
   * celý nejhorší případ. Opačná volba by z padajícího poskytovatele udělala
   * cestu, jak strop obejít: každé volání by selhalo, nic by se nenaúčtovalo a
   * peníze by přitom odcházely.
   *
   * Druhé a další vyrovnání téže rezervace nedělá nic.
   *
   * **Vrací dolary, které se doopravdy strhly** — tedy `actualUsd`, když se dá
   * použít, a jinak celou rezervaci. Bez toho volající neměl jak zjistit, které
   * z těch dvou čísel platí, a hlásil dál to, které poslal: naměřeno 1. 9. 2026,
   * že účtenka `{input_tokens: -1e9}` strhla správně 0,2195 USD a operátorovi
   * ohlásila `costUsd=-5000`. Opakované vyrovnání vrátí totéž číslo jako to
   * první, protože strop se podruhé nehnul.
   */
  settle(actualUsd: number | 'unknown'): number;
}

export interface Refused {
  readonly ok: false;
  readonly reason: RefusalReason;
  readonly detail: string;
  readonly snapshot: CapSnapshot;
}

export type Reservation = Reserved | Refused;

function parseControl(raw: string): CapControl | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { enabled, capUsd } = parsed as { enabled?: unknown; capUsd?: unknown };
  if (typeof enabled !== 'boolean') return null;
  if (typeof capUsd !== 'number' || !Number.isFinite(capUsd) || capUsd < 0) return null;
  const { callCap } = parsed as { callCap?: unknown };
  if (callCap === undefined) return { enabled, capUsd };
  // Vyplněný, ale nesmyslný strop je rozbitý vypínač, ne „bez stropu".
  if (typeof callCap !== 'number' || !Number.isInteger(callCap) || callCap < 0) return null;
  return { enabled, capUsd, callCap };
}

export class SpendCap {
  #spentUsd = 0;
  #reservedUsd = 0;
  /**
   * Povolená **placená** volání. Roste při **rezervaci**, ne při vyrovnání, a zpátky se
   * nevrací: volání, které se smělo uskutečnit, se uskutečnilo. Kdyby se
   * počítalo až po úspěchu, byl by padající poskytovatel cesta, jak strop
   * obejít — týž důvod, proč se neznámá cena účtuje nejhorším případem.
   *
   * **Rezervace za nula dolarů se nepočítá, a je to oprava naměřené vady**
   * (nezávislá revize 31. 8. 2026). Obě větve zdarma — offline `mock`
   * (`src/server/mock/index.ts`) i nenakonfigurovaný upstream — hlásí
   * `worstCaseUsd: () => 0`, a offline větev je **výchozí**. Dokud se počítaly,
   * dvousetkrát napsaná věta do nasazeného dema vyčerpala strop, který na
   * nulových voláních nemohl nic uspořit: od 201. požadavku dostal každý
   * návštěvník 429 `CALL_CAP_EXHAUSTED` při útratě 0 USD a nula volání
   * k poskytovateli. U živé větve bez klíče je to ještě horší — poctivá 503
   * `BRANCH_UNCONFIGURED` se po dvou stech pokusech změní na zavádějící 429.
   *
   * **Placené volání takhle proklouznout nemůže.** Nejhorší případ živé větve
   * je vždy kladný: `upstreamConfigFromEnv` bez kladné ceny výstupu vrací
   * `null` a `maxOutputTokens` prochází `positiveNumber`. Nula tedy znamená
   * „tahle větev nestojí nic", nikdy „ceník je opsaný špatně" — a přesně na ten
   * druhý případ tenhle strop je.
   */
  #callsMade = 0;
  readonly #defaults: CapControl;
  readonly #controlPath: string | null;

  constructor(defaults: CapControl, controlPath: string | null = null) {
    this.#defaults = defaults;
    this.#controlPath = controlPath;
  }

  /**
   * Přečte vypínač. `null` znamená rozbitý ovládací soubor, tedy odmítnutí —
   * chybějící soubor je oproti tomu normální stav a vrací výchozí hodnoty.
   */
  #control(): CapControl | null {
    if (this.#controlPath === null) return this.#defaults;
    let raw: string;
    try {
      raw = readFileSync(this.#controlPath, 'utf8');
    } catch (thrown) {
      return (thrown as NodeJS.ErrnoException).code === 'ENOENT' ? this.#defaults : null;
    }
    return parseControl(raw);
  }

  snapshot(): CapSnapshot {
    const control = this.#control() ?? { enabled: true, capUsd: 0, callCap: 0 };
    const callCap = control.callCap ?? DEFAULT_CALL_CAP;
    return {
      ...control,
      callCap,
      spentUsd: this.#spentUsd,
      reservedUsd: this.#reservedUsd,
      remainingUsd: control.capUsd - this.#spentUsd - this.#reservedUsd,
      callsMade: this.#callsMade,
      callsRemaining: callCap - this.#callsMade,
    };
  }

  /**
   * Zamluví nejhorší případ ceny. Volání se smí uskutečnit jen po `ok: true`.
   *
   * Vypnutý strop rezervaci **pořád vede** a útratu počítá dál. Bez toho by se
   * po zapnutí vracel k číslu, které mezitím přestalo platit, a strop by kryl
   * jen tu část provozu, kterou zrovna viděl.
   */
  reserve(worstCaseUsd: number): Reservation {
    const control = this.#control();
    if (control === null)
      return {
        ok: false,
        reason: 'CONTROL_UNREADABLE',
        detail: `spend cap control file ${String(this.#controlPath)} is unreadable or malformed`,
        snapshot: this.snapshot(),
      };

    if (!Number.isFinite(worstCaseUsd) || worstCaseUsd < 0)
      return {
        ok: false,
        reason: 'INVALID_ESTIMATE',
        detail: `worst case estimate ${String(worstCaseUsd)} is not a finite non-negative number of dollars`,
        snapshot: this.snapshot(),
      };

    // Před dolarovým stropem schválně: tenhle drží i tehdy, když je ceník
    // opsaný špatně, a právě proto tu je.
    const callCap = control.callCap ?? DEFAULT_CALL_CAP;
    if (control.enabled && this.#callsMade >= callCap)
      return {
        ok: false,
        reason: 'CALL_CAP_EXHAUSTED',
        // Čísla tu být SMÍ a mají: tenhle text je pro operátora, je to jediná
        // diagnostika, kterou má (logovací kanál pod tímhle není). Ořez pro
        // veřejnost dělá `PUBLIC_REFUSAL` v `src/app/api/generate/route.ts` —
        // dělí se to tam, aby žádná příčina neodešla ven omylem.
        detail: `the call cap of ${callCap} calls is used up (made ${this.#callsMade}); this call was not made`,
        snapshot: this.snapshot(),
      };

    const wouldHold = this.#spentUsd + this.#reservedUsd + worstCaseUsd;
    if (control.enabled && wouldHold > control.capUsd)
      return {
        ok: false,
        reason: 'CAP_EXHAUSTED',
        detail:
          `this call would hold ${wouldHold.toFixed(6)} USD against a cap of ` +
          `${control.capUsd.toFixed(6)} USD; it was not made`,
        snapshot: this.snapshot(),
      };

    this.#reservedUsd += worstCaseUsd;
    // Jen placená volání, viz `#callsMade`. Větev zdarma nemá co ušetřit.
    if (worstCaseUsd > 0) this.#callsMade += 1;
    let settledUsd: number | null = null;
    const release = (actualUsd: number | 'unknown'): number => {
      if (settledUsd !== null) return settledUsd;
      this.#reservedUsd -= worstCaseUsd;
      // Číslu od poskytovatele se tady NEVĚŘÍ, a je to naměřené: `Math.max(0, NaN)`
      // je zase `NaN`, takže jediná vadná účtenka otráví součet a od té chvíle je
      // `wouldHold > capUsd` napořád nepravda — strop je do konce běhu procesu
      // vypnutý a nikdo se to nedozví. `reserve()` svůj vstup kontroluje o pár
      // řádků výš; tady ta kontrola chyběla a byla to jediná asymetrie mezi nimi.
      //
      // Když účtenka nedává smysl, účtuje se celá **rezervace**: je to horní odhad,
      // který kontrolou už jednou prošel, takže strop spíš přestřelí než povolí.
      const usable = typeof actualUsd === 'number' && Number.isFinite(actualUsd) && actualUsd >= 0;
      // **A nesmí to být víc, než se na to volání drželo.** `reserve()` hlídá
      // jen to, co se rezervuje; čísla, která pošle poskytovatel, nehlídalo
      // nic. Naměřeno nezávislou revizí 1. 9. 2026 celou cestou přes
      // `runPipeline`: odpověď 200 s platnou emisí a účtenkou
      // `{input_tokens: 1e12, output_tokens: 0}` strhla **5 000 000 USD** proti
      // rezervaci 0,2195 USD a stropu 5 USD, `{0, 1e12}` pak 25 000 000 USD —
      // a každý další požadavek dostal do konce života procesu 429
      // `CAP_EXHAUSTED`. Konečné kladné číslo projde kontrolou nad tímhle
      // řádkem, ať je jakkoli velké.
      //
      // **Ořez smí být tvrdý jen proto, že je rezervace strop, ne odhad.**
      // Dokud se vstup odhadoval po ~3 znacích na token, poctivá účtenka
      // `{8000, 8000}` stála o 9,3 % víc než rezervace a tvrdý ořez by ten
      // rozdíl tiše zahodil — proto `worstCaseUsd()` v `./upstream.ts` od
      // téhož dne rezervuje jeden token na znak. Kdyby se tam mez vrátila
      // k průměru, začne tenhle řádek podúčtovat každé poctivé volání.
      settledUsd = usable ? Math.min(actualUsd, worstCaseUsd) : worstCaseUsd;
      this.#spentUsd += settledUsd;
      return settledUsd;
    };

    return { ok: true, reservedUsd: worstCaseUsd, settle: release };
  }
}

/** Výchozí strop, když prostředí neříká jinak. */
export const DEFAULT_CAP_USD = 5;

/**
 * Výchozí strop na počet volání.
 *
 * 200 je `DEFAULT_CAP_USD` vydělené jedním nejhorším případem (~0,024 USD při
 * 8000 výstupních tokenech), takže při **správně** opsaném ceníku se nikdy
 * neozve dřív než dolarový strop a nikomu nepřekáží. Ozve se přesně tehdy, když
 * je ceník opsaný špatně — a to je jediná situace, na kterou tu je.
 */
export const DEFAULT_CALL_CAP = 200;

/**
 * Strop poskládaný z prostředí.
 *
 * `env` je parametr, ne `process.env` uvnitř — stejný důvod jako u
 * `evals/harness/preflight.ts`: globální čtení se nedá otestovat, aniž by si
 * testy sahaly na proces.
 *
 * Vadná hodnota `WORLDSMITH_SPEND_CAP_USD` je **nula**, ne výchozí strop.
 * Překlep v proměnné jinak tiše zvedne strop na výchozí hodnotu; nula zastaví
 * provoz a je hned vidět.
 */
export function spendCapFromEnv(env: Record<string, string | undefined>): SpendCap {
  const raw = env.WORLDSMITH_SPEND_CAP_USD;
  const parsed = raw === undefined ? DEFAULT_CAP_USD : Number(raw);
  const capUsd = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  // Táž doktrína jako u dolarů: chybějící proměnná je výchozí hodnota, vadná je
  // NULA. Překlep jinak tiše zvedne strop, kdežto nula zastaví provoz a je vidět.
  const rawCalls = env.WORLDSMITH_CALL_CAP;
  const parsedCalls = rawCalls === undefined ? DEFAULT_CALL_CAP : Number(rawCalls);
  const callCap = Number.isInteger(parsedCalls) && parsedCalls >= 0 ? parsedCalls : 0;
  return new SpendCap({ enabled: true, capUsd, callCap }, env.WORLDSMITH_SPEND_CAP_FILE ?? null);
}
