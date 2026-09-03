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
 * souborem (`WORLDSMITH_CONTROL_FILE`), který si čte tenhle modul při **každém**
 * rozhodnutí — změna platí od dalšího požadavku, přístup k souboru má jen kdo
 * má přístup ke stroji, a HTTP povrch nevzniká žádný.
 *
 * **Od P15 T30 je ten soubor sdílený s kill switchi** a jeho čtení bydlí
 * v `control-file.ts`; tenhle modul z něj bere klíče `enabled`, `capUsd`
 * a `callCap` a o zbytek se nestará. Do té doby se proměnná jmenovala
 * `WORLDSMITH_SPEND_CAP_FILE` a četl ji jenom strop.
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

import { controlFilePath, readControlFile } from './control-file';
import { ledgerFromEnv, memoryLedger, resetProcessLedger, type SpendLedger } from './spend-store';

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
  | 'INVALID_ESTIMATE'
  /**
   * Účetní kniha neodpověděla, nebo odpověděla nesmyslem.
   *
   * Zavřené selhání, ze stejného důvodu jako rozbitý ovládací soubor: neznámý
   * zůstatek je přesně ten stav, ve kterém se placené volání dělat nemá. Průchod
   * by z výpadku úložiště udělal způsob, jak strop vypnout.
   */
  | 'LEDGER_UNAVAILABLE'
  /**
   * Běžíme na serverless a **žádné sdílené úložiště není nastavené**.
   *
   * Kniha v paměti procesu tam totiž neznamená nic: každá studená instance
   * začíná s plným zůstatkem, takže strop 5 USD je ve skutečnosti 5 USD × počet
   * instancí. Do 3. 9. 2026 tomu bránil jen komentář v `.env.example`.
   */
  | 'STORE_UNCONFIGURED';

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
   * **Vrací dolary, které se doopravdy strhly** — tedy `actualUsd` **oříznuté
   * rezervací**, když se dá použít, a jinak celou rezervaci. Ořez tu od
   * 1. 9. 2026 je a je vidět: `/api/generate` z návratové hodnoty píše jediný
   * účetní řádek nasazení, takže „vrací actualUsd" by u účtenky nad rezervací
   * ukazovalo na jiné číslo, než jaké odejde. Bez toho volající neměl jak zjistit, které
   * z těch dvou čísel platí, a hlásil dál to, které poslal: naměřeno 1. 9. 2026,
   * že účtenka `{input_tokens: -1e9}` strhla správně 0,2195 USD a operátorovi
   * ohlásila `costUsd=-5000`. Opakované vyrovnání vrátí totéž číslo jako to
   * první, protože strop se podruhé nehnul.
   *
   * **Od P15 T29 je to `Promise`**, protože kniha, do které se zapisuje, může
   * být na jiném stroji. Volající ho musí `await`nout ještě před odpovědí:
   * nedokončený zápis se na serverless nedokončí nikdy — instance po odeslání
   * odpovědi zamrzne a rezervace by zůstala držená až do vypršení klíče.
   *
   * **Selhání zápisu se nepřepočítává na nulu.** Když kniha neodpoví, zůstane
   * držená celá rezervace: to je horní odhad, který strop spíš přestřelí, než
   * aby ho pustil.
   */
  settle(actualUsd: number | 'unknown'): Promise<number>;
}

export interface Refused {
  readonly ok: false;
  readonly reason: RefusalReason;
  readonly detail: string;
  readonly snapshot: CapSnapshot;
}

export type Reservation = Reserved | Refused;

/**
 * Přečte strop z **validního** ovládacího souboru. `null` je rozbitý vypínač.
 *
 * **Chybějící klíč rozbitý vypínač není** — a do 3. 9. 2026 byl. Soubor má od
 * P15 T30 dvě půlky: strop (`enabled`, `capUsd`, `callCap`) a kill switche
 * (`off`). Operátor, který za incidentu napíše `{"off":["refine"]}`, o stropu
 * neříká nic, jenže tahle funkce v takovém souboru neviděla `enabled` ani
 * `capUsd` a vracela `null`. Naměřeno: `refine` se sice vyplo, ale současně
 * `reserve()` začalo vracet `CONTROL_UNREADABLE`, takže vypnutí **druhé věty**
 * zastavilo i zakládání každého nového světa. Přesný opak povelu, a hlavička
 * `kill-switch.ts` k tomu operátora sama naváděla.
 *
 * Chybějící klíč proto znamená „platí výchozí hodnota volajícího" — tedy to,
 * co by platilo bez souboru. **Vyplněný nesmysl znamená dál zavřené selhání:**
 * `{"capUsd":"pět"}` je pokus stropem hnout a ten se nepovedl, a to je jiný
 * stav než mlčení.
 */
function parseControl(parsed: Record<string, unknown>, defaults: CapControl): CapControl | null {
  const { enabled, capUsd, callCap } = parsed as {
    enabled?: unknown;
    capUsd?: unknown;
    callCap?: unknown;
  };
  if (enabled !== undefined && typeof enabled !== 'boolean') return null;
  if (capUsd !== undefined && (typeof capUsd !== 'number' || !Number.isFinite(capUsd) || capUsd < 0))
    return null;
  // Vyplněný, ale nesmyslný strop je rozbitý vypínač, ne „bez stropu".
  if (
    callCap !== undefined &&
    (typeof callCap !== 'number' || !Number.isInteger(callCap) || callCap < 0)
  )
    return null;
  // **Vypnout strop je jediný povel, který se musí napsat celý.** `enabled:false`
  // je jediná hodnota v celém souboru, která peněžní mez odstraní úplně, takže
  // `{"enabled":false}` samotné by z pravidla „chybějící klíč = výchozí hodnota"
  // udělalo nejkratší cestu k neomezenému utrácení — před 3. 9. 2026 týž soubor
  // odmítal všechno. Nález nezávislé revize, `VERDICT: blocking`: naměřeno 501
  // rezervací a 511 000 USD držených. Kdo strop vypíná, napíše i jeho hodnotu
  // pro chvíli, kdy ho zapne zpátky.
  if (enabled === false && capUsd === undefined) return null;

  const resolvedCalls = callCap ?? defaults.callCap;
  const resolved = { enabled: enabled ?? defaults.enabled, capUsd: capUsd ?? defaults.capUsd };
  return resolvedCalls === undefined ? resolved : { ...resolved, callCap: resolvedCalls };
}

export class SpendCap {
  /**
   * **Poslední součty, které kniha vrátila** — ne vlastní účetnictví.
   *
   * Do P15 T29 tady bydlel stav (`#spentUsd`, `#reservedUsd`, `#callsMade`) a
   * strop platil přesně tak daleko, jak sahá jeden proces. Autoritou je od té
   * doby `SpendLedger` (`./spend-store.ts`); tyhle dvě čísla jsou jen to, co
   * z ní naposledy přišlo, a slouží `snapshot()`, tedy diagnostice.
   *
   * `snapshot()` proto **neptá se** — nesmí, je synchronní a čtení knihy je
   * síťový let. Kdo chce čerstvá čísla, vezme si je z odmítnutí, které je nese.
   */
  #seenUsd = 0;
  #seenCalls = 0;
  /**
   * Dolary, které **tahle instance** zarezervovala a ještě nevyrovnala.
   *
   * Je to jediné číslo tady, které kniha neurčuje, a schválně: měří se jím
   * vlastnost volajícího, ne zůstatek — „každá cesta ven svou rezervaci
   * vyrovnala". Nevyrovnaná rezervace drží peníze až do konce procesu a strop
   * se sám utáhne; naměřeno v `runPipeline` 1. 9. 2026 a hlídá to jedenáct
   * asercí `reservedUsd === 0` napříč `src/server/__tests__`.
   *
   * Napříč instancemi neznamená nic a znamenat nemá — od toho je kniha.
   */
  #heldUsd = 0;
  readonly #defaults: CapControl;
  readonly #controlPath: string | null;
  /**
   * Kniha, ve které to počítadlo doopravdy bydlí. `null` znamená **odmítat
   * všechno**: běžíme na serverless a sdílené úložiště nikdo nenastavil, takže
   * strop by byl dekorace (`STORE_UNCONFIGURED`).
   *
   * Výchozí hodnota je **vlastní kniha v paměti**, ne procesová. Strop postavený
   * ručně (typicky v testu) tak nikdy nepřebírá cizí zůstatek; jediné místo,
   * kde se sdílí, je `processSpendCap()` níž, a to je schválně jedno místo.
   */
  readonly #ledger: SpendLedger | null;

  constructor(
    defaults: CapControl,
    controlPath: string | null = null,
    ledger: SpendLedger | null = memoryLedger(),
  ) {
    this.#defaults = defaults;
    this.#controlPath = controlPath;
    this.#ledger = ledger;
  }

  /**
   * Přečte vypínač. `null` znamená rozbitý ovládací soubor, tedy odmítnutí —
   * chybějící soubor je oproti tomu normální stav a vrací výchozí hodnoty.
   */
  #control(): CapControl | null {
    const read = readControlFile(this.#controlPath);
    if (read.kind === 'absent') return this.#defaults;
    if (read.kind === 'broken') return null;
    return parseControl(read.value, this.#defaults);
  }

  snapshot(): CapSnapshot {
    const control = this.#control() ?? { enabled: true, capUsd: 0, callCap: 0 };
    const callCap = control.callCap ?? DEFAULT_CALL_CAP;
    return {
      ...control,
      callCap,
      // **`spentUsd` nese držené i utracené dohromady.** Kniha je jeden součet,
      // ne dva: mezi rezervací a jejím vyrovnáním se z téhož čísla stane útrata
      // a rozdělit to zpátky by u sdíleného úložiště šlo jen odhadem.
      //
      // `reservedUsd` je proti tomu **jen to, co drží tahle instance** — viz
      // `#heldUsd`. Není to podíl na knize a nesmí se tak číst.
      spentUsd: this.#seenUsd,
      reservedUsd: this.#heldUsd,
      remainingUsd: control.capUsd - this.#seenUsd,
      callsMade: this.#seenCalls,
      callsRemaining: callCap - this.#seenCalls,
    };
  }

  /**
   * Zamluví nejhorší případ ceny. Volání se smí uskutečnit jen po `ok: true`.
   *
   * Vypnutý strop rezervaci **pořád vede** a útratu počítá dál. Bez toho by se
   * po zapnutí vracel k číslu, které mezitím přestalo platit, a strop by kryl
   * jen tu část provozu, kterou zrovna viděl.
   *
   * ## Přičti, podívej se, případně vrať
   *
   * Rezervace je **jeden atomický zápis** do knihy (`add(+worst, +1)`) a teprve
   * pak se soudí součet, který z ní přišel. Přeteče-li, tentýž zápis se odečte
   * zpátky. Pořadí „přečti, rozmysli, zapiš" by se sem nedalo napsat bezpečně:
   * mezi čtení a zápis se souběžný požadavek vejde a poslední kredit by koupili
   * oba. Tohle pořadí naopak umí strop krátkodobě **přestřelit** — dva souběžní
   * uvidí přeteklý součet a vrátí se oba, takže se odmítnou i tehdy, když by se
   * jeden vešel. U peněz je to ta správná strana omylu.
   */
  async reserve(worstCaseUsd: number): Promise<Reservation> {
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

    if (this.#ledger === null)
      return {
        ok: false,
        reason: 'STORE_UNCONFIGURED',
        detail:
          'this deployment runs serverless and has no shared spend store, ' +
          'so a per-process cap would hold nothing; no call was made',
        snapshot: this.snapshot(),
      };

    /**
     * Kdy se volání **započítá** do stropu na počet, a proč zrovna takhle.
     *
     * Počítadlo roste při **rezervaci**, ne při vyrovnání, a zpátky se
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
    const countedCall = worstCaseUsd > 0 ? 1 : 0;
    let totals;
    try {
      totals = await this.#ledger.add(worstCaseUsd, countedCall);
    } catch (thrown) {
      return {
        ok: false,
        reason: 'LEDGER_UNAVAILABLE',
        detail: `the ${this.#ledger.id} spend ledger did not answer: ${(thrown as Error).message}`,
        snapshot: this.snapshot(),
      };
    }
    this.#seenUsd = totals.usd;
    this.#seenCalls = totals.calls;

    /**
     * Vrátit, co si tahle rezervace vzala. Použije se na obou odmítnutích níž.
     *
     * Selhání se **polkne schválně**: zápis, který nejde vrátit, drží peníze
     * navíc, tedy zavírá, ne otevírá. Vyhodit ho ven by z odmítnutí udělalo
     * `LEDGER_UNAVAILABLE` a zamlčelo skutečnou příčinu, kterou už známe.
     */
    const giveBack = async (): Promise<void> => {
      try {
        const returned = await this.#ledger?.add(-worstCaseUsd, -countedCall);
        // **Vrácená čísla se musí zapsat i sem.** `snapshot()` je jediná
        // diagnostika, kterou strop vydává, a odmítnutí ji nese s sebou; bez
        // tohohle řádku by ukazovala nafouklý součet, který na knize existoval
        // jen ty dvě operace mezi přičtením a vrácením. Odmítnuté volání by
        // pak v odpovědi vypadalo jako započítané.
        if (returned !== undefined) {
          this.#seenUsd = returned.usd;
          this.#seenCalls = returned.calls;
        }
      } catch {
        /* účet zůstane vyšší, než by musel — u stropu ta správná strana */
      }
    };

    // Před dolarovým stropem schválně: tenhle drží i tehdy, když je ceník
    // opsaný špatně, a právě proto tu je.
    const callCap = control.callCap ?? DEFAULT_CALL_CAP;
    if (control.enabled && totals.calls > callCap) {
      await giveBack();
      return {
        ok: false,
        reason: 'CALL_CAP_EXHAUSTED',
        // Čísla tu být SMÍ a mají: tenhle text je pro operátora, je to jediná
        // diagnostika, kterou má (logovací kanál pod tímhle není). Ořez pro
        // veřejnost dělá `PUBLIC_REFUSAL` v `src/app/api/generate/route.ts` —
        // dělí se to tam, aby žádná příčina neodešla ven omylem.
        //
        // **Utracené dolary jsou v té větě schválně.** Počítadlo roste
        // i tehdy, když poskytovatel všechno odmítne (propadlý klíč), a bez
        // toho čísla vypadá takové vyčerpání stejně jako vyčerpaný rozpočet.
        // „200 volání, 0.000000 USD" je naopak čitelná diagnóza: nezaplatilo se
        // za nic, takže to nebyl rozpočet, kdo došel.
        detail:
          `the call cap of ${callCap} calls is used up (made ${totals.calls - countedCall}, ` +
          `spent ${(totals.usd - worstCaseUsd).toFixed(6)} USD); this call was not made`,
        snapshot: this.snapshot(),
      };
    }

    if (control.enabled && totals.usd > control.capUsd) {
      await giveBack();
      return {
        ok: false,
        reason: 'CAP_EXHAUSTED',
        detail:
          `this call would hold ${totals.usd.toFixed(6)} USD against a cap of ` +
          `${control.capUsd.toFixed(6)} USD; it was not made`,
        snapshot: this.snapshot(),
      };
    }

    this.#heldUsd += worstCaseUsd;

    let settledUsd: number | null = null;
    const release = async (actualUsd: number | 'unknown'): Promise<number> => {
      if (settledUsd !== null) return settledUsd;
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
      // Vyrovnáno, takže tahle rezervace už nic nedrží. Odečítá se **jednou**:
      // druhé vyrovnání se vrátilo o pár řádků výš.
      this.#heldUsd -= worstCaseUsd;

      // Rezervace se mění na útratu **rozdílem**, ne novým zápisem: v knize je
      // to jedno číslo a `add()` je jediná operace, která ho umí posunout
      // atomicky. Nula znamená „účtenka sedí na rezervaci", a pak se nezapisuje
      // vůbec — jeden síťový let míň za každé volání, které nic nepřeplatilo.
      //
      // **Počítadlo volání se nevrací nikdy**, ani když se strhne nula. Volání,
      // které se smělo uskutečnit, se uskutečnilo; opačné pravidlo by
      // z padajícího poskytovatele udělalo neomezené volno. Rozhodnuto P15 T29
      // proti druhé možnosti („vrať počet, když `billed === 0`") — diagnostiku
      // propadlého klíče nese místo toho text odmítnutí u `CALL_CAP_EXHAUSTED`.
      const delta = settledUsd - worstCaseUsd;
      if (delta !== 0) {
        try {
          const totals = await this.#ledger?.add(delta, 0);
          if (totals !== undefined) {
            this.#seenUsd = totals.usd;
            this.#seenCalls = totals.calls;
          }
        } catch {
          /* nepovedlo se snížit: drží se dál celá rezervace, tedy horní odhad */
        }
      }
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
 * 200 je `DEFAULT_CAP_USD` vydělené jedním nejhorším případem, takže při
 * **správně** opsaném ceníku se nikdy neozve dřív než dolarový strop a nikomu
 * nepřekáží. Ta dělenka dnes vychází jinak: nejhorší případ je na výchozím
 * ceníku ~0,2585 USD (rezervace se od 1. 9. 2026 počítá po jednom tokenu na
 * znak, viz `worstCaseUsd()` v `./upstream.ts`), tedy 5 / 0,2585 ≈ **19**.
 * Konstanta zůstává 200 schválně — 200 je pořád nad devatenácti, takže závěr
 * „dolarový strop se ozve dřív" platí dál a nemá cenu s ní hýbat. Ozve se přesně tehdy, když
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

/**
 * Jediný strop procesu.
 *
 * **Dvě instance nejsou strop.** `spendCapFromEnv()` vyrábí pokaždé nový
 * `SpendCap` s vlastním `#spentUsd` a `#callsMade`, takže dvě route, které
 * si ho každá zavolají samy, utratí dohromady **dvojnásobek** nastaveného
 * stropu — a nikdo si toho nevšimne, protože každá půlka svůj strop dodržela.
 * Naměřeno nezávislou revizí 3. 9. 2026 nad `/api/generate` a
 * `/api/worldstream/sessions`, které přesně tohle dělaly.
 *
 * Je to **líné**, ne `const` na úrovni modulu: `process.env` se tak nečte při
 * importu, takže si testy nemusí sahat na proces jen proto, že tenhle soubor
 * někdo naimportoval. Je to táž doktrína, jakou `spendCapFromEnv()` drží
 * parametrem `env`.
 */
export function processSpendCap(): SpendCap {
  const holder = globalThis as Record<string, unknown>;
  // **Na `globalThis`, ne v modulové proměnné** — táž oprava jako u účetní
  // knihy. Modulová proměnná je jedna na graf modulů, a Next jich staví víc
  // (server components, HMR ve vývoji); dva grafy = dva stropy = dvojnásobek.
  // Napříč instancemi to nespojí ani tohle, na to je kniha.
  holder[PROCESS_CAP_KEY] ??= spendCapFromEnv(process.env);
  return holder[PROCESS_CAP_KEY] as SpendCap;
}

const PROCESS_CAP_KEY = '__worldsmithSpendCap';

/**
 * Jen pro testy: zahodí singleton, aby si další test mohl nastavit vlastní prostředí.
 *
 * ⚠ **Platí jen v procesu, kde ještě žádná route nenačetla svůj modul.** Obě
 * placené routy si instanci berou při importu do modulové konstanty, takže po
 * resetu by `processSpendCap()` vydával druhý živý strop, zatímco routy dál
 * rezervují proti prvnímu — a „jeden strop procesu" by přestal platit. Vitest
 * izoluje soubory, takže se to v testech nepotká; z produkčního kódu se sem
 * nesmí sáhnout vůbec (hlídá to lexikální brána v `spend-cap.test.ts`).
 */
export function resetProcessSpendCap(): void {
  delete (globalThis as Record<string, unknown>)[PROCESS_CAP_KEY];
  resetProcessLedger();
}

export function spendCapFromEnv(env: Record<string, string | undefined>): SpendCap {
  const raw = env.WORLDSMITH_SPEND_CAP_USD;
  const parsed = raw === undefined ? DEFAULT_CAP_USD : Number(raw);
  const capUsd = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  // Táž doktrína jako u dolarů: chybějící proměnná je výchozí hodnota, vadná je
  // NULA. Překlep jinak tiše zvedne strop, kdežto nula zastaví provoz a je vidět.
  const rawCalls = env.WORLDSMITH_CALL_CAP;
  const parsedCalls = rawCalls === undefined ? DEFAULT_CALL_CAP : Number(rawCalls);
  const callCap = Number.isInteger(parsedCalls) && parsedCalls >= 0 ? parsedCalls : 0;
  // **Kniha z prostředí, a `null` z ní znamená odmítat** — serverless bez
  // sdíleného úložiště, viz `ledgerFromEnv()`. Strop, který se resetuje
  // s chladným startem, je horší než žádný: tváří se, že platí.
  return new SpendCap(
    { enabled: true, capUsd, callCap },
    controlFilePath(env),
    ledgerFromEnv(env),
  );
}
