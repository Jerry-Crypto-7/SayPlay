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

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BODY_DEADLINE_MS, MAX_CONCURRENT_BODY_READS_PER_CALLER, readBody } from '@/http/body';
import type { UpstreamRequest } from '@/model/prompt';
import { resetFaultLog } from '@/server/public-faults';
import {
  MAX_REQUESTS_PER_WINDOW,
  resetRateWindows,
  takeRateSlot,
} from '@/server/rate-limit';
import type { PendingChange, RefinePlan } from '@/model/worldstream-refine';
import { clearSessions, openSession, putChange, type StoredSession } from '@/worldstream/sessions';

import {
  MAX_CONCURRENT_GENERATIONS,
  MAX_WORLD_GENERATIONS,
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

    // Čítač se sytí **levnými dveřmi**, protože jen ony smí až na dno: drahé
    // se zastaví o slot dřív a preview by pořád prošlo. Tenhle test soudí
    // sdílenost čítače, ne rezervu — tu soudí test hned pod ním.
    for (let i = 0; i < MAX_CONCURRENT_GENERATIONS; i += 1)
      expect(acquireSlot('refine')).toBe(true);

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
    // levné dveře dojdou na dno čítače a pátý pokus už neprojde.
    for (let i = MAX_WORLD_GENERATIONS; i < MAX_CONCURRENT_GENERATIONS; i += 1)
      expect(acquireSlot('refine'), `rezervovaný slot ${i} měl být volný`).toBe(true);
    expect(acquireSlot('refine'), 'čítač pustil víc než MAX_CONCURRENT_GENERATIONS').toBe(false);
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

  it('plná fronta čtení těl NENÍ pomalé tělo — 429, ne 408', async () => {
    // **Tyhle dveře jako jediné překládaly `raw.reason` samy** a do 4. 9. 2026
    // vydávaly `? 413 : 408`, takže nápor odsud odešel jako 408 „tělo dorazilo
    // pomalu" — tvrzení o volajícím, který neudělal nic.
    const stored = await generated();
    const held = Array.from({ length: MAX_CONCURRENT_BODY_READS_PER_CALLER }, silentBody);
    const pending = held.map((h) => readBody(h.request, 60_000));
    try {
      const response = await preview(stored.session.sessionId, { prompt: 'lower the mast' });
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('5');
      expect((await body(response)).error).toMatchObject({ code: 'TOO_MANY_BODY_READS' });
    } finally {
      for (const h of held) h.finish();
      await Promise.all(pending);
    }
  });
});
