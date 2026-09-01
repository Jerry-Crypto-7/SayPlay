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

/** Vady, které tenhle proces už zapsal. Klíčem je dvojice (dveře, `detail`). */
const STICKY_LOGGED = new Set<string>();

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
 * ⚠ **Ten strop je na jednu instanci, ne na nasazení** — táž výhrada jako
 * u `logRateLimited()` níž. Trvale to zavře až sdílený stav (T29).
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
  if (STICKY_LOGGED.has(key)) return;
  STICKY_LOGGED.add(key);
  logForOperator(route, requestId, code, detail);
}

/**
 * **Okno, ve kterém se výskyty počítají.** Patnáct minut, a to číslo je
 * odvozené, ne vybrané:
 *
 * - **Zdola je držené tím, jak často se má trvající porucha připomenout.** Okno
 *   o délce `W` dává `3600/W` zaručených řádků za hodinu a klíč, tedy **čtyři**
 *   při 900 s. Za den je to zhruba **stovka řádků na klíč** proti dnešním šesti
 *   za celý proces — pořád o pět řádů méně než řádek na požadavek, a poprvé je
 *   to číslo, které volající nemůže koupit dopředu.
 * - **Shora je držené délkou jednoho selhání nahoře.** Jedno volání modelu běží
 *   až `DEFAULT_TIMEOUT_MS = 120 000` (`src/server/upstream.ts:106`). Okno musí
 *   být o řád delší, jinak by se jediný výpadek proudu vyhlásil jako nová
 *   porucha v každém okně a mez by se rozpustila zpátky do záplavy. 900 s je
 *   7,5násobek toho stropu.
 * - **Cena za umlčení** je tím omezená na **jedno okno na klíč**, a platí se
 *   v každém dalším znovu.
 *
 * Paměť to nezvětšuje: klíč je dvojice (dveře, kód), tedy uzavřená množina, a
 * ukládá se o jedno číslo víc.
 */
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Kolikrát tenhle proces viděl dvojici (dveře, kód) a kdy to počítání začalo. */
const SEEN_PER_KEY = new Map<string, { readonly windowStart: number; readonly occurrences: number }>();

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
 * požadavků v jednom okně = šest řádků), takže natáhnout se log nedá. Číslo
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
 * takže ticho po delší pauze je vždycky ticho poctivé.
 *
 * **Okno se kotví na svém prvním výskytu, ne na posledním.** Zapomínání po
 * N minutách *ticha* by tuhle vadu nezavřelo: útočník, který pošle jeden
 * požadavek za okno, by klíč držel naživu napořád a stá porucha by mlčela dál.
 * Kotva na prvním výskytu dělá z okna pevný takt, který nikdo neposune.
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
  SEEN_PER_KEY.set(key, { windowStart: open?.windowStart ?? now, occurrences: occurrence });
  if (!isMilestone(occurrence)) return;
  logForOperator(route, requestId, code, `${detail} (occurrence ${occurrence})`);
}
