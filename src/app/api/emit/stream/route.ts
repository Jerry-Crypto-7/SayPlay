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
 */

import { randomUUID } from 'node:crypto';

import { withRequest } from '../../../../obs/trace';
import {
  PUBLIC_CORPUS_FAULT,
  logRateLimited,
  logStickyFault,
} from '../../../../server/public-faults';
import { emissionSteps, type EmitPhase } from '../chain';
import { readPromptId } from '../route';

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
    const parsed = await readPromptId(request, requestId, 'emit/stream');
    if (!parsed.ok) return parsed.response;

    const promptId = parsed.promptId;
    const encoder = new TextEncoder();

    /**
     * Zrušil proud ten druhý konec?
     *
     * Ptát se na to jde jen takhle. `ReadableStreamDefaultController` stav
     * nezveřejňuje a `desiredSize` vrací nulu i při obyčejném protitlaku, takže
     * by se to nedalo odlišit; sniffovat text `TypeError`u by zase záviselo na
     * hlášce běhového prostředí. `cancel()` na zdroji je jediný signál, který
     * spec dává — a přijde **dřív** než výjimka z `enqueue`, protože zrušení
     * proud nejdřív zavře a hned nato zavolá tuhle metodu.
     */
    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      async start(controller) {
        try {
          let step = 0;
          const send = (phase: EmitPhase | 'requested') => {
            step += 1;
            controller.enqueue(encoder.encode(frame('progress', { phase, step })));
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
            controller.enqueue(
              encoder.encode(
                frame('result', {
                  requestId,
                  error: {
                    code: outcome.failure.reason,
                    message: PUBLIC_CORPUS_FAULT[outcome.failure.reason],
                  },
                }),
              ),
            );
          }
          else if (outcome.kind === 'unknown-prompt')
            controller.enqueue(
              encoder.encode(
                frame('result', {
                  requestId,
                  error: {
                    code: 'UNKNOWN_PROMPT',
                    message: `no frozen create prompt named ${promptId}`,
                    field: 'promptId',
                  },
                }),
              ),
            );
          else controller.enqueue(encoder.encode(frame('result', { requestId, ...outcome.body })));

          controller.close();
        }
        catch (thrown) {
          // Odchod klienta a pád řetězu dostanou **každý svůj klíč**, jinak ten
          // častý umlčí ten vzácný — pravidlo 1 v hlavičce.
          const cause: StreamFault = cancelled ? 'STREAM_CANCELLED' : 'STREAM_FAILED';
          // **Pořadí je nosné, ne kosmetické** — pravidlo 2. Zápis musí
          // předcházet `enqueue`, protože na zrušeném proudu `enqueue` vyhodí
          // a řádek by nevznikl právě v tom případě, kvůli kterému tenhle blok
          // existuje.
          logRateLimited(
            'emit/stream',
            requestId,
            cause,
            thrown instanceof Error ? thrown.message : String(thrown),
          );
          try {
            controller.enqueue(
              encoder.encode(
                frame('result', {
                  requestId,
                  error: { code: cause, message: PUBLIC_STREAM_FAULT[cause] },
                }),
              ),
            );
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
