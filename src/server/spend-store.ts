/**
 * **Účetní kniha stropu, sdílená mezi instancemi** (P15 T29).
 *
 * `src/server/spend-cap.ts` drží doktrínu — rezervace předem, vyrovnání po
 * volání, zavřené selhání. Držel ale i **stav**, a to v poli instance, takže
 * platil přesně tak daleko, jak sahá jeden proces. Na Vercelu je každá studená
 * instance nový proces s plným zůstatkem: dvacet souběžných návštěvníků na
 * dvaceti lambdách je až dvacetinásobek nastaveného stropu. Naměřila to
 * nezávislá revize 31. 8. 2026 a je to jediný důvod, proč tenhle soubor existuje.
 *
 * ## Jedna operace, a je atomická
 *
 * Port má jedinou měnící metodu: `add()` přičte dolary i volání **naráz** a
 * vrátí součty **po** změně. Všechno ostatní se z ní složí:
 *
 * | Co strop dělá | Jak to vypadá tady |
 * |---|---|
 * | rezervace nejhoršího případu | `add(+worst, +1)` |
 * | odmítnutí (součet přeteče) | `add(-worst, -1)`, tedy vrácení téže rezervace |
 * | vyrovnání skutečnou cenou | `add(actual - worst, 0)` |
 *
 * **Přičti a případně vrať** je schválně, a ne „přečti, rozmysli, zapiš":
 * čtení a zápis jsou dvě operace a mezi ně se souběžný požadavek vejde —
 * přesně ta vada, kterou má tahle úloha zavřít. Přičtení napřed může strop
 * krátkodobě **přestřelit** (dva souběžné požadavky oba přičtou, oba uvidí
 * přeteklý součet, oba se vrátí), takže se pak odmítnou oba místo jednoho.
 * Chyba směrem k odmítnutí je u stropu na peníze ta správná.
 *
 * ## Proč tu není žádné SDK
 *
 * Adaptér mluví přes `fetch` protokolem Upstash REST (`INCRBYFLOAT`, `INCRBY`),
 * protože to je jediný sdílený stav, který má na Vercelu smysl a nepotřebuje
 * spojení držené mezi požadavky. Balíček by přinesl závislost, licenci do
 * `DISCLOSURE.md` a nic navíc — tenhle protokol jsou dva řetězce v poli.
 *
 * ⚠ **Nic z toho není naměřené proti živé službě.** Kontrakt je psaný podle
 * dokumentace protokolu; první běh proti skutečné instanci teprve bude, a do té
 * doby se nikde nesmí tvrdit, že persistence je ověřená. Ověřený je **port**,
 * a to deterministickým adaptérem v paměti, který sdílí týž kontrakt a týž
 * test.
 */

/** Součty účetní knihy. Dolary jsou rezervované i utracené dohromady. */
export interface LedgerTotals {
  readonly usd: number;
  readonly calls: number;
}

export interface SpendLedger {
  /** Jméno do diagnostiky. Ven nikdy nejde — je v něm poznat druh úložiště. */
  readonly id: string;
  /**
   * Atomicky přičte (obojí smí být záporné) a vrátí součty **po** změně.
   *
   * Vyhozená výjimka znamená „nevím, jak na tom účet je". Strop ji překládá na
   * odmítnutí, ne na průchod: neznámý zůstatek je přesně ten stav, ve kterém
   * se placené volání dělat nemá.
   */
  add(usd: number, calls: number): Promise<LedgerTotals>;
}

/**
 * Kniha v paměti procesu — **výchozí a poctivě označená**.
 *
 * Je to totéž, co strop uměl do 3. 9. 2026, jen vytažené za port: jeden proces,
 * jeden součet. Pod `next start` a při lokálním vývoji je to správně a je to
 * deterministické, takže na něm stojí i testy. Na serverless **nestačí** a
 * `ledgerFromEnv()` níž to tam ani nedovolí.
 */
export function memoryLedger(id = 'memory'): SpendLedger {
  let usd = 0;
  let calls = 0;
  return {
    id,
    add(addedUsd, addedCalls) {
      usd += addedUsd;
      calls += addedCalls;
      return Promise.resolve({ usd, calls });
    },
  };
}

/**
 * Jediná kniha procesu.
 *
 * Visí na `globalThis`, ne na modulu, a je to oprava naměřené vady: pod
 * `next start` si každá routa vytáhne tentýž modul z cache, ale **Next umí
 * postavit víc grafů modulů** (server components, edge, HMR ve vývoji) a
 * modulová proměnná je pak sdílená jen uvnitř jednoho z nich. Klíč je proto
 * jmenovaný a hledá se na `globalThis`.
 *
 * Napříč **instancemi** to nedrží nic z tohohle — to umí až `httpLedger()`.
 */
const PROCESS_LEDGER_KEY = '__worldsmithSpendLedger';

export function processLedger(): SpendLedger {
  const holder = globalThis as Record<string, unknown>;
  holder[PROCESS_LEDGER_KEY] ??= memoryLedger('process-memory');
  return holder[PROCESS_LEDGER_KEY] as SpendLedger;
}

/** Jen pro testy: zahodí procesovou knihu, aby další test začal na nule. */
export function resetProcessLedger(): void {
  delete (globalThis as Record<string, unknown>)[PROCESS_LEDGER_KEY];
}

export interface HttpLedgerConfig {
  /** Základ REST adresy úložiště. Bez koncového lomítka. */
  readonly url: string;
  readonly token: string;
  /** Předpona klíčů. Dvě nasazení nad jedním úložištěm se tím oddělí. */
  readonly prefix: string;
  readonly timeoutMs: number;
}

/**
 * Kniha ve sdíleném úložišti přes REST.
 *
 * Obě přičtení jdou **jednou rourou** (`POST /pipeline` s polem příkazů), takže
 * je to jeden síťový let a dolary s voláními se nemůžou rozejít o jeden pád
 * spojení mezi nimi. Atomicita je vlastnost každého jednoho příkazu; roura je
 * neslučuje do transakce a ani to není potřeba — obě čísla se jen zvětšují
 * a menší se toutéž cestou.
 *
 * **Časový limit je součást stropu, ne pohodlí.** Bez něj by výpadek úložiště
 * zavěsil požadavek na dobu, kterou určuje někdo jiný; s ním se z toho stane
 * odmítnutí, což je u peněz ta správná strana.
 */
export function httpLedger(config: HttpLedgerConfig, fetchImpl: typeof fetch = fetch): SpendLedger {
  const usdKey = `${config.prefix}:usd`;
  const callsKey = `${config.prefix}:calls`;

  return {
    id: 'http',
    async add(addedUsd, addedCalls) {
      const response = await fetchImpl(`${config.url}/pipeline`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify([
          ['INCRBYFLOAT', usdKey, String(addedUsd)],
          ['INCRBY', callsKey, String(addedCalls)],
        ]),
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      if (!response.ok)
        // **Bez těla odpovědi.** Chybová stránka úložiště nese adresu i klíč
        // požadavku a tenhle text jde do logu operátora vedle `requestId`.
        throw new Error(`spend ledger answered ${String(response.status)}`);

      const parsed: unknown = await response.json();
      if (!Array.isArray(parsed) || parsed.length !== 2)
        throw new Error('spend ledger answered a shape this server cannot read');

      const usd = Number((parsed[0] as { result?: unknown }).result);
      const calls = Number((parsed[1] as { result?: unknown }).result);
      if (!Number.isFinite(usd) || !Number.isFinite(calls))
        throw new Error('spend ledger answered totals that are not numbers');

      return { usd, calls };
    },
  };
}

/** Základ, pod kterým účtuje produkce. Preview si k němu přilepí svoje. */
const BASE_PREFIX = 'worldsmith:spend';

/**
 * Adresa a token sdílené knihy, nebo `null`, když se kniha s nikým nesdílí.
 *
 * **Jediná definice toho, co znamená „sdílená kniha"** — čte ji `storePrefix()`
 * i `ledgerFromEnv()`. Dvě definice by se rozešly a klíč by pak mluvil o jiném
 * uložišti, než do kterého zápis doopravdy míří; u peněz je to ten druh
 * rozporu, který se pozná až na faktuře.
 */
function sharedStoreFromEnv(
  env: Record<string, string | undefined>,
): { readonly url: string; readonly token: string } | null {
  const url = env.WORLDSMITH_SPEND_STORE_URL?.trim().replace(/\/+$/, '') ?? '';
  const token = env.WORLDSMITH_SPEND_STORE_TOKEN?.trim() ?? '';
  // **Půlka konfigurace není konfigurace.** Adresa bez tokenu by dala klíč
  // „sdílíme", ale zápis by neměl kam jít — proto obojí, nebo nic.
  return url !== '' && token !== '' ? { url, token } : null;
}

/**
 * Předpona klíčů účetní knihy — **výslovná, jinak odvozená z prostředí**.
 *
 * ⚠ **Pevný řetězec tuhle práci nedělá.** Proměnné prostředí se na Vercelu mezi
 * prostředími běžně sdílejí a `VERCEL` je nastavené i na preview, takže push
 * feature branche vyrobí nasazení, které účtuje do **téhož klíče** jako
 * produkční demo — a vyčerpá rozpočet, na kterém stojí odevzdání. Zaplatí to
 * produkce a v logu to vypadá jako jedno velmi činorodé nasazení.
 *
 * **Produkce si nechává holý základ**, aby se kniha nepřejmenovala pod běžícím
 * nasazením; odděluje se všechno ostatní.
 *
 * ⚠ **Odděluje se PROSTŘEDÍ, ne větev, a to je oprava blokujícího nálezu
 * revize.** První podoba lepila do klíče i `VERCEL_GIT_COMMIT_REF`, takže každá
 * nová větev dostala **vlastní čerstvý rozpočet** proti témuž klíči
 * u poskytovatele — strop tím přestal omezovat peníze a začal omezovat peníze
 * na větev, přičemž počet větví neomezuje nic. Kdo umí pushnout, koupí si další
 * rozpočet přejmenováním větve. Kdyby někdy měla mít preview vlastní rozpočet
 * na větev, potřebuje **menší vlastní `WORLDSMITH_SPEND_CAP_USD`**, ne jemnější
 * klíč.
 *
 * ⚠ **Jméno prostředí je UZAVŘENÝ seznam, ne volný text — nález druhé revize.**
 * Dokud se `VERCEL_ENV` jen čistilo a lepilo do klíče, mintovala si vlastní
 * čerstvý rozpočet každá jeho hodnota, a **Vercel dovoluje zakládat vlastní
 * prostředí**, jejichž slug do té proměnné padne. Naměřeno revizí: `staging`,
 * `qa` i `development` daly tři různé knihy — táž vada jako u větví, jen
 * o patro výš. Odvozené klíče jsou proto **právě tři** — `…`, `…:preview`
 * a `…:unknown-env` — a součet přes nasazení je nejvýš trojnásobek stropu.
 * Cokoliv mimo `production` a `preview` je neznámo, ne vlastní prostředí.
 *
 * ⚠ **Chybějící `VERCEL_ENV` není produkce, je to neznámo — a nesmí se to poznat
 * podle `VERCEL`.** Systémové proměnné vypíná v projektu jeden přepínač
 * (*Automatically expose System Environment Variables*), a ten řídí `VERCEL`
 * i `VERCEL_ENV` **dohromady**. Záchranná síť pověšená na `VERCEL` tedy mizí
 * přesně v tom případě, kvůli kterému existuje: zhasnou obě proměnné, `scope`
 * je prázdný, `isServerless()` řekne „ne" a nasazení dostane produkční klíč.
 * Naměřeno druhou nezávislou revizí 4. 9. 2026 (P15 `T29-unknownenv`).
 *
 * **Rozhoduje proto sdílená kniha, ne platforma.** Adresa a token jsou
 * uživatelské proměnné, které ten přepínač nevypíná: kdo sdílí knihu a nemá
 * známé prostředí, dostane `unknown-env`. Bez sdílené knihy není s čím
 * kolidovat — jediný proces si vede vlastní součet a holý základ platí dál,
 * takže lokálnímu provozu **bez vyplněných `WORLDSMITH_SPEND_STORE_*`** se
 * kniha nepřejmenovala. `VERCEL` zůstává jako druhý, slabší signál: když
 * svítí, je to nasazení tak jako tak.
 *
 * ⚠ **Kdo sdílenou knihu vyplněnou má a známé prostředí nemá, tomu se klíč
 * přejmenoval** — `worldsmith:spend` → `…:unknown-env`, tedy `next start` nebo
 * Docker nad Upstashem taky. Dosud naúčtovaná útrata zůstane na starém klíči
 * a strop začne od nuly; migrační postup je v `.env.example`.
 *
 * ⚠ **Jedna díra tím zavřená NENÍ a nemá se předstírat, že je:** nasazení
 * s vypnutým přepínačem **a bez sdílené knihy** je z prostředí nerozeznatelné
 * od lokálního běhu, takže dostane knihu v paměti procesu. Zavírá to až
 * vyplněné `WORLDSMITH_SPEND_STORE_*`, což je stejně jediná podoba, ve které
 * strop na serverless platí (`ledgerFromEnv()` níž).
 *
 * Výslovná hodnota vyhrává nad odvozenou — odvození je záchranná síť, ne
 * pravidlo. **Na Vercelu to má háček zapsaný v `.env.example`:** proměnná
 * nastavená pro všechna prostředí odvození vypne a kolize se vrátí.
 */
export function storePrefix(env: Record<string, string | undefined>): string {
  const explicit = env.WORLDSMITH_SPEND_STORE_PREFIX?.trim() ?? '';
  if (explicit !== '') return explicit;

  const scope = env.VERCEL_ENV?.trim().toLowerCase() ?? '';
  if (scope === 'production') return BASE_PREFIX;
  if (scope === 'preview') return `${BASE_PREFIX}:preview`;
  // Prostředí není známé. Holý základ tu smí vyjít jedině tam, kde není s čím
  // kolidovat: nikdo další do té knihy nepíše a nic neříká, že jsme nasazení.
  if (scope === '' && sharedStoreFromEnv(env) === null && !isServerless(env)) return BASE_PREFIX;

  return `${BASE_PREFIX}:unknown-env`;
}

/** Kde běžíme. `VERCEL` nastavuje platforma sama, na všech svých prostředích. */
export function isServerless(env: Record<string, string | undefined>): boolean {
  return env.VERCEL !== undefined;
}

/**
 * Kniha podle prostředí, nebo `null` — a `null` znamená **odmítat**, ne „jeď
 * bez stropu".
 *
 * | Prostředí | Co vyjde |
 * |---|---|
 * | `WORLDSMITH_SPEND_STORE_URL` + token | sdílená kniha přes REST |
 * | bez nich, mimo serverless | kniha v paměti procesu, poctivě označená |
 * | bez nich, **na serverless** | `null`, tedy zavřené selhání |
 *
 * Poslední řádek je celý smysl téhle funkce. Do 3. 9. 2026 bránil nasazení
 * s klíčem a bez sdíleného stavu **jen český komentář v `.env.example`**, a
 * komentář není mechanismus: kdo klíč vyplní, dostane strop, který se resetuje
 * s každým chladným startem, a nedozví se o tom.
 */
export function ledgerFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): SpendLedger | null {
  const shared = sharedStoreFromEnv(env);
  if (shared !== null)
    return httpLedger(
      {
        url: shared.url,
        token: shared.token,
        prefix: storePrefix(env),
        timeoutMs: DEFAULT_LEDGER_TIMEOUT_MS,
      },
      fetchImpl,
    );

  return isServerless(env) ? null : processLedger();
}

/**
 * Kolik se čeká na úložiště.
 *
 * Dvě sekundy jsou **volba uvnitř rozpětí**, ne odvozená hodnota. Zdola to drží
 * síťový let do téhož regionu (`vercel.json` pinuje `fra1`), který se počítá
 * v jednotkách milisekund; shora rozpočet §22.1 na hrubý svět, tedy 3 s, ze
 * kterého tohle nesmí ukousnout víc než zlomek. Vyprší-li, je to odmítnutí —
 * a odmítnutí je u peněz levnější než volání naslepo.
 */
export const DEFAULT_LEDGER_TIMEOUT_MS = 2_000;
