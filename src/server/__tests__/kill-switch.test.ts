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

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    expect(killState({})).toEqual({
      upstream: false,
      sessions: false,
      refine: false,
      snapshots: false,
      replay: false,
    });
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
      replay: false,
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
      replay: false,
    });
  });

  it('vypnuté relace nechají běžet upstream i refine', () => {
    expect(killStateFrom({ off: ['sessions'] })).toEqual({
      upstream: false,
      sessions: true,
      refine: false,
      snapshots: false,
      replay: false,
    });
  });

  it('vypnutý refine nechá běžet upstream i relace', () => {
    expect(killStateFrom({ off: ['refine'] })).toEqual({
      upstream: false,
      sessions: false,
      refine: true,
      snapshots: false,
      replay: false,
    });
  });

  it('dvě jména vypnou dvě vrstvy a třetí nechají běžet', () => {
    expect(killStateFrom({ off: ['upstream', 'refine'] })).toEqual({
      upstream: true,
      sessions: false,
      refine: true,
      snapshots: false,
      replay: false,
    });
  });

  it('`all` vypne úplně všechno, včetně čtení hotových světů', () => {
    expect(killStateFrom({ off: ['all'] })).toEqual({
      upstream: true,
      sessions: true,
      refine: true,
      snapshots: true,
      replay: true,
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
    expect(state.replay, "rozbitý soubor zavřel i neplacené přehrávací dveře").toBe(false);
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
      WORLDSMITH_CONTROL_FILE: controlFile(
        JSON.stringify({ enabled: true, capUsd: 0.42, off: ['refine'] }),
      ),
    };
    // Kdyby si každý četl vlastní proměnnou, jedno z těch dvou tvrzení by bylo
    // o souboru, který v tomhle testu neexistuje.
    //
    // Částka je schválně POD výchozími 5 USD: od podlahy z prostředí
    // (P15 `T30-capfloor`) je účinný strop `min(soubor, výchozí)`, takže
    // původních 42 by se uřízlo na 5 — tedy na hodnotu k nerozeznání od
    // „soubor se vůbec nepřečetl", což je přesně to, co má tenhle test vyloučit.
    expect(spendCapFromEnv(variables).snapshot().capUsd).toBe(0.42);
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
      replay: false,
    });
  });

  // P15 T30-whitelistedge. JSON komentáře nemá, takže poznámka pro kolegu je
  // to první, co operátor za incidentu do souboru napíše — a uzavřený seznam
  // ji do 4. 9. 2026 četl jako rozbitý soubor: troje placené dveře dolů kvůli
  // větě, kterou nikdo nečte. `note` je jediný volný klíč a nikdo ho nečte.
  it('`note` vedle povelu nic nerozbije — vypne jen to, co povel jmenuje', async () => {
    const variables = {
      WORLDSMITH_CONTROL_FILE: controlFile(
        JSON.stringify({ off: ['upstream'], note: 'účet utíká, vypínám model, volej Tomáše' }),
      ),
    };
    expect(killState(variables)).toEqual({
      upstream: true,
      sessions: false,
      refine: false,
      snapshots: false,
      replay: false,
    });
    const cap = spendCapFromEnv(variables);
    expect(cap.snapshot().capUsd, 'poznámka pohnula stropem').toBe(DEFAULT_CAP_USD);
    expect((await cap.reserve(0.01)).ok, 'poznámka odmítla rezervaci').toBe(true);

    // Hodnota `note` je volná: objekt soubor nerozbije. Přes soubor, ne přes
    // `killStateFrom` — seznam klíčů soudí `readControlFile`, a ta by se obešla.
    const objectNote = killState(env(JSON.stringify({ off: ['upstream'], note: { ticket: 42 } })));
    expect(objectNote.upstream).toBe(true);
    expect(objectNote.sessions, 'objekt v `note` rozbil soubor').toBe(false);

    // Ale překlep v tom klíči je pořád překlep v klíči: seznam zůstává uzavřený.
    expect(killState(env(JSON.stringify({ off: ['upstream'], notes: 'x' }))).sessions, '`notes` prošlo').toBe(true);
    expect(killState(env(JSON.stringify({ off: ['upstream'], Note: 'x' }))).sessions, '`Note` prošlo').toBe(true);
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

/* ------------------------------------------------------------------ *
 * Dveře podruhé — vyjmenované ze stromu, ne z hlavy.
 * ------------------------------------------------------------------ */

/**
 * **Tenhle blok existuje proto, že ruční seznam dveří tuhle vadu vyrobil.**
 *
 * Nález `T28` jmenoval troje dveře bez vypínače, remediace zavřela jedny
 * a druhé kolo nezávislé revize 4. 9. 2026 to vrátilo jako `blocking`.
 * Enumerace ze stromu je jediná forma, která **nemůže** zapomenout dveře, které
 * vzniknou příště: nová `route.ts` bez brány shodí tenhle test hned, jak se
 * založí.
 *
 * Soudí se **volání `killState(` v kódu** — komentáře se předtím odstřihnou — ne
 * řádek s importem, a hledá se i v modulech, které si route pod `src/app/api`
 * přitáhne relativní cestou. Všechno tři je vědomé:
 *
 * - `/api/emit/stream` vlastní bránu nemá — volá sdílenou `replayDisabled()`
 *   ze sousední `../route.ts`, aby se ty dvě emitovací cesty nemohly rozejít.
 *   Test, který by četl jen text jednoho souboru, by tu sdílenou bránu neviděl.
 * - Naopak přítomnost importu nic nedokazuje: nepoužitý import projde přes lint
 *   i `tsc` jako mrtvý kód, kdežto `killState(` je volání.
 * - A komentář taky nic nedokazuje. Nezávislá revize 4. 9. 2026 to naměřila:
 *   dveře, jejichž jediná zmínka o vypínači byla věta v hlavičce, prošly zeleně
 *   — a hlavičky v tomhle repu `killState(` jmenují běžně. Odstřihnout se proto
 *   musí dřív, než se hledá.
 */
const API_ROOT = resolve(fileURLToPath(new URL('../../app/api', import.meta.url)));

/**
 * Dveře, které vypínač číst **nemají**. Není to seznam k doplnění po každém
 * nálezu — je to tvrzení, které se musí obhájit:
 *
 * - `build-id` a `health` jsou diagnostika. Vypnout je znamená oslepit
 *   monitoring přesně ve chvíli, kdy operátor vypínač zapnul.
 * - `og` skládá statický obrázek pro náhled odkazu. Nečte relaci, nevolá model
 *   a nesahá na nic, co by šlo vypnout.
 */
const KILL_SWITCH_EXEMPT = ['build-id/route.ts', 'health/route.ts', 'og/route.ts'] as const;

/**
 * Jak se jmenuje soubor, který App Router bere jako dveře.
 *
 * **Všechny přípony, ne jen `.ts`** — nález nezávislé revize 4. 9. 2026:
 * `route.js` i `route.tsx` bez brány prošly zeleně, protože se hledalo jméno
 * `route.ts` doslova. Next je obsluhuje stejně, tak je stejně musí vidět i tenhle
 * test.
 */
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx|mjs)$/;

/** Každé dveře pod `src/app/api`, jako cesta s `/` od kořene těch dveří. */
function apiRoutes(directory: string = API_ROOT): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...apiRoutes(full));
    else if (ROUTE_FILE.test(entry)) found.push(relative(API_ROOT, full).split(sep).join(posix.sep));
  }
  return found.sort();
}

/**
 * Zdroj bez komentářů. Blokové celé, řádkové jen tam, kde `//` začíná řádek —
 * `https://` uvnitř řetězce tak zůstane a nesebere s sebou kód za sebou.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Volá tenhle soubor `killState(` — sám, nebo přes modul, který si pod
 * `src/app/api` přitáhl relativní cestou?
 *
 * Chodí se **jen po relativních importech uvnitř těch dveří**. Balíčky ani `@/`
 * se nesledují schválně: kdyby ano, stačilo by importovat cokoli, co kdesi
 * hluboko vypínač čte, a brána by se rozsvítila zeleně i nad dveřmi, které se
 * nikoho neptají.
 */
function readsKillSwitch(file: string, seen = new Set<string>()): boolean {
  const full = resolve(API_ROOT, file);
  if (seen.has(full)) return false;
  seen.add(full);
  if (!existsSync(full)) return false;

  const source = code(readFileSync(full, 'utf8'));
  if (source.includes('killState(')) return true;

  for (const match of source.matchAll(/from '(\.[^']*)'/g)) {
    const target = `${resolve(dirname(full), match[1])}.ts`;
    if (!target.startsWith(API_ROOT)) continue;
    if (readsKillSwitch(relative(API_ROOT, target), seen)) return true;
  }
  return false;
}

describe('vypínač dosáhne na každé dveře, ne na ty, na které si někdo vzpomněl', () => {
  it('strom dveří se doopravdy prochází', () => {
    const routes = apiRoutes();
    // Kdyby se cesta rozešla se skutečností, prošlo by všechno níž nad prázdnou
    // množinou — tedy zelený test bez jediného tvrzení.
    expect(routes).toContain('emit/route.ts');
    expect(routes).toContain('worldstream/sessions/[sessionId]/events/route.ts');
    expect(routes.length).toBeGreaterThan(KILL_SWITCH_EXEMPT.length);
  });

  it('každá route.ts vypínač čte, nebo stojí na jmenovaném seznamu výjimek', () => {
    const ungated = apiRoutes().filter(
      (route) =>
        !readsKillSwitch(route) && !(KILL_SWITCH_EXEMPT as readonly string[]).includes(route),
    );
    expect(
      ungated,
      'tyhle dveře vypni-provoz neuvidí — buď do nich bránu dopiš, nebo k výjimce napiš důvod',
    ).toEqual([]);
  });

  it('seznam výjimek nesmí zetlít: každá jmenovaná route existuje', () => {
    const routes = apiRoutes();
    for (const exempt of KILL_SWITCH_EXEMPT) expect(routes).toContain(exempt);
  });
});

describe('vypni-provoz dosáhne na obě emitovací cesty', () => {
  it('vypnutý provoz odmítne /api/emit 503, a nepřečte ani tělo', async () => {
    vi.stubEnv('WORLDSMITH_CONTROL_FILE', controlFile(JSON.stringify({ off: ['all'] })));
    const { POST } = await import('../../app/api/emit/route');

    // Tělo je nečitelné schválně: kdyby ho route četla dřív než vypínač,
    // odpověděla by 400 a vypnuté dveře by stály celý `readBody`.
    const response = await POST(
      new Request('http://127.0.0.1/api/emit', { method: 'POST', body: '{ rozbito' }),
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('REPLAY_DISABLED');
  });

  it('vypnutý provoz odmítne /api/emit/stream obyčejnou odpovědí, ne proudem', async () => {
    vi.stubEnv('WORLDSMITH_CONTROL_FILE', controlFile(JSON.stringify({ off: ['all'] })));
    const { POST } = await import('../../app/api/emit/stream/route');

    const response = await POST(
      new Request('http://127.0.0.1/api/emit/stream', {
        method: 'POST',
        body: JSON.stringify({ promptId: 'whatever' }),
      }),
    );
    expect(response.status).toBe(503);
    // Za hlavičkami `text/event-stream` je stav 200 už u klienta a 503 se poslat
    // nedá — vypnutí by pak odešlo jako rámec `stream-fault`, tedy jako porucha
    // potrubí. Brána proto musí být před proudem, ne v něm.
    expect(response.headers.get('content-type')).not.toContain('text/event-stream');
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('REPLAY_DISABLED');
  });

  it('vypnutí tří vrstev emitovací dveře nechá běžet — jsou neplacené', async () => {
    vi.stubEnv(
      'WORLDSMITH_CONTROL_FILE',
      controlFile(JSON.stringify({ off: ['upstream', 'sessions', 'refine'] })),
    );
    const { POST } = await import('../../app/api/emit/route');

    const response = await POST(
      new Request('http://127.0.0.1/api/emit', { method: 'POST', body: '{ rozbito' }),
    );
    // 400 za nečitelné tělo: brána se zeptala a pustila dál.
    expect(response.status).not.toBe(503);
  });

  it('rozbitý ovládací soubor emitovací dveře nepoloží', async () => {
    vi.stubEnv('WORLDSMITH_CONTROL_FILE', controlFile('{ tohle není JSON'));
    const { POST } = await import('../../app/api/emit/route');

    const response = await POST(
      new Request('http://127.0.0.1/api/emit', { method: 'POST', body: '{ rozbito' }),
    );
    // Táž doktrína jako u snapshotů: překlep v JSONu nesmí položit to, co se
    // neplatí. Vypne to jedině výslovné `all`.
    expect(response.status).not.toBe(503);
  });
});

describe('vypni-provoz dosáhne i na čtení běžící relace', () => {
  const unknown = { params: Promise.resolve({ sessionId: 'no-such-session' }) };

  it('vypnutý provoz odmítne snapshot relace 503, dřív než sáhne do registru', async () => {
    vi.stubEnv('WORLDSMITH_CONTROL_FILE', controlFile(JSON.stringify({ off: ['all'] })));
    const { GET } = await import('../../app/api/worldstream/sessions/[sessionId]/route');

    // Neznámá relace: bez vypínače je odpověď 404, takže 503 znamená, že se
    // brána ptala první.
    const response = await GET(new Request('http://127.0.0.1/x'), unknown);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('SERVICE_DISABLED');
  });

  it('vypnutý provoz odmítne i proud relace, a to před slotem', async () => {
    vi.stubEnv('WORLDSMITH_CONTROL_FILE', controlFile(JSON.stringify({ off: ['all'] })));
    const events = await import('../../app/api/worldstream/sessions/[sessionId]/events/route');
    events.resetStreamSubscribers();

    const response = await events.GET(new Request('http://127.0.0.1/x'), unknown);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('SERVICE_DISABLED');
    // Odmítnutý požadavek nesmí obsadit místo, které pak nikdo nevrátí.
    expect(events.streamedSessionCount()).toBe(0);
  });

  it('vypnuté relace čtení běžící relace nezastaví — vrstvy zůstávají oddělené', async () => {
    vi.stubEnv('WORLDSMITH_CONTROL_FILE', controlFile(JSON.stringify({ off: ['sessions'] })));
    const { GET } = await import('../../app/api/worldstream/sessions/[sessionId]/route');

    const response = await GET(new Request('http://127.0.0.1/x'), unknown);
    // 404, ne 503: zakládání stojí, ale co běží, zůstává čitelné (§22.4).
    expect(response.status).toBe(404);
  });

  it('rozbitý ovládací soubor čtení běžící relace nepoloží', async () => {
    vi.stubEnv('WORLDSMITH_CONTROL_FILE', controlFile('{ tohle není JSON'));
    const { GET } = await import('../../app/api/worldstream/sessions/[sessionId]/route');

    const response = await GET(new Request('http://127.0.0.1/x'), unknown);
    expect(response.status).toBe(404);
  });
});
