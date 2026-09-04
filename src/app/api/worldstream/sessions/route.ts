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
 * 3. **Strop souběhu**: je to **týž čítač** jako u preview druhé věty, jen
 *    tyhle dveře se zastaví o slot dřív — porovnávají se proti
 *    `MAX_WORLD_GENERATIONS`, ne proti dnu `MAX_CONCURRENT_GENERATIONS`.
 *    Celé odůvodnění té asymetrie je u `DOOR_CEILING` níž.
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

import { readBody } from '../../../../http/body';
import { withRequest } from '../../../../obs/trace';
import type { UpstreamRequest } from '../../../../model/prompt';
import { killState } from '../../../../server/kill-switch';
import { moderatePrompt } from '../../../../server/moderation';
import { logRateLimited } from '../../../../server/public-faults';
import { costUsd, processSpendCap } from '../../../../server/spend-cap';
import { upstreamBranch, upstreamConfigFromEnv } from '../../../../server/upstream';
import type { BlueprintEmitter } from '../../../../model/worldstream-repair';
import {
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
 * volání, ne před náporem. Čtyři je nad tím, co porotce vyrobí sám, a pod tím,
 * co by z jednoho návštěvníka udělalo účet za den.
 */
export const MAX_CONCURRENT_GENERATIONS = 4;

/**
 * Kolik z těch čtyř smí naráz držet **zakládání relace**.
 *
 * Jeden čítač obsluhuje dvoje dveře, jejichž doba držení se liší o dva řády.
 * Zakládání drží slot po **celou** generaci na pozadí — volání na záměr plus až
 * `MAX_BLUEPRINT_ROUNDS` kol kompilace a oprav, každé `fetch` omezené jen
 * `DEFAULT_TIMEOUT_MS = 120 000` v `src/server/upstream.ts`. Preview druhé věty
 * drží slot na jedno `planChange`. Naměřený následek sdíleného stropu bez
 * rezervy: **čtyři anonymní `POST /sessions`** proti pomalému poskytovateli
 * obsadí všechny čtyři sloty na minuty a každé `POST …/changes` po tu dobu
 * vrátí `503 TOO_MANY_CHANGES`. Cena útoku jsou čtyři požadavky, a vypne to
 * druhou větu — tedy hlavní věc, kterou má porotce vidět.
 *
 * Tři ze čtyř je proto **rezerva pro levné dveře**, ne druhý strop: čítač
 * zůstává jeden, mění se jen strop, proti kterému se drahé dveře porovnávají.
 * Kdo chce platit za osm volání naráz, střídáním adres si je pořád nekoupí.
 *
 * ⚠ **Rezerva je dnes jednosměrná, a to není vlastnost, je to dluh.** První
 * podoba tohohle komentáře tvrdila, že opačným směrem hladovět nejde, protože
 * preview drží slot „vteřiny, ne minuty". **Revize to vyvrátila čtením zdroje:**
 * preview jde týmž `cloudEmitter()` (níž v tomhle souboru) s touž konfigurací,
 * takže jeho jediná mez je zase `DEFAULT_TIMEOUT_MS = 120 000`. Tři souběžná
 * `POST …/changes` proti visícímu poskytovateli tedy zavřou **oboje** dveře na
 * stavbu světa na celé dvě minuty, aniž se staví jediný svět — a stojí to o
 * jeden požadavek míň než před touhle úlohou.
 *
 * Není to regrese v druhu, jen ve stupni: před rezervou to stálo čtyři
 * požadavky, teď tři. Skutečná oprava je **počítat v letu po dveřích** (dva
 * čítače a jeden společný součet), aby rezerva platila na obě strany; to je
 * routovaná úloha `T22-doorcounters`, ne tenhle jeden řádek.
 */
export const MAX_WORLD_GENERATIONS = 3;

/**
 * Dveře, které si o placený slot říkají. Ne řetězec: strop se vybírá podle
 * něj, a překlep by ho tiše nastavil na `undefined`, po čemž `running >=
 * undefined` je nepravda a strop by nedržel vůbec.
 */
export type PaidDoor = 'world' | 'refine';

/** Strop na dveře. Jedno místo, kde ta dvě čísla stojí vedle sebe. */
const DOOR_CEILING: Readonly<Record<PaidDoor, number>> = {
  world: MAX_WORLD_GENERATIONS,
  refine: MAX_CONCURRENT_GENERATIONS,
};

let running = 0;

/**
 * Vzít slot pro jedno placené volání v letu. Vrací `false`, když je plno.
 *
 * **Jeden čítač na oboje dveře** — zakládání relace i preview druhé věty.
 * Dva oddělené stropy po čtyřech nejsou strop čtyř: kdo chce platit za osm
 * volání naráz, střídá obě adresy. Kontrola a zvýšení jsou v jednom
 * synchronním kroku, takže mezi ně nemá co vklouznout.
 *
 * **`door` říká, proti kterému stropu se ten jeden čítač porovnává** —
 * `MAX_WORLD_GENERATIONS` u drahých dveří, `MAX_CONCURRENT_GENERATIONS`
 * u levných. Viz `MAX_WORLD_GENERATIONS` pro naměřený důvod.
 */
export function acquireSlot(door: PaidDoor): boolean {
  if (running >= DOOR_CEILING[door]) return false;
  running += 1;
  return true;
}

/** Slot vrátit. Musí proběhnout na **každé** cestě ven, i na chybové. */
export function releaseSlot(): void {
  running -= 1;
}

/** Jen pro testy: čítač je proces-globální jako registr relací. */
export function resetConcurrency(): void {
  running = 0;
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
export function cloudEmitter(): BlueprintEmitter | null {
  // **Kill switch `upstream` vypadá odsud stejně jako chybějící klíč**, a je to
  // schválně: obě cesty končí `session.failed` s veřejnou větou „the model could
  // not be reached", takže porotci zůstane proud, ve kterém je ta příčina vidět.
  // Vypnutý model není 503 — 503 by mu vzalo i to.
  if (killState(process.env).upstream) return null;

  const config = upstreamConfigFromEnv(process.env);
  if (config === null) return null;

  const branch = upstreamBranch(config);
  const cap = WORLDSTREAM_SPEND_CAP;

  return async (request: UpstreamRequest): Promise<unknown> => {
    const call = { prompt: request.user, request };
    const reservation = await cap.reserve(branch.worstCaseUsd(call));
    if (!reservation.ok) throw new Error(`${reservation.reason}: ${reservation.detail}`);

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
    if (killState(process.env).sessions) {
      logRateLimited('worldstream/sessions', requestId, 'SESSIONS_DISABLED', 'kill switch: sessions');
      return fail(requestId, 503, 'SESSIONS_DISABLED', 'new worlds are switched off right now');
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
    if (!raw.ok)
      return fail(
        requestId,
        raw.reason === 'TOO_LARGE' ? 413 : 408,
        raw.reason,
        raw.reason === 'TOO_LARGE' ? 'the request body is too large' : 'the request body arrived too slowly',
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
        // **Věta neříká, že běží tři světy — čítač to neví.** Sloty mohou
        // držet preview druhé věty, a revize našla, že první podoba téhle
        // hlášky („all 3 … open to new worlds are in flight") pak posílá
        // operátora hledat generaci, která neexistuje. Pravda, kterou čítač
        // unese, je jediná: v letu je tolik, kolik smí držet nový svět.
        `paid slots in flight reached the ${MAX_WORLD_GENERATIONS} of ${MAX_CONCURRENT_GENERATIONS} a new world may hold on this instance`,
      );
      return fail(requestId, 503, 'TOO_MANY_SESSIONS', 'too many worlds are being built right now');
    }

    const grammar = serverGrammar();
    if (typeof grammar === 'string') {
      releaseSlot();
      logRateLimited('worldstream/sessions', requestId, 'GRAMMAR_UNREADABLE', grammar);
      return fail(requestId, 503, 'GRAMMAR_UNREADABLE', 'the frozen protocol could not be read');
    }

    const sessionId = randomUUID();
    const stored = openSession(sessionId, newSessionSeed());

    const emit = cloudEmitter();
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
    // v úložišti, ale zvednutí `capUsd` v ovládacím souboru; je to rozhodnutí
    // o penězích a patří člověku.
    //
    // `after()` doběhne i tehdy, když odpověď skončí chybou, a je omezené
    // `maxDuration` routy, ne donekonečna.
    const settled = work.finally(() => {
      releaseSlot();
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
      },
      { status: 202 },
    );
  });
}
