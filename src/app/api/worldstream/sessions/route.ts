/**
 * `POST /api/worldstream/sessions` — z věty vznikne relace (P13 T16, §21).
 *
 * Odpověď je **202 a adresa proudu**, ne hotový svět. Design book to říká
 * doslova: „validní odpověď neznamená hotový svět". Generace běží dál za
 * odpovědí a hlásí se rámci do relace (`src/worldstream/sessions.ts`).
 *
 * ## Čtyři brány, v tomhle pořadí
 *
 * 1. **Tvar těla.** Přijímá se **prompt a nic jiného**. Klíč navíc je 400, ne
 *    tiše ignorovaný — kdyby se ignoroval, `shapes` nebo `geometry` od klienta
 *    by vypadaly jako přijaté a produkt by tvrdil, že geometrii píše model,
 *    zatímco by ji směl podstrčit kdokoli.
 * 2. **Moderace** (`src/server/moderation.ts`), tedy táž brána jako `/api/emit`.
 * 3. **Strop souběhu**: je to **týž strop** jako u preview druhé věty a jako
 *    u `/api/generate`, jen se každé ty dveře zastaví o kus dřív — vlastní
 *    strop nad společným dnem `MAX_CONCURRENT_GENERATIONS`. V letu se počítá
 *    po dveřích, takže rezerva platí na všechny strany. Odůvodnění a invariant,
 *    na kterém to stojí, jsou u `DOOR_CEILING`.
 * 4. **Strop utrácení** — uvnitř emitoru, u každého placeného volání zvlášť.
 *
 * ## Proč tu není `AdmissionQueue`, ačkoli je napsaná
 *
 * `submit()` splní slib **až když práce doběhne**, a tahle route musí odpovědět
 * dřív, než práce doběhne — jinak se 202 změní v „počkej si třicet vteřin".
 * Fronta se sem tedy nedá zapojit tak, jak je: zapojení celé ochrany proti
 * náporu je vlna 7 (T28) a bude potřebovat slot držený **napříč** požadavkem
 * a generací. Do té doby drží nápor jediná věc, která tuhle vlastnost nemá:
 * čítač souběžných generací níž.
 *
 * ## Rozpočet požadavku tu stál a nikdy nesepnul
 *
 * Do 4. 9. 2026 tu byla ještě brána `admit()` na promlčeném rozpočtu
 * (`SESSION_POLICY`: 15 s rozpočtu, 3 s minimální obsluhy). **Nezávislá revize
 * ji vyvrátila měřením:** odmítala až požadavek, který čekal přes 12 s, jenže
 * `receivedAtMs` se bralo až uvnitř handleru, takže jediný interval, který se
 * odsud dal změřit, bylo čtení těla — a to má vlastní strop
 * `BODY_DEADLINE_MS = 5 000` (`src/http/body.ts`). Brána byla o sedm vteřin
 * mimo dosah a nemohla odmítnout nikdy nikoho. Táž vada a totéž odstranění jako
 * v `/api/generate` (`7c1e12f`); zůstává čítač, který doopravdy kousne.
 */

import { randomUUID } from 'node:crypto';

import { after } from 'next/server';

import { bodyRefusalResponse, readBody } from '../../../../http/body';
import { withRequest } from '../../../../obs/trace';
import type { UpstreamRequest } from '../../../../model/prompt';
import { killState } from '../../../../server/kill-switch';
import { moderatePrompt } from '../../../../server/moderation';
import {
  callerKey,
  rateLimitCode,
  rateLimitedResponse,
  takeRateSlot,
  trustedCallerKey,
  UNIDENTIFIED_CALLER,
} from '../../../../server/rate-limit';
import { logRateLimited } from '../../../../server/public-faults';
import { costUsd, processSpendCap, SpendRefusalError } from '../../../../server/spend-cap';
import { upstreamBranch, upstreamConfigFromEnv } from '../../../../server/upstream';
import type { BlueprintEmitter } from '../../../../model/worldstream-repair';
import { chooseAuthored, emitterFor } from '../../../../worldstream/authored';
import {
  MAX_SESSIONS_PER_CALLER,
  newSessionSeed,
  openSession,
  runGeneration,
  serverGrammar,
  type SessionFault,
} from '../../../../worldstream/sessions';

/** Zmrazený protokol se čte ze souboru a `AsyncLocalStorage` chce Node. */
export const runtime = 'nodejs';

/**
 * Kolik generací smí běžet naráz.
 *
 * Není to výkonnostní ladění, je to strop na **placená volání v letu**: každá
 * generace stojí dvě až čtyři volání modelu a strop utrácení je kontrola po
 * volání, ne před náporem. Je to nad tím, co porotce vyrobí sám, a pod tím,
 * co by z jednoho návštěvníka udělalo účet za den.
 *
 * ✅ **Ze čtyř na šest 4. 9. 2026, a je to rozhodnutí o penězích.** Čtyři sloty
 * na troje dveře vycházely 2 + 1 + 1, tedy **jedno** souběžné preview druhé věty
 * na celou instanci — a druhá věta je hlavní věc, kterou má porotce vidět. Šest
 * dovolí 3 + 2 + 2. Peníze to neuvolňuje: horní mez útraty drží
 * `src/server/spend-cap.ts`, tenhle strop je jen mez souběhu.
 *
 * ⚠ **Vedlejší následek, který stojí za to znát:** při 2 + 1 + 1 byl součet
 * stropů roven dnu, takže brána na součet nikdy nekousla první a nešla změřit
 * (mutant, který ji vypustil, přežil). Při 3 + 2 + 2 je součet 7 proti dnu 6,
 * takže rozhoduje a má vlastní test.
 */
export const MAX_CONCURRENT_GENERATIONS = 6;

/**
 * Kolik z těch čtyř smí naráz držet **zakládání relace**.
 *
 * Jeden čítač obsluhoval dvoje dveře, jejichž doba držení se liší o dva řády.
 * Zakládání drží slot po **celou** generaci na pozadí — volání na záměr plus až
 * `MAX_BLUEPRINT_ROUNDS` kol kompilace a oprav, každé `fetch` omezené jen
 * `DEFAULT_TIMEOUT_MS = 120 000` v `src/server/upstream.ts`. Preview druhé věty
 * drží slot na jedno `planChange`. Naměřený následek sdíleného stropu bez
 * rezervy: **čtyři anonymní `POST /sessions`** proti pomalému poskytovateli
 * obsadí všechny čtyři sloty na minuty a každé `POST …/changes` po tu dobu
 * vrátí `503 TOO_MANY_CHANGES`. Cena útoku jsou čtyři požadavky, a vypne to
 * druhou větu — tedy hlavní věc, kterou má porotce vidět.
 *
 * ✅ **Od 4. 9. 2026 jsou dveře troje, ne dvoje** (`T22-doorcounters`, druhé
 * kolo nezávislé revize). `POST /api/generate` je **třetí veřejné dveře na
 * placené volání** a do té doby si bral slot pod jménem `world`, tedy z týchž
 * dvou slotů jako zakládání relace: tři souběžná `POST /api/generate` (strop
 * frekvence pustí padesát za deset sekund, takže tři jsou zadarmo) obsadila
 * celý strop dveří `world` na celou dobu poskytovatele a **každé** zakládání
 * relace po tu dobu dostalo `503`. Rezerva na dveře platí jen tehdy, když má
 * vlastní čítač **každé** veřejné dveře.
 *
 * ✅ **Kapacita se 4. 9. 2026 vrátila zvednutím dna, ne zrušením rezervy.**
 * První podoba téhle opravy dělila čtyři sloty na troje dveře (2 + 1 + 1),
 * takže druhá věta směla běžet jednou naráz. Dno je od téhož dne šest a dělí se
 * 3 + 2 + 2, tedy `world` má zpátky své tři.
 */
export const MAX_WORLD_GENERATIONS = 3;

/**
 * Dveře, které si o placený slot říkají. Ne řetězec: strop se vybírá podle
 * něj, a překlep by ho tiše nastavil na `undefined`, po čemž `running >=
 * undefined` je nepravda a strop by nedržel vůbec.
 */
export type PaidDoor = 'world' | 'generate' | 'refine';

/**
 * Strop na dveře. Jedno místo, kde ta tři čísla stojí vedle sebe.
 *
 * **Každé dveře se zastaví o slot dřív, kvůli těm ostatním.** První podoba
 * `T22-doorcounters` nechávala `refine` až na dno čítače, a nezávislá revize to
 * spustila: čtyři souběžná `POST …/changes` proti visícímu poskytovateli pak
 * zavřela **oboje** dveře na stavbu světa na celé dvě minuty, tedy přesně ten
 * útok, který ta úloha zavírala — jen za čtyři požadavky místo tří. Druhé kolo
 * revize našlo totéž potřetí: `/api/generate` sdílelo čítač s `world`.
 *
 * ## Invariant, na kterém rezerva stojí
 *
 * **Součet stropů VŠECH OSTATNÍCH dveří musí být menší než
 * `MAX_CONCURRENT_GENERATIONS`.** Teprve pak platí, že dveře, které nedrží
 * nic, se dovnitř dostanou vždycky: odmítnout je umí jen jejich vlastní strop
 * (tedy jejich vlastní provoz), nebo součet — a na součet ostatní samy
 * nedosáhnou. Dnes: `world` 3 + `generate` 2 + `refine` 2 = 7 proti dnu 6,
 * takže pro každé dveře je součet těch zbylých nejvýš 5 — pod dnem.
 *
 * ⚠ **Ten invariant se poruší tiše.** Zvednout kterýkoli strop o jedna
 * vypadá jako uvolnění, a přitom to jiným dveřím sebere rezervu, o kterou tu
 * celou dobu jde. Pinuje ho vlastnostní test nad těmihle konstantami
 * (`changes.test.ts`, „invariant rezervy"), ne komentář.
 *
 * ⚠ **Součet stropů je NAD dnem (7 proti 6), takže brána na součet doopravdy
 * rozhoduje** — a je to tak správně: je to jediné, co drží celkový počet
 * placených volání bez ohledu na to, kolik dveří přibude. Do 4. 9. 2026 byl
 * součet roven dnu, brána nikdy nekousla první a mutant, který ji vypustil,
 * proto přežil. Hlídá to týž test.
 */
export const DOOR_CEILING: Readonly<Record<PaidDoor, number>> = {
  world: MAX_WORLD_GENERATIONS,
  generate: 2,
  refine: 2,
};

/** Kolik placených volání drží která dveře. **Tři čítače, jeden strop.** */
const running: Record<PaidDoor, number> = { world: 0, generate: 0, refine: 0 };

/**
 * Věta pro operátorský log u odmítnutí: **kdo ty sloty drží a kolik jich smí
 * držet tyhle dveře.** Jedno místo pro všechny troje dveře, protože jinak by
 * se odpověď na „koho mám hledat" psala třikrát a rozešla se.
 *
 * **„on this instance" je součást pravdy:** čítač je stav modulu, takže na
 * Vercelu má vlastní každá instance a globální číslo nedrží nikdo — to zavře
 * až sdílené úložiště (`T29`, měření `T22-slotperroute`).
 */
export function slotsDetail(door: PaidDoor): string {
  return (
    `paid slots in flight: ${running.world} world + ${running.generate} generate + ` +
    `${running.refine} refine of ${MAX_CONCURRENT_GENERATIONS} on this instance; ` +
    `the ${door} door may hold ${DOOR_CEILING[door]}`
  );
}

/**
 * Vzít slot pro jedno placené volání v letu. Vrací `false`, když je plno.
 *
 * **Jeden strop na oboje dveře** — zakládání relace i preview druhé věty.
 * Dva oddělené stropy po čtyřech nejsou strop čtyř: kdo chce platit za osm
 * volání naráz, střídá obě adresy. Proto se `running.world + running.refine`
 * porovnává proti `MAX_CONCURRENT_GENERATIONS` **vždycky**, ať přijdou které
 * dveře chtějí. Kontrola a zvýšení jsou v jednom synchronním kroku, takže mezi
 * ně nemá co vklouznout.
 *
 * **Vlastní strop dveří je nad tím**, ne místo toho: `MAX_WORLD_GENERATIONS`
 * u drahých, dno čítače u levných. Ten drží rezervu — obojím směrem, protože
 * sytit ho umí jen ty dveře, kterých se týká. Viz `MAX_WORLD_GENERATIONS`.
 */
export function acquireSlot(door: PaidDoor): boolean {
  // Díra pod tou, kterou hlídá typ (P15 T22-doorkeyguard): pro klíč mimo
  // `PaidDoor` je `running[door]` `undefined`, obě porovnání níž jsou nepravda
  // a `+= 1` zapíše `NaN` — od té chvíle je součet `NaN` a strop neodmítne
  // nikoho do konce života procesu. Dnes sem cizí klíč nedosáhne (všichni tři
  // volající předávají literál); tohle jen zavírá cestu, kdyby typ někdo obešel.
  if (!Object.hasOwn(running, door)) return false;
  if (running.world + running.generate + running.refine >= MAX_CONCURRENT_GENERATIONS)
    return false;
  if (running[door] >= DOOR_CEILING[door]) return false;
  running[door] += 1;
  return true;
}

/**
 * Slot vrátit. Musí proběhnout na **každé** cestě ven, i na chybové.
 *
 * `door` je povinné a musí sedět s tím, čím se slot bral: vrácení pod cizími
 * dveřmi by jeden čítač poslalo do záporu a druhý natrvalo utáhlo. Typ to
 * hlídá jen zpola (obojí je `PaidDoor`), zbytek je na tom, že vzetí i vrácení
 * stojí v témž bloku.
 */
export function releaseSlot(door: PaidDoor): void {
  if (!Object.hasOwn(running, door)) return;
  running[door] -= 1;
}

/** Jen pro testy: čítač je proces-globální jako registr relací. */
export function resetConcurrency(): void {
  running.world = 0;
  running.generate = 0;
  running.refine = 0;
}

/**
 * Strop utrácení je stav **procesu**, ne požadavku — a je to **táž instance**,
 * jakou drží `src/app/api/generate/route.ts`, ne jeho kopie.
 *
 * ⚠ **Do 3. 9. 2026 to byly dvě instance a nikdo si toho nevšiml.** Obě route
 * si volaly `spendCapFromEnv(process.env)` samy, každá dostala vlastní
 * `#spentUsd` a `#callsMade`, a proces tedy utratil až **dvojnásobek**
 * nastaveného stropu — každá půlka přitom svůj strop poctivě dodržela.
 * Naměřeno nezávislou revizí. Proto se sem chodí výhradně přes
 * `processSpendCap()`.
 *
 * Postavit ho uvnitř `cloudEmitter()` znamenalo nový strop na každý požadavek:
 * `#spentUsd` i `#callsMade` se pokaždé vynulovaly, takže strop nikdy nic
 * neodmítl. Naměřeno revizí 3. 9. 2026 — sdílený strop odmítl na volání #38,
 * strop na požadavek neodmítl ani po šedesáti.
 *
 * Napříč instancemi to pořád nedrží; to je `T29` a jiná vada.
 */
export const WORLDSTREAM_SPEND_CAP = processSpendCap();

function fail(requestId: string, status: number, code: string, message: string): Response {
  return Response.json({ requestId, error: { code, message } }, { status });
}

/**
 * Emitor, který mluví s poskytovatelem a **platí za to**.
 *
 * Vypadá jako `liveEmitter()` z měřidla T14 a je to jiná věc: ten archivuje
 * a scrubuje, protože jeho výstup jde do commitnutého souboru. Tenhle nesmí
 * ven pustit **nic** — text výjimky nese adresu koncového bodu a `fetch` ji
 * píše do hlášek celou, takže ho čte jen `runGeneration`, který ho přeloží na
 * veřejnou větu a detail pošle do logu operátora.
 *
 * `null` znamená „cloudová větev není nakonfigurovaná". Relace se i tak
 * založí a skončí `session.failed`: 503 rovnou by porotci vzalo proud, ve
 * kterém je ta příčina vidět, a `RULES.md` §3.3 mu dává právo zkoušet vlastní
 * věty i tehdy, když je nasazení bez klíče.
 */
export async function cloudEmitter(): Promise<BlueprintEmitter | null> {
  // **Kill switch `upstream` vypadá odsud stejně jako chybějící klíč**, a je to
  // schválně: obě cesty končí `session.failed` s veřejnou větou „the model could
  // not be reached", takže porotci zůstane proud, ve kterém je ta příčina vidět.
  // Vypnutý model není 503 — 503 by mu vzalo i to.
  if ((await killState(process.env)).upstream) return null;

  const config = upstreamConfigFromEnv(process.env);
  if (config === null) return null;

  const branch = upstreamBranch(config);
  const cap = WORLDSTREAM_SPEND_CAP;

  return async (request: UpstreamRequest): Promise<unknown> => {
    const call = { prompt: request.user, request };
    const reservation = await cap.reserve(branch.worstCaseUsd(call));
    // **Vlastní třída, ne holý `Error`** (P15 `T29-readinessledger`). Volající
    // chytá jedinou výjimku a musí z ní poznat, jestli se k poskytovateli
    // vůbec někdo připojoval — odmítnutý strop se do té chvíle hlásil jako
    // „the model could not be reached". Text zprávy zůstává, mění se typ.
    if (!reservation.ok) throw new SpendRefusalError(reservation);

    let outcome;
    try {
      outcome = await branch.generate(call);
    } catch (thrown) {
      // Rezervaci vyrovnat **před** rethrow, jinak visí do restartu procesu a
      // strop se sám utáhne — táž oprava jako v `runPipeline`.
      await reservation.settle('unknown');
      throw thrown;
    }

    await reservation.settle(outcome.usage === null ? 'unknown' : costUsd(outcome.usage, branch.pricing));
    if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.detail}`);
    return outcome.body;
  };
}

interface PromptRead {
  readonly ok: true;
  readonly prompt: unknown;
}

/** Tělo je `{ prompt }` a nic víc. Klíč navíc je vada, ne přebytek. */
function readPrompt(text: string): PromptRead | { readonly ok: false; readonly code: string; readonly message: string } {
  let body: unknown;
  try {
    body = JSON.parse(text === '' ? 'null' : text);
  } catch {
    return { ok: false, code: 'BODY_NOT_JSON', message: 'the request body is not JSON' };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, code: 'BODY_NOT_AN_OBJECT', message: 'the request body is not a JSON object' };

  const extra = Object.keys(body).filter((key) => key !== 'prompt');
  if (extra.length > 0)
    return {
      ok: false,
      code: 'UNEXPECTED_FIELDS',
      message: `this endpoint takes a prompt and nothing else; it will not accept ${extra.join(', ')}`,
    };

  return { ok: true, prompt: (body as { prompt?: unknown }).prompt };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();

  return withRequest(requestId, async () => {
    // **Vypínač je první brána, před čtením těla.** Vypnuté dveře nesmí stát
    // víc než jeden `readFileSync` nad souborem o pár řádcích — tělo požadavku
    // je proti tomu až 64 kB, které někdo pošle a my je nepotřebujeme.
    //
    // ⚠ **Ta věta byla od `T30-controllever` chvíli nepravdivá a je znovu
    // pravdivá.** Druhým zdrojem povelu je sdílený obchod, takže čtení umí být
    // síťový let — a jako první příkaz na neomezených dveřích to byl
    // zesilovač, kterým šlo vypálit kvótu obchodu (nález nezávislé revize
    // commitu `316a4f1`, `VERDICT: blocking`). Zavírá to okno
    // `CONTROL_CACHE_TTL_MS` v `spend-store.ts`: instance vydá nejvýš jeden
    // `GET` za sekundu, všechno ostatní je pohled do mapy. Pořadí bran proto
    // zůstává — přeřadit vypínač za strop frekvence by odchozí lety
    // neohraničilo (strop instance pouští 400 za 10 s, tedy 40 příkazů za
    // sekundu) a jen by vypnutým dveřím vzalo přednost.
    if ((await killState(process.env)).sessions) {
      logRateLimited('worldstream/sessions', requestId, 'SESSIONS_DISABLED', 'kill switch: sessions');
      return fail(requestId, 503, 'SESSIONS_DISABLED', 'new worlds are switched off right now');
    }

    // Strop na frekvenci, hned za vypínačem a před čtením těla. Tyhle dveře
    // stojí navíc placená volání, takže čítač souběhu níž zůstává — frekvence
    // a souběh měří dvě různé věci a jedna druhou nenahradí.
    const slot = takeRateSlot('sessions', trustedCallerKey(request) ?? callerKey(request));
    if (!slot.allowed) {
      logRateLimited(
        'worldstream/sessions',
        requestId,
        rateLimitCode(slot),
        `${String(slot.count)} in window`,
      );
      return rateLimitedResponse(requestId, slot);
    }

    let raw;
    try {
      raw = await readBody(request);
    } catch (thrown) {
      logRateLimited(
        'worldstream/sessions',
        requestId,
        'BODY_UNREADABLE',
        thrown instanceof Error ? thrown.message : String(thrown),
      );
      return fail(requestId, 400, 'BODY_UNREADABLE', 'the request body could not be read');
    }
    // **Dva starší důvody si nechávají svůj pravopis.** Tyhle dveře vydávají
    // `TOO_LARGE`/`TIMEOUT` tam, kde ostatní vydávají `PAYLOAD_TOO_LARGE`
    // a `BODY_TIMEOUT`; sjednotit to je změna kontraktu, kterou tahle úloha
    // neobjednala. Nový důvod (plná fronta čtení) sdílí kód se všemi dveřmi,
    // aby nevznikl pátý pravopis.
    if (!raw.ok)
      return raw.reason === 'BUSY'
        ? bodyRefusalResponse(requestId, raw)
        : fail(
            requestId,
            raw.reason === 'TOO_LARGE' ? 413 : 408,
            raw.reason,
            raw.reason === 'TOO_LARGE'
              ? 'the request body is too large'
              : 'the request body arrived too slowly',
          );

    const read = readPrompt(raw.text);
    if (!read.ok) return fail(requestId, 400, read.code, read.message);

    const verdict = moderatePrompt(read.prompt);
    if (!verdict.ok) return fail(requestId, 400, verdict.category, verdict.detail);

    // **Slot se bere PŘED čtením protokolu, protože odmítnutí musí být levné.**
    // `serverGrammar()` není cachované: každé volání blokuje smyčku událostí
    // dvěma `readFileSync`, sha256 a `JSON.parse` nad 26 kB. Naměřeno
    // nezávislou revizí 3. 9. 2026 — s obráceným pořadím stál požadavek
    // odsouzený k `503 TOO_MANY_SESSIONS` **2,223 ms**, takže tisíc odmítnutí
    // = 2,2 s úplně zablokovaného Node, a s ním stojí i SSE proudy, snapshot
    // i preview. V tomhle pořadí stojí odmítnutí ~0.
    //
    // ⚠ **Od `f5b1b49` je `serverGrammar()` memoizované, takže těch 2,223 ms
    // platí jen pro PRVNÍ požadavek na instanci.** Pořadí se přesto nemění:
    // tu cenu platí každá nová instance znovu, a na Vercelu jich naskakuje
    // tolik, kolik jich zrovna běží. Kdo to půjde přeměřit, naměří nulu.
    //
    // Kontrola a zvýšení čítače jsou jeden synchronní krok (`acquireSlot`),
    // takže jsou atomické na smyčce událostí. Jediný odchod z route mezi
    // vzetím slotu a `work.finally` níž je nečitelný protokol — a ten slot
    // vrací sám, řádek níž. **Přibude-li sem další `return`, musí vrátit taky.**
    if (!acquireSlot('world')) {
      // **Odmítnutí musí být vidět v operátorském logu**, jinak se „strop nás
      // ochránil" nedá odlišit od „nikdo nepřišel". Text je konstantní
      // schválně: `logRateLimited` klíčuje `(dveře, kód)` a objem nese
      // `(occurrence N)`, takže z náporu nevyroste víc než logaritmus řádků.
      // **„on this instance" je součást pravdy:** `running` je stav modulu, takže
      // na Vercelu má vlastní čítač každá instance a globální číslo nedrží nikdo
      // — to zavře až sdílené úložiště `T29`.
      logRateLimited(
        'worldstream/sessions',
        requestId,
        'TOO_MANY_SESSIONS',
        // **Řádek jmenuje dveře, které sloty drží.** Do `T22-doorcounters` to
        // čítač nevěděl, takže uměl říct jen „v letu je tolik, kolik smí držet
        // nový svět" — a operátor z toho nepoznal, jestli ho zavřely světy,
        // nebo preview druhé věty. Rozpad po dveřích tu odpověď nese.
        //
        // **Proměnlivý text nevyrobí povodeň.** `logRateLimited` vydá nanejvýš
        // `MAX_DETAILS_PER_WINDOW = 8` různých příčin za okno, a různých
        // podob je tu stejně nejvýš pět: `world` se přes svůj strop nedostane.
        slotsDetail('world'),
      );
      return fail(requestId, 503, 'TOO_MANY_SESSIONS', 'too many worlds are being built right now');
    }

    const grammar = serverGrammar();
    if (typeof grammar === 'string') {
      releaseSlot('world');
      logRateLimited('worldstream/sessions', requestId, 'GRAMMAR_UNREADABLE', grammar);
      return fail(requestId, 503, 'GRAMMAR_UNREADABLE', 'the frozen protocol could not be read');
    }

    const sessionId = randomUUID();
    // **Vlastník relace je klíč volajícího, a je to mez, ne diagnostika**
    // (`MAX_SESSIONS_PER_CALLER`). Bez něj by registr seskupil všechny relace
    // do jednoho kbelíku a strop 64 by šel naplnit z jedné smyčky.
    //
    // ⚠ **Je to JINÝ klíč než ten pár řádků výš, a od `T16-trustedkey` to tak
    // má být.** Kvóta bere `trustedCallerKey()` **holý**, protože tady je cizí
    // klíč zbraň: jedna relace vložená do kbelíku oběti z něj udělá největší
    // kbelík a přetečení pak sáhne po oběti (naměřeno 5 z 5, `T16-evictkill`).
    // Strop frekvence bere od `T29-freeunbounded` (6. 9. 2026) **týž klíč
    // s pádem** — `trustedCallerKey(request) ?? callerKey(request)` — takže se
    // liší jen v tom, co dělají, když důvěryhodný konec řetězu není: kvóta se
    // vypne, frekvence spadne na vstup volajícího a platí dál.
    //
    // ⚠ **Do 6. 9. 2026 tu stálo „strop frekvence bere `callerKey()`,
    // podvrhnout ho tam nic nezískává" a byl to blokující nález nezávislé
    // revize.** Podvrhnout ho získává **cizí kbelík**: první položka
    // `x-forwarded-for` je vstup volajícího, takže padesát požadavků
    // s hlavičkou oběti umlčí porotce na deset sekund. Celý rozpad je
    // v hlavičce `rate-limit.ts`; pin je `útočník s hlavičkou oběti jí na
    // nasazení požadavek NEODRAZÍ`.
    //
    // ⚠ **Bez důvěryhodného konce řetězu je kvóta VYPNUTÁ, ne přísnější.**
    // `null` → sentinel → `openSession()` dá relaci vlastní kbelík, což je
    // izolace, ne mez; celé odůvodnění je tam. **Mimo Vercel to platí vždycky**
    // — `next start`, demo z notebooku i vlastní reverse proxy. Režim „za
    // vlastní nginx" tu do 5. 9. 2026 byl a zrušil ho měřením potvrzený nález
    // (doktrína u `trustedCallerKey()`); zpátky smí jedině se zdrojem, který
    // volající nepíše. **Na Vercelu klíč je — ale jedině při `VERCEL=1`:**
    // přepínač *Automatically expose System Environment Variables* zháší
    // `VERCEL` i `VERCEL_ENV` naráz, a s vypnutým přepínačem je kvóta i tam
    // vypnutá. Tvrdit „na Vercelu klíč je" bez té podmínky je nepravda.
    const owner = trustedCallerKey(request) ?? UNIDENTIFIED_CALLER;
    const stored = openSession(sessionId, newSessionSeed(), Date.now(), owner);
    // **Nad vlastní kvótou se odmítá nováček, a slot se vrací.** Je to ten
    // další `return` mezi `acquireSlot('world')` a `work.finally`, o kterém
    // mluví komentář výš: bez `releaseSlot` by každé odmítnutí natrvalo ubralo
    // jeden ze tří slotů dveří `world`, tedy z toho, co má chránit.
    //
    // ⚠ **429, ne 503.** 503 by řeklo „instance je plná", což je nepravda:
    // odmítnutí se týká **jen tohohle klíče**, a od `QUOTA_ENGAGES_AT` je
    // registr navíc zaručeně aspoň z poloviny obsazený.
    //
    // ⚠ **Věta nesmí radit „zavři jedno okno", protože to nefunguje** — nález
    // sedmé nezávislé revize, `VERDICT: blocking`, změřený. Koncový bod na
    // zavření relace neexistuje; `release()` je dosažitelné jedině ze zametení
    // stárnutí a z přetečení registru, takže volající, který zavře všechny
    // karty, je zpátky v poli až po **dvou hodinách a třech požadavcích**.
    // `Retry-After` se z téhož důvodu neposílá: jediné poctivé číslo by bylo
    // „nevím", a u relace s drženým proudem je to dokonce „nikdy"
    // (`T16-idleforever`). Hláška proto říká jen stav, ne radu.
    if (stored === null) {
      releaseSlot('world');
      logRateLimited(
        'worldstream/sessions',
        requestId,
        'TOO_MANY_SESSIONS_PER_CALLER',
        `caller already holds ${String(MAX_SESSIONS_PER_CALLER)} live sessions on this instance`,
      );
      return fail(
        requestId,
        429,
        'TOO_MANY_SESSIONS_PER_CALLER',
        'this address already holds as many live worlds as one address may hold on a busy instance',
      );
    }

    // ⚠ **Pořadí je součást kontraktu, ne detail zápisu.** Živá cesta má
    // přednost vždycky; sklad uvařených světů je až za ní. Kdyby předbíhal,
    // zaplacený klíč by přestal být vidět a `T14` by místo modelu měřila cache.
    //
    // Vypnutý model i chybějící klíč vypadají odsud stejně (`cloudEmitter()`
    // vrátí `null`) a to je správně: kill switch `upstream` vypíná **živou**
    // větev, ne sklad. Porotci má vypnutý model nechat svět, ne prázdno.
    const cloud = await cloudEmitter();
    // Sklad se hledá **tady**, ne uvnitř emitoru: odpověď musí říct, jestli
    // věta trefila uvařený svět přesně, nebo dostala ten nejbližší. Bez toho
    // by produkt tvrdil, že tenhle svět napsal model teď — a to je nepravda,
    // kterou porotce odhalí druhou větou (`T45-honestlabel`).
    const authored = cloud === null ? chooseAuthored(verdict.prompt) : null;
    const emit = cloud ?? (authored === null ? null : emitterFor(authored.world));
    // **Relace si pamatuje, ze kterého uvařeného světa vznikla** — jinak nemá
    // druhá věta ze skladu co vydat (`T35-actsthree4`). Uvařená změna nese
    // `stableId` z jednoho blueprintu, takže patří k jednomu světu a hledat ji
    // přes celý sklad znamená vydat cizí cíl.
    stored.authoredWorldId = authored?.world.id ?? null;
    const work =
      emit === null
        ? Promise.resolve().then(() => {
            stored.fault = 'the model could not be reached';
            stored.session.fail(stored.fault);
          })
        : runGeneration(stored, verdict.prompt, {
            emit,
            grammar,
            log: (fault: SessionFault, detail: string) =>
              logRateLimited('worldstream/sessions', requestId, fault, detail),
          });

    // **`after()`, ne holé `void`.** Odpověď 202 musí odejít dřív, než generace
    // doběhne — to je celý smysl téhle route — ale práce za ní musí platformu
    // přežít.
    //
    // Naměřeno nezávislou revizí 3. 9. 2026 nad `4ee2b3d`: `vercel.json`
    // nasazuje serverless a instance se po odeslání odpovědi **zmrazí**, takže
    // `void work` znamená „rezervace se zapsala, vyrovnání ne". Do P15 T29 to
    // stálo jen paměť procesu a umřelo to s ním; od T29 je kniha sdílená
    // a trvalá, takže každá taková rezervace strop **natrvalo utáhne** —
    // dvacet opuštěných rezervací po 0,2585 USD vyčerpá strop 5 USD a další
    // instance začne rovnou na `CAP_EXHAUSTED`. Zotavení pak není mazání klíče
    // v úložišti, ale zvednutí `WORLDSMITH_SPEND_CAP_USD` a redeploy; je to
    // rozhodnutí o penězích a patří člověku. **Ovládacím souborem to od
    // `T30-capfloor` nejde** — ten umí strop jen přitáhnout, takže vyšší
    // `capUsd` v něm je tichý no-op.
    //
    // `after()` doběhne i tehdy, když odpověď skončí chybou, a je omezené
    // `maxDuration` routy, ne donekonečna.
    const settled = work.finally(() => {
      releaseSlot('world');
    });
    try {
      after(settled);
    } catch {
      // **`after()` mimo request scope vyhodí**, a to je jediná větev, kterou
      // tenhle `catch` chytá: test, který volá `POST()` přímo, a `next start`.
      // Ani na jednom z těch dvou se instance po odpovědi nezmrazí, takže tam
      // holé `void` platí dál — není to náhradní řešení, je to ta správná
      // odpověď mimo serverless. Že se práce na serverless doopravdy předává
      // platformě, pinuje lexikálně `sessions.test.ts`; uvnitř jednoho procesu
      // se ta vlastnost změřit nedá.
      void settled;
    }

    return Response.json(
      {
        requestId,
        sessionId,
        events: `/api/worldstream/sessions/${sessionId}/events`,
        snapshot: `/api/worldstream/sessions/${sessionId}`,
        // **Chybí, když svět píše model**, a to je celý rozdíl, který má
        // porotce vidět. Klíč se posílá jen tehdy, když odpovídá sklad; co
        // s tím rozhraní udělá, patří jemu, ne téhle route.
        ...(authored === null ? {} : { authored: { match: authored.match } }),
      },
      { status: 202 },
    );
  });
}
