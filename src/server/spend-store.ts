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
 *
 * ## Opuštěná rezervace a postup zotavení (P15 T29-abandoned)
 *
 * Rezervace `add(+worst, +1)` se vyrovnává až po volání. Odpoví-li úložiště
 * po časovém limitu (`DEFAULT_LEDGER_TIMEOUT_MS`), server **neví**, jestli
 * `INCRBYFLOAT` dorazil, a odmítne (`LEDGER_UNAVAILABLE`). Dorazil-li,
 * rezervace v knize zůstane natrvalo: kniha nemá TTL a repo nemá příkaz, který
 * by klíč vynuloval. Obojí je vědomá volba, ne opomenutí:
 *
 * - **`EXPIRE` na klíčích knihy** by s rezervací nechal vypršet celý součet
 *   útraty, takže by se strop dal koupit znovu počkáním — přesně vada, kterou
 *   `T9-capcoldstart` zavírá. TTL na běžícím počítadle není úklid, je to reset.
 * - **Slepá kompenzace `add(-worst, -1)` v `catch`** by mohla vrátit peníze,
 *   které se nikdy nestrhly, a strop tím otevřít. Doktrína celého souboru je
 *   opačná: chyba směrem k odmítnutí je u peněz ta správná.
 *
 * Obojí vyvrátila nezávislá revize 3. 9. 2026 měřením; příští kolo to nemá
 * zkoušet znovu.
 *
 * **Zotavení je ruční a je to rozhodnutí o penězích:** porovnat součet knihy
 * s účtem poskytovatele a o rozdíl zvednout `WORLDSMITH_SPEND_CAP_USD`, pak
 * redeploy.
 *
 * ⚠ **Ovládacím souborem to NEJDE a do 4. 9. 2026 tady stálo, že jde.** Od
 * `T30-capfloor` je účinná částka `min(soubor, WORLDSMITH_SPEND_CAP_USD)`,
 * takže soubor umí strop jen přitáhnout. Vyšší `capUsd` zapsané do souboru je
 * tichý no-op: nic se nezmění a nevznikne u toho řádek, takže operátor uvidí
 * jen to, že `CAP_EXHAUSTED` trvá dál. Proměnná a redeploy jsou jediná páka
 * směrem nahoru.
 *
 * Postup pro operátora je v `.env.example` u `WORLDSMITH_SPEND_STORE_PREFIX`.
 * Hlídač, který by opuštěné rezervace měřil, dnes neexistuje; kdyby vznikl,
 * nesmí umět součet knihy snížit sám od sebe.
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
 * ⚠ **Výslovná předpona je ZÁKLAD jména, ne celé jméno — a je to obrácení
 * dřívějšího AC `T29-storeprefix`.** Do 4. 9. 2026 `WORLDSMITH_SPEND_STORE_PREFIX`
 * odvození vypnula úplně, na tom stál zelený test a bylo to napsané jako
 * pravidlo. Jenže vercelské UI při zakládání proměnné **předškrtává všechna tři
 * prostředí**, takže operátor, který se řídil starou radou z `.env.example`
 * („vyplň ji a nasazení se oddělí"), tím odvození vypnul a vrátil přesně tu
 * kolizi, kterou úloha zavírala. Naměřeno revizí: `{VERCEL:1,
 * VERCEL_ENV:preview, WORLDSMITH_SPEND_STORE_PREFIX:worldsmith:spend}` →
 * `worldsmith:spend`, tedy **preview účtuje do produkční knihy**.
 *
 * „Výslovná vyhrává" proto od `T29-explicitscope` znamená **který základ**, ne
 * jestli smí preview psát do produkční knihy. Segment prostředí se připojuje
 * i k výslovné předponě; jediné, co si nechá holý základ, je `production` —
 * a lokální běh bez sdílené knihy, kde není s čím kolidovat (o řádek níž).
 *
 * ⚠ **Kdo výslovnou předponu má a sdílenou knihu taky, tomu se klíč
 * jednorázově přejmenoval** — `demo` → `demo:unknown-env` mimo Vercel,
 * `demo` → `demo:preview` na preview. Dosud naúčtovaná útrata zůstane na
 * starém klíči a strop začne od nuly.
 *
 * **Zpátky se tou proměnnou dostat nedá a nikde se to nemá radit** — mimo
 * `production` ne. Segment se připojuje k čemukoli, takže `demo:unknown-env`
 * dá `demo:unknown-env:unknown-env`, tedy třetí klíč s prázdnou útratou a
 * celým stropem navrch. Zotavení je na straně úložiště: přejmenovat starý klíč,
 * nebo ho vyprázdnit a snížit `WORLDSMITH_SPEND_CAP_USD` o uvízlou částku.
 * Celý postup je v `.env.example`.
 */
export function storePrefix(env: Record<string, string | undefined>): string {
  // **Výslovná předpona mění ZÁKLAD, ne pravidla pod ním** — každá větev níž
  // zůstala, jen se přestala vázat na konstantu. Kdyby tady byl dřívější
  // `return explicit`, vercelské předškrtnutí všech tří prostředí by odvození
  // vyplo a preview by účtovalo do produkční knihy.
  const explicit = env.WORLDSMITH_SPEND_STORE_PREFIX?.trim() ?? '';
  const base = explicit !== '' ? explicit : BASE_PREFIX;

  const scope = environmentScope(env);
  if (scope === 'production') return base;
  if (scope === 'preview') return `${base}:preview`;
  // Prostředí není známé. Holý základ tu smí vyjít jedině tam, kde není s čím
  // kolidovat: nikdo další do té knihy nepíše a nic neříká, že jsme nasazení.
  if (scope === 'unset' && sharedStoreFromEnv(env) === null && !isServerless(env)) return base;

  return `${base}:unknown-env`;
}

/**
 * Prostředí, ve kterém tenhle proces běží — **jediná definice, uzavřený
 * seznam** (P15 `T29-lambdadetect`).
 *
 * Čte ji `storePrefix()` (do kterého klíče se účtuje) i `ledgerFromEnv()`
 * (jestli se vůbec smí platit). Dvě definice by se rozešly a server by účtoval
 * do knihy, o které si druhá půlka kódu myslí něco jiného — u peněz je to ten
 * druh rozporu, který se pozná až na faktuře.
 *
 * **`unset` a `unrecognized` se rozlišují schválně**, i když obojí je
 * „neznámo". Chybějící proměnná je normální stav lokálního běhu, kdežto vlastní
 * vercelské prostředí (`staging`, `qa` — Vercel je dovoluje zakládat) je
 * nasazení, které se jen jmenuje jinak. `storePrefix()` na tom rozdílu stojí:
 * jen `unset` smí dostat holý základ.
 */
type EnvironmentScope = 'production' | 'preview' | 'unset' | 'unrecognized';

function environmentScope(env: Record<string, string | undefined>): EnvironmentScope {
  const raw = env.VERCEL_ENV?.trim().toLowerCase() ?? '';
  if (raw === 'production') return 'production';
  if (raw === 'preview') return 'preview';
  return raw === '' ? 'unset' : 'unrecognized';
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
 * | bez nich, `VERCEL` nastavené | `null`, tedy zavřené selhání |
 * | bez nich, `VERCEL_ENV` neznámé | `null`, tedy zavřené selhání |
 * | bez nich, známé prostředí mimo Vercel | kniha v paměti procesu, poctivě označená |
 *
 * Zavřené selhání je celý smysl téhle funkce. Do 3. 9. 2026 bránil nasazení
 * s klíčem a bez sdíleného stavu **jen český komentář v `.env.example`**, a
 * komentář není mechanismus: kdo klíč vyplní, dostane strop, který se resetuje
 * s každým chladným startem, a nedozví se o tom.
 *
 * ## Proč nestačí `isServerless()` samotné (P15 `T29-lambdadetect`)
 *
 * `T29-unknownenv` zavřela **klíč**, ne **volbu knihy**: `storePrefix()`
 * přestala věřit `VERCEL`, kdežto tahle funkce podle něj rozhodovala dál.
 * Přepínač *Automatically expose System Environment Variables* přitom zhasíná
 * `VERCEL` i `VERCEL_ENV` naráz, takže nasazení s vypnutým přepínačem a bez
 * sdílené knihy vypadalo z prostředí jako lokální běh — dostalo knihu v paměti
 * procesu a s ní N-násobek stropu, přesně tu vadu, kvůli které tenhle soubor
 * vznikl. Naměřila to nezávislá revize 4. 9. 2026.
 *
 * **Kniha v paměti procesu proto platí jen tam, kde je jeden proces, a to musí
 * být řečeno — ne odhadnuto z ticha.** Řekne to `VERCEL_ENV` s uzavřeného
 * seznamu při zhasnutém `VERCEL`.
 *
 * ⚠ **Co ta dvojice dokazuje doopravdy, a co ne** (`T29-singleprocess`,
 * 6. 9. 2026). Dokazuje „**nejsme na Vercelu**", ne „**jsme jeden proces**" —
 * a to je slabší tvrzení, než na kterém strop stojí. Operátor na cizím
 * hostiteli si `VERCEL_ENV=production` nastaví sám (`.env.example` mu to pro
 * lokální placení výslovně radí) a se čtyřmi replikami bez sdílené knihy má
 * čtyřnásobek stropu. **Kód se kvůli tomu vědomě NEMĚNÍ** — rozhodnutí
 * uživatele 6. 9. 2026: `WORLDSMITH_SINGLE_PROCESS` by měnila rozhodnutí ze
 * 4. 9. („žádný nový platformní signál"), a vyžadovat sdílenou knihu všude
 * zastaví i měřicí běh `T14`, který je povinný pro bránu `G2`. Ta vada navíc
 * míří na tvar nasazení, který v repu není: žádný `Dockerfile`, žádné
 * `docker-compose`, cíl je Vercel. **Podmínka znovuotevření je proto věcná,
 * ne časová:** jakmile v repu přibude `Dockerfile`, `docker-compose*` nebo
 * jakékoli nasazení s víc než jednou instancí bez sdílené knihy, tahle mez se
 * musí dodělat DŘÍV než to nasazení.
 *
 * ⚠ **Cena je, že lokální `next start` bez `VERCEL_ENV` placená volání
 * odmítne** (`STORE_UNCONFIGURED`). Je to vědomé: na peněžní cestě se selhává
 * zavřeně a mlčení není důkaz, že jsme sami. Vývojář si dopíše `VERCEL_ENV`,
 * nebo sdílenou knihu; obojí je v `.env.example`.
 *
 * ⚠ **„Neplacené cesty to nezastaví" tady stálo od 3. 9. 2026 a bylo to
 * nepravdivé** (P15 `T29-e2egeneratedead`). Offline větev `mock` přes strop
 * **chodí** — `src/server/pipeline.ts` rezervuje před každým voláním, tedy
 * i za nula dolarů — takže `null` odsud kladlo i ji. Naměřeno 6. 9. 2026: týž
 * build a táž adresa, jediný rozdíl `VERCEL_ENV`, 503 proti 200 se světem.
 * Slib teď plní `SpendCap.reserve()`, která knihu žádá jen pro rezervaci
 * s kladnou částkou; tenhle soubor rozhoduje beze změny.
 *
 * ⚠ **`AWS_LAMBDA_FUNCTION_NAME` ani `NEXT_RUNTIME` se sem zavádět NEMÁ a
 * příští kolo to nemá zkoušet.** `NEXT_RUNTIME` přiřazuje `next` sám, tedy
 * i lokálnímu `next start` a `next dev`; `AWS_LAMBDA*` je neověřené chování
 * cizí platformy na peněžní cestě a v repu se nevyskytuje ani jednou. Zavřené
 * selhání nový platformní signál nepotřebuje.
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

  if (isServerless(env)) return null;
  const scope = environmentScope(env);
  return scope === 'production' || scope === 'preview' ? processLedger() : null;
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

/**
 * **Druhé místo, odkud se čte ovládací soubor** (P15 `T30-controllever`).
 *
 * Vypínače i strop se do `T30-controllever` ovládaly výhradně souborem na
 * disku (`control-file.ts` říká, proč souborem a ne routou). Na Vercelu je ale
 * souborový systém **jen pro čtení** kromě `/tmp`, a `/tmp` je per-instance:
 * operátor tedy za incidentu neměl kam napsat `{"off":["all"]}` tak, aby to
 * viděla celá flotila. Vypínač existoval v kódu a chyběla mu páka.
 *
 * Klíč je proto **druhý zdroj čtení, ne třetí ovládací povrch**. Je to tentýž
 * obchod, který od `T29` drží účetní knihu, tatáž předpona (`storePrefix()`),
 * tentýž token — a hlavně **týž obsah**: do klíče se píše přesně ten JSON,
 * který by jinak ležel v souboru, takže pravidla o uzavřeném seznamu klíčů,
 * o rozbitém souboru i o podlaze stropu platí beze změny. Soubor si drží
 * přednost, aby lokální provoz a `next start` zůstaly, jak byly.
 *
 * **Předpona je táž jako u knihy schválně.** Preview tím vypíná preview
 * a produkce produkci; jedna kniha na prostředí a jeden vypínač na prostředí
 * je jedna hranice, ne dvě, které se můžou rozejít.
 */
export interface ControlStore {
  /** Jméno do diagnostiky. Ven nikdy nejde. */
  readonly id: string;
  /** Klíč, ze kterého se čte. Do diagnostiky a do testů, ven nejde. */
  readonly key: string;
  /**
   * Text uloženého ovládacího klíče, nebo `null`, když klíč neexistuje.
   *
   * `null` je „nikdo vypínačem nehnul", tedy totéž co chybějící soubor.
   * Vyhozená výjimka znamená „nevím, co je vypnuté", a volající ji překládá na
   * **rozbitý ovládací soubor** — tedy placené dveře stojí a čtení běží dál.
   */
  read(): Promise<string | null>;
}

/**
 * Přípona klíče, pod kterým ovládací JSON v obchodě bydlí.
 *
 * Vedle `…:usd` a `…:calls`, které drží knihu. Tři klíče na jednu předponu,
 * takže operátor, který se dívá do konzole úložiště, vidí rozpočet i vypínače
 * pohromadě.
 */
export const CONTROL_KEY_SUFFIX = ':control';

/**
 * Kolik se čeká na ovládací klíč — **desetina toho, co na knihu**.
 *
 * Kniha je ta operace, kvůli které se platí (`DEFAULT_LEDGER_TIMEOUT_MS`, 2 s);
 * ovládací klíč je proti tomu **brána před prací**, a to na každých veřejných
 * dveřích včetně čtecích. Dvě sekundy by na nich znamenaly, že výpadek
 * úložiště přidá dvě sekundy ke každému požadavku, který se pak stejně
 * odmítne — z rozpočtu §22.1 na hrubý svět (3 s) by nezbylo nic.
 *
 * 200 ms je nad síťovým letem do téhož regionu (`vercel.json` pinuje `fra1`)
 * o řád a pod tím, co porotce postřehne. Vyprší-li, čte se to jako rozbitý
 * ovládací soubor: placené dveře stojí (kniha by je stejně odmítla o operaci
 * později), čtení hotových světů běží dál.
 */
export const DEFAULT_CONTROL_TIMEOUT_MS = 200;

export interface HttpControlStoreConfig {
  /** Základ REST adresy úložiště. Bez koncového lomítka. */
  readonly url: string;
  readonly token: string;
  /** Táž předpona jako u knihy. Klíč je `${prefix}${CONTROL_KEY_SUFFIX}`. */
  readonly prefix: string;
  readonly timeoutMs: number;
}

/** Ovládací klíč ve sdíleném úložišti přes REST. */
export function httpControlStore(
  config: HttpControlStoreConfig,
  fetchImpl: typeof fetch = fetch,
): ControlStore {
  const key = `${config.prefix}${CONTROL_KEY_SUFFIX}`;

  return {
    id: 'http',
    key,
    async read() {
      const response = await fetchImpl(`${config.url}/get/${encodeURIComponent(key)}`, {
        headers: { authorization: `Bearer ${config.token}` },
        // **Bez cache.** Vypínač, který platí až od vypršení cizí cache, není
        // vypínač — týž důvod, proč se soubor čte při každém rozhodnutí znovu.
        cache: 'no-store',
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      if (!response.ok)
        // Bez těla odpovědi, ze stejného důvodu jako u knihy: chybová stránka
        // úložiště nese adresu i klíč požadavku a tenhle text jde do logu.
        throw new Error(`control store answered ${String(response.status)}`);

      const parsed: unknown = await response.json();
      const result = (parsed as { result?: unknown }).result;
      // `null` i chybějící pole znamenají „klíč není", tedy normální stav
      // nasazení, na které nikdo nesáhl.
      if (result === null || result === undefined) return null;
      if (typeof result !== 'string')
        throw new Error('control store answered a shape this server cannot read');
      return result;
    },
  };
}

/**
 * Jak dlouho smí jeden přečtený povel platit pro další čtenáře **téže
 * instance**.
 *
 * ⚠ **Bez téhle meze je čtení vypínače zesilovač, který platí operátor** —
 * nález nezávislé revize commitu `316a4f1`, `VERDICT: blocking`. `killState()`
 * se od `T30-controllever` čte přes síť a sedí jako **první** příkaz na každých
 * dveřích. Tři čtecí dveře přitom strop frekvence nemají vůbec
 * (`snapshots/[hash]`, `sessions/[sessionId]`, `.../events`), takže jeden
 * anonymní požadavek = jeden příkaz do sdíleného obchodu, bez horní meze. Kdo
 * ve smyčce žádá `GET /api/worldstream/snapshots/<náhodný hash>`, projde i
 * kolem CDN (`s-maxage` na nové adrese nikdy netrefí) a vypálí kvótu obchodu
 * rychlostí požadavků. Až kvóta dojde, `read()` vyhazuje → `PAID_OFF`, kniha
 * hlásí `LEDGER_UNAVAILABLE` — a jediná páka, kterou to má operátor zastavit,
 * je právě ten obchod.
 *
 * **Omezuje se to, co brána VYPRODUKUJE, ne kdo na ni smí sáhnout.** Přeřazení
 * `killState()` za strop frekvence samo nestačí a je to spočítané, ne
 * odhadnuté: strop instance pouští 400 požadavků za 10 s, tedy pořád 40
 * příkazů za sekundu, což je 3,4 milionu za den. S tímhle oknem vydá instance
 * **nejvýš jeden příkaz za sekundu** bez ohledu na to, kolik jich přijde.
 *
 * ⚠ **Je to odchylka od rozhodnutí ze 4. 9. 2026 („čerstvost, ne cache") a
 * takhle je zaplacená:** zamítnutá varianta byla cache **obnovovaná jinde**,
 * tedy s neomezeným stářím. Tady je stáří ohraničené na jednu sekundu a nikdo
 * ji neobnovuje — vypínač zabere do sekundy od chvíle, kdy ho operátor napíše.
 * Soubor na disku se necachuje vůbec, takže lokální provoz a `next start` jsou
 * pořád plně čerstvé.
 */
export const CONTROL_CACHE_TTL_MS = 1000;

interface ControlWindow {
  readonly at: number;
  readonly read: Promise<string | null>;
}

/**
 * Sdílená okna na instanci. Klíčem záznamu je adresa **a** ovládací klíč, aby
 * si dvě prostředí (a dva testy) nesáhly do téhož letu.
 *
 * ⚠ **Visí to na `globalThis` ze stejného naměřeného důvodu jako
 * `PROCESS_LEDGER_KEY` výš**, a je to nález nezávislé revize commitu `1dfc7ec`:
 * Next umí postavit víc grafů modulů, takže modulová proměnná by byla sdílená
 * jen uvnitř jednoho z nich — a slíbený strop „jeden let za sekundu na
 * instanci" by tiše platil **na graf**, ne na instanci. Ze stejného důvodu by
 * `__resetControlWindows()` uklidil jen graf volajícího.
 */
const CONTROL_WINDOWS_KEY = '__worldsmithControlWindows';

function controlWindows(): Map<string, ControlWindow> {
  const holder = globalThis as Record<string, unknown>;
  holder[CONTROL_WINDOWS_KEY] ??= new Map<string, ControlWindow>();
  return holder[CONTROL_WINDOWS_KEY] as Map<string, ControlWindow>;
}

/** Zahodí okna. Jen pro testy — provoz je nemá proč zahazovat. */
export function __resetControlWindows(): void {
  delete (globalThis as Record<string, unknown>)[CONTROL_WINDOWS_KEY];
}

/**
 * Obalí obchod oknem: souběžní čtenáři sdílejí **jeden** let a další sekundu
 * ho sdílejí i ti, co přijdou po nich.
 *
 * Ukládá se `Promise`, ne hodnota, a to je celá pointa: souběh 400 požadavků
 * v jednom tiku by nad hotovou hodnotou pořád vypálil 400 letů, protože by
 * všechny našly okno prázdné. Takhle najdou rozdělaný let a přidají se k němu.
 *
 * **Neúspěch se cachuje taky, schválně.** Výpadek obchodu je přesně ta chvíle,
 * kdy se nesmí každý požadavek pokoušet znovu: 200 ms na požadavek by udělalo
 * z výpadku frontu a z kvóty popel. Zavřené selhání drží sekundu a pak se
 * zkusí znovu.
 */
export function windowedControlStore(
  inner: ControlStore,
  cacheKey: string,
  ttlMs: number = CONTROL_CACHE_TTL_MS,
  now: () => number = Date.now,
): ControlStore {
  return {
    id: inner.id,
    key: inner.key,
    read() {
      const at = now();
      const windows = controlWindows();
      const open = windows.get(cacheKey);
      if (open !== undefined && at - open.at < ttlMs) return open.read;

      const read = inner.read();
      windows.set(cacheKey, { at, read });
      // Bez tohohle by odmítnutý let, ke kterému se do vypršení okna nikdo
      // nepřidá, spadl do Node jako neošetřené odmítnutí a shodil proces.
      read.catch(() => undefined);
      return read;
    },
  };
}

/**
 * Ovládací klíč podle prostředí, nebo `null`, když se s nikým nesdílí.
 *
 * `null` tady znamená **„není druhý zdroj"**, ne „odmítat" — na rozdíl od
 * `ledgerFromEnv()`. Je to schválně: bez sdíleného obchodu platí soubor a to
 * je celý lokální provoz. Zavřené selhání bez sdíleného stavu už drží kniha,
 * a dvě místa, která ho drží, by znamenala dvě pravidla.
 *
 * **Okno se nasazuje tady, ne v `httpControlStore()`.** Kdo si obchod skládá
 * sám — testy a budoucí volající — dostane holé čtení bez sdíleného stavu;
 * okno má jedině ta cesta, kterou chodí běžící server.
 */
export function controlStoreFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): ControlStore | null {
  const shared = sharedStoreFromEnv(env);
  if (shared === null) return null;
  const store = httpControlStore(
    {
      url: shared.url,
      token: shared.token,
      prefix: storePrefix(env),
      timeoutMs: DEFAULT_CONTROL_TIMEOUT_MS,
    },
    fetchImpl,
  );
  return windowedControlStore(store, `${shared.url} ${store.key}`);
}
