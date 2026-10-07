import {proxyOwnerIdentity} from './owner-identity';

/**
 * **Strop na frekvenci veřejných dveří** (P15 `T28-editrate`).
 *
 * Naměřeno 4. 9. 2026, ne odhadnuto: jeden `POST /api/edit` stojí **medián
 * 15,3 ms, p95 27,7 ms a max 38,6 ms** synchronního CPU na smyčce (60 měření,
 * tělo 1 784 B, po zahřátí cache korpusu). Je to anonymní veřejná adresa, takže
 * ~**66 požadavků za sekundu** zastaví celou instanci — a s ní SSE proudy,
 * preview i snapshoty, tedy všechno, co má porotce vidět. Cena útoku je jedna
 * smyčka `curl`.
 *
 * ## Klíčem je VOLAJÍCÍ, a je to oprava blokujícího nálezu revize
 *
 * ⚠ **První podoba počítala jen po dveřích, a tím útok ZLEVNILA.** Jeden
 * čítač na dveře znamená, že kdokoli, kdo drží okno plné, zavře dveře **všem
 * ostatním** — a to už za 5,1 požadavku za sekundu místo naměřených ~66.
 * Odmítnuté požadavky se přitom počítají (viz níž), takže flooder okno drží
 * napořád. Obrana proti náporu, která je levnější než nápor sám, je vada, ne
 * mez; naměřila to nezávislá revize 4. 9. 2026 (`VERDICT: blocking`).
 *
 * Klíč je proto **(dveře, volající)**, a nad ním stojí druhý, mnohem vyšší
 * strop na celou instanci. Volající se bere z hlaviček proxy a **dá se
 * podvrhnout** — to je vědomé:
 *
 * | | Bez stropu | Strop na dveře | Strop na volajícího |
 * |---|---|---|---|
 * | co stojí položit instanci | ~66 req/s | **5,1 req/s** | ~66 req/s, a útočník musí střídat adresy |
 * | koho to odmítne | nikoho | **všechny** | toho, kdo střílí |
 *
 * Podvržený klíč tedy útočníka vrací nanejvýš tam, kde byl **bez** téhle meze,
 * kdežto sdílený čítač ho posouval o řád dopředu.
 *
 * ⚠ **Věta „klíč nemusí být důvěryhodný, aby byl lepší" tady stála do
 * 6. 9. 2026 a byla to lež o polovině účastníků** — blokující nález nezávislé
 * revize, potvrzený spuštěním. Platí **o útočníkovi** a neplatí **o oběti**:
 * `callerKey()` čte první položku `x-forwarded-for`, což je hodnota, kterou
 * píše volající, takže si útočník nevybírá svůj kbelík — vybírá **cizí**.
 * Padesát požadavků s `x-forwarded-for: <oběť>, <útočník>` za deset sekund
 * (nečitelné tělo, žádná emise) umlčí porotce na dalších deset, bez
 * přihlášení a bez peněz.
 *
 * **Proto všech sedmero veřejných dveří klíčuje `trustedCallerKey(request) ??
 * callerKey(request)`** (`T29-freeunbounded`). Na platformě si klíč vybrat
 * nejde; mimo ni je to **beze změny** — `null` padá zpátky na starý klíč,
 * takže se nikde nezhroutí všichni volající do jednoho kbelíku, což je ta
 * horší polovina staré doktríny a **platí dál** (sloupec „Strop na dveře").
 * Naměřená cena přepnutí: **0 obrácených asercí ze 686**; jediný pin, který
 * zčervenal, tvrdil právě tu zavřenou cenu (`sessions.test.ts`).
 *
 * ⚠ **Co zbývá mimo platformu, a musí se to číst jako napsané:** tam je klíč
 * dál vstup volajícího, útok na cizí kbelík dál vyjde a rotace hlavičky dál
 * dává nové kbelíky. Uzavřít to nejde bez zdroje, do kterého volající nemluví
 * (doktrína u `trustedCallerKey()`), a nasazení dema na platformě běží.
 *
 * ## Proč je stav v PROCESU, ačkoli plán psal sdílený obchod
 *
 * `T28-editrate` v plánu předepisovala, aby frekvence bydlela v tomtéž sdíleném
 * obchodu jako účetní kniha stropu (`src/server/spend-store.ts`), protože stav
 * v paměti procesu na serverless nedrží. **U peněz to platí a tady ne, a je
 * v tom rozdíl v tom, co se vlastně poškozuje:**
 *
 * | | Strop utrácení | Tenhle strop |
 * |---|---|---|
 * | co se vyčerpá | jeden rozpočet u poskytovatele, **společný** všem instancím | smyčka **téhle** instance |
 * | co znamená druhá instance | druhá půlka téže peněženky → musí se sčítat | vlastní smyčka → počítá si sama |
 * | cena sdíleného obchodu | zaplatí se jednou za placené volání | **síťový let před každým požadavkem** |
 *
 * Sdílený čítač by tedy měřil něco, co sdílené není, a zaplatil by to letem do
 * Upstashe na kritické cestě porotcovy věty. Navíc je asynchronní, kdežto
 * `/api/edit` má dnes **jediný `await`** (čtení těla) a brána `T28-editpins`
 * to hlídá nad celým uzávěrem importů.
 *
 * ⚠ **Co tenhle soubor tedy NEDĚLÁ a nesmí se to nikde tvrdit** (`T28-fleetrate`):
 * neomezuje součet požadavků přes celé nasazení. **Strop platí na instanci**,
 * takže flotila o N instancích propustí N násobek stropu.
 *
 * **Rozhodnuto 4. 9. 2026: sdílený čítač se NESTAVÍ a tenhle rozdíl zůstává.**
 * Není to odložení — je to volba a tady je její cena. Sdílený čítač by znamenal
 * síťový let do Upstashe **před každým požadavkem**, tedy latenci na kritické
 * cestě porotcovy věty, a platilo by se tím za mez, kterou naměřená vada
 * nepotřebuje: ta vada je zastavená smyčka **téhle** instance, a tu si každá
 * instance spočítá sama. Kapacitu celého nasazení hlídá strop utrácení
 * (`spend-store.ts`), a ten sdílený **je** — protože peněženka sdílená je,
 * kdežto smyčka ne. Tenhle rozdíl je celé odůvodnění a stojí o dvě tabulky výš.
 *
 * Co se tím vědomě vzdává, napsané nahlas: „kolik toho unese celé nasazení"
 * tahle mez neříká a nikde se to tvrdit nesmí.
 *
 * ## Pevné okno, ne klouzavé
 *
 * Klouzavé okno je přesnější a drží frontu časů na požadavek. Pevné okno drží
 * **dvě čísla na klíč** a nejhorší případ je dvojnásobek stropu na hranici
 * dvou oken. Ten dvojnásobek je pořád **řádově** pod tím, co instanci zastaví,
 * a paměť meze neroste s provozem — což je u obrany proti náporu ta
 * důležitější vlastnost.
 */

/**
 * Strop na jednoho volajícího a jedny dveře v jednom okně.
 *
 * **Odvozený z naměřeného p95, ne vybraný:** 50 požadavků za 10 s je 5 za
 * sekundu, tedy 5 × 27,7 ms ≈ **138 ms práce na každou sekundu smyčky** — 14 %
 * jedné instance z jednoho návštěvníka. Shora to drží ruka porotce: člověk,
 * který píše věty a kliká, nevyrobí ani jeden požadavek za sekundu.
 */
export const RATE_WINDOW_MS = 10_000;
export const MAX_REQUESTS_PER_WINDOW = 50;

/**
 * Strop na klíč, který **není jeden člověk, ale celé IPv6 přidělení `/64`**
 * (P15 `T29-netfloor`).
 *
 * `trustedKeyFor()` sráží IPv6 na `/64`, protože jinak stačí vyměnit spodních
 * 64 bitů a mez neplatí vůbec. Seskupení je tím správně a nezrušíme ho —
 * špatně bylo jen to, že takový kbelík dostal **týž strop jako jeden člověk**,
 * takže sál, kancelář nebo VPN sdílely 50 požadavků za okno. Jedna síť se
 * SLAAC je jedna `/64`, takže je to celá místnost.
 *
 * **Proč zrovna dvojnásobek, a co to NENÍ.** Porotce, který píše věty a kliká,
 * nevyrobí ani jeden požadavek za sekundu (doktrína u `MAX_REQUESTS_PER_WINDOW`
 * o řádek výš), takže 100 za 10 s pokryje **deset lidí naráz v jedné síti** —
 * víc, než kolik jich na tuhle soutěž kdy sedne k jednomu stolu. Není to
 * změřené číslo a nesmí se tak citovat; je to nejmenší mez, která pojme
 * pojmenovaný scénář.
 *
 * ⚠ **Nejhorší případ instance se tím nehne, a to je celá bezpečnost téhle
 * změny.** `MAX_REQUESTS_PER_WINDOW_PER_INSTANCE` zůstává 400 a soudí se
 * první, takže žádná `/64` nedostane víc, než co instance unese. Zvedá se
 * jenom podíl, který si z toho jeden kbelík může vzít: ze 14 % na 28 % práce
 * jedné smyčky.
 *
 * ⚠ **Volající si tenhle kbelík vybrat neumí.** Předponu `net:` skládá jedině
 * `trustedKeyFor()`, tedy cesta, která běží až za `VERCEL === '1'` a čte konec
 * řetězu psaný platformou. Pád `callerKey()` píše `xff:` a doslovný řetězec
 * z hlavičky skončí pod `ip:`, takže volnější strop není dosažitelný zvenčí.
 *
 * ⚠ **Číslo přepočítá `G1`, ne další úvaha.** Dokud demo neběží na veřejné
 * adrese, není čím změřit, jestli porotci přijdou z jedné `/64` (sál) nebo ze
 * sedmi (každý doma). Až ta data budou, mění se tahle konstanta — seskupení
 * se neruší a `ip:` se nezvedá.
 */
export const MAX_REQUESTS_PER_WINDOW_PER_GROUP = 100;

/**
 * Druhý strop: celá instance, všechny dveře dohromady.
 *
 * 400 za 10 s je **40 požadavků za sekundu**, tedy pod naměřenou hranicí ~66/s,
 * kde se smyčka zastaví, a nad čímkoli, co vyrobí sál plný porotců. Je to mez
 * na **kapacitu**, ne na volajícího, a odmítá se pod ní jinou hláškou — protože
 * říct člověku, který poslal první požadavek, „posíláš jich moc" je lež.
 *
 * ⚠ Nad tímhle stropem platí totéž, co u prvních podob toho spodního: kdo ho
 * naplní, odmítne všechny. Je to vědomé a je to jediná možná odpověď — nad
 * 40 req/s už instance neobsluhuje nikoho tak jako tak, takže odmítnout je
 * levnější než odpovědět pozdě.
 */
export const MAX_REQUESTS_PER_WINDOW_PER_INSTANCE = 400;

/**
 * ## Troje čtecí dveře tady schválně NEJSOU — `T30-readdoorrate`, 5. 9. 2026
 *
 * `GET /api/worldstream/snapshots/[hash]`, `GET .../sessions/[sessionId]`
 * a `GET .../sessions/[sessionId]/events` **nemají strop frekvence žádný**.
 * Není to opomenutí a je to zapsané tady, protože seznam níž je jediné místo,
 * kde je ten rozdíl vidět.
 *
 * **Proč ne u `/events`.** Je to SSE proud a prohlížeč se na něm **běžně
 * reconnectuje sám** — `EventSource` navazuje po každém výpadku sítě a po
 * uspání záložky. Strop na požadavky za okno by tedy trestal poctivého
 * porotce za chování, které nenapsal. A proti páce, kvůli které by tam někdo
 * strop chtěl, **nezavře nic: je naměřené** (`T16-evictworld`), že útok drží
 * **otevřené proudy**, ne frekvenci požadavků — omezit počet POKUSŮ o
 * připojení nezmenší počet DRŽENÝCH spojení ani o jedno. Ta páka má vlastní
 * mez a je jí `MAX_STREAM_SUBSCRIBERS`, tedy strop odběratelů na relaci.
 *
 * **Proč ne u těch dvou čtecích.** Vydávají hotový stav z paměti, nesahají
 * na poskytovatele a neutrácejí. Jediné, co se přes ně dalo zesílit, byla
 * odchozí frekvence čtení ovládacího klíče, a **na Vercelu je to zavřené
 * jinde**: `CONTROL_CACHE_TTL_MS` (`1dfc7ec`) drží nanejvýš jeden let za
 * sekundu na instanci, ať se ptá kdokoli jak často chce.
 *
 * ⚠ **S ovládacím SOUBOREM to ale neplatí a naměřila to nezávislá revize.**
 * Všechny troje ty dveře volají `killState()`, a když je vyplněné
 * `WORLDSMITH_CONTROL_FILE` (typicky `next start` a demo z notebooku),
 * jde to na **nekešovaný synchronní `readFileSync`** — kešování tam odmítá
 * `control-file.ts` schválně, aby povel zabral hned. Naměřeno: 25 volání
 * `killState()` = **25 čtení souboru**. Smyčka na `snapshots/[hash]` je tam
 * tedy jedno blokující čtení disku na požadavek, na smyčce událostí a bez
 * jakékoli meze. **Na dnešním nasazení ta větev neběží** (Vercel žádný soubor
 * nemá a rozhoduje sdílená kniha), takže je to zapsaná cena režimu se
 * souborem, ne otevřená vada dema — ale kdo ten režim pustí veřejně, musí
 * buď dát dveřím slot, nebo čtení souboru pověsit do téhož okna.
 *
 * ⚠ **Zbytek po té opravě je flotilové číslo, a je změřený, ne odhadnutý.**
 * Okno je **na instanci**, kdežto kvóta obchodu je **na flotilu**: N souběžných
 * spojení Vercel rozprostře až na N instancí, takže na týž ovládací klíč jde
 * **~N příkazů za sekundu** plus jeden za každý studený start. Proti stavu
 * před oknem je to o dva řády lépe, **ale není to nula** — a je to jediné, co
 * k tomu číslu ještě jde udělat, protože strop frekvence na instanci flotilové
 * číslo z principu nezmenší.
 *
 * ⛔ **Co by to rozhodnutí otočilo:** kdyby některé z těch tří dveří začaly
 * utrácet nebo sahat na poskytovatele — a u režimu s ovládacím souborem
 * (odstavec výš) je to otočené už dnes. Do té doby se sem
 * **nedopisují** — a kdo je dopíše, musí současně ukázat e2e, že se reconnect
 * SSE o ten slot nezasekne. Pinuje to test `troje čtecí dveře nemají slot,
 * a je to rozhodnutí` v `rate-limit.test.ts`.
 */

/** Dveře, které se omezují. Ne řetězec: překlep by tiše založil další okno. */
export type RateLimitedDoor =
  | 'edit'
  | 'emit'
  | 'emit/stream'
  | 'generate'
  | 'sessions'
  | 'changes'
  | 'commit'
  | 'play'
  // Události smyčky PLAY (P27D T4) mají vlastní okno: statistika nesmí ubrat hráči kvótu na tvorbu her.
  | 'play/events'
  // Výzva Dare (P36B T5) navíc ke slotu `play`: jedna stojí řádově víc CPU (`MAX_DARE_REQUESTS_PER_WINDOW`).
  | 'play/dare'
  // Změna přezdívky (P44B T3) navíc ke slotu `play`: zápis do úložiště nemá ubírat z kvóty tvorby her.
  | 'play/me';

export interface RateVerdict {
  readonly allowed: boolean;
  /** Kolikátý požadavek to v tomhle okně je — na tom klíči, který rozhodl. */
  readonly count: number;
  readonly limit: number;
  /** Kdo mez naplnil: tenhle volající, nebo instance jako celek. */
  readonly scope: 'caller' | 'instance';
  /** Za kolik sekund se okno otočí. Jde do `retry-after`. */
  readonly retryAfterSeconds: number;
}

interface Window {
  count: number;
}

interface Windows {
  /** Začátek okna, zaokrouhlený na násobek `RATE_WINDOW_MS`. */
  startedAtMs: number;
  /** Klíč je `${door} ${caller}`. Vyprazdňuje se s každým novým oknem. */
  perCaller: Map<string, Window>;
  /** Všechny dveře a všichni volající dohromady – kromě událostí smyčky. */
  instanceCount: number;
  /**
   * Události smyčky PLAY mají vlastní strop instance (revize P27D T4): levné
   * beacony by jinak naplnily společný a zavřely tvorbu her. Týž strop drží
   * i počet jejich klíčů v mapě.
   */
  eventsCount: number;
  /** Výzvy Dare – vlastní strop instance (`MAX_DARE_REQUESTS_PER_WINDOW_PER_INSTANCE`). */
  dareCount: number;
  /** Začátky posledních `MAX_DARE_REPLAYS_PER_SECOND` přehrání výzev. S oknem se nevyprazdňuje – sekunda klouže přes jeho hranici. */
  dareStartsMs: number[];
}

/**
 * Strop výzev Dare (P36B T5, nález revize 2. 10. 2026, `VERDICT: blocking`).
 *
 * **Z naměřené ceny, ne vybraný:** výzva přehraje celý běh na serveru – revize
 * naměřila 139 ms (5 400 tiků, 32 živých změn po pěti nových tělech) a
 * 200–250 ms (svět s fyzikou Rapier, 5 400 tiků). Pod obecným stropem dveří
 * (50 za 10 s) by jeden volající vzal ~1,1 s práce za sekundu, tedy celou
 * smyčku. Strop instance 10 za 10 s drží nejhorší případ na čtvrtině smyčky,
 * ať střílí kolik chce volajících.
 *
 * **Volající 1 za 10 s (T5r3, revize T5r3-1 a T5r3-2):** s pěti stačily dvě
 * adresy a výzvy byly zavřené všem na instanci každé okno; se třemi čtyři –
 * prohraným během i opakovaným vítězným (opakování je 200, přehrání ale
 * stálo). Zaplnit instanci teď chce 10 adres IPv4. Náš klient posílá výzvu
 * jednou po každé výhře a výhra trvá sekundy hraní, takže jeden hráč na strop
 * nenarazí; porota za jednou IPv4 (NAT), když dva vyhrají v týchž 10 s, dá
 * druhému obyčejný odkaz s větou – přijatelná cena za výzvy, které nezavře
 * hrstka adres.
 */
export const MAX_DARE_REQUESTS_PER_WINDOW = 1;
export const MAX_DARE_REQUESTS_PER_WINDOW_PER_INSTANCE = 10;
/**
 * Skupina (sdílená /64) je víc lidí než jedna adresa, ale skupiny se strop
 * instance dělí stejně – pět jich ho zaplní (T5r3).
 */
export const MAX_DARE_REQUESTS_PER_WINDOW_PER_GROUP = 2;

/**
 * Přehrání výzev na instanci v jedné **klouzavé** sekundě (P36B T5r2, nález 2. revize T5).
 *
 * Pevné okno pustí na hranici dvou oken dvojnásobek stropu instance naráz
 * (10 v 9,9 s + 10 v 10,1 s), tedy 20 přehrání za sebou. Naměřeno 2. 10. 2026
 * (Node, pracovní stanice): přehrání světa s fyzikou Rapier na 5 400 tiků stojí
 * **115–215 ms** (7 pravidlových světů s 1 i 12 tělesy s fyzikou, nečinný běh),
 * takže 20 za sebou ≈ 4,3 s, kdy instance neobslouží nic jiného. Klouzavá
 * sekunda drží nejvýš 2 přehrání (≈ 430 ms) v každé sekundě, i přes hranici oken.
 * Časový rozpočet uvnitř přehrání to není schválně: replay cesta wall-clock
 * číst nesmí (`CLAUDE.md`, determinismus). Dva výherci v téže sekundě projdou
 * oba; třetí dostane 429 s `retry-after: 1` a sdílí obyčejný odkaz.
 */
export const MAX_DARE_REPLAYS_PER_SECOND = 2;
const DARE_SPACING_MS = 1000;

/**
 * Okna visí na `globalThis`, ne na modulu — týž naměřený důvod jako u procesové
 * účetní knihy v `src/server/spend-store.ts`: Next umí postavit víc grafů
 * modulů a modulová proměnná by pak počítala jen uvnitř jednoho z nich, tedy
 * pod mezí, která má chránit celou instanci.
 */
const WINDOWS_KEY = '__worldsmithRateWindows';

function windows(): Windows {
  const holder = globalThis as Record<string, unknown>;
  holder[WINDOWS_KEY] ??= { startedAtMs: 0, perCaller: new Map<string, Window>(), instanceCount: 0, eventsCount: 0, dareCount: 0, dareStartsMs: [] };
  return holder[WINDOWS_KEY] as Windows;
}

/**
 * Nejdelší textová podoba IPv6 adresy. Klíč se na ni ořezává, protože jde
 * o **hlavičku od volajícího**: bez ořezu by stačilo posílat kilobajtová
 * `x-forwarded-for` a mapa oken by byla úložiště zdarma.
 */
const MAX_CALLER_KEY_LENGTH = 45;

/**
 * Klíč, pod který spadne každý, koho **nejde rozeznat** — běh bez proxy, tedy
 * bez obou hlaviček. Je to konstanta, a ne řetězec na dvou místech, protože se
 * podle ní rozhoduje i strop souběžných čtení těla (`src/http/body.ts`):
 * v jednom kbelíku není koho od koho izolovat, takže tam per-caller mez neplatí
 * a nahrazuje ji mez na paměť. Přepsat sentinel jen tady by tu druhou mez tiše
 * utáhlo na čtyři pro celý proces.
 */
export const UNIDENTIFIED_CALLER = 'unknown';

/**
 * Předpona klíče odvozeného **z hlavičky**.
 *
 * ⚠ **Bez ní je sentinel dosažitelný a je to obejití, ne kosmetika** — nález
 * nezávislé revize 4. 9. 2026, ověřený spuštěním. Klíč se skládal z hodnoty,
 * kterou píše volající, takže `x-forwarded-for: unknown` vydalo přesně
 * `'unknown'` — a tím se dalo **dobrovolně vstoupit do kbelíku
 * nerozeznaných**, který má v `src/http/body.ts` osmkrát vyšší strop
 * souběžných čtení. Jeden klient by tak sám držel celý rozpočet paměti
 * instance a ostatní by dostávali 429.
 *
 * S předponou žádná hodnota hlavičky sentinel složit neumí: klíč z hlavičky
 * jím vždycky začíná, kdežto `UNIDENTIFIED_CALLER` nikdy.
 */
const HEADER_CALLER_PREFIX = 'ip:';

/**
 * Předpona klíče, který vznikl **seskupením** na IPv6 `/64`.
 *
 * ⚠ **Vlastní předpona, ne kosmetika — nález nezávislé revize 5. 9. 2026.**
 * Seskupený klíč je čitelný řetězec (`2001:db8:0:0::/64`) a nerozpoznaná
 * hodnota se do klíče propisuje, jak přišla. Se společnou předponou by tedy
 * stačilo poslat ten řetězec **doslova** a volající by se trefil do kbelíku
 * celého cizího přidělení, aniž zná jedinou adresu z něj. S vlastní předponou
 * to nejde: doslovný řetězec je nerozpoznaná hodnota, takže skončí pod
 * `ip:`, kdežto seskupení pod `net:`.
 *
 * ⚠ **Co tím zavřené NENÍ, napsané nahlas:** kdo umí do hlavičky platformy
 * psát, potřebuje po tomhle commitu znát jen `/64` oběti místo její přesné
 * adresy, a prefixy jsou veřejná směrovací informace. Je to **vědomá cena
 * seskupování** a bez ní by neexistoval jeho užitek. Že do té hlavičky psát
 * nejde, je zatím dokumentované chování platformy, ne naše měření — ověří ho
 * `G1`.
 */
const GROUPED_CALLER_PREFIX = 'net:';

/**
 * Je ten klíč **skupina**, tedy celé přidělení `/64`, a ne jeden člověk?
 *
 * Ptá se na to strop frekvence tady i čítač rozečtených těl v `src/http/body.ts`
 * (P15 `T29-netfloor`) — obojí klíčuje týmiž funkcemi, takže odpověď má být na
 * jednom místě. Předpona je privátní schválně: kdo potřebuje vědět, jestli je
 * klíč skupina, se ptá touhle funkcí a neskládá si řetězec sám.
 */
export function isGroupedCaller(caller: string): boolean {
  return caller.startsWith(GROUPED_CALLER_PREFIX);
}

/**
 * Předpona klíče, který složil **nedůvěryhodný** `callerKey()`.
 *
 * ⚠ **Vlastní předpona, a je to nález druhého kola nezávislé revize
 * 6. 9. 2026** (`T29-freeunbounded`, `VERDICT: routed`, kolize CONFIRMED
 * spuštěním). Od téhož dne klíčuje sedmero dveří i čítač rozečtených těl
 * `trustedCallerKey(request) ?? callerKey(request)`, takže **oba klíče žijí
 * v jedné mapě**. Se společnou předponou `ip:` by stačilo poslat požadavek
 * **bez** platformní hlavičky (nebo s prázdnou, kterou `lastEntry()` mění na
 * `null`) a s `x-forwarded-for: <oběť>, <útočník>`: pád složí `ip:<oběť>`,
 * tedy **přesně ten klíč**, pod kterým počestná oběť sedí — a útok, který ten
 * commit zavíral, se vrátí zadními dveřmi.
 *
 * Je to táž třída, kterou u seskupených klíčů zavřel `net:` (doktrína
 * o řádek výš), jen o patro níž. Dvě různá pravidla klíčování **nesmějí umět
 * složit tentýž řetězec**, jinak si volající vybírá, které z nich se na něj
 * použije.
 */
const UNTRUSTED_CALLER_PREFIX = 'xff:';

/**
 * Kdo požadavek poslal, podle hlaviček proxy.
 *
 * `x-forwarded-for` je **seznam** a první položka je klient; Vercel ji plní sám.
 * Bez obou hlaviček — lokální běh, `next start` bez proxy — spadnou všichni do
 * jednoho jména, což je tam správně: je to jeden stroj a jeden návštěvník.
 *
 * ⚠ **Podvrhnout to jde, a od 6. 9. 2026 je to důvod, proč je tahle funkce
 * jen PÁD.** Věta „podvržený klíč vrací útočníka nanejvýš tam, kde by byl bez
 * téhle meze" tu stála jako odůvodnění a je to lež o oběti: první položka
 * `x-forwarded-for` je vstup volajícího, takže se jím míří na **cizí** kbelík
 * (blokující nález nezávislé revize, naměřený). Volají to proto všechny dveře
 * jako `trustedCallerKey(request) ?? callerKey(request)` a tahle funkce se
 * použije jedině tam, kde důvěryhodný konec řetězu neexistuje — což je pořád
 * lepší než jediný sdílený čítač, a to je celý zbytek toho odůvodnění.
 * Rozpad je v tabulce v hlavičce souboru.
 */
export function callerKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const real = request.headers.get('x-real-ip');

  // **Sentinel patří jedině tomu, kdo neposlal ANI JEDNU hlavičku.** Ne tomu,
  // kdo poslal hlavičku prázdnou nebo nepoužitelnou — to je vstup od
  // volajícího, a rozhodovat podle něj o vstupu do volnějšího kbelíku znamená
  // nechat volajícího vybrat si vlastní strop.
  //
  // ⚠ **Kam tedy spadne, a proč se to neopravuje** (`T28-emptyxff`, nezávislá
  // revize 4. 9. 2026). Do kbelíku `ip:` bez adresy — jediného, sdíleného,
  // a od `2fad718` odmítajícího. Poctivý provoz do něj ale nevede ani jednou
  // cestou: na Vercelu `x-forwarded-for` vždycky přijde, a bez proxy
  // nepřijde žádná hlavička, takže klíč je sentinel. Obsadí ho jedině ten,
  // kdo si takovou hlavičku napsal sám — zamčnout ho znamená zamčnout sebe.
  // Drží to test `nepoužitelná hlavička dá kbelík bez adresy, do kterého se
  // dá jen vstoupit schválně`, a zavírá to až `T16-trustedkey`.
  if (forwarded === null && real === null) return UNIDENTIFIED_CALLER;

  // **První NEPRÁZDNÁ položka, ne první.** `" , 203.0.113.7"` má první položku
  // prázdnou, takže se dřív celá hlavička zahodila a spadlo se na sentinel —
  // právě tou cestou se dal strop obejít.
  const client = forwarded?.split(',').find((item) => item.trim() !== '')?.trim() ?? '';
  const value = client === '' ? (real?.trim() ?? '') : client;
  return `${UNTRUSTED_CALLER_PREFIX}${value.slice(0, MAX_CALLER_KEY_LENGTH)}`;
}

/**
 * Kdo požadavek poslal — z konce řetězu, kterému **volající nemůže vnutit
 * hodnotu**. `null`, když takový konec neexistuje (P15 `T16-trustedkey`).
 *
 * ## Proč druhá funkce, a ne oprava `callerKey()`
 *
 * Plán předepisoval opravit `callerKey()`. **Změřeno 4. 9. 2026, než se to
 * postavilo: jedna společná funkce položí 8 testů, a čtyři z nich pinují
 * opravu dřívějšího blokujícího nálezu** — `okno commitu patří JEDNOMU
 * volajícímu, ne dveřím` a tři sousední v `rate-limit.test.ts`. Důvod je
 * v tabulce v hlavičce souboru: strop frekvence s klíčem, který nejde
 * rozeznat, spadne na **strop na dveře**, a ten je měřeně horší než žádný
 * (5,1 req/s zavře dveře všem místo naměřených ~66/s jednomu). Nasazení za
 * prostou nginx bez vyplněné hloubky by tím o per-caller frekvenci přišlo.
 *
 * Rozdělují se proto podle toho, **co podvržený klíč způsobí**:
 *
 * | | `callerKey()` | `trustedCallerKey()` |
 * |---|---|---|
 * | čte | první položku XFF, tedy vstup volajícího | konec řetězu, který píše proxy |
 * | co s ním jde udělat | **vybrat si cizí kbelík** a odmítnout z něj oběť | nic |
 * | kde se dnes používá | **jen jako pád**, když důvěryhodný konec neexistuje | kvóta relací, volba oběti a klíč všech sedmi stropů frekvence |
 * | mimo Vercel | sdílený kbelík, mez platí dál | `null`, tedy pád na levý sloupec |
 *
 * ⚠ **Levý sloupec býval do 6. 9. 2026 klíčem stropu frekvence a byla to
 * měřená vada, ne volba** (`T29-freeunbounded`, blokující nález nezávislé
 * revize). „Podvržený klíč je levný a neškodný" platí o útočníkovi a neplatí
 * o oběti: první položka XFF je vstup volajícího, takže se jím míří na cizí
 * kbelík. Dnes je proto `callerKey()` **záchranná cesta**, ne volba —
 * a rozdíl mezi sloupci je pořád ten samý, jen se levý používá jinde.
 *
 *
 * ## Jediný zdroj: hlavička, kterou píše platforma
 *
 * `x-vercel-forwarded-for` píše vercelský edge, ne volající, a čte se **jen
 * když je `VERCEL` rovné `1`**, tedy hodnotě, kterou tam píše platforma.
 * Mimo Vercel ji nikdo nepřepisuje, takže tam je to obyčejná hlavička od
 * volajícího a nesmí rozhodovat o ničem. ⚠ **Rovnost, ne definovanost:**
 * `!== undefined` propustí i `VERCEL=0` a `VERCEL=`, tedy přesně to, co si
 * operátor napíše, když chce říct „tady Vercel NENÍ" — a zapnul by tím větev,
 * kterou chtěl vypnout. Kdo sem sáhne, ať to nezmírňuje zpátky.
 * ⚠ **Je to dokumentované chování platformy, ne naše měření** — na vlastním
 * nasazení to ověří teprve `G1`. Do té doby se nikde nesmí tvrdit, že je
 * míření na nasazeném demu zavřené.
 * ⚠ **`VERCEL` zháší týž přepínač jako `VERCEL_ENV`** (*Automatically expose
 * System Environment Variables*, doktrína u `isServerless()`). S vypnutým
 * přepínačem se kvóta **vypne** — zhorší se, ale nezamíří na cizího
 * volajícího, a to je ta správná strana.
 *
 * ## Proč tu žádný druhý zdroj není — a proč se sem nesmí vrátit
 *
 * Do 5. 9. 2026 tu stála druhá větev: `x-forwarded-for` a proměnná
 * `WORLDSMITH_TRUSTED_PROXY_HOPS` s hloubkou řetězu. **Zrušil ji druhý
 * blokující nález nezávislé revize, potvrzený spuštěním:** `HOPS=1`
 * a `x-forwarded-for: 198.51.100.4` bez jediného připsání vrátilo
 * `ip:198.51.100.4`, tedy klíč vybraný volajícím. Nastane to za nginx, která
 * píše `X-Real-IP` a XFF propouští — Next ji nepřepíše.
 *
 * **Ta větev byla neopravitelná, a jsou to dvě měření, ne názor:**
 *
 * 1. „Řetěz musí mít víc položek, než je hloubka" položí **právě ten poctivý
 *    případ.** Poctivý volající XFF neposílá vůbec, nginx připíše jedinou
 *    položku, řetěz má délku 1 — a při `HOPS=1` by vyšel `null`, tedy kvóta
 *    vypnutá všem. Rozdíl mezi „proxy připsala" a „volající si napsal" v tom
 *    řetězu prostě není.
 * 2. „Ověř, že peer socketu je nakonfigurovaná proxy" nejde postavit:
 *    `Request` v Next App Routeru adresu protistrany nenese.
 *
 * Zbylo jediné poctivé chování: mimo Vercel **žádný důvěryhodný konec řetězu
 * neexistuje**. `null` znamená „neumím rozeznat" a volající si z něj musí
 * udělat konzervativní závěr — `openSession()` z něj dělá vlastní kbelík,
 * tedy vypnutou kvótu, a říká to nahlas.
 *
 * ⛔ **Kdo sem chce vrátit režim za vlastní proxy, musí přinést zdroj, který
 * volající nepíše** — ne pozici v hlavičce, kterou píše. Pin je v
 * `rate-limit.test.ts`, test `mimo Vercel je klíč vždycky null`.
 */
export function trustedCallerKey(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const proxy=proxyOwnerIdentity(request,env);
  if(proxy.kind==='verified')return proxy.key;
  // Configured identity never falls back to caller-authored forwarding headers.
  // HTTP mutation doors reject this case before taking any rate/provider slot.
  if(proxy.kind!=='disabled')return 'proxy-owner:unverified';
  // ⚠ **Vlastní kopie `isServerless()` ze `spend-store.ts`, a rozhodlo o tom
  // měření, ne preference.** Import té funkce položí pinnutou vlastnost
  // `mezi čtením těla a odpovědí není jediný await` (`src/app/api/edit`):
  // do rozsahu dosažitelného z neplacených dveří by tím přibyl celý
  // `spend-store.ts` se čtyřmi `await`. Ta vlastnost je starší a dražší.
  // ⛔ **NESYNCHRONIZUJ ty dvě podoby.** Obě odpovídají na touž otázku
  // „běžíme na platformě?", ale mají **opačnou bezpečnou stranu**: tady je
  // `true` to nebezpečné (zapne důvěru v hlavičku), kdežto u `isServerless()`
  // je `true` to bezpečné (zavře placenou cestu). Proto je tady rovnost
  // na `'1'` a tam `!== undefined` — a naměřeno je i to, co stojí jejich
  // srovnání: mutace `isServerless()` na `=== '1'` položí 2 testy.
  // Kdo sahá na jednu, ať si přečte doktrínu u obou; kdo je slaďuje, otevře
  // jednu z těch dvou stran. Ta druhá doktrína bydlí u `isServerless()`.
  // ⚠ **Rovnost, ne pouhá definovanost — nález nezávislé revize 5. 9. 2026.**
  // `env.VERCEL !== undefined` je fail-**open** na každé hodnotě: operátor,
  // který si mimo Vercel napíše `VERCEL=0` (nebo `VERCEL=false`, nebo prázdno)
  // ve smyslu „tady Vercel není", tím tuhle větev naopak ZAPNE a klíč kvóty si
  // pak volající napíše sám. Naměřeno: `{VERCEL:'0'}` +
  // `x-vercel-forwarded-for: 203.0.113.9` → `ip:203.0.113.9`.
  // Platforma tu proměnnou nastavuje na `1`; cokoli jiného je proto neznámo
  // a padá na `null`, tedy vypnutá kvóta — horší mez, ale míří na nikoho.
  if (env.VERCEL !== '1') return null;

  const platform = lastEntry(request.headers.get('x-vercel-forwarded-for'));
  return platform === null ? null : trustedKeyFor(platform);
}

/**
 * Adresa svedená na tvar, pod kterým je **jeden volající jeden klíč**
 * (P15 `T16-addrshape`).
 *
 * ## Proč to nestačí jen ořezat na délku
 *
 * Do 5. 9. 2026 se hodnota z důvěryhodného konce jen usekla na
 * `MAX_CALLER_KEY_LENGTH`. **Naměřeno nezávislou revizí:** `[2001:db8::1]:51234`
 * prošlo celé, tedy i s portem. Za proxy, která do řetězu píše `ip:port`
 * (Azure App Service, Front Door), má pak **každý požadavek jiný klíč**, takže
 * `MAX_SESSIONS_PER_CALLER` nezakousne nikdy a všechny kbelíky zůstanou po
 * jednom. Přetečení registru pak nerozhoduje podle kbelíků, ale podle stání —
 * a nejdéle stojící sledovaná relace je porotcova. **Týž efekt na Vercelu
 * z jediné IPv6 `/64`:** 64 adres nestojí nic, protože jedno přidělení `/64`
 * jich dává 2^64.
 *
 * Sráží se proto čtyři věci, každá jinou třídu:
 *
 * | Vstup | Klíč | Co to zavírá |
 * |---|---|---|
 * | `198.51.100.4:51234` | `ip:198.51.100.4` | port jako zdroj entropie |
 * | `[2001:db8::1]:51234` | `net:2001:db8:0:0::/64` | port i hostitel uvnitř přidělení |
 * | `2001:DB8::1` | `net:2001:db8:0:0::/64` | velikost písmen |
 * | `2001:db8::1%eth0` | `net:2001:db8:0:0::/64` | zone id, tedy jméno rozhraní u odesílatele |
 *
 * ⚠ **Co se ZÁMĚRNĚ neseskupuje: IPv4, a to v obou zápisech.** Sráží se jen
 * IPv6 prefix, protože jedno IPv6 přidělení je jeden odběratel, kdežto
 * sousední IPv4 adresy jsou cizí lidé. Propadá proto beze změny jak
 * `::ffff:203.0.113.9`, tak **totéž zapsané šestnáctkově**
 * (`::ffff:cb00:7109`) — druhý zápis sem doplnil nález nezávislé revize
 * 5. 9. 2026, protože přes soud na hexadecimální skupinu prošel a seskupoval
 * se do `0:0:0:0::/64` společně s `::1` a `::`. Slít všechny IPv4 volající do
 * jednoho kbelíku znamená vyrobit tu odepření služby, kterou má kvóta zavírat.
 *
 * ⚠ **Co se sem nesmí přidat: soud „tohle není adresa, tak ji zahoď".**
 * Nerozpoznaná hodnota se ořezává jako dřív a klíč z ní vznikne. Vrátit
 * `null` znamená kvótu vypnout, a to je přesně ta strana, na kterou volající
 * chce hodnotu dotlačit. Drží to test `nerozpoznaná hodnota klíč nezruší`.
 *
 * ⚠ **Netýká se `callerKey()`, a to je pořád pravda — ale ta věta znamená od
 * 6. 9. 2026 něco jiného.** `callerKey()` je dnes už jen **pád**, když
 * důvěryhodný konec řetězu neexistuje; srážet tam tvar adresy nic nezavírá,
 * protože útočník tam stejně píše, co chce.
 *
 * ⚠ **Co se tím dnem naopak ZMĚNILO, a je to naměřená vedlejší škoda**
 * (`T29-freeunbounded`, druhé kolo nezávislé revize): tohle seskupení řídí
 * nově i **strop frekvence sedmera dveří** a **čítač rozečtených těl**
 * (`src/http/body.ts`), ne jen kvótu relací. Na platformě má proto celá
 * `/64` — tedy typicky celá kancelář, sál nebo VPN, protože SLAAC dává jedné
 * síti jednu `/64` — dohromady 50 požadavků za 10 s přes všechny dveře a
 * **čtyři** souběžně čtená těla. Do 6. 9. měl na Vercelu každý porotce vlastní
 * kbelík.
 *
 * **Vědomá cena, ne přehlédnutí:** bez seskupení stačí u IPv6 vyměnit spodních
 * 64 bitů a mez neplatí vůbec. Sál plný porotců je ale reálný scénář téhle
 * soutěže, takže **jestli se to na `G1` projeví, zvedá se mez pro klíče `net:`**
 * (dnes tam žádné zvláštní číslo není), ne že se seskupení zruší.
 */
function trustedKeyFor(platform: string): string {
  const address = normalizeAddress(platform);
  const grouped = ipv6Prefix(address);
  return grouped === null
    ? `${HEADER_CALLER_PREFIX}${address}`
    : `${GROUPED_CALLER_PREFIX}${grouped}`;
}

function normalizeAddress(value: string): string {
  // `[v6]:port` i holé `[v6]` — hranaté závorky píše každá proxy, která port
  // připisuje, protože jinak by dvojtečka portu splynula s adresou.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  let address = bracketed?.[1] ?? value;

  // `v4:port`. Podmínka „přesně jedna dvojtečka" je nosná: IPv6 jich má
  // vždycky víc, takže se tímhle nedá uříznout skupina adresy.
  if (bracketed === null && /^[^:]+:\d+$/.test(address)) {
    address = address.slice(0, address.lastIndexOf(':'));
  }

  // **Zone id (`%eth0`, `%12`) pryč, a je to zavření celé třídy, ne detail.**
  // Je to jméno rozhraní u ODESÍLATELE, takže o tom, kdo volá, neříká nic —
  // ale seskupení maří úplně. Naměřeno nezávislou revizí: tisíc požadavků
  // jako `2001:db8::1%<n>` dalo **tisíc klíčů**, tedy přesně tu neomezenou
  // zásobu klíčů, kterou tahle funkce zavírá.
  //
  // ⚠ **Malá písmena se dělají na VŠECH cestách, ne jen na té rozpoznané.**
  // Dokud se sráželo jen uvnitř `ipv6Prefix()`, dávalo `HOST:80` a `host:80`
  // dva klíče. Velikost písmen v adrese nenese identitu na žádné cestě.
  //
  // ⚠ **Ořez na délku tady NENÍ, a je to změřené, ne opomenuté.** `lastEntry()`
  // useká hodnotu na `MAX_CALLER_KEY_LENGTH` dřív, než se sem dostane,
  // a seskupení řetězec jedině zkracuje (nejdelší výstup má 24 znaků).
  // Druhý ořez tu byl mrtvý kód: revize ho smazala a sada zůstala celá zelená.
  return address.split('%')[0]!.toLowerCase();
}

/**
 * Prvních 64 bitů IPv6 adresy jako klíč. `null`, když to IPv6 adresa není —
 * a to je většina vstupů, protože sem chodí i IPv4 a i vyložený nesmysl.
 */
const HEX_GROUP = /^[0-9a-f]{1,4}$/;

function ipv6Prefix(value: string): string | null {
  if (!value.includes(':')) return null;

  const halves = value.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  // `::` musí zastupovat aspoň jednu nulovou skupinu, jinak je to jiný zápis.
  if (halves.length === 2 && head.length + tail.length > 7) return null;

  const groups =
    halves.length === 2
      ? [...head, ...(new Array(8 - head.length - tail.length).fill('0') as string[]), ...tail]
      : head;
  if (groups.length !== 8) return null;
  // Skupina, která není hexadecimální, znamená „tohle není IPv6" — sem spadá
  // IPv4 zapsaná tečkami jako `::ffff:203.0.113.9`.
  if (!groups.every((group) => HEX_GROUP.test(group))) return null;

  // **A sem ta táž adresa zapsaná šestnáctkově, `::ffff:cb00:7109`** — nález
  // nezávislé revize 5. 9. 2026, potvrzený spuštěním. Přes tečkovaný zápis
  // neprojde, ale hexadecimální je platná skupina, takže se seskupoval
  // a padal do `0:0:0:0::/64` **společně s `::1`, `::` a každou další nízkou
  // adresou** — tedy přesně to slití všech IPv4 volajících do jednoho kbelíku,
  // o kterém doktrína výš tvrdí, že nenastane. Obě podoby `::ffff:0:0/96`
  // proto propadají na doslovnou hodnotu.
  const mappedV4 =
    groups.slice(0, 5).every((group) => Number.parseInt(group, 16) === 0) &&
    Number.parseInt(groups[5]!, 16) === 0xffff;
  if (mappedV4) return null;

  const prefix = groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':');
  return `${prefix}::/64`;
}

/**
 * Poslední položka řetězu, ořezaná. `null`, když tam žádná není.
 *
 * Nezahazují se prázdné položky, a je to podstatné: zahodit je znamená
 * přečíslovat seznam podle toho, co do něj napsal volající. Prázdná položka
 * na konci je proto `null` — nevíme, ne „vezmi vedlejší".
 */
function lastEntry(header: string | null): string | null {
  if (header === null) return null;
  const entries = header.split(',');
  const value = entries[entries.length - 1]?.trim() ?? '';
  return value === '' ? null : value.slice(0, MAX_CALLER_KEY_LENGTH);
}

/**
 * Kód, pod kterým odmítnutí odchází — **ven i do operátorského logu**.
 *
 * Bydlí to tady, protože to jsou dvě hlášení o téže věci a rozejít se smějí
 * jedině tiše: `logRateLimited` klíčuje `(dveře, kód)`, takže napevno napsané
 * „TOO_MANY_REQUESTS" u naplněného stropu **instance** dá operátorovi tvrzení
 * o volajícím, které odpověď o řádek níž zrovna opravila — a navíc oba případy
 * slije do jednoho promlčovacího okna.
 */
export function rateLimitCode(verdict: RateVerdict): 'SERVER_AT_CAPACITY' | 'TOO_MANY_REQUESTS' {
  return verdict.scope === 'instance' ? 'SERVER_AT_CAPACITY' : 'TOO_MANY_REQUESTS';
}

/**
 * Vzít jeden požadavek na těch dveřích a říct, jestli se smí obsloužit.
 *
 * **Počítá se i odmítnutý požadavek** — schválně. Kdyby se počítaly jen
 * propuštěné, útočník držící mez na maximu by dostal na začátku každého okna
 * čerstvý strop a odmítnutí by ho nic nestálo; takhle okno doběhne do konce.
 *
 * **Strop instance se soudí PRVNÍ, a je to mez na paměť téhle mapy.** Pod ním
 * nemůže v jednom okně vzniknout víc než `MAX_REQUESTS_PER_WINDOW_PER_INSTANCE`
 * klíčů, takže podvrhování adres mapu nenafoukne. Kdyby se soudil až druhý,
 * byla by mapa přesně tím úložištěm zdarma, kterému se ořezem klíče bráníme.
 *
 * `nowMs` se předává schválně, ne čte uvnitř: bez toho se mez nedá otestovat
 * jinak než čekáním deseti sekund, a test, který trvá deset sekund, se přestane
 * pouštět. Wall-clock je tu legální — do hashovaného stavu z těchhle dveří
 * nevstupuje nic (`CLAUDE.md`, zákaz platí na replay cestě).
 */
export function takeRateSlot(
  door: RateLimitedDoor,
  caller: string,
  nowMs: number = Date.now(),
): RateVerdict {
  const open = windows();
  const startedAtMs = Math.floor(nowMs / RATE_WINDOW_MS) * RATE_WINDOW_MS;

  if (open.startedAtMs !== startedAtMs) {
    // Nové okno zahodí klíče toho starého naráz. Prořezávat po jednom není
    // potřeba a stálo by průchod mapou na každý požadavek.
    open.startedAtMs = startedAtMs;
    open.perCaller.clear();
    open.instanceCount = 0;
    open.eventsCount = 0;
    open.dareCount = 0;
  }

  const retryAfterSeconds = Math.ceil((startedAtMs + RATE_WINDOW_MS - nowMs) / 1000);
  const events = door === 'play/events';
  const dare = door === 'play/dare';
  const key = `${door} ${caller}`;
  // Výzva soudí volajícího PRVNÍ: odmítnutý volající jinak dál ubírá strop
  // instance a jedna adresa výzvy zavře všem (nález 3. revize T5). Mapu to
  // nenafoukne – klíčů výzev je nanejvýš tolik, kolik pustí `admit()` (400).
  if (dare) {
    const own = open.perCaller.get(key)?.count ?? 0;
    const ownLimit = isGroupedCaller(caller) ? MAX_DARE_REQUESTS_PER_WINDOW_PER_GROUP : MAX_DARE_REQUESTS_PER_WINDOW;
    if (own >= ownLimit) return { allowed: false, count: own + 1, limit: ownLimit, scope: 'caller', retryAfterSeconds };
    // Klouzavá sekunda instance (T5r2). Odmítnutí tu strop okna neubírá: jinak by jeden
    // volající za sekundu naplnil `dareCount` odmítnutými a zavřel výzvy všem do konce okna.
    // Začátek „v budoucnu“ (hodiny couvly) se nepočítá, jinak by výzvy stály, než je doženou.
    const recent = open.dareStartsMs.filter((at) => at <= nowMs && nowMs - at < DARE_SPACING_MS).length;
    // Plné i okno instance → čekat na jeho konec, ne na sekundu (revize T5r3-1, LOW).
    if (recent >= MAX_DARE_REPLAYS_PER_SECOND)
      return {
        allowed: false,
        count: recent + 1,
        limit: MAX_DARE_REPLAYS_PER_SECOND,
        scope: 'instance',
        retryAfterSeconds: open.dareCount >= MAX_DARE_REQUESTS_PER_WINDOW_PER_INSTANCE ? retryAfterSeconds : 1,
      };
  }
  const instanceCount = events ? (open.eventsCount += 1) : dare ? (open.dareCount += 1) : (open.instanceCount += 1);
  const instanceLimit = dare ? MAX_DARE_REQUESTS_PER_WINDOW_PER_INSTANCE : MAX_REQUESTS_PER_WINDOW_PER_INSTANCE;
  if (instanceCount > instanceLimit)
    return {
      allowed: false,
      count: instanceCount,
      limit: instanceLimit,
      scope: 'instance',
      retryAfterSeconds,
    };
  // Sem výzva dojde jen pod vlastním stropem (soudil se výš), takže je propuštěná.
  if (dare) open.dareStartsMs = [...open.dareStartsMs, nowMs].slice(-MAX_DARE_REPLAYS_PER_SECOND);

  const window = open.perCaller.get(key) ?? { count: 0 };
  window.count += 1;
  open.perCaller.set(key, window);

  // **Skupina má vlastní strop, protože to není jeden člověk** (`T29-netfloor`).
  // Odůvodnění čísla i to, proč si tenhle kbelík volající nevybere, je
  // u `MAX_REQUESTS_PER_WINDOW_PER_GROUP`.
  const perCaller = dare ? MAX_DARE_REQUESTS_PER_WINDOW : MAX_REQUESTS_PER_WINDOW;
  const limit = isGroupedCaller(caller) ? (dare ? MAX_DARE_REQUESTS_PER_WINDOW_PER_GROUP : MAX_REQUESTS_PER_WINDOW_PER_GROUP) : perCaller;

  return {
    allowed: window.count <= limit,
    count: window.count,
    limit,
    scope: 'caller',
    // Zbytek okna **nahoru** na celé sekundy. Nula z toho vyjít nemůže a
    // nehlídá se: `startedAtMs` je zaokrouhlené dolů, takže zbytek je vždycky
    // větší než nula a horní zaokrouhlení z něj udělá aspoň jedničku.
    retryAfterSeconds,
  };
}

/**
 * Hotová odpověď na překročený strop.
 *
 * **Dvě situace, dvě věty, a je to oprava nálezu revize.** Pod stropem
 * instance neudělal volající nic špatně — říct mu „posíláš moc požadavků" je
 * táž lež, jakou `bodyRefusal()` přestal říkat o pomalém těle. **Číslo stropu
 * ven nejde**: je to přesně ten údaj, ze kterého se počítá nejlevnější způsob,
 * jak dveře držet zavřené.
 */
export function rateLimitedResponse(requestId: string, verdict: RateVerdict): Response {
  const code = rateLimitCode(verdict);
  const message =
    code === 'SERVER_AT_CAPACITY'
      ? 'this instance is at capacity right now'
      : 'too many requests from this client';

  return Response.json(
    { requestId, error: { code, message } },
    { status: 429, headers: { 'retry-after': String(verdict.retryAfterSeconds) } },
  );
}

/**
 * Výzva, jejíž přehrání nevyhrálo, stojí volajícího zbytek okna výzev (P36B T5r3r1, revize T5r3-1).
 * Klient výzvu posílá jen po výhře (`publishDare`), takže prohraný běh posílá cizí klient. Adresa
 * se stropem 1 má okno utracené tak jako tak; platí to pro skupinu /64 (strop 2).
 * Klíč volajícího už v okně je (slot vzal před přehráním), takže mapa nenaroste; po otočení okna
 * klíč zmizel a není co utratit.
 */
export function spendDareWindow(caller: string): void {
  // Týž klíč jako v `takeRateSlot`: dveře a volající oddělené znakem NUL.
  const window = windows().perCaller.get(`play/dare\u0000${caller}`);
  if (window !== undefined) window.count = isGroupedCaller(caller) ? MAX_DARE_REQUESTS_PER_WINDOW_PER_GROUP : MAX_DARE_REQUESTS_PER_WINDOW;
}

/** Jen pro testy: okna jsou proces-globální jako čítač souběžných generací. */
export function resetRateWindows(): void {
  const open = windows();
  open.startedAtMs = 0;
  open.perCaller.clear();
  open.instanceCount = 0;
  open.eventsCount = 0;
  open.dareCount = 0;
  open.dareStartsMs = [];
}
