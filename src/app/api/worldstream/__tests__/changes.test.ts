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
import { MAX_HERO_SHAPES } from '@/worldstream/schema';
import {
  callerKey,
  MAX_REQUESTS_PER_WINDOW,
  MAX_REQUESTS_PER_WINDOW_PER_INSTANCE,
  resetRateWindows,
  takeRateSlot,
} from '@/server/rate-limit';
import { readAdditionEmission, type PendingChange, type RefinePlan } from '@/model/worldstream-refine';
import {
  clearSessions,
  getSession,
  MAX_LIVE_SESSIONS,
  openSession,
  putChange,
  peekChange,
  newSessionSeed,
  runGeneration,
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
import { POST as restoreComparison } from '../sessions/[sessionId]/comparison/restore/route';
import { POST as previewChange, createChange } from '../sessions/[sessionId]/changes/route';
import { ANSWER, generated, grammar } from './world-fixture';
import { stormBellAnswers } from '../../../../../e2e/fixtures/storm-bell';

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
    addition: null,
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
    // **Nejasná** znamená nerozhodnutá — `the mast` i `the flat` jsou stejně
    // dlouhé. Věta bez jakéhokoli cíle už nejasná není: od P21 T8 zakládá objekt.
    const stored = await generated();
    const response = await preview(stored.session.sessionId, { prompt: 'raise the mast and the flat' }, null);
    expect(response.status).toBe(200);
    const read = await body(response);
    expect(read.outcome).toBe('AMBIGUOUS');
    expect(read.reason).toBe('AMBIGUOUS');
    expect(read.candidates).toHaveLength(2);
  });

  it('věta bez cíle ve světě jde k modelu jako přidání, ne zpátky jako nabídka', async () => {
    // P21 T8: `NO_MATCH` už není odmítnutí. Bez modelu a bez skladu je to 503
    // `NO_AUTHORED_CHANGE` — a to je pravda o nasazení, ne o větě.
    const stored = await generated();
    const asked: string[] = [];
    const response = await preview(stored.session.sessionId, { prompt: 'add a lantern at the far edge' }, (request) => {
      asked.push(request.system);
      return Promise.resolve({});
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('ONE new object');
    // Prázdná odpověď modelu je odmítnutí přidání, ne nabídka kandidátů.
    expect(await body(response)).toMatchObject({ outcome: 'REJECTED', reason: 'WRONG_SHAPE' });

    const withoutModel = await preview(stored.session.sessionId, { prompt: 'add a lantern at the far edge' }, null);
    expect(withoutModel.status).toBe(503);
    expect((await body(withoutModel)).error).toMatchObject({ code: 'NO_AUTHORED_CHANGE' });
  });

  /**
   * P21 T9: věta se řeže na kusy **před** groundingem a před modelem.
   * Věta bez obsahu projde moderací a model by na ni objekt vymyslel — tady
   * je odmítnutá zadarmo. Dlouhá věta jde modelu po prvním kusu a zbytek se
   * vrací porotci jako fronta, ne tiše zahozený.
   */
  it('věta bez obsahu je NO_CONTENT a model se nevolá', async () => {
    const stored = await generated();
    const asked: string[] = [];
    const response = await preview(stored.session.sessionId, { prompt: 'ok add something nice please' }, (request) => {
      asked.push(request.user);
      return Promise.resolve(LANTERN_ANSWER);
    });
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ outcome: 'REJECTED', reason: 'NO_CONTENT' });
    expect(asked).toHaveLength(0);
    expect(stored.session.events.all().at(-1)).toMatchObject({ type: 'patch.rejected', payload: { reason: 'NO_CONTENT' } });
  });

  it('dlouhá věta jde modelu po prvním kusu a zbytek se vrací jako fronta', async () => {
    const stored = await generated();
    const asked: string[] = [];
    const response = await preview(
      stored.session.sessionId,
      { prompt: 'add a lantern at the far edge, then put a bell on the mast. When the bell rings, the lantern lights up.' },
      (request) => {
        asked.push(request.user);
        return Promise.resolve(LANTERN_ANSWER);
      },
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('add a lantern at the far edge');
    expect(asked[0]).not.toContain('bell');
    expect(await body(response)).toMatchObject({
      outcome: 'PREVIEW',
      target: { stableId: 'lantern' },
      pieces: { asked: 'add a lantern at the far edge', remaining: ['put a bell on the mast', 'When the bell rings, the lantern lights up'] },
    });
  });

  it('věta o jednom kusu jde modelu doslova a `pieces` v odpovědi není', async () => {
    const stored = await generated();
    const asked: string[] = [];
    const response = await preview(stored.session.sessionId, { prompt: 'add a lantern at the far edge.' }, (request) => {
      asked.push(request.user);
      return Promise.resolve(LANTERN_ANSWER);
    });
    expect(asked[0]).toContain('add a lantern at the far edge.');
    expect(await body(response)).not.toHaveProperty('pieces');
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
        appearance: [],
      }),
    );

    expect(response.status).toBe(200);
    const read = await body(response);
    expect(read.outcome).toBe('PREVIEW');
    expect(read.target).toMatchObject({ stableId: 'ironMast' });
    expect(read.scope).toEqual({ shape: true, behavior: 0, appearance: 0, addition: false });
    expect(read.preserved).toEqual(['the salt flat']);

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

    expect(response.status).toBe(422);
    const read = await body(response);
    expect(read.error).toMatchObject({ code: 'APPEARANCE_UNSUPPORTED' });
    expect(stored.changes.size).toBe(0);
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
   * **Vadný tvar operace nesmí být pád** — třetí kolo nezávislé revize
   * 6. 9. 2026. `readOperations` schválně soudí jen `path` a zbytek nechává
   * routeru a `applyWorldPatch`, takže se sem `from` dostane i jako číslo.
   * Odpovědí je odmítnutí nebo poctivé preview, nikdy holá pětistovka bez
   * `requestId` — a už vůbec ne po zaplaceném volání modelu.
   */
  it('operace s nesmyslným `from` neshodí dveře', async () => {
    const stored = await generated();

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'turn the mast into woven metal' },
      async () => ({
        summary: 'the mast is rewoven',
        shape: WOVEN_MAST,
        behavior: [{ op: 'move', from: 7, path: '/sim/entities/ironMast/state' }],
        appearance: [],
      }),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).outcome).toBe('PREVIEW');
  });

  /**
   * **Tvar je taky část změny.** Jméno materiálu se smí rovnat `stableId`
   * jiného objektu; pak ho změna jmenuje, aniž ji vidí jediná operace.
   */
  it('objekt jmenovaný uvnitř nového tvaru není nedotčený', async () => {
    const stored = await generated();

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'turn the mast into woven metal' },
      async () => ({
        summary: 'the mast is rewoven',
        shape: { ...WOVEN_MAST, materialIntent: 'saltFlat' },
        behavior: [],
        appearance: [],
      }),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).preserved).toEqual([]);
  });

  /**
   * **Hluboko zanořená hodnota nesmí vyčerpat zásobník** — čtvrté kolo
   * nezávislé revize 6. 9. 2026, a je to táž třída jako `from: 7` o kus výš.
   * `JSON.parse` je iterativní a takovou hodnotu rozparsuje; rekurzivní
   * procházka nad ní spadne kolem pěti tisíc pater, a `RangeError` uvnitř
   * `withRequest` nevrátí odpověď vůbec.
   *
   * Dvacet tisíc pater je s rezervou nad tou mezí a pořád se vejde do stropu
   * výstupu modelu. Jméno na dně se **musí najít** — jinak by test procházel
   * i nad procházkou, která se zastaví o patro dřív, než je potřeba.
   */
  it('hodnota zanořená dvacet tisíc pater neshodí dveře a jméno na dně se najde', async () => {
    const stored = await generated();

    let deep: unknown = 'saltFlat';
    for (let level = 0; level < 20_000; level += 1) deep = [deep];

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'turn the mast into woven metal' },
      async () => ({
        summary: 'the mast is rewoven',
        shape: WOVEN_MAST,
        behavior: [{ op: 'add', path: '/sim/entities/ironMast/state/queue', value: deep }],
        appearance: [],
      }),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).preserved).toEqual([]);
  });

  /**
   * **Kontrola k testu o tvaru: tvar, který nikoho nejmenuje, seznam nekrátí.**
   * Bez ní projde i procházka, která po každém tvaru označí za dotčené všechno
   * — naměřeno čtvrtým kolem revize jako přeživší mutant.
   */
  it('tvar, který cizí objekt nejmenuje, nechá seznam být', async () => {
    const stored = await generated();

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'turn the mast into woven metal' },
      async () => ({ summary: 'the mast is rewoven', shape: WOVEN_MAST, behavior: [], appearance: [] }),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).preserved).toEqual(['the salt flat']);
  });

  /**
   * **Segment, ne podřetězec — pátým kolem revize (6. 9. 2026) přeživší
   * mutant.** `preservedBy` sype do `touched` celé segmenty cesty a ptá se na
   * ně `Set.has`, což je shoda na celém jménu; docstring to tvrdí výslovně
   * („jméno socketu `leftLegPad` není jméno objektu"). Záměna té shody za
   * `includes` ale nechala celou sadu zelenou, protože fixtura má jen
   * `saltFlat` a `ironMast` a žádná cesta v ostatních testech jméno objektu
   * jako podřetězec nenese — všechny se ptaly na prázdný seznam, který
   * plošné označení vyrobí taky.
   *
   * Směr té chyby je konzervativní (objekt navíc vypadne z „nedotčených",
   * panel tedy netvrdí víc, než umí), takže porotci nelže. Ale nevynucené
   * pravidlo je dekorativní: `saltFlatEdge` je socket pojmenovaný po terénu
   * a terén přežít musí.
   */
  it('socket pojmenovaný po objektu ten objekt nedotýká', async () => {
    const stored = await generated();

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'raise the mast on its footing' },
      async () => ({
        summary: 'the mast rides higher',
        shape: null,
        behavior: [{ op: 'replace', path: '/sim/sockets/saltFlatEdge/height', value: 0.4 }],
        appearance: [],
      }),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).preserved).toEqual(['the salt flat']);
  });

  /**
   * **Druhý směr téže shody, a v tomhle je ta drahá polovina** — nález šestého
   * kola nezávislé revize (6. 9. 2026). Test nad ním pinuje jen relaxaci
   * `segment.includes(stableId)`; obrácená, `stableId.includes(segment)`, mu
   * projde, protože `touched` vždycky nese obecné segmenty (`sim`, `sockets`,
   * `look`, `entities`) a ani `saltFlat`, ani `ironMast` žádný z nich neobsahuje.
   *
   * Přitom je to ta horší mutace: pod ní by z „Not named by this change"
   * vypadl každý objekt, jehož jméno nese obecný segment jako podřetězec —
   * `lookoutTower`, `simRig`. Tady to obstará `salt` jako jméno entity, kterou
   * cesta jmenuje: `saltFlat` ho obsahuje, ale rovná se mu ne, takže pláň
   * přežít musí.
   */
  it('segment, který je jen podřetězcem jména, ten objekt nedotýká', async () => {
    const stored = await generated();

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'raise the mast on its footing' },
      async () => ({
        summary: 'the mast rides higher',
        shape: null,
        behavior: [{ op: 'replace', path: '/sim/entities/salt/state/lit', value: true }],
        appearance: [],
      }),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).preserved).toEqual(['the salt flat']);
  });

  /* ---------------------------------------------------------------- *
   * T35-preservedattr: poddokument, který objekt řídí, aniž ho jmenuje.
   * ---------------------------------------------------------------- */

  /**
   * **Socket jmenuje objekt, který na něm stojí** — `sim.entities[*].socket`
   * je jediná vazba téhle třídy, kterou dokument doopravdy nese.
   *
   * Cesta `/sim/sockets/saltPad/0` neobsahuje `saltFlat` v žádném segmentu, ale
   * pláň na tom socketu stojí, takže ji ta změna posouvá. Slibovat porotci, že
   * ji nechá být, je nepravda.
   */
  it('zápis na socket jmenuje objekt, který si ten socket nárokuje', async () => {
    const stored = await generated();

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'raise the mast on its footing' },
      async () => ({
        summary: 'the mast rides higher and the flat shifts under it',
        shape: null,
        behavior: [{ op: 'replace', path: '/sim/sockets/saltPad/0', value: 5 }],
        appearance: [],
      }),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).preserved).toEqual([]);
  });

  /**
   * **Nenárokovaný socket seznam schválně NEvyprazdňuje** — a je to rozhodnutí
   * změřené, ne opomenuté (`T35-preservedattr`).
   *
   * Přísné pravidlo „nepřiřaditelná operace ⇒ neslibuj nic" vyprázdní **2 z 5**
   * uvařených seznamů v `authored-worlds.json`, mezi nimi vlajkový `c04`/`r02`,
   * který posouvá `southeastLegPad` a `southwestLegPad` — dva sockety, které si
   * v `c04` nenárokuje žádná entita. Půlka dějství III na porotcově cestě by
   * tím zmizela. Cena za to je pojmenovaná v panelu: věta zní **„Not named by
   * this change"**, ne „Untouched".
   */
  it('zápis na socket, který si nikdo nenárokuje, nikoho neodebere', async () => {
    const stored = await generated();

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'raise the mast on its footing' },
      async () => ({
        summary: 'the mast rides higher',
        shape: null,
        behavior: [{ op: 'replace', path: '/sim/sockets/sparePad/0', value: 5 }],
        appearance: [],
      }),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).preserved).toEqual(['the salt flat']);
  });

  /**
   * **`remove` nenese `value`, a přesto umí jmenovat cizí objekt** — jméno
   * stojí v **uloženém** těle mazaného pravidla, ne v patchi.
   *
   * Fixturové pravidlo `guard` má akci `setState target: saltFlat`. Smazat ho
   * znamená, že pláň přestane reagovat na příchod měřiče; slib „pláně se to
   * netýká" je proto nepravdivý. Patch to neví — dokument ano.
   */
  it('remove čte uložené tělo, takže smazané pravidlo jmenuje, koho jmenovalo', async () => {
    const stored = await generated();

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'raise the mast on its footing' },
      async () => ({
        summary: 'the mast rides higher and the flat stops reacting',
        shape: null,
        behavior: [{ op: 'remove', path: '/sim/rules/guard' }],
        appearance: [],
      }),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).preserved).toEqual([]);
  });

  /**
   * **`replace` ničí uložené tělo stejně jako `remove`** — první blokující
   * nález nezávislé revize nad `T35-preservedattr` (6. 9. 2026).
   *
   * Původní oprava se ptala na `op === 'remove'`, tedy zavírala nepravdu
   * o jedno klíčové slovo a vedle ní nechávala tutéž. `withRuleId()` ve
   * `worldstream-refine.ts` existuje právě proto, že model `add`/`replace` nad
   * klíči pravidel doopravdy píše, takže je to tvar z provozu, ne z hlavy.
   *
   * Nové tělo `guard` pláň nejmenuje, staré ano — přepis ji tedy přestane
   * řídit a slib „pláně se to netýká" je nepravdivý.
   */
  it('replace nad pravidlem čte i tělo, které přepisuje', async () => {
    const stored = await generated();

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'raise the mast on its footing' },
      async () => ({
        summary: 'the mast rides higher and the guard rule changes hands',
        shape: null,
        behavior: [
          {
            op: 'replace',
            path: '/sim/rules/guard',
            value: {
              phase: 0,
              priority: 1,
              event: { kind: 'onEnterZone', entity: 'surveyor', zone: 'mastPad' },
              condition: null,
              actions: [{ kind: 'win' }],
            },
          },
        ],
        appearance: [],
      }),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).preserved).toEqual([]);
  });

  /**
   * **`move` ničí adresu `from`, takže se soudí stejně přísně jako cíl** —
   * druhý blokující nález téže revize.
   *
   * Socketové pravidlo se do 6. 9. 2026 ptalo jen na `path`. Přesun `saltPad`
   * jinam přitom bere pláni footing, na kterém stojí, a `from` je jediné
   * místo, kde se to jméno objeví.
   */
  it('move čte majitele socketu i na adrese from, ne jen na cíli', async () => {
    const stored = await generated();

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'raise the mast on its footing' },
      async () => ({
        summary: 'the footing moves out from under the flat',
        shape: null,
        behavior: [{ op: 'move', from: '/sim/sockets/saltPad', path: '/sim/sockets/relocatedPad' }],
        appearance: [],
      }),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).preserved).toEqual([]);
  });

  /**
   * **`from` nad celým poddokumentem vyprázdní seznam stejně jako `path`.**
   * `move from: /sim/entities` odstěhuje všechny entity naráz; slíbit v tu
   * chvíli cokoli je nepravda bez ohledu na to, kam to míří.
   */
  it('move z celého poddokumentu neslibuje nic', async () => {
    const stored = await generated();

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'raise the mast on its footing' },
      async () => ({
        summary: 'everything moves at once',
        shape: null,
        behavior: [{ op: 'move', from: '/sim/sockets', path: '/sim/relocated/sockets' }],
        appearance: [],
      }),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).preserved).toEqual([]);
  });

  /**
   * **Cesta, která v dokumentu nikam nevede, nesmí spadnout** — poučení ze
   * čtvrtého a pátého kola revize, kde dvě remediace po sobě přinesly
   * `TypeError` uvnitř `withRequest`, tedy **holou pětistovku bez `requestId`
   * po zaplaceném volání**. Čtení uloženého těla je třetí místo téže třídy.
   *
   * `readOperations` schválně soudí jen tvar cesty, takže sem `remove` nad
   * neexistujícím pravidlem doopravdy dojde.
   */
  it('remove nad cestou, která nikam nevede, vrátí plán, ne pětistovku', async () => {
    const stored = await generated();

    const response = await preview(
      stored.session.sessionId,
      { prompt: 'raise the mast on its footing' },
      async () => ({
        summary: 'the mast rides higher',
        shape: null,
        behavior: [
          { op: 'remove', path: '/sim/rules/neverWritten' },
          { op: 'remove', path: '/sim/rules/guard/actions/notAnIndex' },
          { op: 'remove', path: '/sim/rules/reach/phase/deeper/still' },
          // ⚠ **Tenhle je ten, který doopravdy padá.** `condition` je `null`
          // a `Object.hasOwn(null, 'kind')` vyhodí `TypeError`; číslo ani
          // řetězec se jen tiše minou. Bez `current === null` v `valueAt()`
          // tady průchod skončí pětistovkou.
          { op: 'remove', path: '/sim/rules/reach/condition/kind' },
        ],
        appearance: [],
      }),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).preserved).toEqual(['the salt flat']);
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
  it.each([false, true])('A4 pre-commit comparison is atomic (invalid fork=%s)', async invalid => {
    const stored = await generated();
    const doc = worldOf(stored);
    const change = pending(stored, plan({ behavior: [{ op: 'replace',
      path: '/sim/rules/guard/condition', value: { kind: 'stateIs', target: 'saltFlat', state: 'dry' } }] }));
    const before = JSON.stringify(stored.blueprint);
    const response = await commitChange(new Request('http://127.0.0.1/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: { simRevision: doc.simRevision, simHash: doc.simHash,
        comparisonRevision: 0, inputCount: 0 }, inputs: [], forkTick: invalid ? 2 : 0, observationTick: 1 }),
    }), { params: Promise.resolve({ sessionId: stored.session.sessionId, changeId: change.changeId }) });
    const result = await body(response);
    if (invalid) {
      expect(response.status).toBe(422);
      expect(result.error).toMatchObject({ code: 'COMPARISON_REJECTED' });
      expect(JSON.stringify(stored.blueprint)).toBe(before);
      expect(peekChange(stored, change.changeId)).not.toBeNull();
    } else {
      expect(result.outcome, JSON.stringify(result)).toBe('COMMITTED');
      expect(result.acceptedBlueprint).toEqual(stored.blueprint);
      expect(result.comparison).toMatchObject({ intervention: { kind: 'condition', ruleId: 'guard' },
        originalAtFork: { tick: 0 }, changedAtFork: { tick: 0 } });
      expect(worldOf(stored).simRevision).toBe(doc.simRevision + 1);
      const accepted = worldOf(stored);
      const geometry = stored.blueprint!.objects;
      const restore = (payload: unknown) => restoreComparison(new Request('http://127.0.0.1/restore', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      }), { params: Promise.resolve({ sessionId: stored.session.sessionId }) });
      const expected = { simRevision: accepted.simRevision, lookRevision: accepted.lookRevision, simHash: accepted.simHash };
      expect((await restore({ ...expected, simHash: 'stale' })).status).toBe(409);
      expect(worldOf(stored)).toBe(accepted);
      expect((await restore({ ...expected, original: doc })).status).toBe(400);
      expect(worldOf(stored)).toBe(accepted);
      const restored = await restore(expected);
      expect(restored.status).toBe(200);
      expect((await body(restored)).acceptedBlueprint).toEqual(stored.blueprint);
      expect(worldOf(stored).sim).toEqual(doc.sim);
      expect(worldOf(stored).simRevision).toBe(accepted.simRevision + 1);
      expect(stored.blueprint!.objects).toBe(geometry);
      expect(stored.comparisonOrigin).toBeNull();
      expect((await restore(expected)).status).toBe(409);
    }
  });

  it('neznámé preview je 404', async () => {
    const stored = await generated();
    const response = await commit(stored.session.sessionId, 'never-existed');
    expect(response.status).toBe(404);
    expect((await body(response)).error).toMatchObject({ code: 'UNKNOWN_CHANGE' });
  });

  it('nepodporovaná změna vzhledu nezmění revizi, runtime hash ani podobu', async () => {
    const stored = await generated();
    const hashBefore = worldOf(stored).simHash;
    const change = pending(
      stored,
      plan({ appearance: [{ op: 'replace', path: '/look/palette', value: 'sand' }] }),
    );

    const response = await commit(stored.session.sessionId, change.changeId);
    expect(response.status).toBe(422);
    const read = await body(response);
    expect(read.error).toMatchObject({ code: 'APPEARANCE_UNSUPPORTED' });

    const after = worldOf(stored);
    expect(after.look.palette).toBe('moss');
    expect(after.lookRevision).toBe(0);
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
      plan({ behavior: [{ op: 'replace', path: '/sim/rules/reach/priority', value: 2 }] }),
      'change-stale',
    );
    const winner = pending(
      stored,
      plan({ behavior: [{ op: 'replace', path: '/sim/rules/reach/priority', value: 3 }] }),
      'change-winner',
    );

    expect((await commit(stored.session.sessionId, winner.changeId)).status).toBe(200);

    const response = await commit(stored.session.sessionId, stale.changeId);
    expect(response.status).toBe(409);
    expect((await body(response)).error).toMatchObject({ field: 'basedOn/sim' });
  });

  it('smíšená změna je celá, nebo žádná', async () => {
    // Unsupported appearance rejects the whole mixed change before certification.
    const stored = await generated();
    const change = pending(
      stored,
      plan({
        behavior: [{ op: 'remove', path: '/sim/rules/reach' }],
        appearance: [{ op: 'replace', path: '/look/palette', value: 'sand' }],
      }),
    );

    const response = await commit(stored.session.sessionId, change.changeId);
    expect(response.status).toBe(422);
    const read = await body(response);
    expect(read.error).toMatchObject({ code: 'APPEARANCE_UNSUPPORTED' });

    const after = worldOf(stored);
    expect(after.look.palette).toBe('moss');
    expect(after.lookRevision).toBe(0);
    expect(after.simRevision).toBe(0);
    expect(stored.session.revisionOf('ironMast')).toBe(0);
    expect(stored.session.events.all().some(event => event.type === 'patch.committed')).toBe(false);

    // Retrying the same unsupported preview preserves the same refusal.
    const znovu = await commit(stored.session.sessionId, change.changeId);
    expect(znovu.status).toBe(422);
    expect((await body(znovu)).error).toMatchObject({ code: 'APPEARANCE_UNSUPPORTED' });
  });

  it('jedno preview je jeden commit', async () => {
    const stored = await generated();
    const change = pending(
      stored,
      plan({ shape: WOVEN_MAST }),
    );

    expect((await commit(stored.session.sessionId, change.changeId)).status).toBe(200);
    expect((await commit(stored.session.sessionId, change.changeId)).status).toBe(404);
    expect(stored.session.revisionOf('ironMast')).toBe(1);
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
    // Emulate an archived/external look revision. Public appearance commits are now refused.
    stored.blueprint = { ...stored.blueprint!, world: { ...worldOf(stored),
      lookRevision: 1, look: { ...worldOf(stored).look, palette: 'sand' } } };
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
      plan({ shape: WOVEN_MAST }),
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

  function importClosure(entry: string, boundary?: string | readonly string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      if (typeof boundary === 'string' ? next === boundary : boundary?.includes(next)) continue;
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

  it('server replay remains behind pure comparison or project boundaries', () => {
    // T8 privately replays a source project, never rolling back the legacy
    // blueprint or its rejectedAt stamps. Keep checking the FULL closure for
    // blueprint writers below; do not exempt project code from that invariant.
    expect(
      routes.filter((route) => importClosure(route, ['src/worldstream/evidence-commit.ts',
        ...(route.includes('/changes/[changeId]/commit/') ? ['src/worldstream/accepted-branch.ts'] : [])]).has(REBRANCH)),
      'přetáčení času dostalo serverové dveře, takže svět umí jít na dřívější revizi a razítková brána se nad ním znovu otevře — otevři T22-rewindrevision',
    ).toEqual([]);
  });

  it('A4 comparison cannot access the mutable session or blueprint registry', () => {
    const comparison = importClosure('src/worldstream/accepted-branch.ts');
    expect(comparison.has('src/worldstream/sessions.ts')).toBe(false);
    expect(comparison.has('src/worldstream/session.ts')).toBe(false);
    expect(comparison.has('src/worldstream/snapshot-store.ts')).toBe(false);
  });

  it('project transakce nemá přístup k mutable legacy relaci ani registru blueprintů', () => {
    const project = importClosure('src/worldstream/evidence-commit.ts');
    expect(project.has('src/worldstream/sessions.ts')).toBe(false);
    expect(project.has('src/worldstream/session.ts')).toBe(false);
    expect(project.has('src/worldstream/snapshot-store.ts')).toBe(false);
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
        shape: WOVEN_MAST,
        behavior: [],
        appearance: [],
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
    //
    // ⚠ **Dveře na zakládání relace to od `T14r-actone` dokazují jinak.**
    // Sdílený strop chrání **placená volání**, ne odpovědi: nad plným čítačem
    // se k poskytovateli nesmí ozvat nikdo, a to platí dál. Odpověď ale už
    // není 503 — uvařený svět nic nestojí, tak se vydá. Aby se ta ochrana dala
    // pozorovat, musí být model nakonfigurovaný; bez klíče by se o slot
    // neucházel nikdo a test by neměřil sdílenost, ale její nepřítomnost.
    vi.stubEnv('WORLDSMITH_MODEL_ENDPOINT', 'https://model.invalid/v1/messages');
    vi.stubEnv('WORLDSMITH_MODEL_KEY', 'not-a-real-key');
    vi.stubEnv('WORLDSMITH_USD_PER_MTOK_OUT', '15');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const cookedSession = await createSession(
      new Request('http://127.0.0.1/api/worldstream/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'a salt flat with one iron mast' }),
      }),
    );
    expect(cookedSession.status).toBe(202);
    // Popisek je důkaz, že svět vydal sklad, ne poskytovatel.
    expect((await body(cookedSession)).authored, 'uvařený svět se nepřiznal').toBeDefined();
    // **A tohle je ta chráněná věc.** Sdílený čítač je nasycený, takže placená
    // větev těchhle dveří nesměla běžet.
    expect(fetchSpy, 'nad sdíleným stropem se šlo k poskytovateli').not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();

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
    // **Relace se neodmítla, takže se ani nemá co logovat.** Operátorský řádek
    // popisuje odmítnutí; nad vydaným světem by tvrdil, že někdo odešel s
    // prázdnou, což se nestalo.
    expect(refusedSessions, 'vydaný uvařený svět se hlásí jako odmítnutí').toHaveLength(0);
    expect(refusedChanges, 'odmítnuté preview neodešlo operátorovi').toHaveLength(1);
    expect(refusedChanges[0]).toContain('[worldstream/changes]');

    // **Oba řádky jmenují, které dveře ty sloty drží** (`T22-doorcounters`).
    // Do té doby uměl čítač říct jen souhrn, takže operátor u zavřených dveří
    // na stavbu světa nepoznal, jestli je zavřely světy, nebo preview — a
    // tenhle případ je přesně ten druhý. Čísla doslova, ne interpolovaná: se
    // stejnou konstantou na obou stranách by se strop dal zvednout ze čtyř na
    // čtyřicet a řádek by se pořád shodoval sám se sebou.
    // ⚠ **Varianta pro dveře `world` se sem od `T14r-actone` nevejde**, protože
    // ty dveře nad plným čítačem neodmítají — vydají uvařený svět. Tentýž
    // řádek nad nimi pinuje `sessions.test.ts` na jediné cestě, kde odmítnutí
    // zbylo: plný stroj a prázdný sklad.
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
      const bodyRead = code.indexOf('readBody(request)');
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
      plan({ behavior: [{ op: 'replace', path: '/sim/rules/reach/priority', value: 2 }] }),
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

/* ------------------------------------------------------------------ *
 * Přidání nového objektu (P21 T8)
 * ------------------------------------------------------------------ */

/**
 * Lucerna, kterou svět z fixtury nemá. Objekt bez `source` — tak ho píše model
 * a `readAdditionEmission` mu zdroj dosadí z tvaru — plus vlastní socket,
 * kvádr a entita, všechno pod klíčem, který novému objektu patří.
 */
const LANTERN_ANSWER = {
  summary: 'a lantern stands at the far edge of the flat',
  object: {
    stableId: 'lantern',
    label: 'the lantern',
    synonyms: ['the lamp', 'the light'],
    role: 'prop',
    targetBounds: { min: [2.6, 0, 0.6], max: [3.4, 0.9, 1.4] },
    importance: 1,
  },
  shape: {
    shapeId: 'lanternBody',
    stableId: 'lantern',
    nodes: [{ kind: 'prism', sides: 6, radius: 0.3, height: 0.8 }],
    root: 0,
    targetBounds: { min: [-0.4, -0.45, -0.4], max: [0.4, 0.45, 0.4] },
    anchors: [],
    materialIntent: 'metal',
    priority: 5,
  },
  behavior: [
    { op: 'add', path: '/sim/sockets/lanternPad', value: [3, 1] },
    { op: 'add', path: '/sim/collisionAabb/lantern', value: [3, 1, 1, 1] },
    { op: 'add', path: '/sim/entities/lantern', value: { role: 'prop', socket: 'lanternPad', state: 'unlit' } },
  ],
};

/** Plán přidání přečtený **toutéž** funkcí, kterou ho čte route. */
function additionPlan(stored: StoredSession, answer: Record<string, unknown> = LANTERN_ANSWER): RefinePlan {
  const read = readAdditionEmission(answer, stored.blueprint!);
  if (!read.ok) throw new Error(`${read.reason}: ${read.detail}`);
  return read.value;
}

/** Co se přidáním nesmí hnout: staré objekty, staré tvary a stav světa. */
function untouchedOf(stored: StoredSession) {
  const blueprint = stored.blueprint!;
  return {
    objects: blueprint.objects,
    shapes: blueprint.shapes,
    entities: JSON.stringify((worldOf(stored).sim as { entities: unknown }).entities),
    bytes: JSON.stringify(blueprint),
  };
}

describe('přidání nového objektu', () => {
  // Skutečné UI posílá `comparison: true` vždycky (page.tsx); přidání se nesmí
  // dostat do srovnávací větve, protože svět před ním ten objekt neměl.
  it('preview se srovnáním přidání nesrovnává a vrátí PREVIEW', async () => {
    const stored = await generated();
    const previewed = await body(
      await preview(stored.session.sessionId, { prompt: 'add a lantern at the far edge', comparison: true }, () => Promise.resolve(LANTERN_ANSWER)),
    );
    expect(previewed, JSON.stringify(previewed)).toMatchObject({
      outcome: 'PREVIEW',
      target: { stableId: 'lantern' },
      scope: { addition: true },
    });
  });

  it('preview odmítne přidání, které sahá na cizí objekt, pod ALLOWED_PATH', async () => {
    const stored = await generated();
    const answer = {
      ...LANTERN_ANSWER,
      behavior: [...LANTERN_ANSWER.behavior, { op: 'replace', path: '/sim/entities/surveyor/state', value: 'lit' }],
    };
    const previewed = await body(await preview(stored.session.sessionId, { prompt: 'add a lantern at the far edge' }, () => Promise.resolve(answer)));
    expect(previewed, JSON.stringify(previewed)).toMatchObject({ outcome: 'REJECTED', reason: 'ALLOWED_PATH' });
    expect(stored.session.events.all().at(-1)).toMatchObject({ type: 'patch.rejected', payload: { reason: 'ALLOWED_PATH' } });
  });

  it('věta bez cíle projde previewm i commitem a staré objekty se nehnou', async () => {
    const stored = await generated();
    const before = untouchedOf(stored);

    const previewed = await body(await preview(stored.session.sessionId, { prompt: 'add a lantern at the far edge' }, () => Promise.resolve(LANTERN_ANSWER)));
    expect(previewed).toMatchObject({
      outcome: 'PREVIEW',
      target: { stableId: 'lantern', label: 'the lantern' },
      scope: { shape: false, behavior: 3, appearance: 0, addition: true },
      basedOn: { representation: 0, sim: 0, look: 0 },
    });
    // Preview do světa nezapsalo nic — ani do registru podob.
    expect(JSON.stringify(stored.blueprint)).toBe(before.bytes);
    expect(stored.session.revisionOf('lantern')).toBeNull();

    const read = await body(await commit(stored.session.sessionId, previewed.changeId as string));
    expect(read, JSON.stringify(read)).toMatchObject({ outcome: 'COMMITTED', stableId: 'lantern', applied: ['sim'], representation: null });
    expect(read.certificate).toMatchObject({ verdict: 'CERTIFIED' });

    const blueprint = stored.blueprint!;
    // Nový objekt a jeho tvar jsou ve světě a ukazují na sebe.
    expect(blueprint.objects.map((object) => object.stableId)).toEqual(['saltFlat', 'ironMast', 'lantern']);
    expect(blueprint.objects[2]).toMatchObject({ source: { kind: 'shape', shapeId: 'lanternBody' } });
    expect(blueprint.shapes.map((shape) => shape.shapeId)).toEqual(['mastPost', 'lanternBody']);
    // Dosavadní objekty a tvary jdou dál **týmiž** referencemi, ne kopiemi.
    before.objects.forEach((object, index) => expect(blueprint.objects[index]).toBe(object));
    before.shapes.forEach((shape, index) => expect(blueprint.shapes[index]).toBe(shape));
    // Stav dosavadních entit je bajt po bajtu týž; přibyla jen lucerna.
    const entities = (worldOf(stored).sim as { entities: Record<string, unknown> }).entities;
    const { lantern, ...others } = entities;
    expect(JSON.stringify(others)).toBe(before.entities);
    expect(lantern).toEqual({ role: 'prop', socket: 'lanternPad', state: 'unlit' });
    expect(worldOf(stored).simRevision).toBe(1);
    // Registr podob: nový objekt na nule, ty staré tam, kde byly.
    expect(stored.session.revisionOf('lantern')).toBe(0);
    expect(stored.session.revisionOf('ironMast')).toBe(0);
    expect(stored.session.revisionOf('saltFlat')).toBe(0);
    // Preview se commitem spotřebovalo.
    expect(peekChange(stored, previewed.changeId as string)).toBeNull();
  });

  it('druhé přidání téhož jména je IDENTITY_TAKEN na commitu, i když preview vzniklo dřív', async () => {
    const stored = await generated();
    // Obě preview vznikla nad světem bez lucerny, takže obě prošla čtením.
    const first = pending(stored, additionPlan(stored), 'first');
    const second = pending(stored, additionPlan(stored), 'second');

    expect((await body(await commit(stored.session.sessionId, first.changeId))).outcome).toBe('COMMITTED');
    const after = untouchedOf(stored);

    const read = await body(await commit(stored.session.sessionId, second.changeId));
    expect(read.outcome).toBe('REJECTED');
    expect(read.rejections).toMatchObject([{ reason: 'IDENTITY_TAKEN' }]);
    expect(JSON.stringify(stored.blueprint)).toBe(after.bytes);
    expect(stored.session.revisionOf('lantern')).toBe(0);
  });

  it('přidání, které sáhne na cizí entitu, je ALLOWED_PATH a ve světě není ani bajt', async () => {
    const stored = await generated();
    const before = untouchedOf(stored);
    const change = pending(stored, additionPlan(stored, {
      ...LANTERN_ANSWER,
      behavior: [...LANTERN_ANSWER.behavior, { op: 'replace', path: '/sim/entities/surveyor/state', value: 'lit' }],
    }));

    const read = await body(await commit(stored.session.sessionId, change.changeId));
    expect(read.outcome).toBe('REJECTED');
    expect(read.rejections).toMatchObject([{ reason: 'ALLOWED_PATH', pointer: '/sim/entities/surveyor/state' }]);
    expect(JSON.stringify(stored.blueprint)).toBe(before.bytes);
    expect(stored.session.revisionOf('lantern')).toBeNull();
    // Odmítnutí preview nespálí — platí i pro přidání.
    expect(peekChange(stored, change.changeId)).not.toBeNull();
  });

  it('přidání bez jediné operace je čistě vizuální objekt: řetěz pravidel se nespouští a sim stojí', async () => {
    // Nález revize `bae05c0`: `readAdditionEmission` prázdné `behavior` přijme
    // a route pak obejde router, staleRevision i svědka. To je záměr — objekt
    // bez entity v1 povoluje — ale nikdo to nepřipíchl.
    const stored = await generated();
    const before = untouchedOf(stored);
    const hashBefore = worldOf(stored).simHash;
    const change = pending(stored, additionPlan(stored, { ...LANTERN_ANSWER, behavior: [] }));

    const read = await body(await commit(stored.session.sessionId, change.changeId));
    expect(read).toMatchObject({ outcome: 'COMMITTED', stableId: 'lantern', applied: [], representation: null });
    expect(stored.blueprint!.objects.map((object) => object.stableId)).toEqual(['saltFlat', 'ironMast', 'lantern']);
    expect(stored.blueprint!.shapes.map((shape) => shape.shapeId)).toEqual(['mastPost', 'lanternBody']);
    expect(JSON.stringify((worldOf(stored).sim as { entities: unknown }).entities)).toBe(before.entities);
    expect(worldOf(stored).simRevision).toBe(0);
    expect(worldOf(stored).simHash).toBe(hashBefore);
    expect(stored.session.revisionOf('lantern')).toBe(0);
  });

  it('plný rozpočet tvarů mezi preview a commitem odmítne s ukazatelem na /shapes, ne /objects', async () => {
    const stored = await generated();
    const change = pending(stored, additionPlan(stored));
    // Svět se mezitím naplnil až po strop — jinou cestou, než je tenhle commit.
    const filler = Array.from({ length: MAX_HERO_SHAPES - stored.blueprint!.shapes.length }, (_, i) => ({
      ...stored.blueprint!.shapes[0], shapeId: `filler${i}`, stableId: `fillerObject${i}`,
    }));
    stored.blueprint = { ...stored.blueprint!, shapes: [...stored.blueprint!.shapes, ...filler] };
    const before = untouchedOf(stored);

    const read = await body(await commit(stored.session.sessionId, change.changeId));
    expect(read.outcome).toBe('REJECTED');
    expect(read.rejections).toMatchObject([{ reason: 'BLUEPRINT_INVALID', pointer: '/shapes' }]);
    expect(JSON.stringify(stored.blueprint)).toBe(before.bytes);
    expect(stored.session.revisionOf('lantern')).toBeNull();
    expect(peekChange(stored, change.changeId)).not.toBeNull();
  });

  it('když registr podob nový objekt odmítne, preview i svět zůstanou tam, kde byly', async () => {
    // Pořadí zápisů: registr → spotřeba preview → dokument. Výjimka registru
    // (dnes bez volajícího, který by ji vyvolal) nesmí nechat půlku commitu.
    const stored = await generated();
    const before = untouchedOf(stored);
    const change = pending(stored, additionPlan(stored));
    vi.spyOn(stored.session, 'registerBlueprint').mockImplementation(() => { throw new Error('registry refused'); });

    await expect(commit(stored.session.sessionId, change.changeId)).rejects.toThrow('registry refused');
    expect(JSON.stringify(stored.blueprint)).toBe(before.bytes);
    expect(peekChange(stored, change.changeId)).not.toBeNull();
  });

  it('přidání se srovnáním dvou budoucností je 422 a svět se nehne', async () => {
    const stored = await generated();
    const before = untouchedOf(stored);
    const doc = worldOf(stored);
    const change = pending(stored, additionPlan(stored));

    const response = await commitChange(new Request('http://127.0.0.1/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: { simRevision: doc.simRevision, simHash: doc.simHash, comparisonRevision: 0, inputCount: 0 },
        inputs: [], forkTick: 0, observationTick: 1 }),
    }), { params: Promise.resolve({ sessionId: stored.session.sessionId, changeId: change.changeId }) });
    expect(response.status).toBe(422);
    // Důvod je přidání samo, ne až odmítnutí zásahu uvnitř srovnání — bez téhle
    // brány by řetěz srovnání vrátil týž kód s větou o pravidlech, a porotce
    // by hledal chybu v pravidle, které nenapsal.
    expect((await body(response)).error).toMatchObject({ code: 'COMPARISON_REJECTED', message: 'A new object has no earlier future to compare against.' });
    expect(JSON.stringify(stored.blueprint)).toBe(before.bytes);
    expect(peekChange(stored, change.changeId)).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * P22 T19 – druhá věta nesmí nechat viset vazbu vzhledu ani signálu.
 * ------------------------------------------------------------------ */

/**
 * Nález nezávislé revize fáze 4 (`T12-1.md`, nález 1): commit jen pravidel
 * skládal blueprint bez kontroly odkazů, takže věta, která odstraní příznak,
 * nechala `lookBindings[].variable` i `binding.signalFlag` ukazovat do prázdna.
 * `lookBindings` není směrovatelná část (`ROUTABLE = sim|look`), takže to
 * žádný další patch neopraví – a `session-store.ts` pak záznam odmítne a otráví
 * trvalé úložiště všem relacím. Rozhodnutí je **odmítnout**, ne prořezat:
 * prořezání by tiše změnilo svět, o který porotce žádal.
 *
 * Svět je zvon s bouří z `e2e/fixtures/storm-bell.ts` – přesně ta fixtura,
 * na které revize díru předvedla – prohnaný skutečným kompilátorem, takže
 * `lookBindings` i `signalFlag` v něm napsal produkční kód, ne test.
 */
describe('commit, který nechá viset vazbu na příznak', () => {
  async function stormBell(): Promise<StoredSession> {
    const { planner, compiler } = stormBellAnswers();
    let calls = 0;
    const stored = openSession(`test-${newSessionSeed()}`, 1722)!;
    await runGeneration(stored, 'A hilltop bell that starts a storm when rung', {
      legacyPlan: true,
      emit: () => { calls += 1; return Promise.resolve(calls === 1 ? planner : compiler); },
      grammar: grammar(),
    });
    if (stored.blueprint === null) throw new Error(`storm-bell world did not build: ${stored.session.phase}`);
    return stored;
  }

  /** Pravidla bez příznaku: zvon jen odemkne bránu, průchod nic nepodmiňuje. Svědek dál vede k výhře. */
  const WITHOUT_STORM: RefinePlan['behavior'] = [
    { op: 'replace', path: '/sim/rules/ring/actions', value: [
      { kind: 'setState', entity: 'bell', value: 'ringing' },
      { kind: 'setLocked', entity: 'gate', value: false },
    ] },
    { op: 'replace', path: '/sim/rules/pass/condition', value: null },
    { op: 'remove', path: '/sim/state/flags/storm' },
  ];

  function bindingOf(stored: StoredSession, stableId: string) {
    return stored.blueprint!.objects.find((object) => object.stableId === stableId)?.binding;
  }

  it('fixtura nese obě vazby, jinak by testy níž neměřily nic', async () => {
    const stored = await stormBell();
    expect(stored.blueprint!.lookBindings).toEqual([{ variable: 'storm', values: { '0': 'day', '1': 'storm' } }]);
    expect(bindingOf(stored, 'bell')?.signalFlag).toBe('storm');
  });

  it('odstranění příznaku, na který ukazuje lookBindings, je BLUEPRINT_INVALID a svět se nehne', async () => {
    const stored = await stormBell();
    // Signál zvonu pryč, aby tu zbyla jen vazba vzhledu a verdikt ukázal na ni.
    stored.blueprint = { ...stored.blueprint!, objects: stored.blueprint!.objects.map((object) =>
      object.stableId === 'bell' ? { ...object, binding: { ...object.binding!, signalFlag: undefined } } : object) };
    const before = JSON.stringify(stored.blueprint);
    const change = pending(stored, plan({ stableId: 'bell', summary: 'the bell no longer calls the storm', behavior: WITHOUT_STORM }));

    const response = await commit(stored.session.sessionId, change.changeId);
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({
      outcome: 'REJECTED',
      rejections: [{ stage: 'apply', reason: 'BLUEPRINT_INVALID', pointer: '/lookBindings/0/variable' }],
    });
    expect(JSON.stringify(stored.blueprint)).toBe(before);
    expect(worldOf(stored).simRevision).toBe(0);
    expect(peekChange(stored, change.changeId)).not.toBeNull();
  });

  it('odstranění příznaku, na který ukazuje signalFlag, je BLUEPRINT_INVALID a svět se nehne', async () => {
    const stored = await stormBell();
    // Vazba vzhledu pryč, aby tu zbyl jen signál objektu a verdikt ukázal na něj.
    stored.blueprint = { ...stored.blueprint!, lookBindings: undefined };
    const before = JSON.stringify(stored.blueprint);
    const change = pending(stored, plan({ stableId: 'bell', summary: 'the bell no longer calls the storm', behavior: WITHOUT_STORM }));

    const response = await commit(stored.session.sessionId, change.changeId);
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({
      outcome: 'REJECTED',
      rejections: [{ stage: 'apply', reason: 'BLUEPRINT_INVALID', pointer: '/objects/1/binding/signalFlag' }],
    });
    expect(JSON.stringify(stored.blueprint)).toBe(before);
    expect(worldOf(stored).simRevision).toBe(0);
    expect(peekChange(stored, change.changeId)).not.toBeNull();
  });

  it('změna pravidel, která příznak nechá být, se commitne – brána nesmí odmítat naslepo', async () => {
    const stored = await stormBell();
    const change = pending(stored, plan({ stableId: 'bell', summary: 'the gate matters more', behavior: [
      { op: 'replace', path: '/sim/rules/pass/priority', value: 3 },
    ] }));

    const response = await commit(stored.session.sessionId, change.changeId);
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ outcome: 'COMMITTED', applied: ['sim'] });
    expect(worldOf(stored).simRevision).toBe(1);
    expect(stored.blueprint!.lookBindings).toEqual([{ variable: 'storm', values: { '0': 'day', '1': 'storm' } }]);
    expect(bindingOf(stored, 'bell')?.signalFlag).toBe('storm');
  });
});
