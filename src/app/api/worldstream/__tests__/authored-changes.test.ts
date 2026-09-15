/**
 * **Druhá věta ze skladu uvařených světů** (P15 `T35-actsthree4`).
 *
 * Do 6. 9. 2026 stavěla route plánovač výhradně z `cloudEmitter()`, takže bez
 * `.env` neměla druhá věta výrobce vůbec a dějství III se nedalo předvést ani
 * ručně. První větu obsluhoval sklad od `T46-routewire`; tahle sada soudí, že
 * ho dostala i druhá — a hlavně **za jakých podmínek**.
 *
 * ## Tři vlastnosti, které oko nepokryje
 *
 * 1. **Živý model má přednost.** Kdyby sklad předbíhal, zaplacený klíč by
 *    přestal být vidět a nikdo by si toho nevšiml: obojí vrátí preview.
 * 2. **Změna se hledá jen v mezích groundnutého cíle.** „Nejbližší přes celý
 *    svět" vypadá vstřícněji a je to zaručené odmítnutí o krok dál.
 * 3. **Přehrávanou změnu produkt přizná.** Popisek je tvrzení o původu, ne
 *    dekorace, a jeho absence se z obrazovky nepozná.
 *
 * Sklad na disku se sem **nečte**: sada by pak měřila, co zrovna uvařil autorský
 * běh, ne rozhodování route. `authoredWorldById()` je proto jediná věc, která se
 * podstrkuje — všechno ostatní (výběr změny, emitor, brány route) je skutečné.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetFaultLog } from '@/server/public-faults';
import { resetRateWindows } from '@/server/rate-limit';
import type { AuthoredWorld } from '@/worldstream/authored';
import { clearSessions } from '@/worldstream/sessions';

import { resetConcurrency } from '../sessions/route';
import { createChange } from '../sessions/[sessionId]/changes/route';
import { ANSWER, generated } from './world-fixture';

/**
 * Uvařená změna nad hrdinou fixtury.
 *
 * `stableId` je `ironMast`, protože přesně tak by ji napsal model: dostal ten
 * `stableId` v zadání a `readRefineEmission()` jiný nepřijme.
 */
const MAST_CHANGE = {
  id: 'ch-rust',
  prompt: 'Let the mast go to rust.',
  stableId: 'ironMast',
  synonyms: ['the mast', 'the tower'],
  refine: {
    summary: 'the mast goes to rust',
    shape: (ANSWER.shapes as unknown[])[0],
    behavior: [],
    appearance: [],
  },
};

const SHELF: AuthoredWorld = {
  id: 'w-salt',
  prompt: 'a salt flat with one iron mast standing in the middle of it',
  heroObjects: ['ironMast'],
  synonyms: ['the mast'],
  planner: {},
  compiler: {},
  changes: [MAST_CHANGE],
};

vi.mock('@/worldstream/authored', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/worldstream/authored')>();
  return {
    ...original,
    // **Jen tahle jedna funkce.** Výběr změny, emitor i práh `exact` zůstávají
    // skutečné, takže sada pořád soudí rozhodování a ne svoji vlastní fixturu.
    authoredWorldById: (id: string) => id === 'legacy-look' ? { ...SHELF, changes: [{ ...MAST_CHANGE, refine: { ...MAST_CHANGE.refine, appearance: [{ op: 'replace', path: '/look/palette', value: 'sand' }] } }] } : (id === SHELF.id ? SHELF : null),
  };
});

function previewRequest(sessionId: string, prompt: string): Request {
  return new Request(`http://127.0.0.1/api/worldstream/sessions/${sessionId}/changes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

afterEach(() => {
  clearSessions();
  resetConcurrency();
  resetFaultLog();
  resetRateWindows();
  vi.restoreAllMocks();
});

it('refuses an archived authored appearance change without updating the world', async () => {
  const stored = await generated(); stored.authoredWorldId = 'legacy-look';
  const before = stored.blueprint;
  const response = await createChange(previewRequest(stored.session.sessionId, MAST_CHANGE.prompt), stored.session.sessionId, null);
  expect(response.status).toBe(422);
  expect((await body(response)).error).toMatchObject({ code: 'APPEARANCE_UNSUPPORTED' });
  expect(stored.blueprint).toBe(before); expect(stored.changes.size).toBe(0);
});

describe('druhá věta bez klíče jde ze skladu', () => {
  it('relace z uvařeného světa dostane preview, ne 503', async () => {
    const stored = await generated();
    stored.authoredWorldId = SHELF.id;

    const response = await createChange(
      previewRequest(stored.session.sessionId, 'let the mast go to rust'),
      stored.session.sessionId,
      null,
    );

    expect(response.status).toBe(200);
    const answer = await body(response);
    expect(answer.outcome).toBe('PREVIEW');
    expect(answer.summary).toBe('the mast goes to rust');
    expect(answer.target).toMatchObject({ stableId: 'ironMast' });
  });

  it('přehrávanou změnu produkt přizná, když to není ta uvařená věta', async () => {
    const stored = await generated();
    stored.authoredWorldId = SHELF.id;

    const near = await body(
      await createChange(
        previewRequest(stored.session.sessionId, 'make the mast look old'),
        stored.session.sessionId,
        null,
      ),
    );
    expect(near.authored).toEqual({ match: 'nearest' });

    // A **mlčí**, když věta trefila uvařenou změnu přesně — tam se nic
    // nenahrazovalo, takže není co přiznávat (táž doktrína jako `T45`).
    const exact = await body(
      await createChange(
        previewRequest(stored.session.sessionId, MAST_CHANGE.prompt),
        stored.session.sessionId,
        null,
      ),
    );
    expect(exact.authored).toEqual({ match: 'exact' });
  });

  it('relace, kterou psal model, sklad nedostane vůbec', async () => {
    // `authoredWorldId` je `null`, tedy „svět napsal model". Sáhnout do skladu
    // by znamenalo vydat změnu jiného světa a nechat ji o krok dál odmítnout.
    const stored = await generated();

    const response = await createChange(
      previewRequest(stored.session.sessionId, 'let the mast go to rust'),
      stored.session.sessionId,
      null,
    );

    expect(response.status).toBe(503);
    expect((await body(response)).error).toMatchObject({ code: 'NO_AUTHORED_CHANGE' });
  });

  it('objekt bez uvařené změny je 503, ne změna cizího objektu', async () => {
    const stored = await generated();
    stored.authoredWorldId = SHELF.id;

    // `saltFlat` je v tom světě, ale žádná uvařená změna na něj nemíří.
    const response = await createChange(
      previewRequest(stored.session.sessionId, 'let the salt flat go to rust'),
      stored.session.sessionId,
      null,
    );

    expect(response.status).toBe(503);
    // Porotce se tenhle text dočte v panelu změny, takže se pinuje i on:
    // pět světů z jedenácti uvařenou změnu má, takže tohle je pro zbytek
    // **výchozí** odpověď, ne okrajová porucha.
    const error = (await body(response)).error as { code: string; message: string };
    expect(error.code).toBe('NO_AUTHORED_CHANGE');
    expect(error.message).toBe(
      'no change for that object was authored ahead of time, and no model is configured to write one now',
    );
  });

  it('živý model má přednost před skladem, i když sklad odpověď má', async () => {
    // **Pořadí je součást kontraktu.** Kdyby sklad předbíhal, zaplacený klíč by
    // přestal být vidět — a obojí vrátí preview, takže z odpovědi samotné by se
    // to nepoznalo. Rozhoduje `summary`, které sklad nezná.
    const stored = await generated();
    stored.authoredWorldId = SHELF.id;

    const response = await createChange(
      previewRequest(stored.session.sessionId, 'let the mast go to rust'),
      stored.session.sessionId,
      () =>
        Promise.resolve({
          summary: 'the model answered this one',
          shape: (ANSWER.shapes as unknown[])[0],
          behavior: [],
          appearance: [],
        }),
    );

    const answer = await body(response);
    expect(answer.summary).toBe('the model answered this one');
    // Popisek o původu **nesmí** být u odpovědi modelu: tvrdil by, že je
    // přehrávaná, a to je lež opačným směrem.
    expect(answer.authored).toBeUndefined();
  });
});
