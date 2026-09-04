/**
 * `POST /api/edit` — emise **patche** proti běžícímu světu. Druhá větev téhož
 * kontraktu, kterou `/api/emit` obsluhuje pro tvorbu.
 *
 * ## Vrací patch, ne svět
 *
 * `DESIGN-BOOK.md` §15 a zmrazený `editContract`: živá editace je transakční
 * patch běžícího grafu **bez resetu**. Celý přeemitovaný svět by hráči sebral
 * stav a zároveň by zrušil jedinou věc, kterou jde na editaci měřit — dosah
 * změny. Dosah celého světa je celý svět. Odpověď proto nese operace, revize
 * po commitu a rozvinutý dosah; dokument v ní není.
 *
 * ## Dráhu rozhodují cesty, ne štítek
 *
 * Router (`src/patch/router.ts`, T22) je jediný vstup na editační cestě a štítek
 * od modelu **čte a zapisuje, ale nepoužije**. Kdyby si model směl říct „tohle je
 * jen vzhled", vybíral by si sám, jestli jeho změna půjde přes verifikátor —
 * přesně ta chyba, kterou §7 zakazuje. Neshoda štítku a cest je **anomálie do
 * telemetrie, ne důvod k odmítnutí**.
 *
 * ## Dvě revize, dvě nezávislé kontroly zastaralosti
 *
 * `baseRevision` je **dvojice**, ne číslo, a to je celý smysl §13.1.1: patch
 * pravidel se posuzuje proti `simRevision` a patch vzhledu proti `lookRevision`.
 * Se sdílenou revizí by vzhledový commit uprostřed verifikace `sim` odmítl patch
 * pravidel jako zastaralý, ačkoli se na `sim` nezměnilo nic. Zastaralá revize té
 * části, do které patch **podle cest** míří, je **409** — a rozhoduje se
 * o ní dřív, než se aplikuje cokoli, aby smíšený požadavek nezůstal půl
 * commitnutý.
 *
 * ## Co je chyba a co je výsledek
 *
 * Tatáž hranice jako u `/api/emit`, protože ji konzumuje týž scorer: **400**
 * nevalidní požadavek, **404** neznámý editační prompt nebo dvojice (svět,
 * prompt), kterou zmrazení nekryje, **408** tělo bez deadlinu, **413** tělo přes
 * strop, **409** zastaralá revize, **503** nečitelný nebo podvržený korpus.
 * Všechno ostatní je **200 s verdiktem** — patch, který se nedá směrovat,
 * aplikovat, snížit nebo jehož svědek po editaci nedojde do výhry, je *naměřený
 * výsledek*, ne chyba serveru.
 *
 * ## Necertifikovaný patch se nepoužije, ale scéna zůstává
 *
 * §13.4 (`look.emptyScreenRule`): *„`NO_FIT` a necertifikovaný patch se vztahují
 * VÝHRADNĚ na `sim`."* U smíšeného požadavku se proto vzhledová půlka commitne
 * okamžitě a zůstane v platnosti i tehdy, když pravidla neprojdou verifikací.
 * `applied` říká, které půlky si volající smí nechat — a `sim` mezi nimi je jen
 * tehdy, když jeho svědek po editaci znovu došel do výhry.
 *
 * ## Proč tyhle dveře NEJSOU za čítačem placených volání
 *
 * `T28-editungated` chtěla, aby si `/api/edit` bralo slot z téhož čítače jako
 * `/api/generate` a worldstreamové dveře. **Změřeno 4. 9. 2026 a zamítnuto,
 * dvakrát nezávisle:**
 *
 * 1. **Nejsou to placené dveře.** `emitPatch()` přehrává zmrazený korpus
 *    (`src/model/client.ts`) — tenhle soubor neimportuje ani upstream klienta,
 *    ani `fetch`, ani strop utrácení. Placených volání odsud vede **nula**.
 *    Sdílený čítač má strop 4 a `MAX_WORLD_GENERATIONS = 3` v něm drží čtvrtý
 *    slot pro druhou větu (`dc58740`). Pustit na něj **neplacené** dveře
 *    znamená, že anonymní provoz sem obsadí všechny čtyři sloty a **odmítne
 *    ty placené** — tedy přesně to vyhladovění, které `dc58740` odstranil.
 * 2. **Čítač by ohradil špatný úsek.** Mezi `await readBody` a odpovědí **není
 *    jediný `await`** — `migrateWorldDoc`, `frozenPrompt`, `frozenGrammar`,
 *    `emitPatch`, `routePatch` i `commitRoutedParts` doběhnou synchronně
 *    v jednom taktu smyčky, takže se do drahé části nemá jak dostat druhý
 *    požadavek a čítač kolem ní by ukazoval nejvýš jedna.
 *
 *    ⚠ **Neznamená to, že „čítač tady nemůže nikdy sepnout" — revize 4. 9. 2026
 *    tu formulaci vyvrátila a je opravená.** Čítač vzatý na *vstupu* handleru
 *    sepne dobře: `readBody` čeká až `BODY_DEADLINE_MS = 5 000`
 *    (`src/http/body.ts`), takže N klientů, kteří pošlou hlavičky a pak mlčí,
 *    sedí uvnitř `POST` současně. Ohradil by ale **okno čtení těla**, ne těch
 *    15 ms CPU — a to okno má dnes strop jen na velikost (`MAX_BODY_BYTES`),
 *    ne na počet. Patří to do `T28-editrate` spolu s omezením frekvence,
 *    protože je to táž mez a stavět ji dvakrát nemá smysl.
 *
 * **Co naměřené ZŮSTÁVÁ jako otevřený problém:** jeden požadavek stojí
 * **medián 15,3 ms, p95 27,7 ms a max 38,6 ms** synchronního CPU na smyčce
 * (60 měření nad tělem o 1 784 B, po zahřátí cache korpusu). To je anonymní
 * veřejná adresa bez jakéhokoli omezení, takže ~66 požadavků za sekundu
 * zastaví celou instanci — a s ní SSE proudy, preview i snapshot. Lék na to
 * není čítač v letu, ale omezení **frekvence** nebo přesun té práce ze smyčky;
 * je to úloha `T28-editrate`, ne tahle.
 *
 * ## Endpoint NEČTE `allowedPaths`
 *
 * `allowedPaths` je pole **kontraktu z eval sady** (`contracts.v1.jsonl`),
 * autorovaného člověkem pro měření. Produkční požadavek žádný nemá a nikdy mít
 * nebude, takže vpustit eval data na produkční cestu by znamenalo měřit potrubí
 * proti datům, která v něm za HALT bránou nebudou. Endpoint proto dosah jen
 * **spočítá a vydá** (`changedLeaves`, `editContract.changedLeafRule`); soudí ho
 * oracle úlohy a po něm scorer z T16.
 */

import { randomUUID } from 'node:crypto';

import type { Operation } from 'rfc6902';

import { BODY_DEADLINE_MS, MAX_BODY_BYTES, readBody } from '../../../http/body';
import type { PartPatch } from '../../../ir/revision';
import { migrateWorldDoc, type WorldDoc } from '../../../ir/worlddoc';
import { emitPatch, frozenGrammar, frozenPrompt, type ClientFailure } from '../../../model/client';
import { killState } from '../../../server/kill-switch';
import { buildEditRequest } from '../../../model/edit-prompt';
import { withRequest } from '../../../obs/trace';
import {
  PUBLIC_CORPUS_FAULT,
  logRateLimited,
  logStickyFault,
} from '../../../server/public-faults';
import { routePatch, type Lane, type RoutedPatch, type RoutingAnomaly } from '../../../patch/router';
import { commitRoutedParts, staleRevision, type BaseRevision, type CommitOutcome } from './commit';

/** `AsyncLocalStorage` i čtení zmrazeného korpusu potřebují Node, ne edge. */
export const runtime = 'nodejs';

function badRequest(requestId: string, code: string, message: string, field?: string): Response {
  return Response.json({ requestId, error: { code, message, ...(field === undefined ? {} : { field }) } }, { status: 400 });
}

/**
 * Zmrazený korpus je nečitelný nebo se rozešel s `MANIFEST.lock`.
 *
 * **Není to verdikt a nesmí se skórovat** — stejně jako u `/api/emit`. Odchylkou
 * jsou dva důvody, které nemluví o prostředí, ale o dotazu: `BASE_WORLD_MISMATCH`
 * a `NO_FROZEN_RESPONSE` říkají, že pro dvojici (svět, prompt) zmrazený záznam
 * není. To je 404 nad dvojicí, ne 503.
 *
 * `BASE_WORLD_MISSING` je naopak zpátky na straně prostředí: editační záznam
 * jmenuje základní svět, který v korpusu chybí. Kdyby se schoval mezi ty dva
 * nad ním, rozbitý korpus by se vydával za naměřený výsledek.
 */
function corpusUnavailable(requestId: string, failure: ClientFailure): Response {
  // Ven veřejný text, operátorovi ten pravý — viz `src/server/public-faults.ts`.
  const message = PUBLIC_CORPUS_FAULT[failure.reason];

  if (failure.reason === 'BASE_WORLD_MISMATCH' || failure.reason === 'NO_FROZEN_RESPONSE') {
    /**
     * **Tohle není vada serveru, a proto se nesmí zapisovat jako by byla** —
     * nález dvou nezávislých revizí 1. 9. 2026, obě `blocking`.
     *
     * `BASE_WORLD_MISMATCH` vybírá **volající** tím, jaký `worldDoc` a
     * `promptId` pošle: „pro tuhle dvojici zmrazený záznam není" je běžný omyl
     * klienta, ne porucha. Do 1. 9. 2026 se logoval bezpodmínečně spolu
     * s vadami korpusu, takže na **zdravém** korpusu stačilo poslat platný svět
     * s cizím `promptId` a log rostl o řádek na požadavek. Naměřeno: čtrnáct
     * z patnácti zmrazených světů tu dvojici nesplní, a demo je samo vydává.
     *
     * Mlčet úplně by ale zahodilo jediný signál o tom, že klient a korpus se
     * rozešly, takže milníky: 1., 10., 100. výskyt. Rozdíl proti vadě korpusu
     * níž je v tom, **čí je to stav** — tenhle je volajícího, takže bound musí
     * být na rychlosti, ne na lepivosti.
     *
     * ## Proč `NO_FROZEN_RESPONSE` odbočuje jinam — kontrolní revize 1. 9. 2026
     *
     * **Na těchhle dveřích si ho volající vybrat neumí.** `frozenPrompt(promptId)`
     * odmítne neznámé i nesprávně otypované id o sto řádků níž jako
     * `UNKNOWN_PROMPT`, takže sem ten důvod dojde **jen** tehdy, když
     * v korpusu chybí odpověď na prompt, který v něm je. To je stav serveru —
     * díra ve zmrazeném artefaktu — a patří mu lepivá mez.
     *
     * Následek sdíleného boundu byl přesně ten, proti kterému je lepivá mez
     * psaná: `logRateLimited` klíčuje `(dveře, kód)`, takže několik různých děr
     * sdílí jedno počítadlo a druhá ani třetí se neohlásí nikdy. Lepivá mez
     * klíčuje `detail`, tedy konkrétní záznam, a její strop drží, protože
     * `promptId` je tady už porovnaný se zmrazenými id: do klíče neteče nic od
     * volajícího a počet je omezený velikostí korpusu.
     *
     * **Rozdělení nemění odpověď ven ani o bajt** — obojí je pořád 404
     * s kódem `UNKNOWN_PAIR`. Co se ale nesmí tvrdit (a první verze tohohle
     * odstavce to tvrdila) je, že volající ty dva stavy od sebe nerozezná:
     * `message` je `PUBLIC_CORPUS_FAULT[failure.reason]` o třicet řádků výš,
     * a ty dvě věty se liší doslova. Dvacet pět dotazů tedy vyjmenuje, které
     * editační odpovědi tomuhle nasazení chybí.
     *
     * **Sjednotit ten text by tu třídu nezavřelo — změřeno, ne odhadnuto.**
     * `/api/emit` vrací neověřenému volajícímu `code: outcome.failure.reason`
     * (`emit/route.ts:199`), tedy tentýž důvod rovnou jako kód, ne jen jako
     * větu. Vyjmenovat tak jde i tam, jen pro tvořivou větev. A protože
     * `evals/frozen/**` je commitnutý artefakt v repu, které jde podle
     * `RULES.md` §2 ven, není tím prozrazený obsah korpusu, ale **rozdíl
     * nasazení proti repu**. Kdyby se to jednou zavírat mělo, patří to na
     * všechny dveře naráz a do `PUBLIC_CORPUS_FAULT`, ne sem.
     */
    if (failure.reason === 'BASE_WORLD_MISMATCH')
      logRateLimited('edit', requestId, failure.reason, failure.detail);
    else logStickyFault('edit', requestId, failure.reason, failure.detail);
    return Response.json(
      { requestId, error: { code: 'UNKNOWN_PAIR', message, field: 'worldDoc' } },
      { status: 404 },
    );
  }

  // Vada korpusu je naopak lepivý stav serveru: jednou nečitelný soubor je
  // nečitelný napořád a `detail` u `CORPUS_UNREADABLE` nese absolutní cestu na
  // disku včetně jména účtu. Jeden řádek za vadu, ne za požadavek.
  logStickyFault('edit', requestId, failure.reason, failure.detail);
  return Response.json({ requestId, error: { code: failure.reason, message } }, { status: 503 });
}

function parseBaseRevision(value: unknown): BaseRevision | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { sim, look } = value as { sim?: unknown; look?: unknown };
  if (!Number.isInteger(sim) || !Number.isInteger(look)) return null;
  if ((sim as number) < 0 || (look as number) < 0) return null;
  return { sim: sim as number, look: look as number };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();

  return withRequest(requestId, async () => {
    /**
     * **Vypínač je první brána, před čtením těla** — týž vzor jako
     * u worldstreamových dveří. Vypnuté dveře nesmí stát víc než jeden
     * `readFileSync` nad souborem o pár řádcích.
     *
     * Čte se `replay`, ne `sessions`: tyhle dveře nic neplatí (přehrávají
     * zmrazený korpus), takže je **rozbitý** ovládací soubor nechává běžet
     * ze stejného důvodu jako snapshoty. Vypne je jedině výslovné
     * `off: ["all"]`, tedy „vypni provoz" — a to na ně dosáhnout musí, protože
     * jeden požadavek stojí medián 15,3 ms synchronního CPU na smyčce a bez
     * tohohle řádku byl jediným zastavením redeploy.
     */
    if (killState(process.env).replay) {
      logRateLimited('edit', requestId, 'REPLAY_DISABLED', 'kill switch: all');
      return Response.json(
        {
          requestId,
          error: { code: 'REPLAY_DISABLED', message: 'editing worlds is switched off right now' },
        },
        { status: 503 },
      );
    }

    /**
     * **Čtení těla je uvnitř `try`, a je to jediný důvod, proč tenhle handler
     * odpoví vždycky.** `readBody()` vrací svoje meze jako hodnotu, ale samo
     * `reader.read()` se odmítnout může — přerušené spojení, vadná komprese —
     * a odpověď by pak složil Next.js: pětistovka bez `requestId`, tedy jediný
     * požadavek v provozu, který se nedá spárovat s řádkem v logu. Naměřeno
     * nezávislou revizí 1. 9. 2026, týž vzor jako v `/api/generate`.
     */
    let raw;
    try {
      raw = await readBody(request);
    } catch (thrown) {
      logRateLimited(
        'edit',
        requestId,
        'BODY_UNREADABLE',
        thrown instanceof Error ? thrown.message : String(thrown),
      );
      return badRequest(requestId, 'BODY_UNREADABLE', 'the request body could not be read');
    }
    if (!raw.ok)
      return raw.reason === 'TOO_LARGE'
        ? Response.json(
            {
              requestId,
              error: { code: 'PAYLOAD_TOO_LARGE', message: `request body exceeds ${MAX_BODY_BYTES} bytes` },
            },
            { status: 413 },
          )
        : Response.json(
            {
              requestId,
              error: { code: 'BODY_TIMEOUT', message: `request body did not arrive within ${BODY_DEADLINE_MS} ms` },
            },
            { status: 408 },
          );

    let body: unknown;
    try {
      body = JSON.parse(raw.text);
    } catch {
      return badRequest(requestId, 'MALFORMED_BODY', 'request body is not JSON');
    }

    const { worldDoc, baseRevision, promptId } = (body ?? {}) as {
      worldDoc?: unknown;
      baseRevision?: unknown;
      promptId?: unknown;
    };

    if (typeof promptId !== 'string' || promptId.length === 0)
      return badRequest(
        requestId,
        'INVALID_REQUEST',
        'promptId must be a non-empty string naming a frozen edit prompt',
        'promptId',
      );

    const base = parseBaseRevision(baseRevision);
    if (base === null)
      return badRequest(
        requestId,
        'INVALID_REQUEST',
        'baseRevision must be { sim, look } with two non-negative integers — the two parts commit against separate revisions',
        'baseRevision',
      );

    // `migrateWorldDoc` je **jediný** vstup pro čtení dokumentu (viz poznámka na
    // konci `ir/revision.ts`): ověří tvar, verzi, konečnost čísel i to, že
    // `simHash` sedí na `sim`, kterou popisuje. Dokument, jehož `sim` si volající
    // upravil a hash nechal starý, se sem nedostane.
    //
    // **Na revize se ta věta nevztahuje a nesmí se tak číst.** `simHash` kryje
    // `doc.sim` a nic jiného (`worlddoc.ts`, a je to zmrazený protokol), takže
    // `simRevision` ani `lookRevision` hashem vázané nejsou. Meze téhle kontroly
    // jsou proto zapsané u brány 409 níž.
    const migrated = migrateWorldDoc(worldDoc);
    if (!migrated.ok || migrated.doc === null)
      return badRequest(requestId, 'INVALID_WORLD_DOC', migrated.reason, 'worldDoc');
    const doc = migrated.doc;

    const prompt = frozenPrompt(promptId);
    if (!prompt.ok) return corpusUnavailable(requestId, prompt);
    if (prompt.value === null || prompt.value.kind !== 'edit')
      return Response.json(
        {
          requestId,
          error: { code: 'UNKNOWN_PROMPT', message: `no frozen edit prompt named ${promptId}`, field: 'promptId' },
        },
        { status: 404 },
      );

    const grammar = frozenGrammar();
    if (!grammar.ok) return corpusUnavailable(requestId, grammar);

    const upstream = buildEditRequest(prompt.value.prompt, grammar.value, doc);
    // Vazba se ověřuje proti **obsahu** `sim`, ne proti `simHash`, který přišel
    // v požadavku. Ten je FNV-1a-32 a padělá se výpočtem, ne štěstím — viz
    // `simFingerprint` v `model/client.ts`.
    const emission = emitPatch(promptId, upstream, doc.sim);
    if (!emission.ok) return corpusUnavailable(requestId, emission);

    const envelope = {
      requestId,
      promptId,
      baseWorld: emission.baseWorld,
      upstream,
      provenance: emission.provenance,
      /** Co model poslal, doslova. Je to deliverable úlohy — patch, ne svět. */
      patch: emission.body,
      /** Štítek se zaznamenává, dráhu neurčuje. */
      label: emission.label ?? null,
    };

    /**
     * **Jediný tvar 200 s verdiktem, pro obě cesty, které ho vydávají.**
     *
     * Dřív si směrovací odmítnutí skládalo tělo vlastní cestou a vyšlo mu o klíč
     * míň: `rejection` ano, `rejections` ne. Konzument, který se větví na
     * `outcome === 'REJECTED'` a sáhne na `body.rejections` — a scorer z T16 je
     * přesně takový konzument — dostal `undefined`. Dva tvary za jednou hodnotou
     * `outcome` na veřejné cestě.
     *
     * **Není to opravené doplněním klíče, ale zrušením druhé cesty**, protože
     * doplněný klíč se za měsíc rozejde znovu. Odmítnutí routeru sem vstupuje
     * jako `CommitOutcome`, ve kterém se nic necommitlo (`after: doc`), takže
     * tvar odpovědi má v kódu jedno místo. Test to navíc nemá jak pokrýt zvenčí:
     * `emitPatch` vrací zmrazené tělo a všech 25 se rozřadí čistě, takže
     * `routing.verdict === 'REJECTED'` v režimu záznamu nenastane vůbec.
     */
    const verdict = (committed: CommitOutcome, lanes: readonly Lane[], anomalies: readonly RoutingAnomaly[]): Response =>
      Response.json({
        ...envelope,
        outcome: committed.outcome,
        lanes,
        applied: committed.applied,
        changedLeaves: committed.changedLeaves,
        revisions: revisionsOf(doc, committed.after),
        certificate: committed.certificate,
        anomalies,
        rejection: committed.rejections[0] ?? null,
        rejections: committed.rejections,
      });

    // Router je jediný vstup: rozhodne dráhu z normalizovaných cest a smíšený
    // patch rozdělí na dva se stejným pořadím operací uvnitř každého. Přetypování
    // je poctivé právě proto, že router tvar obálky i operací kontroluje sám —
    // `readonly Operation[]` platí jen při překladu a tělo přišlo jako JSON.
    // Dokument se předává, takže router smí doletět na nejbližší legální variantu
    // (T13). Dráhu to nemění — rozhoduje se z cest, než se cokoli přepíše — a
    // `certifySim` v `commitRoutedParts` zůstává beze změny jediným rozhodčím.
    const routing = routePatch({ label: emission.label, operations: emission.body as readonly Operation[] }, doc);
    if (routing.verdict === 'REJECTED')
      return verdict(
        {
          outcome: 'REJECTED',
          applied: [],
          changedLeaves: [],
          after: doc,
          certificate: null,
          rejections: [
            {
              stage: 'routing',
              reason: routing.reason,
              pointer: routing.pointer,
              detail: `${routing.detail} (expected ${routing.expected})`,
            },
          ],
        },
        [],
        [],
      );

    // Zastaralost se rozhoduje **před aplikací čehokoli** a každá část proti své
    // vlastní revizi — odůvodnění i meze té brány jsou u `staleRevision`
    // v `./commit`, protože jen tam se dají otestovat obě její poloviny.
    const stale = staleRevision(doc, base, routing.patches);
    if (stale !== null)
      return Response.json(
        {
          ...envelope,
          error: {
            code: 'STALE_REVISION',
            message: `patch was issued against ${stale.part}Revision ${stale.claimed}, the document is at ${stale.current}`,
            field: `baseRevision/${stale.part}`,
          },
          revisions: revisionsOf(doc, doc),
        },
        { status: 409 },
      );

    const parts = routing.patches.map(
      (routed: RoutedPatch): PartPatch => ({
        part: routed.part,
        baseRevision: base[routed.part],
        operations: routed.operations,
      }),
    );

    return verdict(
      commitRoutedParts(doc, parts),
      routing.patches.map((routed) => routed.lane),
      routing.anomalies,
    );
  });
}

function revisionsOf(before: WorldDoc, after: WorldDoc): object {
  return {
    sim: { before: before.simRevision, after: after.simRevision },
    look: { before: before.lookRevision, after: after.lookRevision },
  };
}

