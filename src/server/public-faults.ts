/**
 * **Jeden veřejný text na jednu vadu zmrazeného korpusu, pro všechny čtyři dveře.**
 *
 * `readFrozen()` (`src/model/client.ts`) skládá detail jako
 * „<soubor> is not readable under <FROZEN_DIR>", a `FROZEN_DIR` je
 * `join(process.cwd(), 'evals', 'frozen')` — **absolutní cesta na disku serveru
 * včetně jména účtu**. Do 31. 8. 2026 ji `/api/generate` posílal neověřenému
 * volajícímu; oprava tam ale zavřela jen jedny dveře ze čtyř. `/api/emit`,
 * `/api/emit/stream` a `/api/edit` vracely `failure.detail` doslova dál.
 *
 * Spouštěč je pravděpodobný, ne teoretický: serverless balíček nemusí
 * `readFileSync(process.cwd() + …)` dohledat vůbec, takže na nasazeném demu
 * odpoví 503 s `/var/task/evals/frozen/…`, a na VPS i se jménem účtu.
 *
 * ## Proč modul, a ne čtyři kopie
 *
 * Protože se to jednou už rozešlo. Čtvrté dveře se opravily a tři zůstaly
 * otevřené právě proto, že každá routa měla svůj vlastní pohled na to, co je
 * „veřejný text". Jeden `Record<ClientReason, string>` navíc dělá z **úplnosti**
 * věc překladače: nový `ClientReason` bez veřejného textu neprojde přes `tsc`
 * v žádné z těch čtyř rout naráz.
 *
 * ## Doktrína, kterou ten modul nese celou
 *
 * Ořezat ven **nestačí** — diagnostika nesmí zmizet, jen se přesunout. Proto sem
 * patří i `logForOperator()`: kdo použije veřejný text, má vedle sebe kanál,
 * kterým pošle ten pravý operátorovi. Bez toho by se jedna vada vyměnila za
 * druhou a rozbitý korpus by nebylo jak najít.
 */

import type { ClientReason } from '../model/client';

/**
 * Co se o vadě zmrazeného korpusu řekne **ven**.
 *
 * Texty jsou anglicky, protože je čte porotce (`CLAUDE.md`, Konvence), a jsou
 * úmyslně bez čísel, cest a hashů: jmenují **co se stalo**, ne kde a s jakou
 * hodnotou. To druhé je v operátorově logu.
 */
export const PUBLIC_CORPUS_FAULT: Record<ClientReason, string> = {
  MANIFEST_MISMATCH: 'the frozen corpus does not match its manifest; no answers will be served',
  CORPUS_UNREADABLE: 'the frozen corpus cannot be read on this server',
  NO_FROZEN_RESPONSE: 'the frozen corpus has no answer for that prompt',
  RESPONSE_TAMPERED: 'a frozen answer failed its own checksum; it will not be served',
  BASE_WORLD_MISMATCH: 'the edit names a different base world than the one that arrived',
  BASE_WORLD_MISSING: 'the frozen corpus is missing the base world that edit names',
};

/**
 * `user:heslo@host` → `<credentials>@host`, kdekoli v textu.
 *
 * Vzor je úmyslně širší než URL: hlášky `fetch`e adresu přeformátovávají a
 * dvakrát ji nesou jinak („Failed to parse URL from …", „…URL that includes
 * credentials: …"). Hledá se proto **dvojice před zavináčem**, ne platná URL.
 */
export function withoutCredentials(text: string): string {
  return text.replace(/(^|[\s(/@])[^\s/@:]+:[^\s/@]*@/g, '$1<credentials>@');
}

/**
 * Diagnostika, která nesmí ven — ale nesmí ani zmizet.
 *
 * Bez tohohle by ořezání veřejných textů vyměnilo jednu vadu za druhou:
 * operátor s rozbitým korpusem by dostal „the frozen corpus cannot be read"
 * a **žádný způsob, jak zjistit který soubor a proč**. `withRequest()` nese jen
 * korelační ID a nic neloguje, takže pod tím doopravdy žádný kanál není.
 * Tenhle je: stderr procesu vidí ten, kdo server provozuje.
 *
 * ⚠ **„Operátorův stderr" není tak úzký kanál, jak to zní.** Na cílové
 * platformě jdou runtime logy každému členovi projektu a do všech nastavených
 * odtoků, takže adresa s přihlašovacími údaji by se v nich objevila čitelně.
 * Heslo se proto **před zápisem odstraní**; zbytek adresy zůstává, protože bez
 * něj ten řádek nediagnostikuje nic.
 *
 * `route` je jméno dveří, ne cesta — v logu se podle něj pozná, které z těch
 * čtyř mluví.
 */
export function logForOperator(
  route: string,
  requestId: string,
  code: string,
  detail: string,
): void {
  console.error(`[${route}] ${requestId} ${code}: ${withoutCredentials(detail)}`);
}

/**
 * **Okno, ve kterém se výskyty počítají.** Patnáct minut je **volba uvnitř
 * rozpětí**, ne odvozená hodnota — a stojí to tu takhle schválně: předstíraná
 * derivace je horší než přiznaná volba, a první verze tohohle komentáře si
 * odporovala v sousedních větách (nezávislá revize 1. 9. 2026).
 *
 * - **Zdola to drží délka jednoho volání nahoru.** Volání modelu běží ve
 *   výchozím nastavení až 120 s (`DEFAULT_TIMEOUT_MS`, `src/server/upstream.ts:106`)
 *   a `WORLDSMITH_UPSTREAM_TIMEOUT_MS` to smí zvednout (`upstream.ts:231`). Okno
 *   kratší než několik takových volání by jeden výpadek nahoře vyhlašovalo
 *   pořád dokola jako novou poruchu. 900 s je 7,5násobek **výchozí** hodnoty,
 *   ne té nastavené: **kdo ten timeout zvedne nad ~450 s, má zvednout i tohle
 *   okno.**
 * - **Shora to drží doba, po kterou smí stát koupené ticho.** Okno je zároveň
 *   nejdelší pauza, po kterou umlčený klíč mlčí, takže delší okno je levnější
 *   útok.
 * - **Mezi tím** dává 900 s `3600/W` = **čtyři** zaručené řádky za hodinu a klíč
 *   a je to perioda, kterou operátor přečte bez počítání.
 *
 * Kratší okno není bezpečnější, jen upovídanější — `W` = 120 s dá 30 řádků za
 * hodinu a klíč, což pořád není záplava. Rozpětí je široké a tohle je bod v něm.
 *
 * Paměť to nezvětšuje o řád: klíč je dvojice (dveře, kód), tedy uzavřená
 * množina dvanácti hodnot, a k počítadlu přibylo `windowStart` a nejvýš
 * `MAX_DETAILS_PER_WINDOW` řetězců.
 */
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * **Jak dlouho smí mlčet vada, která se opravila a vrátila.** Hodina, a je
 * odvozená **z okna nad ní**, ne vybraná zvlášť — jinak by tenhle soubor nesl
 * dva volné parametry místo jednoho.
 *
 * Čtyřnásobek proto, že ty dva kanály hlídají věci s jinou rychlostí. Vady,
 * které omezuje `logRateLimited`, jsou stav **spojení** a mění se po minutách.
 * Lepivá vada je stav **korpusu**: mění se jen tehdy, když někdo nasadí nebo
 * sáhne na soubor, takže častější připomínka není informace, ale šum. Hodina
 * Ceny toho poměru jsou dvě, ne jedna:
 *
 * 1. **návrat téže vady zůstane nepovšimnutý nejvýš hodinu**;
 * 2. **trvale rozbité dveře napíšou 24 řádků za den místo jednoho** — do
 *    1. 9. 2026 to byl jeden řádek za proces. Nasazení bez `evals/frozen/**`
 *    má dvanáct dosažitelných klíčů, tedy 288 řádků za den proti dvanácti.
 *    Je to zanedbatelné množstvím a **není to zanedbatelné jako tvrzení**,
 *    protože tenhle soubor má za sebou čtyři kola komentářů, které přežily kód.
 */
export const STICKY_WINDOW_MS = 4 * RATE_LIMIT_WINDOW_MS;

/** Kdy tenhle proces vadu naposled zapsal. Klíčem je dvojice (dveře, `detail`). */
const STICKY_LOGGED = new Map<string, number>();

/**
 * **Jeden řádek za vadu, ne za požadavek** — pro stavy, které jsou *lepivé*.
 *
 * Lepivá vada je taková, u které první řádek a tisící říkají doslova totéž:
 * rozbitý zmrazený záznam je rozbitý napořád, nečitelný korpus je nečitelný
 * napořád. Řádek na požadavek by z toho udělal log, který si kdokoli natáhne
 * donekonečna — a žádné z těch čtyř dveří nechtějí přihlášení.
 *
 * **Klíčem je `detail`, ne kód.** `detail` jmenuje konkrétní záznam, takže tři
 * rozbité záznamy dají tři řádky, ale tisíc požadavků na jeden dá pořád jeden.
 * Počet je tím shora omezený velikostí korpusu — commitnutého artefaktu, který
 * volající nafouknout nemůže. Kdyby se klíčovalo kódem, druhý a třetí rozbitý
 * záznam by mlčely napořád; `public-faults.test.ts` to drží mutací.
 *
 * **Do `detail` proto nesmí nic od volajícího.** Kdyby tam tekl prompt nebo
 * cokoli jiného z těla požadavku, byla by tahle množina neomezený růst paměti
 * v dlouho běžícím procesu — a bound by se vyměnil za horší vadu. Dnes je
 * každá hodnota, která sem doteče, odvozená ze serveru: hlášky `readFrozen()`,
 * `promptId` vzatý ze shody v korpusu, a konstanty.
 *
 * ## Proč okno, a ne „jednou za proces" — nález nezávislé revize 1. 9. 2026
 *
 * „Jednou za proces" mlčí i tehdy, když se vada **opraví a vrátí**. Operátor
 * dostane řádek, rozbitý zmrazený záznam spraví, ten se v témž procesu rozejde
 * znovu se stejným `detail`em — a nedozví se o tom nic. Je to tatáž třída vady,
 * kvůli které se den předtím `logOncePerProcess()` měnilo na `logRateLimited()`
 * u `BODY_UNREADABLE`, jen o dveře vedle: tam byl spouštěč volající, tady je
 * provozní.
 *
 * Zapisuje se proto **nejvýš jednou za `STICKY_WINDOW_MS` na klíč**, a to okno
 * se kotví na **posledním zápisu**, ne na posledním výskytu. Kdyby ho posouval
 * každý potlačený požadavek, trvalá porucha pod trvalým provozem by se už
 * nepřipomněla nikdy — a to je přesně ta vada, jen naruby.
 *
 * ⚠ **Ten strop je na jednu instanci, ne na nasazení** — táž výhrada jako
 * u `logRateLimited()` níž. Trvale to zavře až sdílený stav (T29). **Čekat na
 * něj se ale nemá:** T29 řeší sdílení stavu mezi instancemi a visí na volbě
 * hostingu, která ještě nepadla, kdežto tahle vada je špatně **uvnitř jednoho
 * procesu**. Sdílený store by ji jen rozšířil na všechny.
 *
 * Bydlí to tady, a ne v jedné z těch rout, protože **stejná mez má platit na
 * všech čtverých dveřích naráz**. Do 1. 9. 2026 byla soukromá v `/api/generate`
 * a `/api/emit`, `/api/emit/stream` i `/api/edit` psaly řádek na požadavek —
 * přesně ta třída vady, kvůli které je v tomhle souboru i `PUBLIC_CORPUS_FAULT`.
 */
export function logStickyFault(
  route: string,
  requestId: string,
  code: string,
  detail: string,
): void {
  const key = `${route} ${detail}`;
  const now = Date.now();
  const written = STICKY_LOGGED.get(key);
  if (written !== undefined && now - written < STICKY_WINDOW_MS) return;
  STICKY_LOGGED.set(key, now);
  logForOperator(route, requestId, code, detail);
}

/**
 * **Kolik různých příčin smí jedno okno pojmenovat nad rámec milníků.**
 *
 * Milníky počítají výskyty klíče `(dveře, kód)`, jenže `detail` u téhož kódu
 * jmenuje **příčinu**: „aborted" od volajícího, který zavřel spojení, a
 * „Premature close" od rozbité proxy jsou dva různé světy pod jedním
 * `BODY_UNREADABLE`. Bez tohohle pravidla umlčí první příčina druhou — přesně
 * to nezávislá revize 1. 9. 2026 změřila jako běh, ve kterém operátor dostal
 * 96 řádků útočníka a nula řádků o poruše, která mezitím padla 28 768krát.
 *
 * **Osm** proto, že je to týž řád jako milníková řada (nejvýš sedm řádků na
 * okno při milionu výskytů), takže rozpočet řádků na okno zůstává ve stejném
 * řádu, a přitom to s rezervou pokryje množinu hlášek, kterou runtime na
 * přerušeném čtení těla vůbec vyrábí.
 */
export const MAX_DETAILS_PER_WINDOW = 8;

/** Co tenhle proces viděl u dvojice (dveře, kód) v běžícím okně. */
interface KeyWindow {
  readonly windowStart: number;
  readonly occurrences: number;
  /** Příčiny, které tohle okno už pojmenovalo. Nejvýš `MAX_DETAILS_PER_WINDOW`. */
  readonly details: Set<string>;
}

const SEEN_PER_KEY = new Map<string, KeyWindow>();

/** 1, 10, 100, 1000 … — výskyty, na kterých se řádek vydá. */
function isMilestone(occurrence: number): boolean {
  return /^10*$/.test(String(occurrence));
}

/**
 * Totéž, ale **s omezenou rychlostí**: vydá se 1., 10., 100., 1000. … výskyt
 * dvojice (dveře, kód) **v běžícím okně**.
 *
 * Je to pro vady, které si volající umí vyrobit sám a kolikrát chce — typicky
 * přerušené spojení uprostřed těla. Žádná z těch rout nechce přihlášení, takže
 * řádek na požadavek znamená log, který kdokoli natáhne donekonečna; táž vada,
 * kvůli které `/api/generate` neloguje vady dotazu a odmítnutí stropem píše
 * jen jednou.
 *
 * Mlčet úplně by ale bylo taky špatně: „tělo se nedá přečíst" hromadně znamená
 * rozbitou proxy nebo kompresi před serverem, a to je jediné, co operátorovi
 * o téhle třídě stojí za vědění.
 *
 * ## Proč rychlost, a ne životnost — vada v původním nápadu, naměřená revizí
 *
 * Do 1. 9. 2026 se zapisoval **jen první výskyt za proces**, a to bylo špatně.
 * Precedens, ze kterého to vzniklo (lepivá vada korpusu), platí proto, že tam
 * první řádek a tisící říkají totéž. `BODY_UNREADABLE` je ale stav
 * **spojení**, ne serveru: jeden anonymní požadavek s přerušeným tělem hned po
 * nasazení zapsal klíč napořád, a když se ve dvanácté hodině rozbila komprese
 * nebo proxy před serverem, dostal operátor **nula řádků** — přesně ten signál,
 * o kterém tenhle komentář tvrdil, že je jediný, co za to stojí. Umlčet kanál
 * si tak mohl kdokoli, a mohl si to vybrat dopředu.
 *
 * Milníky po desítkách drží dávku: strop je logaritmus provozu (milion
 * požadavků v jednom okně = sedm řádků, `log10(N)+1`), takže natáhnout se log
 * nedá. Číslo
 * výskytu jde do textu, protože jinak vypadá desátý řádek jako první a záplavu
 * z něj nikdo nepozná.
 *
 * ## Proč okno, a ne počítadlo na celý proces — druhá vada téhož nápadu
 *
 * Milníky samy o sobě omezují **dávku**, ne kanál. Počítadlo, které se za celý
 * proces nikdy nezahodí, jde totiž **předplatit**: sto přerušených těl
 * (zadarmo, bez přihlášení) posune klíč `emit BODY_UNREADABLE` na stý výskyt
 * a skutečná rozbitá proxy pak vyrobí **nula řádků** dalších 899 selhání.
 * Umlčet si kanál mohl zase kdokoli, jen o patro výš než před `62eab7c` —
 * a předchozí verze tohohle komentáře přitom tvrdila opak („porucha se ozve
 * znovu, kdykoli se rozjede naostro").
 *
 * Počítá se proto **uvnitř okna**, které začíná prvním výskytem klíče a trvá
 * `RATE_LIMIT_WINDOW_MS`. První výskyt v každém dalším okně se vydá vždycky,
 * takže koupené ticho **vyprší**.
 *
 * **Okno se kotví na svém prvním výskytu, ne na posledním.** Zapomínání po
 * N minutách *ticha* by tuhle vadu nezavřelo: útočník, který pošle jeden
 * požadavek za okno, by klíč držel naživu napořád a stá porucha by mlčela dál.
 * Kotva na prvním výskytu dělá z okna pevný takt, který nikdo neposune.
 *
 * A protože klíč je `(dveře, kód)`, vydá se navíc **první výskyt každé nové
 * příčiny v okně** — nejvýš `MAX_DETAILS_PER_WINDOW` na okno. Bez toho stačí
 * držet počítadlo nahoře jednou příčinou a ta druhá, skutečná, pod týmž kódem
 * nevyleze nikdy.
 *
 * ## Co okno nezavírá — naměřeno nezávislou revizí 1. 9. 2026
 *
 * **Ticho vyprší, ale dá se koupit znovu, a v tom je celý rozdíl.** Sto
 * přerušených těl na začátku **každého** okna je 400 požadavků za hodinu
 * (0,111 req/s) a drží klíč `emit BODY_UNREADABLE` umlčený natrvalo. Revize to
 * změřila přes osm hodin: operátor dostal 96 řádků, **všechny s textem
 * útočníka** a ani jeden s textem skutečné poruchy, která mezitím padla
 * 28 768krát. Pravidlo o nové příčině přesně tenhle běh zavírá (skutečná
 * porucha nese jinou hlášku), ale kdo si v jednom okně vyrobí víc než
 * `MAX_DETAILS_PER_WINDOW` různých příčin, vyčerpá i ten rozpočet.
 *
 * **Na téhle vrstvě to nejde zavřít úplně.** Bez přihlášení se cena za umlčení
 * jednoho klíče drží na stovkách požadavků za hodinu; zvedne ji až sdílený
 * stav a mez na zdroj (T29), ne další počítadlo v procesu. Nikde se proto
 * netvrdí, že se ta mez **nedá předplatit** — tvrdí se, že **vyprší**.
 *
 * ⚠ **Ten strop je na jednu instanci, ne na nasazení.** `SEEN_PER_KEY` je stav
 * modulu, takže na serverless je skutečná mez **instance × dveře × kódy × okna**
 * a počet instancí roste s provozem. Konstanta to tedy není; logaritmus na
 * instanci a okno ano. Trvale to zavře až sdílený stav (T29, tentýž důvod jako
 * u dolarového stropu).
 *
 * ⚠ **Hodiny jsou tu `Date.now()` schválně.** Zákaz z `CLAUDE.md` platí na
 * replay cestě, kde je jedinou jednotkou simulovaný tik; tohle je operátorův
 * log serveru, který na simulaci nesahá.
 */
export function logRateLimited(
  route: string,
  requestId: string,
  code: string,
  detail: string,
): void {
  const key = `${route} ${code}`;
  const now = Date.now();
  const seen = SEEN_PER_KEY.get(key);
  const open = seen !== undefined && now - seen.windowStart < RATE_LIMIT_WINDOW_MS ? seen : undefined;
  const occurrence = (open?.occurrences ?? 0) + 1;
  const details = open?.details ?? new Set<string>();
  const newCause = !details.has(detail) && details.size < MAX_DETAILS_PER_WINDOW;
  if (newCause) details.add(detail);
  SEEN_PER_KEY.set(key, { windowStart: open?.windowStart ?? now, occurrences: occurrence, details });
  if (!isMilestone(occurrence) && !newCause) return;
  logForOperator(route, requestId, code, `${detail} (occurrence ${occurrence})`);
}

/**
 * Jen pro testy: počítadlo okna je stav modulu, tedy sdílené celým souborem.
 *
 * Bez tohohle stojí každá aserce „řádek odešel" na tom, že je ten test **první
 * producent** své dvojice `(dveře, kód)` v souboru — druhý výskyt je až
 * `occurrence 2`, tedy mimo milník, a `logRateLimited` mlčí. Test přidaný nad
 * ten stávající by tak shodil test, který nikdo nesáhl. Nález nezávislé revize
 * 3. 9. 2026; do té doby to držel jen komentář, a komentář není mechanismus.
 */
export function resetFaultLog(): void {
  SEEN_PER_KEY.clear();
}
