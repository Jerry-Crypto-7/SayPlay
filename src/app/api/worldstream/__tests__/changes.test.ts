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

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UpstreamRequest } from '@/model/prompt';
import { resetFaultLog } from '@/server/public-faults';
import type { PendingChange, RefinePlan } from '@/model/worldstream-refine';
import { clearSessions, openSession, putChange, type StoredSession } from '@/worldstream/sessions';

import {
  MAX_CONCURRENT_GENERATIONS,
  POST as createSession,
  acquireSlot,
  releaseSlot,
  resetConcurrency,
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

function commit(sessionId: string, changeId: string): Promise<Response> {
  return commitChange(new Request(`http://127.0.0.1/commit`, { method: 'POST' }), {
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
  // Špionáž na `console.error` (odmítnutí náporem) nesmí přežít do dalšího
  // testu — tichý log by z něj udělal zelenou z jiného důvodu.
  vi.restoreAllMocks();
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
    const stored = openSession('empty-session', 7);
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
    expect((await body(response)).error).toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    expect(stored.session.phase).toBe('world');
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

    // Sloty drží zakládací cesta: `acquireSlot()` je přesně to, co dělá
    // `POST /sessions` před generací.
    for (let i = 0; i < MAX_CONCURRENT_GENERATIONS; i += 1) expect(acquireSlot()).toBe(true);

    // Dvoje dveře, jeden strop. Kdyby měly čítače vlastní, útočník by je
    // střídal a v letu by běželo osm placených volání místo čtyř.
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

    // A jakmile se jeden slot uvolní, tytéž dveře pustí.
    releaseSlot();
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
    expect(acquireSlot()).toBe(true);
  });
});
