/**
 * `POST /api/emit` — emise celého světa proti zmrazenému promptu.
 *
 * Řetěz sám leží v `chain.ts`, protože ho vedle tohohle endpointu čte i jeho
 * SSE varianta (`stream/route.ts`); pořadí kroků je součást kontraktu a druhá
 * kopie by byla druhé místo, kde se dá změnit. Tady zbývá čtení těla a překlad
 * verdiktu na `Response`.
 *
 * ## Co je chyba a co je výsledek
 *
 * **400** vrací jen **nevalidní požadavek** — tělo, které není `{ promptId }`.
 * **404** neznámý zmrazený prompt. **408** tělo, které nedorazilo do
 * `BODY_DEADLINE_MS`. **413** tělo přes strop. **503** nečitelný
 * nebo podvržený zmrazený korpus — rozbité prostředí, o kterém se nesmí nic
 * skórovat — a od `T28-killemit` taky **vypnutý provoz** (`REPLAY_DISABLED`,
 * jedině na `off: ["all"]`). Všechno ostatní je **200 s verdiktem**: emise, která neprošla
 * schématem, nese osiřelý odkaz, nejde snížit nebo její svědek nedojde do výhry,
 * je *naměřený výsledek*, ne chyba serveru. Kdyby se z toho dělalo 5xx, měřicí
 * běh v T17 by nerozeznal vadný svět od spadlého potrubí — a přesně to je
 * rozdíl, který má celý P1 změřit.
 *
 * `rejection.stage` proto nese **atribuci**: `lowering` znamená mez naší
 * reprezentace, `references` a `schema` vadu emise, `witness` nedosažitelnou
 * výhru, `declined` poctivé systémové odmítnutí `sim` části. Scorer v T16 na
 * tom stojí.
 *
 * ## Odmítnutí se vztahuje na `sim`, nikdy na scénu
 *
 * Zmrazený protokol to říká jednou větou a platí pro **všechna** odmítnutí, ne
 * jen pro `NO_FIT`: *„`NO_FIT` a necertifikovaný patch se vztahují VÝHRADNĚ na
 * `sim`"* (`look.emptyScreenRule`, §13.4). Odpověď proto vždy nese `emission` —
 * oloupaný dokument tak, jak přišel — takže `look` i emitovaná `sim` přežijí
 * i odmítnutí, které se stalo dřív, než mohl vzniknout `doc`. Bez toho přišly
 * `C12` a `C13` o scénu i o entity, ze kterých se skórují jejich vlastní
 * požadavky (`sceneMustBuild`, `minEntitiesByRole`).
 *
 * `doc` má oproti tomu užší význam a nechává si ho: **zapečetěný dokument**,
 * který prošel schématem. `null` znamená „nevznikl", ne „scéna se ztratila".
 *
 * ## Anotace obálky
 *
 * `simOutcome`, `refusedBeforeModel` a `clampedFrom` jedou **vedle** dokumentu
 * (`ENVELOPE_ANNOTATIONS` ve `worlddoc.ts`) a řetěz je oloupe dřív, než
 * cokoli validuje. Jmenovitá větev na dvou z nich tuhle třídu nezavřela —
 * pole navíc nesou **4 z 15** zmrazených create emisí, ne 2.
 *
 * ## Část vzhledu
 *
 * Zmrazený protokol (`look.p1Status`) říká, že v P1 vzhled emituje **systém**,
 * ne model. Zmrazené odpovědi ho nesou, protože je autorovala T2 jako systémový
 * default — řetěz ho tedy jen validuje schématem a kontrolou konečnosti všech
 * číselných hodnot a připojí nezměněný. Tvrzení „scénu autoruje model" smí padnout
 * až po P5.
 */

import { randomUUID } from 'node:crypto';

import { BODY_DEADLINE_MS, MAX_BODY_BYTES, bodyRefusalResponse, readBody } from '../../../http/body';
import { withRequest } from '../../../obs/trace';
import { killState } from '../../../server/kill-switch';
import { callerKey, rateLimitedResponse, takeRateSlot } from '../../../server/rate-limit';
import {
  PUBLIC_CORPUS_FAULT,
  logRateLimited,
  logStickyFault,
} from '../../../server/public-faults';
import { runEmission } from './chain';

/** `AsyncLocalStorage` i čtení zmrazeného korpusu potřebují Node, ne edge. */
export const runtime = 'nodejs';

/**
 * Meze těla se od T14 sdílejí s `/api/edit` — implementace i odůvodnění jsou
 * v `src/http/body.ts`. Re-export je tu proto, že tenhle endpoint je jejich
 * první konzument a jeho testy je jmenují na téhle cestě.
 */
export { BODY_DEADLINE_MS, MAX_BODY_BYTES, readBody };

/**
 * **Vypínač je první brána, před čtením těla** — týž vzor jako v `/api/edit`
 * a u worldstreamových dveří. Vypnuté dveře nesmí stát víc než jeden
 * `readFileSync` nad souborem o pár řádcích, kdežto `readPromptId()` níž čeká
 * na tělo až `BODY_DEADLINE_MS`.
 *
 * Čte se `replay`, ne `sessions` ani `upstream`: obě emitovací cesty přehrávají
 * **zmrazený korpus** a neplatí se na nich nic, takže je **rozbitý** ovládací
 * soubor nechává běžet ze stejného důvodu jako snapshoty. Vypne je jedině
 * výslovné `off: ["all"]`, tedy „vypni provoz".
 *
 * **Sdílené, protože ty dveře jsou dvoje a mez na nich musí být táž** — přesně
 * z toho důvodu, proč je sdílený i `readPromptId()` pod tímhle. Kdyby si každá
 * cesta nesla vlastní kopii, dala by se jedna použít k obejití druhé. To se
 * 4. 9. 2026 stalo doopravdy: remediace zavřela `/api/edit` a tyhle dvoje dveře
 * téže třídy braly anonymní požadavky dál, přičemž `/api/emit/stream` navrch
 * otevíral nová SSE spojení a držel je.
 *
 * `route` jde jen do logu, aby se v něm poznalo, které z těch dvou cest se to
 * týká.
 */
export function replayDisabled(requestId: string, route: string): Response | null {
  if (!killState(process.env).replay) return null;
  logRateLimited(route, requestId, 'REPLAY_DISABLED', 'kill switch: all');
  return Response.json(
    {
      requestId,
      error: { code: 'REPLAY_DISABLED', message: 'replaying worlds is switched off right now' },
    },
    { status: 503 },
  );
}

/**
 * Přečte tělo a vytáhne z něj `promptId`, nebo rovnou vrátí chybovou odpověď.
 *
 * Sdílí to s `stream/route.ts`: obě cesty přijímají tentýž požadavek a mez
 * velikosti i času musí být na obou stejná, jinak by se dala jedna z nich
 * použít k obejití druhé. `route` je jméno těch dveří — jde jen do logu, aby
 * se v něm poznalo, která z těch dvou cest mluví.
 *
 * ⚠ **Čtení těla je uvnitř `try`, a je to jediný důvod, proč obě ty cesty
 * odpovědí vždycky.** `readBody()` vrací svoje meze jako hodnotu, ale samo
 * `reader.read()` se **odmítnout** může — přerušené spojení, vadná komprese —
 * a to odmítnutí by proletělo ven. Odpověď by pak složil Next.js: pětistovka
 * bez `requestId`, tedy jediný požadavek v provozu, který se nedá spárovat
 * s řádkem v logu. Naměřeno nezávislou revizí 1. 9. 2026; `/api/generate` má
 * tutéž opravu od `d5970e7`.
 */
export async function readPromptId(
  request: Request,
  requestId: string,
  route: string,
): Promise<{ readonly ok: true; readonly promptId: string } | { readonly ok: false; readonly response: Response }> {
  let raw;
  try {
    raw = await readBody(request);
  } catch (thrown) {
    logRateLimited(
      route,
      requestId,
      'BODY_UNREADABLE',
      thrown instanceof Error ? thrown.message : String(thrown),
    );
    return {
      ok: false,
      response: Response.json(
        { requestId, error: { code: 'BODY_UNREADABLE', message: 'the request body could not be read' } },
        { status: 400 },
      ),
    };
  }
  // Třetí důvod (`BUSY`) a jeden překlad pro všechny dveře — viz
  // `bodyRefusalResponse()` v `src/http/body.ts`.
  if (!raw.ok) return { ok: false, response: bodyRefusalResponse(requestId, raw.reason) };

  let body: unknown;
  try {
    body = JSON.parse(raw.text);
  } catch {
    return {
      ok: false,
      response: Response.json(
        { requestId, error: { code: 'MALFORMED_BODY', message: 'request body is not JSON' } },
        { status: 400 },
      ),
    };
  }

  const promptId = (body as { promptId?: unknown } | null)?.promptId;
  if (typeof promptId !== 'string' || promptId.length === 0)
    return {
      ok: false,
      response: Response.json(
        {
          requestId,
          error: {
            code: 'INVALID_REQUEST',
            message: 'promptId must be a non-empty string naming a frozen prompt',
            field: 'promptId',
          },
        },
        { status: 400 },
      ),
    };

  return { ok: true, promptId };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();

  return withRequest(requestId, async () => {
    const disabled = replayDisabled(requestId, 'emit');
    if (disabled !== null) return disabled;

    // Strop na frekvenci, pořád před čtením těla — táž mez a totéž odůvodnění
    // jako u `/api/edit`, viz `src/server/rate-limit.ts`.
    const slot = takeRateSlot('emit', callerKey(request));
    if (!slot.allowed) {
      logRateLimited('emit', requestId, 'TOO_MANY_REQUESTS', `${String(slot.count)} in window`);
      return rateLimitedResponse(requestId, slot);
    }

    const parsed = await readPromptId(request, requestId, 'emit');
    if (!parsed.ok) return parsed.response;

    const outcome = runEmission(parsed.promptId);

    /**
     * Zmrazený korpus je nečitelný nebo se rozešel s `MANIFEST.lock`.
     *
     * **Není to verdikt a nesmí se skórovat.** Start z jiného pracovního adresáře
     * nebo podvržený soubor nevypovídají o modelu nic; kdyby to endpoint vydal jako
     * 200 s odmítnutím, T17 by to započítal jako vadnou emisi.
     */
    if (outcome.kind === 'unavailable') {
      // Ven veřejný text, operátorovi ten pravý — viz `src/server/public-faults.ts`.
      // `failure.detail` nese u `CORPUS_UNREADABLE` absolutní cestu na disku
      // včetně jména účtu, a tyhle dveře jsou stejně veřejné jako `/api/generate`.
      //
      // **Lepivě, ne na požadavek** — nález dvou nezávislých revizí 1. 9. 2026.
      // Bound byl do té chvíle jen v `/api/generate`, takže na nasazení bez
      // `evals/frozen/**` psaly tyhle dveře jeden řádek s absolutní cestou na
      // každý požadavek. Vada korpusu je jeden stav, tedy jeden řádek.
      logStickyFault('emit', requestId, outcome.failure.reason, outcome.failure.detail);
      return Response.json(
        {
          requestId,
          error: {
            code: outcome.failure.reason,
            message: PUBLIC_CORPUS_FAULT[outcome.failure.reason],
          },
        },
        { status: 503 },
      );
    }

    if (outcome.kind === 'unknown-prompt')
      return Response.json(
        {
          requestId,
          error: {
            code: 'UNKNOWN_PROMPT',
            message: `no frozen create prompt named ${parsed.promptId}`,
            field: 'promptId',
          },
        },
        { status: 404 },
      );

    return Response.json({ requestId, ...outcome.body });
  });
}
