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
 * ## Proč je to mez na PROCES, ačkoli plán psal sdílený obchod
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
 * ⚠ **Co tenhle soubor tedy NEDĚLÁ a nesmí se to nikde tvrdit:** neomezuje
 * součet požadavků přes celé nasazení. Strop platí na instanci, takže flotila
 * o N instancích propustí N násobek — a útočník, kterého vercelský router
 * rozhodí po instancích, si toho N koupí. Zavřít tohle znamená sdílený čítač
 * a ten síťový let; je to routovaná úloha `T28-fleetrate` a **rozhoduje ji
 * uživatel**, protože platí latencí na hlavní cestě.
 *
 * ## Pevné okno, ne klouzavé
 *
 * Klouzavé okno je přesnější a drží frontu časů na požadavek. Pevné okno drží
 * **dvě čísla na dveře** a nejhorší případ je dvojnásobek stropu na hranici
 * dvou oken (49 požadavků na konci jednoho a 50 na začátku druhého). Ten
 * dvojnásobek je pořád **řádově** pod tím, co instanci zastaví, a paměť meze
 * neroste s provozem — což je u obrany proti náporu ta důležitější vlastnost.
 */

/**
 * Délka okna a strop v něm.
 *
 * **Odvozené z naměřeného p95, ne vybrané:** 50 požadavků za 10 s je 5 za
 * sekundu, tedy 5 × 27,7 ms ≈ **138 ms práce na každou sekundu smyčky**, což je
 * 14 % jedné instance. Zbytek zůstává SSE proudům a preview. Dveře jsou troje,
 * takže strop v součtu je 15 požadavků za sekundu — pořád **čtyřikrát pod**
 * naměřenou hranicí ~66/s, kde se instance zastaví.
 *
 * Shora to drží ruka porotce: člověk, který píše věty a kliká, nevyrobí ani
 * jeden požadavek za sekundu, takže mez nesmí kousnout jeho.
 */
export const RATE_WINDOW_MS = 10_000;
export const MAX_REQUESTS_PER_WINDOW = 50;

/** Dveře, které se omezují. Ne řetězec: překlep by tiše založil čtvrté okno. */
export type RateLimitedDoor = 'edit' | 'emit' | 'sessions';

export interface RateVerdict {
  readonly allowed: boolean;
  /** Kolikátý požadavek to v tomhle okně je. */
  readonly count: number;
  readonly limit: number;
  /** Za kolik sekund se okno otočí. Jde do `retry-after`. */
  readonly retryAfterSeconds: number;
}

interface Window {
  /** Začátek okna, zaokrouhlený na násobek `RATE_WINDOW_MS`. */
  startedAtMs: number;
  count: number;
}

/**
 * Okna visí na `globalThis`, ne na modulu — týž naměřený důvod jako u procesové
 * účetní knihy v `src/server/spend-store.ts`: Next umí postavit víc grafů
 * modulů a modulová proměnná by pak počítala jen uvnitř jednoho z nich, tedy
 * pod mezí, která má chránit celou instanci.
 */
const WINDOWS_KEY = '__worldsmithRateWindows';

function windows(): Map<RateLimitedDoor, Window> {
  const holder = globalThis as Record<string, unknown>;
  holder[WINDOWS_KEY] ??= new Map<RateLimitedDoor, Window>();
  return holder[WINDOWS_KEY] as Map<RateLimitedDoor, Window>;
}

/**
 * Vzít jeden požadavek na těch dveřích a říct, jestli se smí obsloužit.
 *
 * **Počítá se i odmítnutý požadavek** — schválně. Kdyby se počítaly jen
 * propuštěné, útočník držící mez na maximu by dostal na začátku každého okna
 * čerstvý strop a odmítnutí by ho nic nestálo; takhle okno doběhne do konce.
 *
 * `nowMs` se předává schválně, ne čte uvnitř: bez toho se mez nedá otestovat
 * jinak než čekáním deseti sekund, a test, který trvá deset sekund, se přestane
 * pouštět. Wall-clock je tu legální — do hashovaného stavu z těchhle dveří
 * nevstupuje nic (`CLAUDE.md`, zákaz platí na replay cestě).
 */
export function takeRateSlot(door: RateLimitedDoor, nowMs: number = Date.now()): RateVerdict {
  const open = windows();
  const startedAtMs = Math.floor(nowMs / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  const current = open.get(door);
  const window: Window =
    current !== undefined && current.startedAtMs === startedAtMs
      ? current
      : { startedAtMs, count: 0 };

  window.count += 1;
  open.set(door, window);

  return {
    allowed: window.count <= MAX_REQUESTS_PER_WINDOW,
    count: window.count,
    limit: MAX_REQUESTS_PER_WINDOW,
    // Zbytek okna **nahoru** na celé sekundy. Nula z toho vyjít nemůže a
    // nehlídá se: `startedAtMs` je zaokrouhlené dolů, takže zbytek je vždycky
    // větší než nula a horní zaokrouhlení z něj udělá aspoň jedničku. Dolní by
    // vydalo „opakuj za nula sekund", tedy pozvánku zpátky do téhož odmítnutí.
    retryAfterSeconds: Math.ceil((startedAtMs + RATE_WINDOW_MS - nowMs) / 1000),
  };
}

/** Hotová odpověď na překročený strop. Týž tvar chyby jako všechny dveře. */
export function rateLimitedResponse(requestId: string, verdict: RateVerdict): Response {
  return Response.json(
    {
      requestId,
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: `too many requests: at most ${String(verdict.limit)} per ${String(
          RATE_WINDOW_MS / 1000,
        )} seconds`,
      },
    },
    { status: 429, headers: { 'retry-after': String(verdict.retryAfterSeconds) } },
  );
}

/** Jen pro testy: okna jsou proces-globální jako čítač souběžných generací. */
export function resetRateWindows(): void {
  windows().clear();
}
