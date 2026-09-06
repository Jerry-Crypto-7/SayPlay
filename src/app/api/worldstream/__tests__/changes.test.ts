/**
 * **Dvoje dveře druhé věty: preview a commit** (P15 T22, §21).
 *
 * Svět, nad kterým se to soudí, projde **skutečným** compilerem a jeho
 * certifikací (`world-fixture.ts`), takže patch řetěz tady pracuje s vyřešeným
 * svědkem a zapečetěným `simHash` — ne s ručně napsaným dokumentem, u kterého
 * by „certifikováno" nic neznamenalo.
 *
 * ## Čtyři vlastnosti, které oko nepokryje
 *
 * 1. **Vzhledová změna nezmění runtime hash.** Vypadá to na obrazovce úplně
 *    stejně, ať se `simHash` pohnul nebo ne — a když se pohnul, hráč přijde
 *    o rozehraný stav a nikdo nepozná proč.
 * 2. **Revizi podoby dostane jeden objekt.** Zvednout ji všem vypadá správně
 *    (svět se přemeshuje a je hezký), a přitom je to reset, který produkt
 *    slibuje neudělat.
 * 3. **Zastaralé preview se nesmí commitnout.** Rozdíl mezi „změnilo se to, co
 *    jsem viděl" a „změnilo se něco jiného" není z výsledku poznat.
 * 4. **Smíšená změna je celá, nebo žádná.** Půlka změny je svět, o který nikdo
 *    nežádal — a ta druhá půlka chybí tiše.
 *
 * ## Preview se zakládá dvěma cestami a obě jsou tu schválně
 *
 * Šťastná cesta jde přes `createChange()` se **scriptovaným** emitorem, protože
 * `cloudEmitter()` bez `.env` vrací `null` a jinak by se otestovala jen
 * odmítnutí. Commitové sady si preview vkládají rovnou `putChange()` — to je
 * přesně to, co route dělá, a nechat je platit modelem za každý případ
 * zastaralosti by ze sady udělalo měřidlo poskytovatele.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BODY_DEADLINE_MS, MAX_CONCURRENT_BODY_READS_UNIDENTIFIED, readBody } from '@/http/body';
import type { UpstreamRequest } from '@/model/prompt';
import { resetFaultLog } from '@/server/public-faults';
import { DEFAULT_CAP_USD, SpendRefusalError } from '@/server/spend-cap';
import {
  callerKey,
  MAX_REQUESTS_PER_WINDOW,
  MAX_REQUESTS_PER_WINDOW_PER_INSTANCE,
  resetRateWindows,
  takeRateSlot,
} from '@/server/rate-limit';
import type { PendingChange, RefinePlan } from '@/model/worldstream-refine';
import {
  clearSessions,
  getSession,
  MAX_LIVE_SESSIONS,
  openSession,
  putChange,
  type StoredSession,
} from '@/worldstream/sessions';

import {
  DOOR_CEILING,
  MAX_CONCURRENT_GENERATIONS,
  MAX_WORLD_GENERATIONS,
  POST as createSession,
  type PaidDoor,
  acquireSlot,
  releaseSlot,
  resetConcurrency,
  slotsDetail,
} from '../sessions/route';
import { POST as commitChange } from '../sessions/[sessionId]/changes/[changeId]/commit/route';
import { POST as previewChange, createChange } from '../sessions/[sessionId]/changes/route';
import { ANSWER, generated } from './world-fixture';

/* ------------------------------------------------------------------ *
 * Volání route.
 * ------------------------------------------------------------------ */

function previewRequest(sessionId: string, body: unknown): Request {
  return new Request(`http://127.0.0.1/api/worldstream/sessions/${sessionId}/changes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function preview(sessionId: string, body: unknown, emit: ((request: UpstreamRequest) => Promise<unknown>) | null = null) {
  return createChange(previewRequest(sessionId, body), sessionId, emit);
}

/**
 * Požadavek na commit. `from` je adresa v `x-forwarded-for`, tedy přesně to, z
 * čeho `callerKey()` skládá klíč stropu frekvence; bez ní spadne volající do
 * kbelíku nerozeznaných a **dva různí lidé jsou pro strop jeden**.
 */
function commitRequest(from: string | null = null): Request {
  return new Request(`http://127.0.0.1/commit`, {
    method: 'POST',
    headers: from === null ? undefined : { 'x-forwarded-for': from },
  });
}

function commit(
  sessionId: string,
  changeId: string,
  from: string | null = null,
): Promise<Response> {
  return commitChange(commitRequest(from), {
    params: Promise.resolve({ sessionId, changeId }),
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * Fasety změn, které se nad tou fixturou dají provést.
 * ------------------------------------------------------------------ */

/** Nová podoba stožáru. Týž `shapeId` i `stableId` — jinak nemá kam přistát. */
const WOVEN_MAST = {
  shapeId: 'mastPost',
  stableId: 'ironMast',
  nodes: [
    { kind: 'prism', sides: 6, radius: 0.4, height: 4.1 },
    { kind: 'twist', child: 0, axis: 'y', radiansPerUnit: 0.75 },
  ],
  root: 1,
  targetBounds: { min: [-0.5, -2.1, -0.5], max: [0.5, 2.1, 0.5] },
  anchors: [{ name: 'tip', at: [0, 2, 0], normal: [0, 1, 0] }],
  materialIntent: 'metal',
  priority: 9,
} as unknown as RefinePlan['shape'];

function plan(overrides: Partial<RefinePlan> = {}): RefinePlan {
  return {
    stableId: 'ironMast',
    summary: 'the mast is rewoven and the salt goes warm',
    shape: null,
    behavior: [],
    appearance: [],
    ...overrides,
  };
}

/** Preview vložené přesně tak, jak ho vkládá route. */
function pending(stored: StoredSession, changed: RefinePlan, changeId = 'change-1'): PendingChange {
  const world = worldOf(stored);
  const change: PendingChange = {
    changeId,
    plan: changed,
    basedOn: {
      representation: stored.session.revisionOf(changed.stableId) ?? 0,
      sim: world.simRevision,
      look: world.lookRevision,
    },
  };
  putChange(stored, change);
  return change;
}

/** Jedno pravidlo světa. `sim` je v dokumentu `unknown`, tak se čte tudy. */
function ruleOf(stored: StoredSession, ruleId: string): Record<string, unknown> {
  const sim = worldOf(stored).sim as { readonly rules: Record<string, Record<string, unknown>> };
  return sim.rules[ruleId];
}

function worldOf(stored: StoredSession) {
  const blueprint = stored.blueprint;
  if (blueprint === null) throw new Error('the fixture session has no world');
  return blueprint.world;
}

afterEach(() => {
  clearSessions();
  resetConcurrency();
  // Počítadlo okna v `public-faults` je stav modulu: bez vynulování by druhý
  // producent téže dvojice (dveře, kód) byl `occurrence 2`, tedy mimo milník,
  // a tvrzení „řádek odešel" by mlčky zčervenalo v cizím testu.
  resetFaultLog();
  // Okna stropu frekvence bydlí na `globalThis` a plní je i odmítnuté
  // požadavky, takže bez vynulování by je sada naplnila sama a červená by
  // vyskočila na náhodném případu, který s frekvencí nemá nic společného.
  resetRateWindows();
  // Špionáž na `console.error` (odmítnutí náporem) nesmí přežít do dalšího
  // testu — tichý log by z něj udělal zelenou z jiného důvodu.
  vi.restoreAllMocks();
  // Sada o pomalém těle si bere falešné hodiny; nechat je zapnuté by zastavilo
  // čas každému testu za ní.
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ *
 * POST /changes — preview
 * ------------------------------------------------------------------ */

describe('preview druhé věty', () => {
  it('neznámá relace je 404, ne prázdné preview', async () => {
    const response = await preview('nobody', { prompt: 'make the mast taller' });
    expect(response.status).toBe(404);
    expect((await body(response)).error).toMatchObject({ code: 'UNKNOWN_SESSION' });
  });

  it('relace bez světa je 409 — ta adresa za chvíli platit bude', async () => {
    const stored = openSession('empty-session', 7)!;
    const response = await preview(stored.session.sessionId, { prompt: 'make the mast taller' });
    expect(response.status).toBe(409);
    expect((await body(response)).error).toMatchObject({ code: 'WORLD_NOT_READY' });
  });

  it('klíč navíc je 400, ne tiše zahozené pole', async () => {
    const stored = await generated();
    const response = await preview(stored.session.sessionId, {
      prompt: 'make the mast taller',
      shape: { shapeId: 'smuggled' },
    });
    expect(response.status).toBe(400);
    expect((await body(response)).error).toMatchObject({ code: 'UNEXPECTED_FIELDS' });
  });

  it('prázdná věta neprojde moderací', async () => {
    const stored = await generated();
    const response = await preview(stored.session.sessionId, { prompt: '   ' });
    expect(response.status).toBe(400);
  });

  it('nejasná věta vrátí kandidáty, a to i bez klíče k modelu', async () => {
    // Grounding je před modelem. Kdyby byl za ním, tahle odpověď by na nasazení
    // bez `.env` neexistovala a porotce by místo nabídky dostal 503.
    const stored = await generated();
    const response = await preview(stored.session.sessionId, { prompt: 'make it nicer' }, null);
    expect(response.status).toBe(200);
    const read = await body(response);
    expect(read.outcome).toBe('AMBIGUOUS');
    expect(read.reason).toBe('NO_MATCH');
    expect(read.candidates).toHaveLength(2);
  });

  it('jasná věta bez nakonfigurovaného modelu je 503, relace zůstane živá', async () => {
    const stored = await generated();
    const response = await preview(stored.session.sessionId, { prompt: 'make the mast taller' }, null);
    expect(response.status).toBe(503);
    // **Ne `MODEL_UNAVAILABLE`** (nález nezávislé revize 6. 9. 2026): žádný
    // model se nevolal, protože žádný nakonfigurovaný není. Hláška o výpadku
    // by porotci popsala poruchu, která se nestala.
    const error = (await body(response)).error as { code: string; message: string };
    expect(error.code).toBe('NO_AUTHORED_CHANGE');
    expect(error.message).not.toContain('could not be reached');
    expect(stored.session.phase).toBe('world');
  });

  /**
   * **Odmítnutý strop není mlčící poskytovatel** — tytéž dveře, táž vada jako
   * u stavby světa (P15 `T29-readinessledger`). Rozeznává se typ výjimky, ne
   * text: druhý případ níž hází doslova tutéž zprávu jako holý `Error`.
   */
  it('odmítnutý strop dá vlastní kód a větu, ne poruchu modelu', async () => {
    const stored = await generated();
    const response = await preview(stored.session.sessionId, { prompt: 'make the mast taller' }, async () => {
      throw new SpendRefusalError({
        ok: false,
        reason: 'STORE_UNCONFIGURED',
        detail: 'no shared ledger is configured for this deployment',
        snapshot: {
          enabled: true,
          capUsd: DEFAULT_CAP_USD,
          spentUsd: 0,
          reservedUsd: 0,
          remainingUsd: DEFAULT_CAP_USD,
          callsMade: 0,
          callsRemaining: 200,
        },
      });
    });

    expect(response.status).toBe(503);
    const error = (await body(response)).error as { code: string; message: string };
    expect(error.code).toBe('SPEND_CAP_BLOCKED');
    expect(error.message).toBe('this deployment is not making model calls right now; nothing was sent');
    // Rozpad příčiny je operátorský, ven nejde.
    expect(error.message).not.toContain('STORE_UNCONFIGURED');
    expect(stored.session.phase).toBe('world');
  });

  it('výjimka poskytovatele se stejným textem zůstává poruchou modelu', async () => {
    const stored = await generated();
    const response = await preview(stored.session.sessionId, { prompt: 'make the mast taller' }, async () => {
      throw new Error('STORE_UNCONFIGURED: no shared ledger is configured for this deployment');
    });

    expect(response.status).toBe(503);
    expect((await body(response)).error).toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });

  it('preview vrátí rozsah, co zůstane, a NEZAČNE meshovat', async () => {
    const stored = await generated();
    const before = stored.session.events.sequence;

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'turn the mast into woven metal' },
      async () => ({
        summary: 'the mast is rewoven',
        shape: WOVEN_MAST,
        behavior: [],
        appearance: [{ op: 'replace', path: '/look/palette', value: 'sand' }],
      }),
    );

    expect(response.status).toBe(200);
    const read = await body(response);
    expect(read.outcome).toBe('PREVIEW');
    expect(read.target).toMatchObject({ stableId: 'ironMast' });
    expect(read.scope).toEqual({ shape: true, behavior: 0, appearance: 1 });
    // ⚠ **Prázdný seznam, a je to oprava, ne regrese.** `replace /look/palette`
    // vyměňuje celou paletu, tedy i barvu solné pláně; slib „the salt flat
    // zůstane" byl tichá nepravda, kterou tenhle test do 6. 9. 2026 pinoval.
    // Cesta o dvou segmentech nejmenuje objekt a přepisuje je všechny.
    expect(read.preserved).toEqual([]);

    // **Žádný meshing před commitem.** Podoba stojí tam, kde stála, revize se
    // nepohnula a do proudu odešel jediný rámec — preview, ne fronta tvarů.
    expect(stored.session.revisionOf('ironMast')).toBe(0);
    expect(stored.session.stateOf('ironMast')).toEqual({ kind: 'planned' });
    const frames = stored.session.events.since(before);
    expect(frames.map((frame) => frame.type)).toEqual(['patch.preview']);

    // A svět je pořád ten původní — preview nic nezapsalo.
    expect(worldOf(stored).look.palette).toBe('moss');
    expect(stored.changes.size).toBe(1);
  });

  /**
   * **„Co zůstane" se počítá z operací, ne z cíle věty** — blokující nález
   * nezávislé revize 6. 9. 2026.
   *
   * Do té doby se do `preserved` dostal každý objekt kromě cíle, takže emise,
   * která sáhla i vedle, nechala produkt tvrdit dvě protichůdné věci uvnitř
   * jednoho průchodu: panel sliboval „Untouched: X" a odpověď commitu vypsala
   * X mezi změněnými listy. Naměřeno na vlajkové změně dema (`c04`/`r02`),
   * takže to porotce viděl na první pokus, ne v okrajovém případě.
   *
   * Emise níž je ta samá třída: cíl je stěžeň, ale vzhledová operace jmenuje
   * solnou pláň. Poctivá odpověď je proto **prázdný** seznam.
   */
  it('objekt, kterého se operace dotkne, nesmí být mezi nedotčenými', async () => {
    const stored = await generated();

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'turn the mast into woven metal' },
      async () => ({
        summary: 'the mast is rewoven and the flat takes its colour',
        shape: WOVEN_MAST,
        behavior: [],
        appearance: [{ op: 'replace', path: '/look/modules/saltFlat/params/tint', value: 'rust' }],
      }),
    );

    expect(response.status).toBe(200);
    const read = await body(response);
    expect(read.target).toMatchObject({ stableId: 'ironMast' });
    expect(read.preserved).toEqual([]);
  });

  /**
   * **Tři cesty, jak objekt změnit, aniž ho cesta jmenuje** — druhé kolo
   * nezávislé revize 6. 9. 2026. Cesta sama je jen třetina patchového
   * slovníku, takže se seznam dal obejít vším ostatním: `move` bere objekt
   * ze zdroje, který stojí jen ve `from`; pravidlo se dá přidat celé a cizí
   * objekt jmenovat uvnitř hodnoty; a `replace /sim/entities` přepíše všechny
   * naráz, aniž jmenuje jediného.
   */
  it.each([
    [
      'move bere objekt ze zdroje, který stojí jen ve `from`',
      {
        behavior: [
          { op: 'move', from: '/sim/entities/saltFlat/state', path: '/sim/entities/ironMast/state' },
        ],
        appearance: [],
      },
    ],
    [
      'pravidlo jmenuje cizí objekt uvnitř hodnoty, ne v cestě',
      {
        behavior: [
          { op: 'add', path: '/sim/rules/tiltFlat', value: { when: 'tick', then: ['saltFlat'] } },
        ],
        appearance: [],
      },
    ],
    [
      'zápis nad celým poddokumentem přepíše všechny objekty naráz',
      { behavior: [{ op: 'replace', path: '/sim/entities', value: {} }], appearance: [] },
    ],
  ])('%s', async (_name, parts) => {
    const stored = await generated();

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'turn the mast into woven metal' },
      async () => ({ summary: 'the mast is rewoven', shape: WOVEN_MAST, ...parts }),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).preserved).toEqual([]);
  });

  /**
   * **Uvolněná relace nesmí dostat 200 na preview, které nikdo nedokáže
   * commitnout** (`T16-changeafterrelease`).
   *
   * Volání modelu trvá vteřiny a registr je mezitím živá věc: nápor přes
   * `MAX_LIVE_SESSIONS` relaci uvolní i uprostřed rozdělané práce. Do
   * 4. 9. 2026 route zkontrolovala fázi **před** modelem a po jeho návratu už
   * ne, takže `putChange` zapsal preview do objektu, který v registru nebyl —
   * volající zaplatil, dostal `changeId` a jeho commit vracel navždy 404.
   */
  it('relace uvolněná během volání modelu vrátí 409, ne changeId do prázdna', async () => {
    const stored = await generated();
    const sessionId = stored.session.sessionId;

    const response = await preview(sessionId, { prompt: 'turn the mast into woven metal' }, async () => {
      // Nápor, který doběhne, zatímco tenhle požadavek čeká na model. Sekvenční
      // POSTy nemá co brzdit: `acquireSlot()` omezuje jen souběžné generace.
      for (let i = 0; i < MAX_LIVE_SESSIONS + 2; i += 1) openSession(`nápor-${i}`, 1);
      expect(getSession(sessionId), 'nápor relaci neuvolnil, test měří něco jiného').toBeNull();
      return {
        summary: 'the mast is rewoven',
        shape: WOVEN_MAST,
        behavior: [],
        appearance: [],
      };
    });

    expect(response.status).toBe(409);
    expect((await body(response)).error).toMatchObject({ code: 'SESSION_CLOSED' });
    // Preview se nesmí zapsat ani na tu odpojenou relaci: route si `stored`
    // drží dál, takže by to byl přesně ten řetěz, který uvolnění přežije.
    expect(stored.changes.size, 'preview se zapsalo do relace, která už není v registru').toBe(0);
  });

  it('cíl vybraný klikem přebije text věty', async () => {
    const stored = await generated();
    let seen = '';
    const response = await preview(
      stored.session.sessionId,
      { prompt: 'make the salt flat brighter', stableId: 'ironMast' },
      async (request: UpstreamRequest) => {
        seen = request.user;
        return { summary: 'the mast is rewoven', shape: WOVEN_MAST };
      },
    );
    expect(response.status).toBe(200);
    expect((await body(response)).target).toMatchObject({ stableId: 'ironMast' });
    expect(seen).toContain('ironMast');
  });

  it('vadná odpověď modelu je 200 REJECTED a rámec, ne 500', async () => {
    const stored = await generated();
    const response = await preview(
      stored.session.sessionId,
      { prompt: 'make the mast taller' },
      async () => ({ summary: 'nothing happens', behavior: [], appearance: [] }),
    );
    expect(response.status).toBe(200);
    expect((await body(response)).outcome).toBe('REJECTED');
    expect(stored.session.events.all().at(-1)?.type).toBe('patch.rejected');
    expect(stored.changes.size).toBe(0);
  });

  it('produkční POST bez .env dojde na tutéž 503', async () => {
    const stored = await generated();
    const response = await previewChange(
      previewRequest(stored.session.sessionId, { prompt: 'make the mast taller' }),
      { params: Promise.resolve({ sessionId: stored.session.sessionId }) },
    );
    expect(response.status).toBe(503);
  });
});

/* ------------------------------------------------------------------ *
 * POST /changes/:id/commit
 * ------------------------------------------------------------------ */

describe('commit druhé věty', () => {
  it('neznámé preview je 404', async () => {
    const stored = await generated();
    const response = await commit(stored.session.sessionId, 'never-existed');
    expect(response.status).toBe(404);
    expect((await body(response)).error).toMatchObject({ code: 'UNKNOWN_CHANGE' });
  });

  it('změna jen vzhledu NEZMĚNÍ runtime hash ani podobu objektu', async () => {
    const stored = await generated();
    const hashBefore = worldOf(stored).simHash;
    const change = pending(
      stored,
      plan({ appearance: [{ op: 'replace', path: '/look/palette', value: 'sand' }] }),
    );

    const response = await commit(stored.session.sessionId, change.changeId);
    expect(response.status).toBe(200);
    const read = await body(response);
    expect(read.outcome).toBe('COMMITTED');
    expect(read.applied).toEqual(['look']);
    // `representation: null` je celé to tvrzení: mesh na scéně zůstává.
    expect(read.representation).toBeNull();

    const after = worldOf(stored);
    expect(after.look.palette).toBe('sand');
    expect(after.lookRevision).toBe(1);
    expect(after.simRevision).toBe(0);
    expect(after.simHash).toBe(hashBefore);
    expect(stored.session.revisionOf('ironMast')).toBe(0);
  });

  it('geometrická změna zvedne revizi JEN dotčeného objektu', async () => {
    const stored = await generated();
    const change = pending(stored, plan({ shape: WOVEN_MAST }));

    const response = await commit(stored.session.sessionId, change.changeId);
    const read = await body(response);
    expect(read.outcome).toBe('COMMITTED');
    expect(read.representation).toBe(1);

    expect(stored.session.revisionOf('ironMast')).toBe(1);
    expect(stored.session.revisionOf('saltFlat')).toBe(0);
    // Nová podoba doopravdy nahradila starou, a dokument se přitom nehnul.
    expect(stored.blueprint?.shapes[0].nodes[0]).toMatchObject({ sides: 6 });
    expect(worldOf(stored).simRevision).toBe(0);
    expect(worldOf(stored).lookRevision).toBe(0);
  });

  it('nové pravidlo projde certifikací, zvedne simRevision a přepočítá hash', async () => {
    const stored = await generated();
    const hashBefore = worldOf(stored).simHash;
    const change = pending(
      stored,
      plan({
        behavior: [
          {
            op: 'add',
            path: '/sim/rules/lightUp',
            value: {
              id: 'lightUp',
              phase: 0,
              priority: 1,
              event: { kind: 'onEnterZone', entity: 'surveyor', zone: 'mastPad' },
              condition: null,
              actions: [{ kind: 'win' }],
            },
          },
        ],
      }),
    );

    const read = await body(await commit(stored.session.sessionId, change.changeId));
    expect(read.outcome).toBe('COMMITTED');
    expect(read.applied).toEqual(['sim']);
    // Svědek se ověřuje **znovu** nad commitnutou `sim`, ne přebírá.
    expect(read.certificate).toMatchObject({ verdict: 'CERTIFIED' });
    expect(worldOf(stored).simRevision).toBe(1);
    expect(worldOf(stored).simHash).not.toBe(hashBefore);
    // Pravidlo se změnilo, podoba ne — mesh na scéně zůstává.
    expect(stored.session.revisionOf('ironMast')).toBe(0);
  });

  it('preview proti revizi N se po commitu na N+1 už nesmí commitnout', async () => {
    // Break-it-on-purpose z AC: dvě preview nad týmž objektem, obě proti revizi
    // 0. První projde a revizi zvedne, druhé je zastaralé — a nesmí to být
    // best-effort změna, protože porotce ji viděl nad světem, který zmizel.
    const stored = await generated();
    const first = pending(stored, plan({ shape: WOVEN_MAST }), 'change-a');
    const second = pending(stored, plan({ shape: WOVEN_MAST }), 'change-b');

    expect((await commit(stored.session.sessionId, first.changeId)).status).toBe(200);

    const response = await commit(stored.session.sessionId, second.changeId);
    expect(response.status).toBe(409);
    expect((await body(response)).error).toMatchObject({
      code: 'STALE_REVISION',
      field: 'basedOn/representation',
    });
  });

  it('preview proti staré revizi dokumentu je taky 409', async () => {
    const stored = await generated();
    const stale = pending(
      stored,
      plan({ appearance: [{ op: 'replace', path: '/look/palette', value: 'sand' }] }),
      'change-stale',
    );
    const winner = pending(
      stored,
      plan({ appearance: [{ op: 'replace', path: '/look/atmosphere', value: 'haze' }] }),
      'change-winner',
    );

    expect((await commit(stored.session.sessionId, winner.changeId)).status).toBe(200);

    const response = await commit(stored.session.sessionId, stale.changeId);
    expect(response.status).toBe(409);
    expect((await body(response)).error).toMatchObject({ field: 'basedOn/look' });
  });

  it('smíšená změna je celá, nebo žádná', async () => {
    // Vzhled je legální a `sim` shodí svědka. `/api/edit` by si vzhled nechal
    // (§13.4); tady je půlka změny horší výsledek než žádná.
    const stored = await generated();
    const change = pending(
      stored,
      plan({
        behavior: [{ op: 'remove', path: '/sim/rules/reach' }],
        appearance: [{ op: 'replace', path: '/look/palette', value: 'sand' }],
      }),
    );

    const response = await commit(stored.session.sessionId, change.changeId);
    expect(response.status).toBe(200);
    const read = await body(response);
    expect(read.outcome).toBe('REJECTED');

    const after = worldOf(stored);
    expect(after.look.palette).toBe('moss');
    expect(after.lookRevision).toBe(0);
    expect(after.simRevision).toBe(0);
    expect(stored.session.revisionOf('ironMast')).toBe(0);
    expect(stored.session.events.all().at(-1)?.type).toBe('patch.rejected');

    // `T22-rejectreplay`: razítko nese revize UPRAVENÉHO světa, ne dokumentu,
    // který `commitRoutedParts` vrátil s commitnutou půlkou vzhledu a který se
    // zahodil. Kdyby neslo ten druhý, byl by druhý pokus 409 nad světem, který
    // se ve skutečnosti nepohnul.
    const znovu = await commit(stored.session.sessionId, change.changeId);
    expect(znovu.status, 'razítko četlo zahozenou půlku patche').toBe(200);
    expect((await body(znovu)).outcome).toBe('REJECTED');
  });

  it('jedno preview je jeden commit', async () => {
    const stored = await generated();
    const change = pending(
      stored,
      plan({ appearance: [{ op: 'replace', path: '/look/palette', value: 'sand' }] }),
    );

    expect((await commit(stored.session.sessionId, change.changeId)).status).toBe(200);
    expect((await commit(stored.session.sessionId, change.changeId)).status).toBe(404);
    expect(worldOf(stored).lookRevision).toBe(1);
  });

  // ⚠ **Změnit STÁVAJÍCÍ zákon, ne jen přidat nový** (`T22-ruleid`). Do
  // 4. 9. 2026 emitoval compiler pravidla bez `id`, a `introducedRuleKeyFault`
  // bere identitu vady jako `(pointer, kanonický zápis položky)` — tedy včetně
  // celého těla. Úprava uvnitř takového pravidla tím vyrobila jinou identitu,
  // `commitPart` ji přečetl jako nově zavlečenou vadu a patch odmítl. Naměřeno:
  // `replace /sim/rules/reach/priority` → `REJECTED`, zatímco `add` nového
  // pravidla s vlastním `id` prošel. Půlka slibu „změň jeden zákon běžícího
  // světa" tedy neprocházela, a vypadalo to jako vada patche od modelu.
  it('úprava uvnitř zákona vygenerovaného světa projde certifikací', async () => {
    // ⚠ **Nejdřív se ověří, že to `id` nedodala fixtura.** Nález nezávislé
    // revize 4. 9. 2026: ta odpověď je sdílená s dalšími ~15 případy, a kdyby
    // do ní někdo `id` dopsal, prošel by tenhle test i nad vrácenou opravou —
    // tedy by přestal měřit cokoli. Tahle aserce ten posun ohlásí nahlas.
    const emitted = (ANSWER.world as { readonly sim: { readonly rules: Record<string, object> } })
      .sim.rules.reach;
    expect(emitted, 'fixtura už `id` nese, takže test níž nic nedokazuje').not.toHaveProperty(
      'id',
    );

    const stored = await generated();
    // Svět prošel skutečným compilerem, takže tohle `id` napsal `repairRules`.
    expect(ruleOf(stored, 'reach'), 'pravidlo ztratilo `id`').toMatchObject({
      id: 'reach',
    });

    const change = pending(
      stored,
      plan({ behavior: [{ op: 'replace', path: '/sim/rules/reach/priority', value: 3 }] }),
    );

    const read = await body(await commit(stored.session.sessionId, change.changeId));
    expect(read.outcome, 'změna stávajícího zákona se odmítla').toBe('COMMITTED');
    expect(ruleOf(stored, 'reach')).toMatchObject({ priority: 3 });
  });

  // ⚠ **Zamítnutý commit preview nespotřebuje** (`T22-takeearly`). Do 4. 9. 2026
  // route vyzvedla preview hned na začátku, tedy dřív, než cokoli ověřila —
  // takže každé odmítnutí ho spálilo a druhý pokus dostal 404 „takové preview
  // tu není". Porotce tím přišel o placené volání modelu za větu, po které se
  // ve světě nezměnil ani bajt. „Jedno preview je jeden commit" platí pro
  // commit, který **prošel**; test o řádek výš to hlídá z druhé strany.
  it('preview zamítnuté bránou revizí přežije a podruhé řekne totéž', async () => {
    const stored = await generated();
    const first = pending(stored, plan({ shape: WOVEN_MAST }), 'change-a');
    const stale = pending(stored, plan({ shape: WOVEN_MAST }), 'change-b');

    expect((await commit(stored.session.sessionId, first.changeId)).status).toBe(200);

    const prvni = await commit(stored.session.sessionId, stale.changeId);
    const druhy = await commit(stored.session.sessionId, stale.changeId);

    expect(prvni.status, 'zastaralé preview mělo dostat 409').toBe(409);
    expect(druhy.status, 'druhý pokus dostal 404, takže se preview spálilo').toBe(409);
    expect((await body(druhy)).error).toMatchObject({ field: 'basedOn/representation' });
  });

  it('preview zamítnuté routerem přežije a podruhé řekne totéž', async () => {
    const stored = await generated();
    const change = pending(
      stored,
      plan({ shape: { ...(WOVEN_MAST as Record<string, unknown>), shapeId: 'ghostSpan' } as RefinePlan['shape'] }),
    );

    expect((await body(await commit(stored.session.sessionId, change.changeId))).outcome).toBe(
      'REJECTED',
    );

    // Týž verdikt, ne 404 — a pořád beze změny ve světě.
    const druhy = await body(await commit(stored.session.sessionId, change.changeId));
    expect(druhy.outcome, 'druhý pokus dostal jiný verdikt, takže se preview spálilo').toBe(
      'REJECTED',
    );
    expect(stored.session.revisionOf('ironMast')).toBe(0);
  });

  // `T22-rejectreplay`. Druhá strana téhož rozhodnutí: preview, které
  // odmítnutí přežilo, smí opakovat **týž verdikt nad týmž světem** — ne si
  // vzít okno, které mu mezitím otevřel někdo jiný. `staleRevision` na to
  // nedosáhne schválně: soudí jen části v patchi, a nezávislost částí je záměr.
  // Tenhle případ je právě ten, který záměr nepokrývá — pohnula se část, které
  // se preview netýká.
  it('zamítnuté preview se po pohybu JINÉ části světa už commitnout nedá', async () => {
    const stored = await generated();
    // Míří jen do `sim` a shodí svědka, takže dostane 200 REJECTED a ve světě
    // nezmění ani bajt.
    const loser = pending(
      stored,
      plan({ behavior: [{ op: 'remove', path: '/sim/rules/reach' }] }),
      'change-loser',
    );
    expect((await body(await commit(stored.session.sessionId, loser.changeId))).outcome).toBe(
      'REJECTED',
    );

    // Cizí věta pohne `look`. `sim` ani revize podoby se nehnuly, takže obě
    // dosavadní brány to preview pustí dál.
    const other = pending(
      stored,
      plan({ appearance: [{ op: 'replace', path: '/look/palette', value: 'sand' }] }),
      'change-other',
    );
    expect((await commit(stored.session.sessionId, other.changeId)).status).toBe(200);
    expect(worldOf(stored).lookRevision).toBe(1);
    expect(worldOf(stored).simRevision).toBe(0);
    expect(stored.session.revisionOf('ironMast')).toBe(0);

    const znovu = await commit(stored.session.sessionId, loser.changeId);
    expect(znovu.status, 'druhý pokus se soudil nad světem, který porotce neviděl').toBe(409);
    expect((await body(znovu)).error).toMatchObject({
      code: 'PREVIEW_REJECTED',
      field: 'changeId',
    });
  });

  // `T22-rejectreplay`, nález nezávislé revize 4. 9. 2026 — **přeživší mutant**.
  // Brána se hlásí k tomu, že soudí dvojici `sim`+`look` **jako celek**, jenže
  // měřila ji jediná věta, a ta hýbala `look`em. Vypustit z podmínky půlku
  // `sim` proto nechalo celou sadu (722) zelenou. Tohle je zrcadlový případ.
  //
  // Poražené preview míří **jen na podobu**, tedy do žádné části dokumentu:
  // nenese jedinou operaci, takže `staleRevision` nemá co soudit, a revize
  // podoby se cizím commitem nehnula. Mezi ním a rozhodnutím nad světem, který
  // člověk neviděl, tak stojí právě a jen půlka `sim` téhle brány.
  it('zamítnuté preview se po pohybu SAMOTNÉHO `sim` už commitnout nedá', async () => {
    const stored = await generated();
    // Tvar, který ve světě není: odmítne ho `nextBlueprint`, ne router, takže
    // preview projde celou cestou dolů bez jediné operace v patchi.
    const loser = pending(
      stored,
      plan({
        shape: { ...(WOVEN_MAST as Record<string, unknown>), shapeId: 'ghostSpan' } as RefinePlan['shape'],
      }),
      'change-loser',
    );
    expect((await body(await commit(stored.session.sessionId, loser.changeId))).outcome).toBe(
      'REJECTED',
    );

    // Cizí věta pohne **jen** `sim`. `look` i revize podoby zůstávají, kde byly.
    const other = pending(
      stored,
      plan({ behavior: [{ op: 'replace', path: '/sim/rules/reach/priority', value: 3 }] }),
      'change-other',
    );
    expect((await commit(stored.session.sessionId, other.changeId)).status).toBe(200);
    expect(worldOf(stored).simRevision).toBe(1);
    expect(worldOf(stored).lookRevision).toBe(0);
    expect(stored.session.revisionOf('ironMast')).toBe(0);

    const znovu = await commit(stored.session.sessionId, loser.changeId);
    expect(znovu.status, 'pohyb samotného `sim` tu bránu nezvedl').toBe(409);
    expect(
      (await body(znovu)).error,
      'brána mlčela a preview se soudilo znovu, jen nad jiným světem',
    ).toMatchObject({ code: 'PREVIEW_REJECTED', field: 'changeId' });
  });

  // `T22-rejectreplay`, nález nezávislé revize. Brána nad pohnutým světem
  // nesmí spolknout důvod: u vady tvaru patche verdikt na světě nezávisí,
  // takže když ho odpověď zamlčí, člověk se ho po prvním cizím commitu
  // nedozví už nikdy.
  it('brána nad pohnutým světem pořád řekne, PROČ ta věta neprošla', async () => {
    const stored = await generated();
    // Cesta nemíří ani do `/sim`, ani do `/look`, takže ji router odmítne —
    // a odmítne ji stejně nad každým světem.
    const loser = pending(
      stored,
      plan({ behavior: [{ op: 'replace', path: '/meta/title', value: 'nowhere' }] }),
      'change-malformed',
    );
    const prvni = await body(await commit(stored.session.sessionId, loser.changeId));
    expect(prvni.outcome).toBe('REJECTED');
    const duvod = (prvni.rejections as readonly Record<string, unknown>[])[0];

    const other = pending(
      stored,
      plan({ appearance: [{ op: 'replace', path: '/look/palette', value: 'sand' }] }),
      'change-other',
    );
    expect((await commit(stored.session.sessionId, other.changeId)).status).toBe(200);

    const znovu = await body(await commit(stored.session.sessionId, loser.changeId));
    expect(
      (znovu.error as Record<string, unknown>).rejections,
      'důvod odmítnutí se ztratil, a u téhle vady se nemá jak vrátit',
    ).toEqual([duvod]);
  });

  // `T22-rejectreplay`, **druhé kolo** nezávislé revize 4. 9. 2026, `blocking`.
  // Čítače jsou tři, ne dva: commit preview, které mění **jen tvar**, nenese
  // jedinou operaci, takže `sim` i `look` stojí a hne se jen revize podoby.
  // Dokud ji brána nečetla, propadl takový retry o pár řádků níž na
  // `STALE_REVISION`, které `rejections` nenese — a revize podoby je
  // monotónní, takže se ten důvod už neměl jak vrátit.
  it('zamítnuté preview se po pohybu SAMOTNÉ revize podoby už commitnout nedá', async () => {
    const stored = await generated();
    // Vada tvaru patche: verdikt na světě nezávisí, takže se opakováním
    // nemůže vrátit sám.
    const loser = pending(
      stored,
      plan({ behavior: [{ op: 'replace', path: '/meta/title', value: 'nowhere' }] }),
      'change-malformed',
    );
    const prvni = await body(await commit(stored.session.sessionId, loser.changeId));
    expect(prvni.outcome).toBe('REJECTED');
    const duvod = (prvni.rejections as readonly Record<string, unknown>[])[0];

    // Cizí věta mění jen podobu **téhož** objektu: žádná operace, tedy ani
    // `sim`, ani `look`.
    const other = pending(stored, plan({ shape: WOVEN_MAST }), 'change-shape');
    expect((await commit(stored.session.sessionId, other.changeId)).status).toBe(200);
    expect(stored.session.revisionOf('ironMast')).toBe(1);
    expect(worldOf(stored).simRevision).toBe(0);
    expect(worldOf(stored).lookRevision).toBe(0);

    const znovu = await commit(stored.session.sessionId, loser.changeId);
    expect(znovu.status).toBe(409);
    expect(
      (await body(znovu)).error,
      'retry propadl na STALE_REVISION, které důvod nenese',
    ).toMatchObject({ code: 'PREVIEW_REJECTED', field: 'changeId', rejections: [duvod] });
  });

  // `T22-gateorder`, nález nezávislé revize 4. 9. 2026. Razítková brána sedí
  // **nad** oběma návraty `STALE_REVISION`, takže u preview, které už jednou
  // prohrálo, přebije ten specifičtější kód. Naměřeno na téže trojici
  // požadavků: před bránou `409 {code:'STALE_REVISION', field:'basedOn/sim'}`,
  // po ní `409 {code:'PREVIEW_REJECTED', field:'changeId'}`.
  //
  // **Pořadí zůstává rozhodnutím** — „prohrálo jsi a svět se pohnul, vyžádej si
  // nové" je akceschopná věta a jako jediná veze původní verdikt s sebou. Test
  // proto pinuje, kudy ta hranice vede: **překryv patří razítku**, a preview,
  // které nikdy neprohrálo, dostane pořád `basedOn/sim`. Obě půlky jsou tu
  // nutné — bez té druhé smí stín růst dál a nikdo to nepozná, protože dvě 409
  // nad týmž stavem a s jiným kódem vypadají v zelené sadě stejně.
  it('překryv obou bran soudí razítko, a jen ten překryv', async () => {
    const stored = await generated();
    // Míří do `sim` a shodí svědka: 200 REJECTED, ve světě ani bajt, razítko na
    // preview. Operace v patchi je tu schválně — bez ní se `staleRevision`
    // vůbec nedosáhne a žádný překryv by nevznikl.
    const loser = pending(
      stored,
      plan({ behavior: [{ op: 'remove', path: '/sim/rules/reach' }] }),
      'change-loser',
    );
    // Postavené nad `sim` 0 už teď, aby mělo tutéž zastaralou bázi jako `loser`
    // — jen bez prohry. Commituje se až úplně dole.
    const cerstve = pending(
      stored,
      plan({ behavior: [{ op: 'replace', path: '/sim/rules/reach/priority', value: 5 }] }),
      'change-fresh',
    );

    const prvni = await body(await commit(stored.session.sessionId, loser.changeId));
    expect(prvni.outcome).toBe('REJECTED');
    const duvod = (prvni.rejections as readonly Record<string, unknown>[])[0];

    // Cizí věta pohne `sim` na 1. Od téhle chvíle platí na `loser` obě brány
    // naráz: razítko (svět se od prohry pohnul) i `staleRevision` (patch míří
    // do `sim`, který je proti `basedOn` napřed).
    const other = pending(
      stored,
      plan({ behavior: [{ op: 'replace', path: '/sim/rules/reach/priority', value: 3 }] }),
      'change-other',
    );
    expect((await commit(stored.session.sessionId, other.changeId)).status).toBe(200);
    expect(worldOf(stored).simRevision).toBe(1);

    const znovu = await commit(stored.session.sessionId, loser.changeId);
    expect(znovu.status).toBe(409);
    expect(
      (await body(znovu)).error,
      'překryv spadl na STALE_REVISION, takže se původní verdikt ztratil',
    ).toMatchObject({ code: 'PREVIEW_REJECTED', field: 'changeId', rejections: [duvod] });

    // Druhá půlka hranice: `cerstve` má tutéž zastaralou bázi, ale razítko ne,
    // takže na něj ta brána nesmí dosáhnout a specifičtější kód vyhraje.
    const nikdy = await commit(stored.session.sessionId, cerstve.changeId);
    expect(nikdy.status).toBe(409);
    expect(
      (await body(nikdy)).error,
      'stín razítka se rozšířil i na preview, které nikdy neprohrálo',
    ).toMatchObject({ code: 'STALE_REVISION', field: 'basedOn/sim' });
  });

  it('tvar, který ve světě není, se tiše nepodstrčí', async () => {
    const stored = await generated();
    const change = pending(
      stored,
      plan({
        shape: { ...(WOVEN_MAST as Record<string, unknown>), shapeId: 'ghostSpan' } as RefinePlan['shape'],
      }),
    );

    const read = await body(await commit(stored.session.sessionId, change.changeId));
    expect(read.outcome).toBe('REJECTED');
    // Revize se nezvedla, takže prohlížeč nepřemeshuje starou podobu jako novou.
    expect(stored.session.revisionOf('ironMast')).toBe(0);
  });

  it('operace mimo obě části dokumentu neprojde routerem', async () => {
    const stored = await generated();
    const change = pending(
      stored,
      // Faseta by tohle nepustila, ale preview může přijít i z jiného kola;
      // rozhoduje router nad cestami, ne štítek.
      plan({ behavior: [{ op: 'replace', path: '/simRevision', value: 9 }] }),
    );

    const read = await body(await commit(stored.session.sessionId, change.changeId));
    expect(read.outcome).toBe('REJECTED');
    expect(worldOf(stored).simRevision).toBe(0);
  });
});


/* ------------------------------------------------------------------ *
 * Předpoklad razítkové brány: na serveru revize jenom rostou
 * ------------------------------------------------------------------ */

/**
 * **`T22-rewindrevision`.** Razítko z `T22-rejectreplay` porovnává revize přes
 * `!==`, takže opakovaný commit prohraného preview odmítne právě tehdy, když se
 * svět od prohry pohnul. Ta brána mlčky stojí na tom, že revize **rostou**:
 * jakmile se svět umí vrátit na dřívější číslo, dorovná se razítko zpátky a
 * brána se otevře znovu — nad jiným světem, který má náhodou totéž číslo.
 *
 * **Naměřeno 6. 9. 2026, ne odhadnuto.** Přetáčení času (`src/sim/rebranch.ts`,
 * `T24`) je celé v prohlížeči: volají ho `Timeline.tsx` a `TimeAxis.tsx`, ani
 * jeden nesahá na síť, a žádná route pod `src/app/api/` na `rebranchAt`
 * nedosáhne. Do `stored.blueprint` píšou dvě místa a obě jen dopředu — revizi
 * zvedá výhradně inkrement v `src/ir/revision.ts`.
 *
 * ⚠ **Návrh úlohy „porovnávat `<` místo `!==`" tohle měření vyvrací.**
 * Přetočení vrátí čítač na hodnotu, kterou razítko nese, takže po návratu ze
 * `sim` 5 na `sim` 3 je `rejectedAt.sim < doc.simRevision` nepravdivé úplně
 * stejně jako `!==` — obojí bránu otevře. Použitelná zůstává jen druhá cesta:
 * **při přetočení zahodit razítka celá**, protože po něm rovnost čísel přestává
 * znamenat shodu světů.
 *
 * Test proto nepinuje chování brány; dokud čas nejde zpátky, vypadají obě
 * varianty v zelené sadě stejně. Pinuje **ten předpoklad**: den, kdy přetáčení
 * dostane serverové dveře, tohle zčervená a ukáže na tuhle úlohu.
 *
 * Uzávěr se počítá z rozřešených importů, ne greppem přes seznam jmen. Seznam
 * řetězců obešly u `T28-editpins` dvě nezávislé revize beze změny chování,
 * a tranzitivní cesta (route → helper → `rebranch`) by mu unikla celá.
 */
describe('razítková brána stojí na tom, že se čas na server nedostal', () => {
  const REBRANCH = 'src/sim/rebranch.ts';
  const IMPORT_SPECIFIER = /(?:\bfrom\b|\bimport\b|\brequire\b)\s*\(?\s*['"]([^'"]+)['"]/g;

  /** Komentář, který cestu jen zmiňuje, není import — a zrovna tenhle soubor jich má hodně. */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const posixPath = (file: string): string =>
    relative(process.cwd(), file).split(sep).join(posix.sep);

  function routeFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return routeFiles(full);
      return entry.name === 'route.ts' ? [posixPath(full)] : [];
    });
  }

  function resolvedImports(file: string): string[] {
    const found: string[] = [];
    for (const match of stripComments(readFileSync(file, 'utf8')).matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      const base = specifier.startsWith('.')
        ? resolve(dirname(file), specifier)
        : specifier.startsWith('@/')
          ? resolve('src', specifier.slice(2))
          : null;
      if (base === null) continue;
      const hit = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((candidate) =>
        existsSync(candidate),
      );
      if (hit !== undefined) found.push(posixPath(hit));
    }
    return found;
  }

  function importClosure(entry: string): Set<string> {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...resolvedImports(next));
    }
    return seen;
  }

  const routes = routeFiles('src/app/api');
  const serverClosure = new Set(routes.flatMap((route) => [...importClosure(route)]));

  it('sběr dveří vůbec něco najde', () => {
    // Prázdný seznam by obě brány níž nechal zeleně projít a nehlídaly by nic.
    expect(routes.length).toBeGreaterThan(10);
    expect(routes).toContain(
      'src/app/api/worldstream/sessions/[sessionId]/changes/[changeId]/commit/route.ts',
    );
  });

  it('žádné veřejné dveře nedosáhnou na přetáčení času', () => {
    expect(
      routes.filter((route) => importClosure(route).has(REBRANCH)),
      'přetáčení času dostalo serverové dveře, takže svět umí jít na dřívější revizi a razítková brána se nad ním znovu otevře — otevři T22-rewindrevision',
    ).toEqual([]);
  });

  it('do blueprintu relace píšou dvě místa a obě jen dopředu', () => {
    const writers = [...serverClosure]
      .filter((file) => /\.blueprint\s*=[^=]/.test(stripComments(readFileSync(file, 'utf8'))))
      .sort();
    expect(
      writers,
      'blueprint relace přepisuje nový zapisovatel — ověř, že nesnižuje revizi (T22-rewindrevision)',
    ).toEqual([
      'src/app/api/worldstream/sessions/[sessionId]/changes/[changeId]/commit/route.ts',
      'src/worldstream/sessions.ts',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Strop souběhu — jeden čítač pro oboje placené dveře
 * ------------------------------------------------------------------ */

/** Emitor, který si počítá, kolikrát se za něj zaplatilo. */
function countingEmit(): { emit: (request: UpstreamRequest) => Promise<unknown>; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    emit: async () => {
      calls += 1;
      return {
        summary: 'the mast turns sand',
        shape: null,
        behavior: [],
        appearance: [{ op: 'replace', path: '/look/palette', value: 'sand' }],
      };
    },
  };
}

describe('druhá věta umí založit zákon', () => {
  it('pravidlo bez `id` projde celou cestou od věty ke commitu', async () => {
    // **Jediný test, který tuhle cestu měří celou** — a proto je tady, ne
    // u `readRefineEmission`. Nález nezávislé revize 4. 9. 2026: model, který
    // napíše `add /sim/rules/<klíč>` s tělem bez `id`, dostal
    // `introducedRuleKeyFault` → `REJECTED`, a **za commitem žádné opravné kolo
    // není**, takže to byl konec. Zákon se přidat nedal, přestože přesně to
    // slibuje design book §4 dějství III.
    //
    // Preview se proto zakládá **scriptovaným emitorem přes `createChange()`**,
    // ne `putChange()`: dosazení `id` bydlí v `readRefineEmission`, tedy na
    // cestě, kterou ruční vložení preview obchází.
    const stored = await generated();
    const created = await preview(
      stored.session.sessionId,
      { prompt: 'the bridge lights up when the surveyor reaches the mast' },
      async () => ({
        summary: 'reaching the mast now wins',
        shape: null,
        appearance: [],
        behavior: [
          {
            op: 'add',
            path: '/sim/rules/lightUp',
            value: {
              phase: 0,
              priority: 1,
              event: { kind: 'onEnterZone', entity: 'surveyor', zone: 'mastPad' },
              condition: null,
              actions: [{ kind: 'win' }],
            },
          },
        ],
      }),
    );
    expect(created.status).toBe(200);
    const changeId = (await body(created)).changeId as string;

    const read = await body(await commit(stored.session.sessionId, changeId));
    expect(read.outcome, 'zákon se nedal přidat').toBe('COMMITTED');
    expect(read.applied).toEqual(['sim']);
    // A pravidlo v dokumentu je adresovatelné: `id` se rovná klíči, jinak by ho
    // příští věta nenašla.
    expect(ruleOf(stored, 'lightUp')).toMatchObject({ id: 'lightUp' });
  });
});

describe('strop souběžných placených volání', () => {
  it('preview se počítá do TÉHOŽ stropu jako zakládání relace', async () => {
    const stored = await generated();
    const model = countingEmit();

    // **Obojí odmítnutí musí být vidět v operátorském logu**, jinak je strop
    // na nasazené adrese nepozorovatelný: 503 vidí jen ten, kdo ho dostal.
    // Tenhle test je jediný producent obou klíčů v souboru, takže oba výskyty
    // jsou první a `logRateLimited` je vydá i s promlčením.
    const log: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      log.push(String(line));
    });

    // Čítač se sytí **všemi troje dveřmi**, protože žádné na dno samy nesmí:
    // každé se zastaví o svůj strop dřív a zbytek drží ty ostatní. Tenhle test
    // soudí sdílenost stropu, ne rezervu — tu soudí dva testy pod ním.
    // Součet stropů (7) je nad dnem (6), takže se sytí **na dno**, ne na stropy:
    // poslední slot vezme ten, kdo přijde první.
    for (let taken = 0; taken < MAX_CONCURRENT_GENERATIONS; taken += 1) {
      const door = (['world', 'generate', 'refine'] as const)[taken % 3];
      expect(acquireSlot(door), `slot ${taken} (${door}) měl být volný`).toBe(true);
    }

    // Troje dveře, jeden strop. Kdyby měly čítače vlastní, útočník by je
    // střídal a v letu by běželo dvanáct placených volání místo čtyř.
    const refusedSession = await createSession(
      new Request('http://127.0.0.1/api/worldstream/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'a salt flat with one iron mast' }),
      }),
    );
    expect(refusedSession.status).toBe(503);
    expect((await body(refusedSession)).error).toMatchObject({ code: 'TOO_MANY_SESSIONS' });

    const refusedChange = await preview(
      stored.session.sessionId,
      { prompt: 'make the mast sand-coloured' },
      model.emit,
    );
    expect(refusedChange.status).toBe(503);
    expect((await body(refusedChange)).error).toMatchObject({ code: 'TOO_MANY_CHANGES' });

    // Odmítnutí je **před** modelem. Za preview, které se nekonalo, se neplatí.
    expect(model.calls()).toBe(0);

    const refusedSessions = log.filter((line) => line.includes('TOO_MANY_SESSIONS'));
    const refusedChanges = log.filter((line) => line.includes('TOO_MANY_CHANGES'));
    expect(refusedSessions, 'odmítnutá relace neodešla operátorovi').toHaveLength(1);
    expect(refusedSessions[0]).toContain('[worldstream/sessions]');
    expect(refusedChanges, 'odmítnuté preview neodešlo operátorovi').toHaveLength(1);
    expect(refusedChanges[0]).toContain('[worldstream/changes]');

    // **Oba řádky jmenují, které dveře ty sloty drží** (`T22-doorcounters`).
    // Do té doby uměl čítač říct jen souhrn, takže operátor u zavřených dveří
    // na stavbu světa nepoznal, jestli je zavřely světy, nebo preview — a
    // tenhle případ je přesně ten druhý. Čísla doslova, ne interpolovaná: se
    // stejnou konstantou na obou stranách by se strop dal zvednout ze čtyř na
    // čtyřicet a řádek by se pořád shodoval sám se sebou.
    expect(refusedSessions[0]).toContain(
      'paid slots in flight: 2 world + 2 generate + 2 refine of 6 on this instance; ' +
        'the world door may hold 3',
    );
    expect(refusedChanges[0]).toContain(
      'paid slots in flight: 2 world + 2 generate + 2 refine of 6 on this instance; ' +
        'the refine door may hold 2',
    );

    // A jakmile se jeden slot uvolní, tytéž dveře pustí.
    releaseSlot('refine');
    const accepted = await preview(
      stored.session.sessionId,
      { prompt: 'make the mast sand-coloured' },
      model.emit,
    );
    expect(accepted.status).toBe(200);
    expect((await body(accepted)).outcome).toBe('PREVIEW');
    expect(model.calls()).toBe(1);
  });

  it('preview slot vrátí, takže věty v řadě neucpou strop', async () => {
    const stored = await generated();
    const model = countingEmit();

    // O jednu víc, než je strop. Kdyby si preview slot nechalo, poslední by
    // narazila na 503 — a stačilo by na to pár vět od jednoho porotce.
    for (let i = 0; i <= MAX_CONCURRENT_GENERATIONS; i += 1) {
      const response = await preview(
        stored.session.sessionId,
        { prompt: 'make the mast sand-coloured' },
        model.emit,
      );
      expect(response.status).toBe(200);
    }
    expect(model.calls()).toBe(MAX_CONCURRENT_GENERATIONS + 1);
    expect(acquireSlot('refine')).toBe(true);
  });

  it('zakládání relace nevyhladoví druhou větu — jeden slot je rezerva', async () => {
    // **Vlastnost, kterou oko nepokryje.** Vyhladovění vypadá zvenčí jako
    // „model je dneska pomalý", ne jako strop: porotce dostane 503, svede to
    // na poskytovatele a druhá věta — hlavní věc, kterou má vidět — přestane
    // fungovat po čtyřech anonymních požadavcích.
    //
    // Drahé dveře drží slot po celou generaci na pozadí (až
    // `MAX_BLUEPRINT_ROUNDS` kol, každé `fetch` omezené jen 120 s), levné jen
    // na jedno `planChange`. Rezerva je proto asymetrická schválně.
    const stored = await generated();
    const model = countingEmit();

    // Drahé dveře se nasytí o slot dřív, než je čítač plný.
    for (let i = 0; i < MAX_WORLD_GENERATIONS; i += 1)
      expect(acquireSlot('world'), `slot ${i} měl být volný`).toBe(true);
    expect(acquireSlot('world'), 'zakládání relace dosáhlo až na dno čítače').toBe(false);

    // A to je celý smysl: rezervovaný slot pustí preview dovnitř.
    const accepted = await preview(
      stored.session.sessionId,
      { prompt: 'make the mast sand-coloured' },
      model.emit,
    );
    expect(accepted.status, 'druhá věta narazila na strop, který ji měl nechat projít').toBe(200);
    expect((await body(accepted)).outcome).toBe('PREVIEW');
    expect(model.calls()).toBe(1);

    // Rezerva je jeden slot, ne druhá fronta: preview svůj slot vrátilo, takže
    // levné dveře dojdou na **svůj** strop a další pokus už neprojde.
    for (let i = 0; i < DOOR_CEILING.refine; i += 1)
      expect(acquireSlot('refine'), `rezervovaný slot ${i} měl být volný`).toBe(true);
    expect(acquireSlot('refine'), 'preview dosáhlo za svůj strop').toBe(false);
  });

  it('druhá věta nevyhladoví stavbu světa — rezerva platí obojím směrem', async () => {
    // **Zrcadlo testu nad tímhle, a do `T22-doorcounters` bylo červené.** Než
    // se v letu začalo počítat po dveřích, byl `running` jedno nerozlišené
    // číslo, takže tři visící preview zavřela **oboje** dveře na stavbu světa
    // na celé dvě minuty (`DEFAULT_TIMEOUT_MS`), aniž se stavěl jediný svět.
    // Cena toho útoku byla tři anonymní požadavky.
    //
    // Vypadá to zvenčí jako „model je dneska pomalý", ne jako strop — proto to
    // pokrývá test, ne oko.
    for (let i = 0; i < DOOR_CEILING.refine; i += 1)
      expect(acquireSlot('refine'), `preview ${i} nemělo na co narazit`).toBe(true);
    // **Až na dno nesmí ani preview.** Nezávislá revize 4. 9. 2026 spustila
    // první podobu téhle úlohy, kde `refine` dno dosáhlo: čtyři souběžná
    // preview pak zavřela oboje dveře na stavbu světa a útok jen podražil ze
    // tří požadavků na čtyři.
    expect(acquireSlot('refine'), 'preview dosáhlo za svůj strop').toBe(false);

    const accepted = await createSession(
      new Request('http://127.0.0.1/api/worldstream/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'a salt flat with one iron mast' }),
      }),
    );
    expect(accepted.status, 'tři visící preview zavřela stavbu světa').toBe(202);
  });

  it('demo dveře `/api/generate` nevyhladoví zakládání relace', async () => {
    // **Nález druhého kola nezávislé revize 4. 9. 2026, `VERDICT: blocking`.**
    // Veřejné dveře na placené volání jsou **troje**, ale čítače byly dva:
    // `/api/generate` si bralo slot pod jménem `world`, tedy z týchž slotů jako
    // zakládání relace. Tři souběžná `POST /api/generate` (strop frekvence
    // pustí padesát za deset sekund, takže tři jsou zadarmo) tím obsadila celý
    // strop dveří `world` na celou dobu poskytovatele — až 120 s na jedno
    // `fetch`, a k tomu opravná kola — a **každé** `POST /sessions` po tu dobu
    // dostalo 503. Rezerva na dveře platí jen tehdy, když má vlastní čítač
    // každé veřejné dveře; tohle je ten třetí.
    for (let i = 0; i < DOOR_CEILING.generate; i += 1)
      expect(acquireSlot('generate'), `demo slot ${i} měl být volný`).toBe(true);
    expect(acquireSlot('generate'), 'demo dveře dosáhly za svůj strop').toBe(false);

    const accepted = await createSession(
      new Request('http://127.0.0.1/api/worldstream/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'a salt flat with one iron mast' }),
      }),
    );
    expect(accepted.status, 'nasycené demo dveře zavřely zakládání relace').toBe(202);
  });

  it('žádné dveře nedokážou vyhladovět ty ostatní — invariant rezervy', () => {
    // **Tohle je ta vlastnost, kterou se rezerva dá porušit tiše.** Zvednout
    // kterýkoli strop o jedna vypadá jako uvolnění a přitom sebere rezervu
    // jiným dveřím: dveře, které nedrží nic, se dovnitř dostanou, jen když na
    // dno čítače nedosáhnou ty ostatní **samy**. Soudí se to nad konstantami
    // i chováním, protože komentář nad `DOOR_CEILING` to uhlídat nemůže.
    const doors = ['world', 'generate', 'refine'] as const;

    for (const door of doors) {
      const others = doors
        .filter((other) => other !== door)
        .reduce((sum, other) => sum + DOOR_CEILING[other], 0);
      expect(others, `${door}: ostatní dveře na dno čítače dosáhnou samy`).toBeLessThan(
        MAX_CONCURRENT_GENERATIONS,
      );
    }

    // ⚠ **Dnes je součet stropů roven dnu čítače, takže brána na součet
    // nekousne první nikdy** — kousnou stropy dveří. Není to zbytečná brána:
    // je to jediné, co drží celkový strop, kdyby někdo kterýkoli strop dveří
    // zvedl. Kdyby ta rovnost padla směrem nahoru, začne rozhodovat součet a
    // tenhle řádek to řekne dřív, než se to projeví na účtu.
    expect(
      doors.reduce((sum, door) => sum + DOOR_CEILING[door], 0),
      'součet stropů klesl na dno čítače — brána na součet přestala rozhodovat',
    ).toBeGreaterThan(MAX_CONCURRENT_GENERATIONS);

    // A totéž jako chování, ne jen jako aritmetika: nasytit ostatní dveře až
    // na jejich strop a zkusit ty nečinné.
    for (const door of doors) {
      resetConcurrency();
      for (const other of doors.filter((each) => each !== door))
        for (let i = 0; i < DOOR_CEILING[other]; i += 1)
          expect(acquireSlot(other), `${other} nedosáhlo na svůj strop`).toBe(true);
      expect(acquireSlot(door), `${door}: ostatní dveře ho vyhladověly`).toBe(true);
    }
  });

  it('součet přes všechny dveře nepřeroste strop, ať přijdou v jakémkoli pořadí', async () => {
    // **Rozpad po dveřích je rozpad, ne druhý strop.** Kdyby si každé dveře
    // hlídaly jen svoje číslo, běželo by v letu tolik volání, kolik je součet
    // stropů — dnes sedm proti dnu šesti — a dno by bylo jen návod, jak se
    // střídat. Součet proto rozhoduje pořád, ať se dveře prokládají jakkoli.
    for (const door of ['world', 'generate', 'refine'] as const)
      for (let i = 0; i < DOOR_CEILING[door] - (door === 'world' ? 0 : 1); i += 1)
        expect(acquireSlot(door), `${door} nedosáhlo na svůj strop`).toBe(true);

    // Pět v letu: `world` na svém stropu, `generate` i `refine` pod ním. Šestý
    // slot ještě je, sedmý ne — a odmítne ho **součet**, ne strop těch dveří.
    expect(acquireSlot('refine'), 'šestý slot měl být volný').toBe(true);
    for (const door of ['generate', 'refine'] as const)
      expect(acquireSlot(door), `${door}: součet přerostl MAX_CONCURRENT_GENERATIONS`).toBe(false);
    expect(MAX_CONCURRENT_GENERATIONS, 'dno se pohnulo — přepiš i tenhle test').toBe(6);
  });

  it('neznámé dveře slot nedostanou a čítač neotráví (P15 T22-doorkeyguard)', () => {
    // Typ `PaidDoor` je dnes jediná zábrana. Kdyby ji někdo obešel, `running[door]`
    // je `undefined`, obě porovnání `>=` jsou nepravda a `+= 1` zapíše `NaN` —
    // od té chvíle je `NaN >= MAX_CONCURRENT_GENERATIONS` nepravda navždy a
    // strop na součet neodmítne nikoho do konce života procesu. V zelené sadě
    // vypadá `NaN` přesně jako nula, proto se ten stav vyrábí přetypováním.
    const stranger = 'admin' as PaidDoor;
    // Vrácení jde první schválně: bez zábrany by `-= 1` na `undefined` klíč
    // založilo (`NaN`), a vzetí by ho pak už za cizí nepoznalo.
    releaseSlot(stranger);
    expect(acquireSlot(stranger), 'cizí dveře slot dostaly').toBe(false);

    // Čítač zůstal beze změny: všechna troje dveře dojdou přesně na svůj strop
    // a součet pak odmítne — kdyby byl `NaN`, prošlo by cokoli.
    // Součet stropů (7) je nad dnem (6), takže se sytí **na dno**, ne na stropy:
    // poslední slot vezme ten, kdo přijde první.
    for (let taken = 0; taken < MAX_CONCURRENT_GENERATIONS; taken += 1) {
      const door = (['world', 'generate', 'refine'] as const)[taken % 3];
      expect(acquireSlot(door), `slot ${taken} (${door}) měl být volný`).toBe(true);
    }
    for (const door of ['world', 'generate', 'refine'] as const)
      expect(acquireSlot(door), `${door}: čítač je otrávený, součet nekousl`).toBe(false);
    expect(slotsDetail('world')).not.toContain('NaN');
  });
});

/* ------------------------------------------------------------------ *
 * Rozpočet požadavku: brána, která nikdy nesepnula (P15 T22-admissiondead).
 * ------------------------------------------------------------------ */

describe('pomalý požadavek končí na stropu těla, ne na rozpočtu', () => {
  /**
   * **Brána, která nesepne, vypadá v kódu i v testu úplně stejně jako brána,
   * která sepne.** Obojí dveře držely `admit()` na promlčeném rozpočtu:
   * preview odmítalo nad 8 s čekání, zakládání relace nad 12 s. Jenže
   * `receivedAtMs` se bralo až uvnitř handleru, takže jediný interval, který se
   * odsud dá změřit, je čtení těla — a to má vlastní strop
   * `BODY_DEADLINE_MS = 5 000`. Naměřeno nezávislou revizí 3. 9. 2026:
   * 0 / 1 000 / 4 999 / 5 000 / 7 999 ms všechno `ADMITTED`.
   *
   * Tenhle test pojmenovává **větev, která zbyla**: nejpomalejší, co požadavek
   * dokáže, je vyčerpat strop těla, a odpověď na to je 408, ne odmítnutí
   * rozpočtem. Kdo sem příště bude psát časovou bránu, musí ji vejít pod
   * `BODY_DEADLINE_MS`, jinak vyrobí totéž znovu.
   *
   * Hodiny jsou falešné schválně — pravdivý běh by stál pět vteřin za test.
   */
  function stalledRequest(url: string): Request {
    // Proud, který nikdy nic nepošle a nikdy se nezavře: přesně to, co brána
    // na čas má chytit.
    const stalled = new ReadableStream({ pull() { return new Promise<void>(() => undefined); } });
    return new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stalled,
      // Node vyžaduje u proudového těla; `Request` ho bez toho odmítne složit.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  }

  /** Tělo, které dorazí celé, jen pozdě. `delayMs` je pod stropem těla. */
  function slowRequest(url: string, payload: unknown, delayMs: number): Request {
    let sent = false;
    const late = new ReadableStream({
      pull(controller) {
        if (sent) {
          controller.close();
          return undefined;
        }
        sent = true;
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
            resolve();
          }, delayMs);
        });
      },
    });
    return new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: late,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  }

  async function answerAfterDeadline(pending: Promise<Response>): Promise<Response> {
    await vi.advanceTimersByTimeAsync(BODY_DEADLINE_MS + 1);
    return pending;
  }

  it('preview druhé věty: 408 TIMEOUT, žádné odmítnutí rozpočtem', async () => {
    vi.useFakeTimers();
    const url = 'http://127.0.0.1/api/worldstream/sessions/s-1/changes';
    const response = await answerAfterDeadline(createChange(stalledRequest(url), 's-1', null));

    expect(response.status, 'pomalé tělo neskončilo na svém vlastním stropu').toBe(408);
    expect((await body(response)).error).toMatchObject({ code: 'TIMEOUT' });
  });

  it('zakládání relace: 408 TIMEOUT, žádné odmítnutí rozpočtem', async () => {
    vi.useFakeTimers();
    const url = 'http://127.0.0.1/api/worldstream/sessions';
    const response = await answerAfterDeadline(createSession(stalledRequest(url)));

    expect(response.status, 'pomalé tělo neskončilo na svém vlastním stropu').toBe(408);
    expect((await body(response)).error).toMatchObject({ code: 'TIMEOUT' });
  });

  /**
   * **Vlastnost, ne pravopis** — a je to oprava routovaného nálezu revize
   * ze 4. 9. 2026. Lexikální brána o kus níž pozná jen `admit(` a slovo
   * `receivedAtMs`; `import { admit as gate }` nebo přejmenovaný čítač by jí
   * prošly a nedosažitelná 503 by se vrátila nad zelenou sadou. Tenhle test
   * proti tomu drží **chování**: tělo, které dorazí těsně pod `BODY_DEADLINE_MS`,
   * musí být obsloužené. Jakýkoli budoucí rozpočet měřený od vstupu handleru
   * a kratší než strop těla ho položí, ať se jmenuje jak chce.
   */
  it('tělo těsně pod stropem projde až k modelu, ne k odmítnutí', async () => {
    vi.useFakeTimers();
    const stored = await generated();
    const model = countingEmit();
    const url = `http://127.0.0.1/api/worldstream/sessions/${stored.session.sessionId}/changes`;
    const request = slowRequest(url, { prompt: 'make the mast sand-coloured' }, BODY_DEADLINE_MS - 1);

    const pending = createChange(request, stored.session.sessionId, model.emit);
    await vi.advanceTimersByTimeAsync(BODY_DEADLINE_MS - 1);
    const response = await pending;

    expect(response.status, 'tělo pod stropem těla přesto neprošlo').toBe(200);
    expect((await body(response)).outcome).toBe('PREVIEW');
    expect(model.calls(), 'k modelu se to nedostalo').toBe(1);
  });

  /**
   * Druhá polovina téhož tvrzení, a soudí se **zdroj**, protože chybějící brána
   * nemá pozorovatelný následek: cesta bez ní vypadá zvenčí přesně jako cesta
   * s branou, která nikdy nesepne. To je celý důvod, proč ten nález našla až
   * revize s měřítkem v ruce, a ne sada.
   *
   * Soudí se **dvě věci**: že tam není `admit(`, a — obecněji, tedy i na
   * přejmenovanou podobu — že si ani jedny dveře neberou hodiny **před** čtením
   * těla. Rozpočet naarmovaný dřív než `readBody` je přesně ten tvar, který
   * strop těla postaví mimo dosah.
   *
   * **Komentáře se odstřihnou** — jinak by bránu prošly zrovna ty odstavce
   * v hlavičkách obou rout, které tuhle historii popisují. Týž postup jako
   * u lexikální brány v `sessions.test.ts`.
   */
  it('ani jedny dveře nedrží hodiny naarmované na vstupu handleru', () => {
    const routes = [
      'src/app/api/worldstream/sessions/route.ts',
      'src/app/api/worldstream/sessions/[sessionId]/changes/route.ts',
    ];

    for (const route of routes) {
      const code = readFileSync(route, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

      expect(code, `${route} volá admit() na rozpočtu, který čtení těla nikdy nepřečerpá`).not.toMatch(
        /\badmit\s*\(/,
      );
      expect(code, `${route} si zase bere čas na vstupu handleru`).not.toContain('receivedAtMs');

      // A totéž o patro obecněji, protože jméno se dá změnit: nad voláním
      // `readBody(request)` nesmí stát žádné čtení hodin. Rozpočet naarmovaný
      // dřív měří interval, který strop těla sám omezuje na pět vteřin.
      const bodyRead = code.indexOf('await readBody(request)');
      expect(bodyRead, `${route}: čtení těla ve zdroji chybí`).toBeGreaterThan(-1);
      expect(
        code.slice(0, bodyRead).indexOf('Date.now()'),
        `${route} armuje hodiny ještě před čtením těla`,
      ).toBe(-1);
    }
  });
});

describe('strop na frekvenci dorazí až ke dveřím', () => {
  it('padesátý první požadavek v okně je 429 s retry-after, ne 200', async () => {
    // Okno se plní přímo čítačem, ne padesáti HTTP požadavky: měří se tady
    // **zapojení** meze do těchhle dveří, ne mez sama (ta má vlastní sadu
    // v `src/server/__tests__/rate-limit.test.ts`).
    const stored = await generated();
    const model = countingEmit();
    for (let taken = 0; taken < MAX_REQUESTS_PER_WINDOW; taken += 1)
      takeRateSlot('changes', 'unknown');

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'make the mast sand-coloured' },
      model.emit,
    );
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await body(response)).error).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    // Odmítnutí je **před** modelem. Za preview, které se nekonalo, se neplatí.
    expect(model.calls()).toBe(0);
  });

  /** Tělo, které mlčí, dokud mu to někdo nedovolí — obsazuje slot čtení. */
  function silentBody(): { readonly request: Request; readonly finish: () => void } {
    let close = (): void => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        close = () => {
          controller.close();
        };
      },
    });
    const request = new Request('http://127.0.0.1/api/worldstream/sessions/s-1/changes', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    return {
      request,
      finish: () => {
        close();
      },
    };
  }

  it('commit je taky za stropem, ne jen preview', async () => {
    // **Nález nezávislé revize 4. 9. 2026, 2. kolo.** Commit byly jediné
    // veřejné `POST` dveře mimo `RateLimitedDoor`, a přitom vedou na
    // `routePatch` i `commitRoutedParts`. Zamítnutý commit navíc preview
    // **nespotřebuje** (`peekChange`, ne `takeChange`), takže jedno zaplacené
    // preview kupovalo neomezené opakování téhle práce.
    const stored = await generated();
    const change = pending(stored, plan({ shape: WOVEN_MAST }));
    for (let taken = 0; taken < MAX_REQUESTS_PER_WINDOW; taken += 1)
      takeRateSlot('commit', 'unknown');

    const response = await commit(stored.session.sessionId, change.changeId);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await body(response)).error).toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    // A brána je **před** prací: preview pořád čeká, svět se nezměnil.
    expect(stored.session.revisionOf('ironMast')).toBe(change.basedOn.representation);
  });

  it('okno commitu patří JEDNOMU volajícímu, ne dveřím', async () => {
    // **Test-gap ze 3. kola nezávislé revize 4. 9. 2026, ověřený mutací.** Test
    // nad ním plní okno klíčem `'unknown'` a požadavek posílá bez hlaviček
    // proxy, takže obojí spadne do téhož kbelíku: vyměnit v route
    // `callerKey(request)` za konstantu by zůstalo zelené. A přitom je to
    // přesně ta vada, kterou 1. kolo revize opravovalo u ostatních šesti dveří
    // — jeden flooder zavře commit **všem**, a to už za 5,1 požadavku za
    // sekundu místo naměřených ~66.
    const stored = await generated();
    const theirs = pending(
      stored,
      plan({ appearance: [{ op: 'replace', path: '/look/palette', value: 'sand' }] }),
      'change-theirs',
    );
    const mine = pending(stored, plan({ shape: WOVEN_MAST }), 'change-mine');

    const FLOODER = '203.0.113.7';
    const BYSTANDER = '198.51.100.4';
    // Klíč skládá `callerKey()`, ne ruka: předpona `ip:` je součást obrany
    // proti složení sentinelu z hlavičky, a opsat ji sem podruhé znamená
    // pinovat překlep místo chování.
    for (let taken = 0; taken < MAX_REQUESTS_PER_WINDOW; taken += 1)
      takeRateSlot('commit', callerKey(commitRequest(FLOODER)));

    // Kdo nestřílel, projde celou cestou až ke commitnutému světu.
    expect((await commit(stored.session.sessionId, theirs.changeId, BYSTANDER)).status).toBe(200);

    // Kdo okno naplnil, dostane 429 — a jeho preview je přitom v pořádku.
    const refused = await commit(stored.session.sessionId, mine.changeId, FLOODER);
    expect(refused.status).toBe(429);
    expect((await body(refused)).error).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('při plném okně je neznámá relace 429, ne 404', async () => {
    // **Test-gap ze 3. kola revize:** pořadí brány vůči `getSession`
    // a `peekChange` drží jedině komentář ve zdroji. Posunout ji pod ně vypadá
    // neškodně a znamená, že nápor na neexistující relace zaplatí `getSession`
    // i `peekChange` za každý požadavek — tedy tu práci, kterou má brána
    // ušetřit.
    const FLOODER = '203.0.113.7';

    // Kontrola proti falešnému poplachu, a je tu první schválně: s prázdným
    // oknem tytéž dveře a tentýž požadavek 404 dají.
    const missing = await commit('no-such-session', 'no-such-change', FLOODER);
    expect(missing.status).toBe(404);
    expect((await body(missing)).error).toMatchObject({ code: 'UNKNOWN_SESSION' });

    for (let taken = 0; taken < MAX_REQUESTS_PER_WINDOW; taken += 1)
      takeRateSlot('commit', callerKey(commitRequest(FLOODER)));

    const refused = await commit('no-such-session', 'no-such-change', FLOODER);
    expect(refused.status).toBe(429);
    expect((await body(refused)).error).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('plná instance jde do operátorského logu jako kapacita, ne jako moc požadavků', async () => {
    // **Test-gap ze 3. kola revize:** `rateLimitCode(slot)` stojí na sedmi
    // místech a **žádné** z nich nepinuje test — vrátit tam napevno psané
    // `'TOO_MANY_REQUESTS'`, jak to všech sedmero dveří dělalo do 4. 9. 2026,
    // přežije celou sadu. Operátor by pak nad naplněnou instancí četl tvrzení
    // o volajícím, které odpověď o řádek níž zrovna opravila; `logRateLimited`
    // navíc klíčuje `(dveře, kód)`, takže by se oba případy slily do jednoho
    // promlčovacího okna a ten vzácnější by z něj nevylezl nikdy.
    //
    // ⚠ **Pinuje to JEDNY dveře ze sedmi.** Každé další bydlí v jiné sadě
    // s vlastní fixturou a je to týž trojřádek opsaný vedle; `rateLimitCode()`
    // samo soudí `src/server/__tests__/rate-limit.test.ts`.
    const stored = await generated();
    const change = pending(stored, plan({ shape: WOVEN_MAST }));

    const log: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      log.push(String(line));
    });

    // Strop instance se soudí PRVNÍ, takže ho nasytí kdokoli. Klíče jsou různé
    // proto, aby se pod ním neschoval strop na volajícího a neodmítal místo něj.
    for (let taken = 0; taken < MAX_REQUESTS_PER_WINDOW_PER_INSTANCE; taken += 1)
      takeRateSlot('commit', `ip:198.51.100.${String(taken)}`);

    const refused = await commit(stored.session.sessionId, change.changeId, '203.0.113.7');
    expect(refused.status).toBe(429);
    expect((await body(refused)).error).toMatchObject({ code: 'SERVER_AT_CAPACITY' });

    const lines = log.filter((line) => line.includes('worldstream/commit'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('SERVER_AT_CAPACITY');
    expect(lines[0]).not.toContain('TOO_MANY_REQUESTS');
  });

  it('plná fronta čtení těl NENÍ pomalé tělo — 429, ne 408', async () => {
    // **Tyhle dveře jako jediné překládaly `raw.reason` samy** a do 4. 9. 2026
    // vydávaly `? 413 : 408`, takže nápor odsud odešel jako 408 „tělo dorazilo
    // pomalu" — tvrzení o volajícím, který neudělal nic. Požadavky nenesou
    // hlavičku proxy, takže plní kbelík nerozeznaných a odmítnutí je
    // `instance` (`src/http/body.ts`).
    const stored = await generated();
    const held = Array.from({ length: MAX_CONCURRENT_BODY_READS_UNIDENTIFIED }, silentBody);
    const pending = held.map((h) => readBody(h.request, 60_000));
    try {
      const response = await preview(stored.session.sessionId, { prompt: 'lower the mast' });
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('5');
      expect((await body(response)).error).toMatchObject({ code: 'SERVER_AT_CAPACITY' });
    } finally {
      for (const h of held) h.finish();
      await Promise.all(pending);
    }
  });
});
