/**
 * `POST /api/emit/stream` — tentýž verdikt jako `/api/emit`, ale s průběhem.
 *
 * Emise projde šesti kroky a ten poslední (replay svědka) je z nich zdaleka
 * nejdražší. Bez kanálu s průběhem stojí viewer nad prázdným plátnem a jediné,
 * co může ukázat, je točící se kolečko — což je přesně ta obrazovka, kterou si
 * `DESIGN-BOOK.md` §13.4 zakazuje.
 *
 * **Verdikt je tentýž objekt**, jaký vrací `POST /api/emit`, jen jede jako
 * poslední rámec. Řetěz je jeden (`../chain.ts`), takže se ty dvě cesty nemají
 * jak rozejít.
 *
 * ## Proč se streamuje POSTem a ne přes `EventSource`
 *
 * `EventSource` umí jen GET, a emise se vyvolává tělem s `promptId`. Klientská
 * polovina je proto `fetch` a ruční dekodér v `src/components/viewer/sse.ts`.
 *
 * ## Mezi kroky se pouští smyčka událostí, a je to nosná část
 *
 * Řetěz je čistě synchronní. Kdyby se protočil vcelku, všechny rámce by se
 * zařadily do fronty proudu dřív, než by kterýkoli opustil socket — průběh by
 * dorazil naráz s verdiktem a kanál by byl jen na oko. `emissionSteps` je proto
 * generátor a tahle smyčka mezi jeho kroky uvolní smyčku událostí, takže rámec
 * skutečně odejde dřív, než začne replay.
 *
 * ## Uvnitř `start()` musí každá cesta skončit rámcem, ne tichem
 *
 * Oprava korelované odpovědi z `readPromptId()` platí jen do chvíle, než se
 * odešlou hlavičky. Za nimi je stav **200** a `content-type` už u klienta, takže
 * výjimka vyhozená uvnitř `start()` nemá kam vyletět: framework ji nevidí (proud
 * ji spolkne), klient dostane přerušené tělo a operátor **nula řádků**. Zvenčí
 * je to nerozeznatelné od úspěchu až do okamžiku, kdy nic nepřijde — a klient
 * nemá ani co odcitovat, protože `requestId` nese výhradně rámec `result`, tedy
 * ten, který nedorazil. Naměřeno nezávislou revizí 1. 9. 2026.
 *
 * Tělo `start()` je proto celé v `try`, a v `catch` platí tři pravidla:
 *
 * 1. **Zrušený proud se počítá zvlášť od spadlého.** `logRateLimited` klíčuje
 *    `(dveře, kód)` a vydá 1., 10., 100. výskyt — takže kdyby obě příčiny
 *    sdílely jeden kód, **první odchod klienta by spotřeboval výskyt číslo
 *    jedna** a skutečný pád hned po něm by byl druhý, tedy žádný řádek. Odchod
 *    klienta přitom není porucha a děje se pořád: `Viewer.tsx` volá `abort()`
 *    při každé změně `promptId` i při odchodu ze stránky, a `reactStrictMode`
 *    to ve vývoji zdvojí. Nález nezávislé revize 1. 9. 2026, `VERDICT: blocking`
 *    — bez rozdělení kódu tahle oprava tentýž stav, který zavírá, vyrábí zpátky
 *    obyčejným proklikáním.
 *
 *    ⚠ **Rozděluje je to, co vyhodilo — nikdy stav proudu.** První podoba téhle
 *    opravy se ptala vlajky nastavené z `cancel()`, a to je špatná otázka: stav
 *    proudu říká, *co se stalo proudu*, ne *co vyhodilo*, a v tomhle okně se ty
 *    dvě věci rozcházejí. Klient odejde a hned nato spadne řetěz → vlajka řekne
 *    „zrušení", pád dostane nálepku běžného provozu a protože každé proklikání
 *    týž klíč posouvá, po pár kliknutích se zahodí úplně. Naměřeno druhou
 *    nezávislou revizí 1. 9. 2026, `VERDICT: blocking`.
 *
 *    Odpověď je proto **sentinel**: jediné místo, které smí říct „zrušeno", je
 *    `write()` níž, tedy obal kolem `enqueue`. Když `enqueue` vyhodí, proud
 *    nikdo nedrží — to je definice zrušení a nedá se splést s ničím jiným.
 *    Cokoli jiného je pád. Vlajka z `cancel()` tím **zanikla**: kdyby zůstala
 *    jako křížová kontrola, byla by to druhá odpověď na tutéž otázku a příští
 *    revize by řešila, která z nich platí.
 *
 *    **Obal musí být kolem každého `enqueue`, ne jen kolem `send()`.** Sondou
 *    naměřeno 3. 9. 2026: zápisů rámců je v `start()` pět, a návrh „sentinel
 *    ze `send()`" by pokryl jeden. Zrušení, které dorazí během posledního
 *    `flush()`, potká až `enqueue` rámce `result` — tedy jednu ze tří větví
 *    verdiktu — a to by byl týž falešný poplach o kus vedle.
 * 2. **Řádek operátorovi jde první, `enqueue` až po něm.** Na proudu, který
 *    protistrana zrušila, `enqueue` vyhodí — kdyby byl zápis až za ním, právě
 *    ten případ, o kterém se operátor potřebuje dozvědět, by řádek nevyrobil
 *    vůbec.
 * 3. **`logRateLimited`, ne `logStickyFault`.** Lepivá mez klíčuje `detail`,
 *    a `detail` je tady **text výjimky, tedy hodnota bez uzavřeného oboru**:
 *    každý nový `throw` kdekoli v řetězu je nová hodnota, takže by velikost
 *    `STICKY_LOGGED` byla funkcí cest v kódu, ne velikosti korpusu, který ji
 *    dnes shora omezuje. `logRateLimited` klíčuje dvěma kódy níž a text jen
 *    tiskne. **Není to o volajícím** — revize 1. 9. 2026 změřila, že `promptId`
 *    se porovná se zmrazenými id dřív, než se dostane kamkoli, odkud by mohl
 *    vyletět, takže do textu výjimky nic zvenčí neteče.
 *
 *    ⚠ **Ta volba platí dál, ale jeden její důsledek se 1. 9. 2026 změnil.**
 *    `logRateLimited` od té doby vydá i **první výskyt každé nové příčiny
 *    v okně**, nejvýš `MAX_DETAILS_PER_WINDOW` na okno. Dva různé pády v jednom
 *    procesu proto dají **dva** řádky, ne jeden. Námitka výš tím nepadá — mířila
 *    na *lepivou* množinu, která neroste s ničím a nikdy se nezahodí; tenhle
 *    rozpočet je konstanta na okno. A padnout by neměla ani ta premisa: dva
 *    různé pády jsou dvě různé poruchy a operátor o obou potřebuje vědět.
 *
 * `requestId` se do rámců `progress` **nepřidává**, ačkoli si o to nález říkal.
 * S tímhle `try/catch` neexistuje stav, kdy klient dostane `progress` a nikdy
 * `result`, takže by to byla změna kontraktu bez následku, který by zavírala.
 *
 * ## Proud, který nikdo nezačne číst
 *
 * Sentinel z `enqueue` výš zavírá jen ten případ, kdy proud **někdo číst
 * začal** a pak odešel: `pipeTo` proud errorovalo a další `enqueue` vyhodí.
 * Existuje ale druhé okno, ve kterém se `enqueue` nikdy nezeptá — a to je celé
 * ticho, které tenhle odstavec zavírá.
 *
 * `pipeToNodeResponse` se vrátí **předčasně**, když je odpověď v okamžiku
 * napojení už `errored || destroyed`
 * (`node_modules/next/dist/server/pipe-readable.js:120–124`). `pipeTo` se pak
 * nezavolá vůbec, proud se nezačne číst, a `enqueue` proto neselže: fronta
 * jen roste, `close()` projde a `start()` doběhne **bez jediné výjimky**.
 * Nikam nedorazí nic a nevznikne ani řádek.
 *
 * **Naměřeno 3. 9. 2026 nad `next build && next start`, Next 16.3.0**, a měření
 * rozhodlo mezi „zúžit tvrzení hlavičky" a „zavřít cestu" ve prospěch toho
 * druhého:
 *
 * 1. **`request.signal` v Node routě opravdu drží spojení.** Devět běhů se
 *    syrovým socketem zničeným 0–30 ms po odeslání požadavku: pokaždé se uvnitř
 *    `start()` přepnul na `aborted=true`. Vyrábí ho `signalFromNodeResponse()`
 *    nad **týmž** `res`, který o kus dál kontroluje `pipeToNodeResponse` — takže
 *    v tom okně, kde ta funkce mlčky odejde, je signál už zrušený.
 * 2. **V těch devíti bězích se ale nic neztratilo**: `pipeTo` stihlo začít,
 *    `enqueue` vyhodilo a sentinel zabral. Nové kontrole tam nezbylo co
 *    opravovat — nezměnila ani jednu nálepku.
 * 3. **Tiché okno se reprodukuje jednotkově, a je úplně tiché:** požadavek,
 *    jehož spojení zmizí po vstupu do routy a jehož tělo nikdo nečte, dnes
 *    vrátí 200, zařadí všech osm rámců do fronty, kterou nikdo nevybírá,
 *    a nechá **nula řádků**. To je stav, kvůli kterému tenhle soubor existuje,
 *    jen o jedno okno dál.
 *
 * ⚠ **„Spojení mrtvé už při vstupu" se sem ale nepočítá, a je to naměřené.**
 * Nález nezávislé revize 3. 9. 2026, `VERDICT: routed`, CONFIRMED spuštěním.
 * Když `signalFromNodeResponse()` vrátí rovnou zrušený signál, Next tomu
 * požadavku **zahodí tělo** — `...signal.aborted ? {} : { body }`
 * (`node_modules/next/dist/server/web/spec-extension/adapters/next-request.js:114`).
 * `readPromptId()` proto dostane prázdné tělo, odpoví **400** a `start()` se
 * nepostaví vůbec. Je to jiné ticho než tohle a **tahle kontrola ho nezavírá**:
 * 400 je korelovaná odpověď na nevalidní tělo, ne porucha, takže řádek
 * nedluží. Zavřít se dá jedině okno, do kterého se emise skutečně dostane —
 * tedy odchod **po** vstupu do routy.
 *
 * Cena opravy je proto **jedno čtení booleanu na rámec** a jde přes jediný
 * trychtýř: `write()` je pět zápisů rámců v `start()` v jednom místě. Za to se
 * ticho vymění za tutéž nálepku `STREAM_CANCELLED`, jakou dostane odchod
 * klienta jinou cestou — je to táž událost, jen zjištěná dřív.
 *
 * ⚠ **Pravidlo „rozděluje je to, co vyhodilo" tím nepadá, a je to ten důvod,
 * proč kontrola sedí ve `write()` a ne v `catch`.** Signál není stav proudu,
 * je to stav **spojení**, a ptá se ho **předpoklad zápisu**, ne klasifikátor
 * poruchy: `catch` pořád soudí výhradně podle toho, jestli přiletěl sentinel.
 * Řetěz, který spadne **na první operaci za odchodem klienta**, vyhodí ze
 * `steps.next()`, tedy mimo `write()` — a zůstává `STREAM_FAILED`. Přesně to
 * pinuje test „pád řetězu po zrušeném spojení je pořád pád, ne zrušení", nově
 * i nad požadavkem, který signál doopravdy nese.
 *
 * ⚠ **Dál než na tu první operaci to tvrzení nesahá, a nemá.** Nález nezávislé
 * revize 3. 9. 2026, `VERDICT: routed`, CONFIRMED spuštěním: když řetěz po
 * odchodu klienta ještě stihne vydat další fázi, potká zrušení nejdřív
 * `write()` toho `progress` a nálepka je `STREAM_CANCELLED` — pád, který by
 * přišel o kolo později, se už neohlásí. **Odchod klienta tedy předběhne
 * jakýkoli pozdější pád řetězu, a je to vědomé:** v okně, kde `pipeTo` už
 * běželo, to tak fungovalo i před touhle opravou, protože `enqueue` na
 * errorovaném proudu vyhodí dřív, než se řetěz dostane k pádu. Kontrola
 * signálu tím nevyrábí nové chování, jen ho rozšiřuje na okno, kde se
 * `enqueue` nikdy nezeptá. Rozhodující je pořád **co vyhodilo**; mění se jen
 * to, kdy se ten sentinel vyrobí.
 *
 * **Za posledním zápisem se signál nekontroluje a nemá to díru:** mezi
 * `write('result', …)` a `controller.close()` není `await`, takže se do toho
 * okna žádné zrušení nemá jak vejít. Kontrola u `close()` by tedy nic
 * nezavřela a jen by přidala druhé místo, které umí říct „zrušeno".
 */

import { randomUUID } from 'node:crypto';

import { withRequest } from '../../../../obs/trace';
import {
  PUBLIC_CORPUS_FAULT,
  logRateLimited,
  logStickyFault,
} from '../../../../server/public-faults';
import { callerKey, rateLimitCode, rateLimitedResponse, takeRateSlot } from '../../../../server/rate-limit';
import { emissionSteps, type EmitPhase } from '../chain';
import { readPromptId, replayDisabled } from '../route';

export const runtime = 'nodejs';

/**
 * Dvě příčiny, kvůli kterým proud skončí bez verdiktu — a **jsou to dva různé
 * stavy, ne dvě jména téhož**.
 *
 * `STREAM_CANCELLED` je odchod protistrany: běžný, častý a ničí porucha.
 * `STREAM_FAILED` je pád řetězu: vzácný a jediný, kvůli kterému má operátor
 * vstávat. Sdílený kód by z toho prvního udělal umlčovač toho druhého — viz
 * pravidlo 1 v hlavičce.
 */
type StreamFault = 'STREAM_CANCELLED' | 'STREAM_FAILED';

/**
 * Co se o pádu proudu řekne **ven**.
 *
 * Bez čísel, cest a jmen, ze stejného důvodu jako `PUBLIC_CORPUS_FAULT`: text
 * výjimky je diagnostika serveru a patří do operátorova logu, ne do rámce, který
 * čte neověřený volající. Ven jde `requestId`, aby šla ta dvojice spárovat.
 *
 * `Record<StreamFault, string>` znovu kvůli **úplnosti**: nová příčina bez
 * veřejného textu neprojde přes `tsc`.
 */
const PUBLIC_STREAM_FAULT: Record<StreamFault, string> = {
  STREAM_CANCELLED: 'the stream was cancelled before the verdict was ready',
  STREAM_FAILED: 'the stream failed before the verdict was ready',
};

/**
 * „Rámec se nedal zařadit, protože proud už nikdo nedrží."
 *
 * Je to **jediný** zdroj nálepky `STREAM_CANCELLED` a vyhazuje ho výhradně
 * `write()`. Symbol proto, aby se nedal splést s ničím, co přiletí z řetězu:
 * na rozdíl od třídy chyby nebo textu hlášky ho nemá jak vyrobit nikdo jiný.
 *
 * Naměřeno v Node 3. 9. 2026: `enqueue` na zrušeném proudu vyhodí
 * `TypeError: Invalid state: Controller is already closed`. Ta hláška se
 * **nesniffuje** — je to text běhového prostředí, ne kontrakt. Sentinel se
 * neptá čím `enqueue` selhal, jen že selhal, a to stačí: proud, do kterého
 * nejde zapsat, nemá druhé vysvětlení.
 */
const STREAM_CLOSED = Symbol('the other end went away');

/**
 * **Čím se rozbité potrubí pozná od změřeného světa** — strojově, ne tím, že
 * v rámci „nějak chybí `doc`".
 *
 * `POST /api/emit` tuhle informaci nese **stavovým kódem**: 503 „o takovém
 * běhu se nesmí nic skórovat", 404 neznámý prompt, 200 verdikt. Proud ji tak
 * nést nemůže — v okamžiku, kdy se kterákoli z těch věcí pozná, jsou hlavičky
 * i stav **200** dávno u klienta a zpátky se vzít nedají. Ty dveře by tím
 * jinak o téže situaci říkaly opak než dveře vedle.
 *
 * Jede proto v těle rámce a je to **uzavřený seznam**, který na ty stavové
 * kódy jedna ku jedné mapuje:
 *
 * | `resultKind` | `/api/emit` | Smí se z toho skórovat? |
 * |---|---|---|
 * | `verdict` | 200 | **ano**, je to změřený svět |
 * | `unknown-prompt` | 404 | ne, nikdo takový prompt nezná |
 * | `unavailable` | 503 | ne, rozbité prostředí |
 * | `stream-fault` | *nemá obdobu* | ne, rozbité potrubí |
 *
 * Poslední řádek je ten, kvůli kterému to vzniklo: pád nebo zrušení proudu je
 * porucha **kanálu**, ne výsledek světa. Bez tohohle pole vypadá v číslech
 * jako svět, který se prostě nepovedl — a to je přesně ten rozdíl, kvůli
 * kterému `EmissionOutcome` odlišuje `unavailable` od verdiktu.
 */
type ResultKind = 'verdict' | 'unknown-prompt' | 'unavailable' | 'stream-fault';

function frame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Uvolní smyčku událostí, aby zařazený rámec stihl odejít. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();

  return withRequest(requestId, async () => {
    // **Vypínač úplně první, ještě před tělem — a hlavně před proudem.**
    // Odůvodnění je u `replayDisabled()` v `../route.ts`; tady navíc platí,
    // že vypnuté dveře musí odmítnout **obyčejnou odpovědí**. Za hlavičkami
    // `text/event-stream` je stav 200 dávno u klienta a 503 se už poslat nedá,
    // takže brána o kus níž by uměla leda rámec `stream-fault` — tedy vypnutí
    // vydávané za poruchu potrubí.
    const disabled = await replayDisabled(requestId, 'emit/stream');
    if (disabled !== null) return disabled;

    // **Strop na frekvenci hned za vypínačem a pořád před proudem** — z téhož
    // důvodu, kvůli kterému je před ním vypínač: za hlavičkami
    // `text/event-stream` je stav 200 u klienta a 429 se poslat nedá. Tyhle
    // dveře stojí navíc celý replay svědka, tedy nejdražší krok emise.
    const slot = takeRateSlot('emit/stream', callerKey(request));
    if (!slot.allowed) {
      logRateLimited(
        'emit/stream',
        requestId,
        rateLimitCode(slot),
        `${String(slot.count)} in window`,
      );
      return rateLimitedResponse(requestId, slot);
    }

    const parsed = await readPromptId(request, requestId, 'emit/stream');
    if (!parsed.ok) return parsed.response;

    const promptId = parsed.promptId;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        /**
         * Jediná cesta, kterou z `start()` odchází rámec — a tím i jediné
         * místo, které umí říct „zrušeno".
         *
         * Bajty se skládají **před** oběma kontrolami, aby se do sentinelu
         * nedostalo selhání `JSON.stringify`. To je pád jako každý jiný
         * a nálepku zrušení si nezaslouží.
         *
         * Zrušení se pozná ze **dvou** různých věcí, protože provoz vyrábí dva
         * různé stavy — viz „Proud, který nikdo nezačne číst" v hlavičce:
         *
         * - `request.signal` je zrušený → spojení je pryč a rámec nemá kam jít,
         *   i kdyby se zařadil. Tohle je jediná cesta, jak se dá poznat proud,
         *   který se **vůbec nezačal číst**.
         * - `enqueue` vyhodí → proud je errorovaný, tedy `pipeTo` běželo
         *   a skončilo.
         */
        const write = (event: string, payload: unknown): void => {
          const bytes = encoder.encode(frame(event, payload));
          if (request.signal.aborted) throw STREAM_CLOSED;
          try {
            controller.enqueue(bytes);
          }
          catch {
            throw STREAM_CLOSED;
          }
        };

        try {
          let step = 0;
          const send = (phase: EmitPhase | 'requested') => {
            step += 1;
            write('progress', { phase, step });
          };

          send('requested');
          await flush();

          const steps = emissionSteps(promptId);
          let next = steps.next();
          while (!next.done) {
            send(next.value);
            await flush();
            next = steps.next();
          }
          const outcome = next.value;

          if (outcome.kind === 'unavailable') {
            // Týž ořez jako u `/api/emit`, jen jinou trubkou. Rámec proudu je
            // odpověď jako každá jiná — že jde po kouscích, na kořist nic nemění.
            // A **týž bound**: vada korpusu je jeden stav, tedy jeden řádek.
            logStickyFault('emit/stream', requestId, outcome.failure.reason, outcome.failure.detail);
            write('result', {
              requestId,
              resultKind: 'unavailable' satisfies ResultKind,
              error: {
                code: outcome.failure.reason,
                message: PUBLIC_CORPUS_FAULT[outcome.failure.reason],
              },
            });
          }
          else if (outcome.kind === 'unknown-prompt')
            write('result', {
              requestId,
              resultKind: 'unknown-prompt' satisfies ResultKind,
              error: {
                code: 'UNKNOWN_PROMPT',
                message: `no frozen create prompt named ${promptId}`,
                field: 'promptId',
              },
            });
          // Diskriminátor jde **za** rozbalením těla, aby ho verdikt nemohl
          // přepsat: o tom, jestli je tohle změřený svět, rozhoduje tahle routa,
          // ne obsah, který jí přišel z řetězu.
          else write('result', { requestId, ...outcome.body, resultKind: 'verdict' satisfies ResultKind });

          controller.close();
        }
        catch (thrown) {
          // Odchod klienta a pád řetězu dostanou **každý svůj klíč**, jinak ten
          // častý umlčí ten vzácný — pravidlo 1 v hlavičce. A rozhoduje o tom
          // **co vyhodilo**: sentinel umí vyrobit jedině `write()`, tedy
          // selhané `enqueue`. Všechno ostatní přiletělo z řetězu, i kdyby
          // protistrana mezitím odešla.
          const closed = thrown === STREAM_CLOSED;
          const cause: StreamFault = closed ? 'STREAM_CANCELLED' : 'STREAM_FAILED';
          // **Pořadí je nosné, ne kosmetické** — pravidlo 2. Zápis musí
          // předcházet `enqueue`, protože na zrušeném proudu `enqueue` vyhodí
          // a řádek by nevznikl právě v tom případě, kvůli kterému tenhle blok
          // existuje.
          logRateLimited(
            'emit/stream',
            requestId,
            cause,
            // Sentinel je symbol a `String()` by z něj udělal šum. Text zrušení
            // je konstanta, protože zrušení žádnou diagnostiku nenese.
            closed ? 'the other end went away' : thrown instanceof Error ? thrown.message : String(thrown),
          );
          try {
            write('result', {
              requestId,
              resultKind: 'stream-fault' satisfies ResultKind,
              error: { code: cause, message: PUBLIC_STREAM_FAULT[cause] },
            });
            controller.close();
          }
          catch {
            // Proud už nikdo nedrží — řádek výš je jediná stopa, která zbyla,
            // a to je přesně ten důvod, proč jde první. U `STREAM_CANCELLED` je
            // to dokonce normální průběh: rámec nemá komu dorazit.
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        // **`no-transform` je nosné, ne opis `no-store`.** `next start` prohání
        // každou odpověď svou vestavěnou kompresí a `text/event-stream` spadne
        // pod pravidlo `^text/`, takže se zabalí gzipem — a zlib pak malé rámce
        // drží, dokud nenaplní svou vyrovnávací paměť. Naměřeno: sedm rámců
        // psaných po 30 ms odešlo jako jeden kus po 243 ms, tedy přesně to
        // „průběh dorazí naráz s verdiktem", proti kterému je tenhle soubor
        // napsaný. Komprese `no-transform` respektuje.
        'cache-control': 'no-store, no-transform',
        // Tohle je proti obrácenému proxy, ne proti kompresi v procesu — jeden
        // druhého nenahrazuje a bez obou je průběh k ničemu.
        'x-accel-buffering': 'no',
      },
    });
  });
}
