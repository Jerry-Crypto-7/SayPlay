/**
 * `GET /api/worldstream/sessions/:id/events` — proud relace, který jde obnovit
 * (P13 T16, §20 a §21).
 *
 * Je to druhá polovina reconnectu. První je snapshot vedle (`../route.ts`),
 * který vydá autoritativní stav jedním kusem; tenhle proud na něj navazuje
 * **od čísla, které si klient drží**, a od té chvíle už jen dopisuje. Protokol
 * §20 zní doslova „snapshot plus události za tím číslem", takže se rámce nikdy
 * nepřehrávají od nuly někomu, kdo je už viděl — a to je jediný způsob, jak se
 * po ztrátě spojení nezopakuje stavový přechod.
 *
 * ## Odkud se bere „za tím číslem"
 *
 * Dvojí, protože jsou dva druhy klientů. `EventSource` posílá při obnovení
 * hlavičku `Last-Event-ID` sám a klient o ní neví; ruční čtečka nad `fetch`
 * (`src/components/viewer/sse.ts`) hlavičky ovlivnit neumí a řekne si `?since=`.
 * **Výslovný dotaz vyhrává nad hlavičkou**, kterou dosadil prohlížeč.
 *
 * ⚠ **Nesmysl v tom čísle je 400, ne tichá nula.** Log si historii drží celou,
 * takže „nepřečetl jsem to, beru od nuly" znamená přehrát relaci od začátku
 * klientovi, který se právě obnovoval — tedy zopakovat každý stavový přechod,
 * což je přesně ta vada, kvůli které tenhle parametr existuje.
 *
 * ## Pořadí uvnitř `start()` je nosné
 *
 * `subscribe` jde **před** `since`. Mezi ta dvě volání nesmí přijít `await`:
 * kdyby se nejdřív četl backlog a teprve pak zapisoval odběr, rámec zapsaný
 * mezitím by nebyl ani v jednom a v proudu by po něm zůstala mezera. Klient ji
 * pozná (T17) a spojení zahodí, jenže to už je svět o jednu událost pozadu.
 * V opačném pořadí je nejhorší možný následek duplikát, a ten je z definice
 * neškodný: log slučuje průběh přepisem konce, takže se totéž `sequence` smí
 * objevit vícekrát i bez reconnectu a reducer to musí unést tak jako tak.
 *
 * ## Heartbeat je komentář, ne událost
 *
 * §20: „potvrzuje živé spojení, ne pokrok". Jde proto ven jako `: heartbeat`,
 * tedy rámec, který dekodér zahodí dřív, než se kohokoli zeptá — kdyby to byla
 * pojmenovaná událost, reducer by dostal rámec bez `sequence` a musel by pro
 * něj mít výjimku. Existuje kvůli tomu, že mezi `session.accepted` a
 * `intent.ready` je celé volání modelu: proud, který mlčí deset vteřin, zavře
 * kdejaká obrácená proxy a porotce uvidí přerušené demo bez jediné chyby.
 *
 * ## Kolik posluchačů smí jedna relace mít
 *
 * Do 4. 9. 2026 nekonečně, a to byly jediné dveře worldstreamu bez jakéhokoli
 * stropu (`T16-streamadmit`). `MAX_CONCURRENT_GENERATIONS` z create route sem
 * nesahá — ten počítá placená volání v letu, kdežto tohle spojení žádné
 * nedělá. Jenže **každé** spojení si založí vlastní patnáctivteřinový časovač
 * a vlastní odběr logu, takže se na každý rámec relace zapisuje N-krát;
 * `POST` je neanonymní jen v tom smyslu, že nechce přihlášení, takže jedno
 * platné `sessionId` stačí komukoli k tomu, aby si těch N vyrobil.
 *
 * Strop je proto jeden a je to konstanta v tomhle souboru:
 * `MAX_STREAM_SUBSCRIBERS` na jednu relaci. Přeplněno je **503**, ne fronta —
 * čekající SSE spojení je další časovač navíc, tedy přesně to, čemu se strop
 * vyhýbá.
 *
 * ⚠ **Druhý strop, na celý proces, se sem NEPÍŠE a je to změřené rozhodnutí.**
 * První podoba téhle úlohy ho měla (`MAX_STREAM_TOTAL = 64`) v domnění, že
 * strop na relaci součet nedrží. **Drží, přes registr:** `putSession()` volá
 * `evict()`, ten uvolní relaci přes `release()`, a `release()` na ní zavolá
 * `session.fail(SESSION_RELEASED)` (`src/worldstream/sessions.ts:129–139`) —
 * tedy koncový rámec, na kterém se tenhle proud sám zavře a slot vrátí.
 * Naměřeno sondou: 67 relací po jednom proudu drželo **64 slotů, ne 67**,
 * a 65. relace uvolnila proud té první. Součet je tedy shora omezený
 * `MAX_LIVE_SESSIONS` × `MAX_STREAM_SUBSCRIBERS` = 256 časovačů.
 *
 * Strop na proces by navrch **odmítal poctivý provoz**: při 64 živých relacích
 * po jednom divákovi by 64 slotů bylo vyčerpaných a druhá karta kterékoli
 * relace by dostala 503, přestože její vlastní strop je ze čtyř na jedné.
 *
 * ## Proud se zavírá sám, na koncové fázi
 *
 * `session.complete` a `session.failed` jsou poslední rámce relace, takže za
 * nimi se nemá na co čekat. Bez toho by čtečka držela otevřený reader do
 * timeoutu a sada by na tom čekání skončila červená — nad relací, která
 * doběhla správně.
 */

import { clearInterval, setInterval } from 'node:timers';

import { killState } from '@/server/kill-switch';

import type { SessionEvent } from '../../../../../../worldstream/events';
import { getSession } from '../../../../../../worldstream/sessions';

export const runtime = 'nodejs';

/**
 * Jak často jde do ticha komentářový rámec.
 *
 * 15 s je pod tím, co zavírají obrácené proxy (běžně 30–60 s), a řádově nad
 * tím, jak dlouho trvá kterýkoli krok generace — takže heartbeat nikdy
 * nesoutěží s událostí o to, kdo dorazí dřív.
 */
export const HEARTBEAT_MS = 15_000;

/**
 * Rámec, který potvrzuje spojení a **nic neříká o stavu**.
 *
 * Je to komentář podle spec `text/event-stream`, takže ho dekodér zahodí dřív,
 * než se na něj kdokoli zeptá. Exportovaný proto, aby se dalo pinovat právě to:
 * kdyby se z heartbeatu stala pojmenovaná událost, reducer by dostal rámec bez
 * `sequence` a proud by přestal být posloupností, o které §20 mluví.
 */
export const HEARTBEAT_FRAME = ': heartbeat\n\n';

/**
 * Kolik proudů smí naráz viset na JEDNÉ relaci.
 *
 * Čtyři, protože tolik jich uživatel vyrobí sám bez zlého úmyslu: karta,
 * duplikát karty, obnovení stránky, které starý proud ještě neuklidilo, a
 * rezerva. Pátý je už vzorec, ne provoz.
 */
export const MAX_STREAM_SUBSCRIBERS = 4;

/**
 * Kolik proudů drží která relace. Klíč se **maže na nule**, jinak by tahle
 * mapa byla táž netěsnost, kterou strop zavírá — jen o patro níž.
 */
const subscribers = new Map<string, number>();

/**
 * Vzít slot pro jeden proud. `false` = plno; kontrola i zvýšení jsou jeden
 * synchronní krok, takže mezi ně nemá co vklouznout.
 */
function acquireStream(sessionId: string): boolean {
  const held = subscribers.get(sessionId) ?? 0;
  if (held >= MAX_STREAM_SUBSCRIBERS) return false;
  subscribers.set(sessionId, held + 1);
  return true;
}

/** Slot vrátit. Musí proběhnout na **každé** cestě ven, i na chybové. */
function releaseStream(sessionId: string): void {
  const held = subscribers.get(sessionId);
  if (held === undefined) return;
  if (held <= 1) subscribers.delete(sessionId);
  else subscribers.set(sessionId, held - 1);
}

/** Jen pro testy: počty jsou proces-globální jako registr relací. */
export function resetStreamSubscribers(): void {
  subscribers.clear();
}

/** Jen pro testy: kolik relací drží aspoň jeden proud. Pinuje mazání na nule. */
export function streamedSessionCount(): number {
  return subscribers.size;
}

/** Fáze, za kterými už žádný rámec nepřijde. */
function terminal(phase: string): boolean {
  return phase === 'complete' || phase === 'failed';
}

/**
 * Rámec §20 celý, ne jen payload.
 *
 * `id:` je tam kvůli `EventSource`: prohlížeč si z něj sám složí `Last-Event-ID`
 * pro příští pokus, takže obnovení funguje i pro klienta, který o protokolu
 * neví nic. `event:` nese typ, aby se dal rámec směrovat bez parsování, a
 * `data:` nese **všech pět polí** — reducer potřebuje `sequence`, ne jen obsah.
 */
export function sessionFrame(event: SessionEvent): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

type ResumePoint =
  | { readonly ok: true; readonly after: number }
  | { readonly ok: false; readonly detail: string };

/**
 * Číslo, za kterým se navazuje — nebo věta, proč to číslo nedává smysl.
 *
 * Přísně jen číslice. `Number()` by propustil `' 12 '`, `1e3` i `0x0c`, a
 * `parseInt` by z `12abc` udělal 12, tedy tiše navázal jinde, než klient
 * myslel.
 */
export function readResumePoint(request: Request): ResumePoint {
  // **`?since=` bez hodnoty není odpověď, je to prázdné pole.** `??` by ho
  // propustilo jako přítomné (`''` není `null`), a tím by udělalo obojí naráz:
  // umlčelo `Last-Event-ID`, který klient poslal, a spadlo na `after: 0` —
  // tedy přehrálo celou relaci od začátku právě tomu, kdo se obnovoval.
  // Naměřeno nezávislou revizí 2. 9. 2026 nad `?since=` + `last-event-id: 3`:
  // proud vydal 1–5 místo 4–5.
  //
  // A hledá se **napříč všemi výskyty**, ne v prvním. `get()` vrací ten
  // první, takže `?since=&since=3` na tomtéž prázdném řetězci uvízlo znovu —
  // stejná ztráta kurzoru, jen jinými dveřmi. Doměřeno toutéž revizí.
  const query = new URL(request.url).searchParams.getAll('since').find((value) => value !== '');
  const header = request.headers.get('last-event-id');
  const raw = query ?? header;
  if (raw === null || raw === '') return { ok: true, after: 0 };

  if (!/^\d+$/.test(raw))
    return {
      ok: false,
      detail: `resume point ${JSON.stringify(raw)} is not a whole number of events`,
    };

  const after = Number(raw);
  if (!Number.isSafeInteger(after))
    return { ok: false, detail: `resume point ${raw} is larger than the stream can have reached` };

  return { ok: true, after };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  // **Vypínač první, před slotem i před registrem** — čte se `snapshots`,
  // protože tohle je druhá polovina čtení existujícího světa (sesterský
  // snapshot vedle) a ne placené volání. Vypne to jedině `all`.
  //
  // ⚠ **Zavírá to nová spojení, ne ta, která už visí.** Proud, který běží,
  // drží odběr logu a časovač a tenhle řádek se ho nezeptá; `off: ["all"]`
  // zastaví zdroj rámců (relace, refine i upstream stojí) a proudy dojedou na
  // koncové fázi nebo na odchodu klienta. Tvrdit víc by znamenalo slíbit
  // vypnutí, které se nekoná.
  if ((await killState(process.env)).snapshots)
    return Response.json(
      { error: { code: 'SERVICE_DISABLED', message: 'this deployment is switched off right now' } },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );

  const { sessionId } = await context.params;

  const resume = readResumePoint(request);
  if (!resume.ok)
    return Response.json(
      { error: { code: 'BAD_RESUME_POINT', message: resume.detail } },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  const after = resume.after;

  const stored = getSession(sessionId);
  if (stored === null)
    return Response.json(
      {
        error: {
          code: 'UNKNOWN_SESSION',
          message: 'no session with that id is being served by this process',
        },
      },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    );

  // **Slot až tady, za 400 i za 404.** Odmítnutý požadavek nesmí obsadit
  // místo, které pak nikdo nevrátí — a obě větve nad tímhle řádkem se vracejí
  // dřív, než by měly co uklízet.
  if (!acquireStream(sessionId))
    return Response.json(
      {
        error: {
          code: 'TOO_MANY_STREAMS',
          message: `this session already has the ${MAX_STREAM_SUBSCRIBERS} listeners it may have on this instance`,
        },
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );

  const log = stored.session.events;
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  let holdsSlot = true;

  function release(): void {
    unsubscribe?.();
    unsubscribe = null;
    if (beat !== null) clearInterval(beat);
    beat = null;
    // **Slot se vrací právě jednou.** `release()` chodí ze čtyř míst (cancel,
    // abort, koncová fáze, selhaný zápis) a je schválně idempotentní; bez téhle
    // závory by dvě z nich stroj počítadla poslaly pod nulu a strop by přestal
    // držet po prvním obyčejném odchodu diváka.
    if (holdsSlot) {
      holdsSlot = false;
      releaseStream(sessionId);
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      release();
    },

    start(controller) {
      let open = true;

      /** Zavře proud jednou, ať přijde konec relace odkudkoli. */
      function finish(): void {
        if (!open) return;
        open = false;
        release();
        controller.close();
      }

      /**
       * Zápis, který přežije odchod protistrany.
       *
       * `enqueue` na zrušeném proudu vyhodí, a tahle funkce běží i z odběru
       * logu — nechat tu výjimku proletět znamená, že odchod jednoho diváka
       * shodí zápis do logu, a tím generaci pro všechny ostatní.
       */
      function write(chunk: string): void {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          open = false;
          release();
        }
      }

      // **Odběr první, backlog druhý, mezi nimi žádný `await`** — viz hlavička.
      unsubscribe = log.subscribe((event) => {
        write(sessionFrame(event));
        if (terminal(stored.session.phase)) finish();
      });

      for (const event of log.since(after)) write(sessionFrame(event));

      // Relace, která doběhla dřív, než se klient připojil: backlog je celý
      // příběh a čekat na další rámec by znamenalo čekat navždy.
      if (terminal(stored.session.phase)) {
        finish();
        return;
      }

      beat = setInterval(() => write(HEARTBEAT_FRAME), HEARTBEAT_MS);
      // Otevřený proud nesmí být důvod, proč proces (nebo běh sady) neskončí.
      beat.unref();
    },
  });

  // **Druhé dveře k úklidu, ne opis těch prvních.** `cancel()` na proudu zavolá
  // až ten, kdo proud čte — a `next` ho podle `dist/server/pipe-readable.js`
  // nezačne číst vůbec, když je odpověď v tu chvíli už zničená. Požadavek
  // useknutý dřív, než se čtení rozjelo, by tedy nechal běžet časovač i odběr
  // logu do restartu procesu, a to je stav, který si nechráněná route umí
  // vyrobit sama tolikrát, kolikrát ji někdo zavolá. Nález nezávislé revize
  // 2. 9. 2026. `release()` je idempotentní, takže dvoje dveře nevadí.
  //
  // ⚠ **Až za konstruktorem, a s dotazem na `aborted`.** `start()` běží
  // synchronně uvnitř `new ReadableStream`, takže dřív tu ještě není co
  // uklidit — `release()` by proběhl naprázdno a odběr by po něm teprve
  // vznikl. A na signálu, který dorazil zrušený, se `abort` už nikdy
  // nevystřelí: posluchač zaregistrovaný na hotovou událost nedostane nic,
  // takže by odběr i patnáctivteřinový časovač přežily požadavek, který se
  // nikdy nezačal číst. Doměřeno nezávislou revizí 2. 9. 2026 nad předem
  // zrušeným signálem (stav 200, odběr zapsaný, úklid neproběhl).
  if (request.signal.aborted) release();
  else request.signal.addEventListener('abort', () => release(), { once: true });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      // `no-transform` je tu ze stejného naměřeného důvodu jako
      // v `/api/emit/stream`: bez něj `next start` rámce sbalí gzipem a zlib je
      // drží, dokud nenaplní vyrovnávací paměť — průběh pak dorazí naráz.
      'cache-control': 'no-store, no-transform',
      // A tohle je proti obrácené proxy, ne proti kompresi v procesu.
      'x-accel-buffering': 'no',
    },
  });
}
