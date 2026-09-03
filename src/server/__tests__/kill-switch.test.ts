/**
 * **Čtyři vrstvy provozu, každá vypnutelná zvlášť** (P15 T30, design book §22.4).
 *
 * Soudí se dvě věci a jsou to dvě různá tvrzení:
 *
 * 1. **Pravidla** — co který obsah ovládacího souboru znamená. Tady se dá
 *    všechno napsat bez routy, takže se to tak píše.
 * 2. **Dveře** — že ten vypínač někdo doopravdy čte. Tohle je ta půlka, která
 *    tady je proto, že modul se správnými pravidly, který nikdo nevolá, je
 *    přesně ten stav, ve kterém byla `admission.ts` do `T28`: 541 řádků hotové
 *    ochrany a žádná route, která by ji zapojila.
 *
 * Poslední tvrzení souboru je to nejdůležitější a je zároveň nejtišší:
 * **rozbitý ovládací soubor nesmí položit čtení hotových světů.** Vypnout
 * placené dveře je při incidentu žádoucí; vypnout na překlep v JSONu i to, co
 * je už zaplacené, je výpadek přesně toho, co §22.4 chrání jmenovitě.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { killState, killStateFrom, KILL_SWITCHES } from '../kill-switch';
import { readControlFile } from '../control-file';
import { DEFAULT_CAP_USD, resetProcessSpendCap, spendCapFromEnv } from '../spend-cap';

const temporary: string[] = [];

function controlFile(contents: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'worldsmith-kill-'));
  temporary.push(dir);
  const path = join(dir, 'control.json');
  if (contents !== null) writeFileSync(path, contents, 'utf8');
  return path;
}

/** Prostředí s ovládacím souborem daného obsahu. */
function env(contents: string | null): Record<string, string | undefined> {
  return { WORLDSMITH_CONTROL_FILE: controlFile(contents) };
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetProcessSpendCap();
});

/* ------------------------------------------------------------------ *
 * Pravidla.
 * ------------------------------------------------------------------ */

describe('bez povelu běží všechno', () => {
  it('nenastavená cesta nevypne nic', () => {
    expect(killState({})).toEqual({ upstream: false, sessions: false, refine: false, snapshots: false });
  });

  it('chybějící soubor nevypne nic — to je normální stav čisté instalace', () => {
    expect(killState(env(null)).sessions).toBe(false);
  });

  it('soubor bez klíče `off` nevypne nic, takže dnešní ovládací soubory stropu platí dál', () => {
    expect(killState(env(JSON.stringify({ enabled: true, capUsd: 5 })))).toEqual({
      upstream: false,
      sessions: false,
      refine: false,
      snapshots: false,
    });
  });

  it('prázdný seznam nevypne nic', () => {
    expect(killStateFrom({ off: [] }).upstream).toBe(false);
  });
});

describe('každá vrstva se vypíná zvlášť', () => {
  it('vypnutý upstream nechá běžet relace i refine', () => {
    expect(killStateFrom({ off: ['upstream'] })).toEqual({
      upstream: true,
      sessions: false,
      refine: false,
      snapshots: false,
    });
  });

  it('vypnuté relace nechají běžet upstream i refine', () => {
    expect(killStateFrom({ off: ['sessions'] })).toEqual({
      upstream: false,
      sessions: true,
      refine: false,
      snapshots: false,
    });
  });

  it('vypnutý refine nechá běžet upstream i relace', () => {
    expect(killStateFrom({ off: ['refine'] })).toEqual({
      upstream: false,
      sessions: false,
      refine: true,
      snapshots: false,
    });
  });

  it('dvě jména vypnou dvě vrstvy a třetí nechají běžet', () => {
    expect(killStateFrom({ off: ['upstream', 'refine'] })).toEqual({
      upstream: true,
      sessions: false,
      refine: true,
      snapshots: false,
    });
  });

  it('`all` vypne úplně všechno, včetně čtení hotových světů', () => {
    expect(killStateFrom({ off: ['all'] })).toEqual({
      upstream: true,
      sessions: true,
      refine: true,
      snapshots: true,
    });
  });

  it('žádné jiné jméno než tahle čtyři neexistuje', () => {
    expect([...KILL_SWITCHES]).toEqual(['upstream', 'sessions', 'refine', 'all']);
  });
});

describe('rozbitý vypínač zastaví placené dveře a čtení nechá běžet', () => {
  /**
   * Tohle je celý smysl toho, že `PAID_OFF` není `EVERYTHING_OFF`. Kdyby
   * rozbitý soubor vypnul i snapshoty, byl by překlep v JSONu úplný výpadek
   * dema — tedy horší následek než ta vada, kvůli které na vypínač někdo sahal.
   */
  function expectPaidOff(state: ReturnType<typeof killState>): void {
    expect(state.upstream).toBe(true);
    expect(state.sessions).toBe(true);
    expect(state.refine).toBe(true);
    expect(state.snapshots).toBe(false);
  }

  it('vadný JSON', () => {
    expectPaidOff(killState(env('{ rozbito')));
  });

  it('JSON, který není objekt', () => {
    expectPaidOff(killState(env('[1, 2, 3]')));
    expectPaidOff(killState(env('"vypnout"')));
  });

  it('`off`, které není seznam', () => {
    expectPaidOff(killStateFrom({ off: 'upstream' }));
    expectPaidOff(killStateFrom({ off: { upstream: true } }));
  });

  it('překlep ve jméně vrstvy — `session` místo `sessions`', () => {
    // Neznámé jméno vzniklo pokusem něco vypnout. Tichý průchod by nechal běžet
    // přesně to, co měl operátor právě zastavit, a v logu by to vypadalo jako
    // splněný povel.
    expectPaidOff(killStateFrom({ off: ['session'] }));
  });

  it('překlep vedle platného jména shodí celý povel, ne jen tu jednu položku', () => {
    expectPaidOff(killStateFrom({ off: ['upstream', 'sessons'] }));
  });

  // Nález nezávislé revize 3. 9. 2026: překlep v **hodnotě** selhával zavřeně,
  // překlep v **klíči** otevřeně. `{"offf":["all"]}` je „zastav všechno" a
  // vracelo „nic není vypnuté", bez jediného řádku v logu.
  it('překlep v klíči, ne v hodnotě — `offf` místo `off`', () => {
    expectPaidOff(killState(env(JSON.stringify({ offf: ['all'] }))));
    expectPaidOff(killState(env(JSON.stringify({ OFF: ['all'] }))));
    expectPaidOff(killState(env(JSON.stringify({ off: ['all'], disable: 'all' }))));
  });

  it('nečitelný soubor — cesta míří na adresář', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worldsmith-kill-dir-'));
    temporary.push(dir);
    expectPaidOff(killState({ WORLDSMITH_CONTROL_FILE: dir }));
  });
});

describe('vypínač se čte při každém rozhodnutí, ne jednou na startu', () => {
  it('přepnutí souboru platí od dalšího dotazu', () => {
    const path = controlFile(JSON.stringify({ off: [] }));
    const variables = { WORLDSMITH_CONTROL_FILE: path };
    expect(killState(variables).sessions).toBe(false);

    writeFileSync(path, JSON.stringify({ off: ['sessions'] }), 'utf8');
    expect(killState(variables).sessions).toBe(true);

    writeFileSync(path, JSON.stringify({ off: [] }), 'utf8');
    expect(killState(variables).sessions).toBe(false);
  });
});

describe('ovládací soubor je jeden, ne dva', () => {
  it('strop i vypínače čtou tutéž cestu', () => {
    const variables = {
      WORLDSMITH_CONTROL_FILE: controlFile(JSON.stringify({ enabled: true, capUsd: 42, off: ['refine'] })),
    };
    // Kdyby si každý četl vlastní proměnnou, jedno z těch dvou tvrzení by bylo
    // o souboru, který v tomhle testu neexistuje.
    expect(spendCapFromEnv(variables).snapshot().capUsd).toBe(42);
    expect(killState(variables).refine).toBe(true);
  });

  // P15 T30-offonlyfile. Hlavička nahoře operátorovi slibuje, že do souboru
  // napíše, co má stát. Do 3. 9. 2026 mu tenhle soubor zastavil i všechno
  // ostatní, protože strop v něm neviděl svoje klíče a odmítal.
  it('soubor s pouhým `off` vypne jednu vrstvu a strop nechá na výchozích hodnotách', async () => {
    const variables = { WORLDSMITH_CONTROL_FILE: controlFile(JSON.stringify({ off: ['refine'] })) };

    expect(killState(variables).refine).toBe(true);
    expect(killState(variables).sessions, 'vypnul se i vypínač, o kterém soubor mlčí').toBe(false);

    const cap = spendCapFromEnv(variables);
    expect(cap.snapshot().capUsd).toBe(DEFAULT_CAP_USD);
    expect((await cap.reserve(0.01)).ok, 'vypnutí refine zastavilo zakládání světů').toBe(true);
  });

  it('klíče se navzájem nepletou: strop ignoruje `off`, vypínače ignorují `capUsd`', () => {
    const read = readControlFile(controlFile(JSON.stringify({ enabled: false, capUsd: 7, off: ['upstream'] })));
    if (read.kind !== 'read') throw new Error('unreachable');
    expect(killStateFrom(read.value)).toEqual({
      upstream: true,
      sessions: false,
      refine: false,
      snapshots: false,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Dveře — že ten vypínač někdo doopravdy čte.
 * ------------------------------------------------------------------ */

describe('vypínač je zapojený do dveří, ne jen napsaný', () => {
  it('vypnuté relace odmítne zakládací route 503, a nepřečte ani tělo', async () => {
    vi.stubEnv('WORLDSMITH_CONTROL_FILE', controlFile(JSON.stringify({ off: ['sessions'] })));
    const { POST } = await import('../../app/api/worldstream/sessions/route');

    // Tělo je nečitelné schválně: kdyby ho route četla dřív než vypínač,
    // odpověděla by `BODY_NOT_JSON` a vypnuté dveře by stály víc než musí.
    const response = await POST(
      new Request('http://127.0.0.1/api/worldstream/sessions', { method: 'POST', body: '{ rozbito' }),
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('SESSIONS_DISABLED');
  });

  it('vypnutý upstream znamená, že placený emitor vůbec nevznikne', async () => {
    vi.stubEnv('WORLDSMITH_BRANCH', 'live');
    vi.stubEnv('WORLDSMITH_MODEL_ENDPOINT', 'https://upstream.invalid/v1/messages');
    vi.stubEnv('WORLDSMITH_MODEL_KEY', 'test-key');
    vi.stubEnv('WORLDSMITH_USD_PER_MTOK_OUT', '15');
    const { cloudEmitter } = await import('../../app/api/worldstream/sessions/route');
    // Kontrola proti opačnému směru: bez vypínače je tahle konfigurace platná
    // a emitor vzniká. Bez ní by test procházel i na nefunkční konfiguraci.
    expect(cloudEmitter()).not.toBeNull();

    vi.stubEnv('WORLDSMITH_CONTROL_FILE', controlFile(JSON.stringify({ off: ['upstream'] })));
    expect(cloudEmitter()).toBeNull();
  });

  it('vypnutý refine odmítne preview 503', async () => {
    vi.stubEnv('WORLDSMITH_CONTROL_FILE', controlFile(JSON.stringify({ off: ['refine'] })));
    const { createChange } = await import('../../app/api/worldstream/sessions/[sessionId]/changes/route');

    const response = await createChange(
      new Request('http://127.0.0.1/x', { method: 'POST', body: '{ rozbito' }),
      'no-such-session',
      null,
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('REFINE_DISABLED');
  });

  it('vypnutý refine odmítne i commit, ne jen preview', async () => {
    vi.stubEnv('WORLDSMITH_CONTROL_FILE', controlFile(JSON.stringify({ off: ['refine'] })));
    const { POST } = await import(
      '../../app/api/worldstream/sessions/[sessionId]/changes/[changeId]/commit/route'
    );

    // Neexistující relace: bez vypínače je odpověď 404. Že vyjde 503, tedy
    // znamená, že se brána zeptala dřív, než se šlo do registru.
    const response = await POST(new Request('http://127.0.0.1/x', { method: 'POST' }), {
      params: Promise.resolve({ sessionId: 'no-such-session', changeId: 'no-such-change' }),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('REFINE_DISABLED');
  });

  it('vypnuté relace nechají refine i upstream běžet — vrstvy jsou oddělené i ve dveřích', async () => {
    vi.stubEnv('WORLDSMITH_CONTROL_FILE', controlFile(JSON.stringify({ off: ['sessions'] })));
    const { createChange } = await import('../../app/api/worldstream/sessions/[sessionId]/changes/route');

    const response = await createChange(
      new Request('http://127.0.0.1/x', { method: 'POST', body: JSON.stringify({ prompt: 'open the door' }) }),
      'no-such-session',
      null,
    );
    // 404, ne 503: dveře refine běží dál a odmítly to až na neznámé relaci.
    expect(response.status).not.toBe(503);
  });
});
