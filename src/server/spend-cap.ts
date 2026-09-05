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

import {
  type ControlRead,
  type ControlSource,
  controlFilePath,
  readControlFile,
  readControlFrom,
} from './control-file';
import {
  type ControlStore,
  controlStoreFromEnv,
  ledgerFromEnv,
  memoryLedger,
  resetProcessLedger,
  type SpendLedger,
} from './spend-store';

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
   * Je **volitelný schválně**: volání konstruktoru, která vznikla dřív, musí
   * dál platit. Vyplněný musí být celé kladné číslo — nesmysl se odmítne stejně
   * jako u zbytku souboru, tedy zavřeně.
   *
   * ⚠ **V ovládacím SOUBORU volitelný není**, i když tady ano. Od
   * `T30-capsilence` táhne `capUsd` s sebou: `{"callCap":10}` je rozbitý soubor,
   * protože kdo píše mez na počet volání, mluví o stropu — a zmínka o stropu se
   * musí napsat celá. Viz `parseControl()`.
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
   *
   * **Nezávislý na ceníku, ne na vypínači.** `enabled:false` v ovládacím
   * souboru vypíná **obě** meze naráz, dolarovou i počet — naměřeno nezávislou
   * revizí 3. 9. 2026: nad `{"enabled":false,"capUsd":0}` 400 rezervací ze 400,
   * `callsRemaining: -200`. Je to rozhodnutí, ne díra (P15 `T30-callcapoff`):
   * `enabled:false` je vědomý povel operátora „utrácej bez meze", ne nouzová
   * brzda — tou jsou kill switche (`off`). Kdyby počet držel i při vypnutém
   * stropu, byl by `{"enabled":false}` s `callCap:0` úplná zastávka provozu,
   * a přesně to pinuje jako NEžádoucí `upstream.test.ts` („`enabled: false`
   * provoz nezastaví, jen přestane odmítat"). Druhá větev — počet drží vždy —
   * se tím vyvrátila měřením: shodila by jeden pinovaný test a dvě zapsaná
   * tvrzení v `src/app/api/generate`. Ochrana proti špatně opsanému ceníku
   * tedy platí, dokud je strop zapnutý; kdo ho vypne, vypne i ji.
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
   * **Žádné sdílené úložiště, a tenhle proces neumí doložit, že je sám.**
   *
   * Kniha v paměti procesu jinde neznamená nic: každá studená instance začíná
   * s plným zůstatkem, takže strop 5 USD je ve skutečnosti 5 USD × počet
   * instancí. Do 3. 9. 2026 tomu bránil jen komentář v `.env.example`.
   *
   * ⚠ **Od `T29-lambdadetect` to není jen o serverless a ta věta se nesmí
   * vrátit.** Nasazení s vypnutým přepínačem systémových proměnných o sobě
   * neřekne `VERCEL` ani `VERCEL_ENV`, takže „poznáme serverless" ho minulo
   * přesně tam, kde na tom záleželo. Podmínkou je proto známé prostředí, ne
   * nepřítomnost platformy — rozhoduje `ledgerFromEnv()`.
   *
   * ⚠ **Operátorovi se to na cestě relace ukáže pod cizím jménem** — nález
   * nezávislé revize 4. 9. 2026. `runGeneration` chytá výjimku emitoru jako
   * `MODEL_UNAVAILABLE`, takže porotce čte „the model could not be reached",
   * zatímco příčina je nedokonfigurovaný strop. Detail se do operátorského logu
   * dostane, ale předem to nikdo neohlásí; zavírá to `T29-readinessledger`.
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
 * Odmítnutí stropu **jako typ**, ne jako text zprávy.
 *
 * Emitor, který platí (`cloudEmitter()`), musí umět selhat — jeho volající
 * `runGeneration()` chytá jedinou výjimku a do P15 `T29-readinessledger` z ní
 * dělal `MODEL_UNAVAILABLE`. Porotce tak nad nedokonfigurovaným stropem četl
 * „the model could not be reached", přestože se k poskytovateli nikdo
 * nepřipojoval; vina padla na cizí stranu a předem to nikdo neohlásil.
 *
 * **Rozhoduje `instanceof`, ne shoda nad `message`.** Text zprávy je pro
 * operátora a mění se s detailem, takže rozhodovat podle něj znamená mít
 * kontrakt, který nikdo nevidí a `tsc` nehlídá. `reason` zůstává strojově
 * čitelné pro toho, kdo chce rozlišit i jednotlivé příčiny.
 *
 * `message` je schválně **týž řetězec**, jaký se házel předtím
 * (`<reason>: <detail>`), protože končí v operátorském logu a měnit ho by
 * znamenalo měnit záznam, ve kterém se incident dohledává.
 */
export class SpendRefusalError extends Error {
  readonly reason: RefusalReason;

  constructor(refused: Refused) {
    super(`${refused.reason}: ${refused.detail}`);
    this.name = 'SpendRefusalError';
    this.reason = refused.reason;
  }
}

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
 *
 * ⚠ **To pravidlo má od `T30-capsilence` jednu výjimku a ta se týká peněz:**
 * mlčet se smí o **celé** peněžní půlce, ne o jejím kusu. Soubor, který nese
 * `enabled` nebo `callCap` a `capUsd` ne, je proto rozbitý. Tím se přestěhovaly
 * dva tvary, které do 4. 9. 2026 byly platné — `{"enabled":true}`
 * a `{"callCap":10}` — mezi odmítané. **Nasazený soubor bez `capUsd` tedy začne
 * odmítat placenou práci hned po deployi, aniž na něj kdokoli sáhne**; kill
 * switche se z něj čtou dál, protože `killState()` čte soubor sám a tudy
 * nechodí.
 *
 * ## Soubor umí jen utahovat — podlaha z prostředí (P15 `T30-capfloor`)
 *
 * Mlčení o celé peněžní půlce platit **musí** (jinak by zaniklo
 * `T30-offonlyfile`), takže přepsat `{"capUsd":0.5}` na `{"off":["refine"]}`,
 * na `{}` nebo soubor smazat dodnes vrátí výchozí částku. Uvnitř téhle funkce
 * se to zavřít nedá a příští kolo to nemá zkoušet — ta dvě pravidla si
 * odporují a mlčení musí vyhrát.
 *
 * Zavírá se to o patro výš: **účinná částka je `min(soubor, výchozí)`**, a
 * totéž pro `callCap` (kde výchozí hodnota vyplněná není, je podlahou
 * `DEFAULT_CALL_CAP`). Soubor tím umí strop **jen přitahovat**; částka nad
 * výchozí hodnotou se uřízne. Ztráta souboru pak nemůže vydat víc, než co
 * povoluje `WORLDSMITH_SPEND_CAP_USD` — tedy rozpočet, který někdo napsal
 * vědomě a mění se jen redeployem. Mlčení tím přestalo být cestou, jak dostat
 * strop **nad** nastavený rozpočet; nález nezávislé revize 4. 9. 2026,
 * CONFIRMED spuštěním (`reserve(2)` skočilo z `CAP_EXHAUSTED` na `ok`, bez
 * řádku v logu).
 *
 * **Cena je zapsaná, ne přehlédnutá:** soubor už není páka, kterou se za
 * incidentu strop ZVEDNE. Kdo potřebuje víc — třeba o velikost opuštěných
 * rezervací — sáhne na `WORLDSMITH_SPEND_CAP_USD` a redeploy; postup je
 * v `.env.example`. Ta výměna je záměr: rychlá páka bez redeploye má právo
 * přitahovat, uvolňovat ne.
 *
 * ⚠ **`enabled:false` podlaha NEDRŽÍ a je to rozhodnutí, ne díra.** Vypnutí
 * stropu je nejsilnější povel v souboru a mlčením nikdy nevznikne — mez výš
 * z něj dělá zmínku o stropu, takže `{"enabled":false}` bez `capUsd` je
 * rozbitý soubor. Podlaha zavírá tiché uvolnění číslem; napsané „utrácej bez
 * meze" zůstává vědomým povelem operátora (`T30-callcapoff`, pinuje
 * `upstream.test.ts`).
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
  // **Kdo o stropu mluví, pojmenuje částku.** Mlčet o celé peněžní půlce se smí
  // (`{"off":["refine"]}` i `{}` dál platí výchozí hodnoty — to je celý smysl
  // `T30-offonlyfile`); mluvit o ní napůl se nesmí.
  //
  // Původní podoba téhle meze hlídala jen jeden směr, `enabled:false` bez
  // `capUsd`, protože vypnutí je nejsilnější povel v souboru: samotné
  // `{"enabled":false}` by bylo nejkratší cestou k neomezenému utrácení
  // (nález nezávislé revize, `VERDICT: blocking`, naměřeno 501 rezervací
  // a 511 000 USD držených).
  //
  // Druhý směr ale mez neměl a je stejně tichý — nález druhé revize
  // (`T30-capsilence`), naměřeno: nad `{"enabled":true,"capUsd":0.5}` stačí
  // soubor přepsat na `{"enabled":true,"off":["refine"]}`, tedy **přidat
  // vypínač a zapomenout přepsat částku**, a `capUsd` skočí z 0,5 zpátky na
  // výchozích 5 USD. `reserve(2)` projde tam, kde před chvílí neprošlo, a v logu
  // to nezanechá řádku. Totéž platí pro `callCap` — kdo píše mez na počet
  // volání, píše zjevně o stropu.
  //
  // Přísnější mez proto nezní „vypnutí se musí napsat celé", ale **„zmínka
  // o stropu se musí napsat celá"**. Rozbitý soubor odmítá; mlčení dál platí.
  if (capUsd === undefined && (enabled !== undefined || callCap !== undefined)) return null;

  // **Podlaha z prostředí** (`T30-capfloor`): soubor smí částku jen snížit.
  // `Math.min` s výchozí hodnotou místo přebíjení — proč, je v hlavičce.
  const resolvedUsd = capUsd === undefined ? defaults.capUsd : Math.min(capUsd, defaults.capUsd);
  // U počtu volání je podlahou `DEFAULT_CALL_CAP` tehdy, když výchozí hodnota
  // vyplněná není — to je totiž číslo, které v takovém případě doopravdy platí
  // (`snapshot()` i `reserve()` si ho dosadí samy). Bez té dosazené podlahy by
  // `{"callCap":1000}` nad konstruktorem, který počet neřešil, zvedlo účinný
  // strop z 200 na 1000; táž třída, jen v druhém čísle.
  const floorCalls = defaults.callCap ?? DEFAULT_CALL_CAP;
  const resolvedCalls = callCap === undefined ? defaults.callCap : Math.min(callCap, floorCalls);
  const resolved = { enabled: enabled ?? defaults.enabled, capUsd: resolvedUsd };
  return resolvedCalls === undefined ? resolved : { ...resolved, callCap: resolvedCalls };
}

/**
 * **Jak dlouho platí vypnutý strop, než sám vyprší** (P15 `T30-capoffbound`).
 *
 * `{"enabled":false,"capUsd":…}` znamená „utrácej bez meze" a po
 * `T30-capfloor` je to **jediná páka v ovládacím souboru, která strop
 * uvolňuje** — všechno ostatní umí soubor už jen přitahovat (`min(soubor,
 * výchozí)`). Zůstávala u ní jedna vlastnost, kterou nemá žádná jiná páka
 * v tomhle modulu: **nic ji nekončí.** Operátor, který za incidentem v noci
 * strop vypne, aby něco doměřil, a pak zavře notebook, nechá veřejné demo
 * s otevřenou peněženkou tak dlouho, dokud si na ten soubor někdo nevzpomene.
 * Nález nezávislé revize 4. 9. 2026 u `T30-capfloor`, routovaný sem.
 *
 * Mez je proto **stáří povelu, ne jeho obsah**: vypnutí platí třicet minut od
 * chvíle, kdy soubor vznikl (`mtime`), a pak se strop sám vrátí na výchozí
 * hodnotu. Kdo potřebuje víc času, soubor přepíše — a tím vyrobí nové razítko.
 * Je to vědomá výměna: rychlá páka bez redeploye má právo uvolnit strop
 * **na dobu jednoho zásahu**, ne natrvalo.
 *
 * ## Třicet minut, a proč zrovna tolik
 *
 * Delší než nejdelší zásah, který má tenhle produkt (měření nad zmrazenou
 * sadou 30 vět, `T14`, běží v jednotkách minut), a kratší než doba, za kterou
 * operátor stihne odejít od počítače a zapomenout. Není to bezpečnostní
 * konstanta a nemá se o ni opírat nic dalšího.
 *
 * ⚠ **Zdroj, který razítko nemá, vypnutí neprosadí vůbec.** Sdílený klíč
 * (`spend-store.ts`) žádnou obdobu `mtime` nenese, takže odsud chodí
 * `writtenAtMs: null` — a `null` se čte jako „neumím doložit stáří", tedy
 * zavřeně. Na Vercelu se tím strop souborem ani klíčem vypnout nedá; cesta
 * k neomezenému utrácení tam vede přes `WORLDSMITH_SPEND_CAP_USD` a redeploy,
 * přesně jako u podlahy v `T30-capfloor`. Uvolnění stropu si žádá krok, který
 * je vidět v historii nasazení.
 */
export const CAP_OFF_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Co ze čtení povelu vyšlo. `broken` nese větu pro operátora, protože zdroje
 * jsou od `T30-controllever` dva a odmítnutí musí říct, který z nich to byl.
 */
type ControlOutcome =
  | { readonly kind: 'ok'; readonly control: CapControl }
  | { readonly kind: 'broken'; readonly detail: string };

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
   * všechno**: sdílené úložiště nikdo nenastavil a tenhle proces neumí doložit,
   * že je sám, takže strop by byl dekorace (`STORE_UNCONFIGURED`). Rozhoduje
   * o tom `ledgerFromEnv()`, ne tenhle soubor.
   *
   * Výchozí hodnota je **vlastní kniha v paměti**, ne procesová. Strop postavený
   * ručně (typicky v testu) tak nikdy nepřebírá cizí zůstatek; jediné místo,
   * kde se sdílí, je `processSpendCap()` níž, a to je schválně jedno místo.
   */
  readonly #ledger: SpendLedger | null;
  /**
   * Druhý zdroj povelu — sdílený klíč v tomtéž obchodě, který drží knihu.
   *
   * `null` znamená „není", ne „odmítat": bez sdíleného obchodu platí soubor
   * a to je celý lokální provoz. Soubor má přednost vždycky
   * (`readControlFrom()`), takže tenhle zdroj nemůže přebít nic, co je na disku.
   */
  readonly #controlStore: ControlStore | null;

  constructor(
    defaults: CapControl,
    controlPath: string | null = null,
    ledger: SpendLedger | null = memoryLedger(),
    controlStore: ControlStore | null = null,
  ) {
    this.#defaults = defaults;
    this.#controlPath = controlPath;
    this.#ledger = ledger;
    this.#controlStore = controlStore;
  }

  /**
   * Přečte vypínač z **obou zdrojů** — souboru i sdíleného klíče
   * (`readControlFrom()` říká, který vyhrává a proč).
   *
   * `broken` znamená odmítnutí a nese s sebou větu pro operátora, ve které je
   * poznat, **který ze zdrojů** je rozbitý; chybějící povel je oproti tomu
   * normální stav a vrací výchozí hodnoty.
   */
  async #control(): Promise<ControlOutcome> {
    const outcome = this.#outcome(await readControlFrom(this.#controlPath, this.#controlStore));
    // **Zapamatovat si povel, který doopravdy rozhodl** (P15 `T30-snapshotstale`).
    // `snapshot()` je synchronní a sdíleného klíče se zeptat nemůže, takže bez
    // téhle stopy hlásí na serverless vždycky výchozí hodnoty — tedy strop,
    // který operátor před chvílí přetáhl a který už neplatí.
    this.#decidedWith = outcome;
    return outcome;
  }

  /**
   * Povel, kterým se rozhodovala **poslední rezervace**. `null` = žádná nebyla.
   *
   * Není to cache a nikdo se podle toho nerozhoduje: rozhoduje se výhradně
   * `reserve()` nad čerstvým čtením. Tohle je stopa pro diagnostiku, aby
   * `snapshot()` uměl vydat číslo, které se doopravdy použilo.
   */
  #decidedWith: ControlOutcome | null = null;

  /**
   * Totéž jen ze souboru, synchronně — **záloha `snapshot()` pro první volání**.
   *
   * `snapshot()` je diagnostika a je synchronní, takže se sdíleného klíče
   * zeptat nemůže; je to táž hranice, kvůli které se neptá ani účetní knihy
   * (viz `#seenUsd`). Rozhodnutí o penězích na téhle cestě nestojí žádné —
   * `reserve()` si čte povel sama a odmítnutí nese `snapshot` složený
   * z toho, co doopravdy rozhodlo.
   *
   * ⚠ **Od `T30-snapshotstale` to není jediný zdroj `snapshot()`.** Byl, a na
   * serverless kvůli tomu hlásil pokaždé výchozí hodnoty — tam žádný soubor
   * není. Jakmile jednou proběhne rezervace, platí `#decidedWith`; sem se sáhne
   * jen předtím.
   */
  #controlFromFile(): ControlOutcome {
    return this.#outcome(readControlFile(this.#controlPath));
  }

  #outcome(read: ControlRead): ControlOutcome {
    if (read.kind === 'absent') return { kind: 'ok', control: this.#defaults };
    if (read.kind === 'broken') return this.#broken(read.source, read.detail);
    const parsed = parseControl(read.value, this.#defaults);
    return parsed === null
      ? this.#broken(read.source, 'it does not describe a spend cap this server can read')
      : { kind: 'ok', control: this.#bounded(parsed, read.writtenAtMs) };
  }

  /**
   * Jestli operátor už dostal řádek o vypršelém vypnutí. Jen proti zaplavení.
   *
   * Vypnutý strop se čte **při každém rozhodnutí**, takže bez téhle značky by
   * jedna věta do logu byla jedna věta na požadavek. Vrací se na `false`, jakmile
   * nějaké vypnutí zase platí, aby se druhý zásah téhož procesu zase ozval.
   */
  #warnedCapOffExpired = false;

  /**
   * **Vypnutý strop ohraničený stářím povelu** (P15 `T30-capoffbound`).
   *
   * Proč vůbec a proč třicet minut, je u `CAP_OFF_MAX_AGE_MS`. Tady je jen ten
   * jeden rozdíl, na kterém záleží: **`null` není „čerstvý"**. Zdroj, který
   * razítko neumí (sdílený klíč), vypnutí neprosadí — jinak by mez platila
   * lokálně a na nasazení, kde jsou peníze doopravdy, ne.
   *
   * Zpátky se padá na `this.#defaults.enabled`, tedy na to, co platí bez
   * souboru. Když je i výchozí hodnota `false`, vypnutí nic nemění a nehlásí
   * se nic — strop je vypnutý rozpočtem, ne pákou, a rozpočet se mění
   * redeployem.
   */
  #bounded(control: CapControl, writtenAtMs: number | null): CapControl {
    if (control.enabled) return control;

    const ageMs = writtenAtMs === null ? null : Date.now() - writtenAtMs;
    if (ageMs !== null && ageMs <= CAP_OFF_MAX_AGE_MS) {
      this.#warnedCapOffExpired = false;
      return control;
    }
    if (!this.#defaults.enabled) return control;

    if (!this.#warnedCapOffExpired) {
      this.#warnedCapOffExpired = true;
      const why =
        ageMs === null
          ? 'the control source cannot say when the command was written'
          : `it was written ${Math.round(ageMs / 60_000)} min ago, past the ${CAP_OFF_MAX_AGE_MS / 60_000} min limit`;
      console.warn(
        `[spend-cap] the disabled spend cap expired: ${why}. The cap is back on. Rewrite the control file to disable it for another window, or raise WORLDSMITH_SPEND_CAP_USD and redeploy.`,
      );
    }
    return { ...control, enabled: true };
  }

  /**
   * Věta pro operátora — a ta **musí jmenovat místo, které má opravit**.
   *
   * U souboru je tím místem cesta na disku a je v ní schválně: bez ní se
   * operátor dozví jen to, že je něco rozbité. (Ven ji nepouští
   * `PUBLIC_REFUSAL` v `/api/generate`, který text zahazuje celý — rozvržení
   * souborů serveru je věc operátora, ne internetu.) U sdíleného klíče jméno
   * klíče nese už `readControlFrom()`, protože cesta k němu je adresa obchodu
   * a ta se do logu neopisuje.
   */
  #broken(source: ControlSource, detail: string): ControlOutcome {
    return {
      kind: 'broken',
      detail:
        source === 'file'
          ? `spend cap control file ${String(this.#controlPath)} is unreadable or malformed: ${detail}`
          : detail,
    };
  }

  /**
   * Diagnostika: čísla knihy a strop, **který naposledy rozhodl**.
   *
   * ⚠ **Dokud se to četlo výhradně ze souboru, umělo to lhát** — nález
   * nezávislé revize 4. 9. 2026 (P15 `T30-snapshotstale`). Na serverless žádný
   * ovládací soubor není, takže `#controlFromFile()` vrací pokaždé výchozí
   * hodnoty; operátor, který strop přetáhl sdíleným klíčem na 0,5 USD, četl
   * v jediném provozním konzumentovi (`accountingStepUsd()` v `/api/generate`)
   * dál původních 5 USD, a zrnitost účetního logu tak tiše sledovala strop,
   * který přestal platit. Na penězích to neviselo — `reserve()` rozhoduje nad
   * vlastním čerstvým čtením — ale na tom jediném čísle, které o stropu
   * operátor v logu vidí, ano.
   *
   * Soubor proto zůstává **jen jako záloha pro první volání**, než jakákoli
   * rezervace proběhne. Pak platí povel, kterým se rozhodovalo.
   */
  snapshot(): CapSnapshot {
    return this.#snapshotOf(this.#decidedWith ?? this.#controlFromFile());
  }

  #snapshotOf(outcome: ControlOutcome): CapSnapshot {
    const control = outcome.kind === 'ok' ? outcome.control : { enabled: true, capUsd: 0, callCap: 0 };
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
    // **Jedno čtení na celou rezervaci, ne jedno na každou odpověď.** Od
    // `T30-controllever` je to i síťový let do sdíleného obchodu; číst ho pod
    // každým `return` znovu by znamenalo tři lety na jedno odmítnutí a povel,
    // který se během jedné rezervace může změnit.
    const outcome = await this.#control();
    if (outcome.kind === 'broken')
      return {
        ok: false,
        reason: 'CONTROL_UNREADABLE',
        detail: outcome.detail,
        snapshot: this.#snapshotOf(outcome),
      };
    const { control } = outcome;

    if (!Number.isFinite(worstCaseUsd) || worstCaseUsd < 0)
      return {
        ok: false,
        reason: 'INVALID_ESTIMATE',
        detail: `worst case estimate ${String(worstCaseUsd)} is not a finite non-negative number of dollars`,
        snapshot: this.#snapshotOf(outcome),
      };

    if (this.#ledger === null)
      return {
        ok: false,
        reason: 'STORE_UNCONFIGURED',
        detail:
          'no shared spend store is configured and this process cannot show it is ' +
          'the only one, so a per-process cap would hold nothing; no call was made',
        snapshot: this.#snapshotOf(outcome),
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
        snapshot: this.#snapshotOf(outcome),
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
        snapshot: this.#snapshotOf(outcome),
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
        snapshot: this.#snapshotOf(outcome),
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
    // **Druhý zdroj ovládacího povelu** (`T30-controllever`): tentýž sdílený
    // obchod, tatáž předpona. Bez vyplněných `WORLDSMITH_SPEND_STORE_*` je to
    // `null` a platí jen soubor, přesně jako dřív.
    controlStoreFromEnv(env),
  );
}
