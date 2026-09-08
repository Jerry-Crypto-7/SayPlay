/**
 * Oracle úlohy: **hlídač pozná server, který odpovídá a světy nevyrábí.**
 *
 * To je celý ten rozdíl, kvůli kterému `T30` existuje. Nejsilnější tvrzení
 * souboru proto není šťastná cesta, ale kontrolní skupina pod ní: cíl, který na
 * **každý** požadavek odpoví 200 a tělem, které vypadá skoro správně, musí
 * spadnout. Kdyby prošel, byl by tenhle hlídač jen dražší ping.
 *
 * ## Co je tady oracle a co proxy
 *
 * **Oracle** je poslední blok: skutečný proces hlídače, spuštěný přes CLI proti
 * skutečnému HTTP serveru na skutečném portu, a čte se soubor, který zapsal na
 * disk. Nic z toho není napodobenina.
 *
 * **Proxy** jsou bloky nad ním: `probeWorldstream` se stubovaným `fetch`. Jsou
 * tam proto, že cesty selhání se přes skutečný server vyrábějí těžko a bez nich
 * by se měřila jediná větev z osmi — ta šťastná.
 */

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error — `.mjs` bez typů, importuje se schválně jako zdroj pravdy.
import { PROBE_FAILURES, PROBE_PROMPT, probeWorldstream } from '../watchdog/worldstream.mjs';

const WATCHDOG = join(dirname(fileURLToPath(import.meta.url)), '..', 'watchdog', 'worldstream.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'worldstream-watchdog-'));
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * Cíl jako tabulka odpovědí.
 * ------------------------------------------------------------------ */

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/** Zdravý cíl s mockovaným modelem: svět vznikne hned a má adresu. */
function healthyTarget(overrides: Record<string, Reply> = {}): Record<string, Reply> {
  const blueprint = { objects: [{ stableId: 'door' }, { stableId: 'stone' }] };
  return {
    'GET /api/health': { status: 200, body: { ready: true, elapsedMs: 3 } },
    'POST /api/worldstream/sessions': { status: 202, body: { sessionId: 'probe-1' } },
    'GET /api/worldstream/sessions/probe-1': {
      status: 200,
      body: { phase: 'world', blueprint, sharedWorld: '/api/worldstream/snapshots/abc' },
    },
    'GET /api/worldstream/snapshots/abc': {
      status: 200,
      body: { hash: 'abc', title: 'a small stone room', blueprint },
    },
    ...overrides,
  };
}

/** `fetch`, který odpovídá z tabulky. Zaznamenává, co se ho kdo ptal. */
function stubFetch(table: Record<string, Reply>) {
  const seen: { method: string; path: string; body: string | null }[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname;
    seen.push({ method, path, body: typeof init?.body === 'string' ? init.body : null });
    const reply = table[`${method} ${path}`];
    if (reply === undefined) return new Response('null', { status: 404 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, seen };
}

function probe(table: Record<string, Reply>, options: Record<string, unknown> = {}) {
  const { impl, seen } = stubFetch(table);
  return {
    seen,
    run: () =>
      probeWorldstream({
        target: 'http://target.test',
        fetchImpl: impl,
        allowGeneration: true,
        wait: async () => undefined,
        ...options,
      }) as Promise<{ ok: boolean; reason?: string; detail?: string; checks: Record<string, unknown> }>,
  };
}

/* ------------------------------------------------------------------ *
 * Šťastná cesta.
 * ------------------------------------------------------------------ */

describe('zdravý cíl projde všemi třemi patry', () => {
  it('založí relaci, dojde do fáze `world` a stáhne si svět zpátky', async () => {
    const { run, seen } = probe(healthyTarget());
    const verdict = await run();

    expect(verdict.ok).toBe(true);
    expect(verdict.checks.generation).toMatchObject({ objects: 2 });
    // **`sessionId` tady být nesmí** — do 3. 9. 2026 se tenhle řádek na jeho
    // přítomnost naopak ptal. `checks` jde celý do logu a živé `sessionId` je
    // schopnost: kdo ho drží, může do té relace POSTovat placená volání.
    // `toMatchObject` výš by ho propustilo, proto vlastní aserce.
    expect(verdict.checks.generation).not.toHaveProperty('sessionId');
    expect(verdict.checks.sharedWorld).toMatchObject({ address: '/api/worldstream/snapshots/abc', objects: 2 });

    // Pořadí je součást tvrzení: nezdravý cíl se nemá zatěžovat generací.
    expect(seen.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /api/health',
      'POST /api/worldstream/sessions',
      'GET /api/worldstream/sessions/probe-1',
      'GET /api/worldstream/snapshots/abc',
    ]);
    expect(seen[1].body).toBe(JSON.stringify({ prompt: PROBE_PROMPT }));
  });

  it('počká, než relace dojede — mezistav není porucha', async () => {
    let asked = 0;
    const table = healthyTarget();
    const ready = table['GET /api/worldstream/sessions/probe-1'];
    const { impl } = stubFetch(table);
    const patched = async (url: string, init?: RequestInit): Promise<Response> => {
      if (new URL(url).pathname === '/api/worldstream/sessions/probe-1') {
        asked += 1;
        if (asked < 3) return new Response(JSON.stringify({ phase: 'intent' }), { status: 200 });
      }
      return impl(url, init);
    };

    const verdict = (await probeWorldstream({
      target: 'http://target.test',
      fetchImpl: patched,
      allowGeneration: true,
      wait: async () => undefined,
    })) as { ok: boolean };

    expect(ready.status).toBe(200);
    expect(asked).toBe(3);
    expect(verdict.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Kontrolní skupina — kvůli tomuhle blok existuje.
 * ------------------------------------------------------------------ */

describe('HTTP 200 není oracle živosti', () => {
  it('cíl, který na všechno odpoví 200 a prázdnem, spadne', async () => {
    const { run } = probe({
      'GET /api/health': { status: 200, body: { ready: true } },
      'POST /api/worldstream/sessions': { status: 202, body: { sessionId: 'probe-1' } },
      'GET /api/worldstream/sessions/probe-1': { status: 200, body: { phase: 'world', blueprint: {} } },
    });
    const verdict = await run();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('WORLD_EMPTY');
  });

  it('relativní adresa z cíle se nesmí složit na jiný host', async () => {
    // **Nález nezávislé revize 3. 9. 2026.** Adresa z generace se do
    // `${target}${address}` skládala **bez** normalizace, na kterou se posílá
    // parametr `--shared`, a docstring to jen tvrdil. Cíl, který vrátí
    // relativní hodnotu, tím posílá hlídače jinam: `https://demo.example`
    // + `.attacker.com/x` je host `demo.example.attacker.com`.
    const { run, seen } = probe(
      healthyTarget({
        'GET /api/worldstream/sessions/probe-1': {
          status: 200,
          body: {
            phase: 'world',
            blueprint: { objects: [{ stableId: 'door' }] },
            sharedWorld: '.attacker.test/x',
          },
        },
      }),
    );
    await run();

    // **Nosné je vedoucí lomítko, ne to, že se řetězec nikde neobjeví.**
    // Normalizace z něj udělá cestu **na cíli** — `.attacker.test/x` se tedy
    // vyskytnout smí a musí, jen jako segment cesty za prefixem, ne jako
    // pokračování hostitele. Kdyby chyběl prefix, `${target}${address}` složí
    // `http://target.test.attacker.test/x`.
    for (const call of seen) expect(call.path.startsWith('/')).toBe(true);
    expect(seen.at(-1)?.path).toBe('/api/worldstream/snapshots/.attacker.test/x');
  });

  it('svět, který nemá adresu, není načtený svět', async () => {
    const { run } = probe(
      healthyTarget({
        'GET /api/worldstream/sessions/probe-1': {
          status: 200,
          body: { phase: 'world', blueprint: { objects: [{ stableId: 'door' }] } },
        },
      }),
    );
    const verdict = await run();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('SHARED_WORLD_MISSING');
  });

  it('adresa, pod kterou nic není, taky ne', async () => {
    const { run } = probe(
      healthyTarget({ 'GET /api/worldstream/snapshots/abc': { status: 200, body: { blueprint: { objects: [] } } } }),
    );
    const verdict = await run();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('SHARED_WORLD_UNREADABLE');
  });

  it('server, který na každou větu odpoví poruchou, je porucha — ne klid', async () => {
    const { run } = probe(
      healthyTarget({
        'GET /api/worldstream/sessions/probe-1': {
          status: 200,
          body: { phase: 'failed', fault: 'the model could not be reached' },
        },
      }),
    );
    const verdict = await run();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('WORLD_FAILED');
    expect(verdict.detail).toBe('the model could not be reached');
  });

  it('nepřipravený server se generací vůbec neobtěžuje', async () => {
    const { run, seen } = probe(
      healthyTarget({ 'GET /api/health': { status: 503, body: { ready: false, reason: 'WRITE_FAILED' } } }),
    );
    const verdict = await run();
    expect(verdict.reason).toBe('HEALTH_NOT_READY');
    expect(seen.map((call) => call.path)).toEqual(['/api/health']);
  });

  it('relace, která do deadlinu nedojede, je porucha', async () => {
    let clock = 0;
    const table = healthyTarget({
      'GET /api/worldstream/sessions/probe-1': { status: 200, body: { phase: 'intent' } },
    });
    const { impl } = stubFetch(table);
    const verdict = (await probeWorldstream({
      target: 'http://target.test',
      fetchImpl: impl,
      allowGeneration: true,
      now: () => (clock += 100),
      wait: async () => undefined,
      deadlineMs: 500,
    })) as { ok: boolean; reason: string };

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('WORLD_NEVER_READY');
  });

  it('každý důvod, který prober vrátí, je z uzavřeného seznamu', async () => {
    const { run } = probe({ 'GET /api/health': { status: 500, body: null } });
    const verdict = await run();
    expect(PROBE_FAILURES).toContain(verdict.reason);
  });
});

/* ------------------------------------------------------------------ *
 * Peníze.
 * ------------------------------------------------------------------ */

describe('výchozí režim nemá cestu, kterou by utratil peníze', () => {
  it('bez `--allow-generation` neodejde jediný prompt', async () => {
    const { impl, seen } = stubFetch(healthyTarget());
    const verdict = (await probeWorldstream({
      target: 'http://target.test',
      fetchImpl: impl,
      sharedWorld: '/api/worldstream/snapshots/abc',
    })) as { ok: boolean };

    expect(verdict.ok).toBe(true);
    // Zakládání relace JE volání modelu. Hlídač zapomenutý na produkci
    // s výchozím nastavením proto nesmí mít cestu, kterou by ho spustil.
    expect(seen.some((call) => call.method === 'POST')).toBe(false);
    expect(seen.map((call) => call.path)).toEqual(['/api/health', '/api/worldstream/snapshots/abc']);
  });

  it('bez adresy sdíleného světa zkontroluje jen připravenost, a nic si nevymyslí', async () => {
    const { impl, seen } = stubFetch(healthyTarget());
    const verdict = (await probeWorldstream({ target: 'http://target.test', fetchImpl: impl })) as {
      ok: boolean;
      checks: Record<string, unknown>;
    };

    expect(verdict.ok).toBe(true);
    expect(verdict.checks.sharedWorld).toBeUndefined();
    expect(seen).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Oracle: skutečný proces proti skutečnému serveru.
 * ------------------------------------------------------------------ */

/** Server, který odpovídá z téže tabulky jako stub — jen po drátě. */
function serve(table: Record<string, Reply>): Promise<string> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const reply = table[`${request.method} ${path}`];
    // Tělo se dočte vždycky, jinak klient dostane ECONNRESET místo odpovědi.
    request.resume();
    request.on('end', () => {
      response.writeHead(reply?.status ?? 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply?.body ?? null));
    });
  });
  servers.push(server);
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('the probe server has no port');
      ready(`http://127.0.0.1:${address.port}`);
    });
  });
}

function runCli(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [WATCHDOG, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('exit', (code) => done({ code, stderr }));
  });
}

describe('hlídač jako program', () => {
  it('zdravý cíl: kód 0 a řádek v logu, který nese, co se ověřilo', async () => {
    const target = await serve(healthyTarget());
    const log = join(scratch, `ok-${Date.now()}.jsonl`);

    const { code } = await runCli(['--target', target, '--log', log, '--allow-generation', '--poll-ms', '10']);
    expect(code).toBe(0);

    const raw = readFileSync(log, 'utf8');
    const lines = raw.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.event)).toEqual(['watchdog.started', 'watchdog.ok']);
    expect(lines[1].checks.generation.objects).toBe(2);

    // **Nad syrovým textem, ne nad rozparsovaným objektem.** Tvrzení je „do
    // souboru se to nezapsalo", takže se soudí to, co v souboru doopravdy
    // stojí — jinak by nový průchod, který `sessionId` zapíše o patro jinam,
    // prošel. Stub zakládá `probe-1`, což je v celém řádku jediná hodnota,
    // která by z relace unikla.
    expect(raw).not.toContain('sessionId');
    expect(raw).not.toContain('probe-1');
  });

  /**
   * **Nejen dokumentovaná cesta, ale celá hloubka, kterou `--log` dovoluje.**
   *
   * Mutační kontrola 3. 9. 2026 nechala jednoho přeživšího: zúžení vzoru
   * v `.gitignore` z `ops/**' + '/*.jsonl` na `ops/*.jsonl` nechalo sadu celou
   * zelenou (19/19), protože jediné tvrzení se ptalo na jedinou cestu.
   * `--log` přitom bere cestu libovolnou, takže `ops/logs/w.jsonl` by šel
   * commitnout — a je to týž soubor s cílovou URL a názvy světů. Tvrzení bez
   * hloubky bylo dekorativní, a proto se sem přidala druhá cesta, ne třetí
   * vzor do `.gitignore`.
   */
  it.each([
    ['dokumentovaná cesta', 'ops/worldstream-watchdog.jsonl'],
    ['cesta o patro níž, kterou `--log` taky dovolí', 'ops/logs/w.jsonl'],
  ])('%s je gitignorovaná, ne jen zamýšlená', async (_label, path) => {
    // **Rozhoduje návratový kód, ne vypsaný řádek** (`CLAUDE.md`, past u
    // `/*.md`). Repozitář jde podle `RULES.md` §2 ven a tenhle soubor nese
    // cílovou URL i názvy světů, takže „chtěli jsme ho ignorovat" nestačí.
    const ignored = await new Promise<number | null>((done) => {
      const child = spawn('git', ['check-ignore', '-q', path], {
        cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
        stdio: 'ignore',
      });
      child.on('exit', done);
    });

    expect(ignored).toBe(0);
  });

  it('cíl, který světy nevyrábí: kód 5 a příčina zapsaná jménem', async () => {
    const target = await serve(
      healthyTarget({
        'GET /api/worldstream/sessions/probe-1': { status: 200, body: { phase: 'failed', fault: 'no model' } },
      }),
    );
    const log = join(scratch, `bad-${Date.now()}.jsonl`);

    const { code } = await runCli(['--target', target, '--log', log, '--allow-generation', '--poll-ms', '10']);
    expect(code).toBe(5);

    const last = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1) as string);
    expect(last).toMatchObject({ event: 'watchdog.failed', reason: 'WORLD_FAILED', detail: 'no model' });
  });

  it('nezapisovatelný log shodí hlídače hned na startu, ne až u poruchy', async () => {
    const target = await serve(healthyTarget());
    const { code, stderr } = await runCli([
      '--target',
      target,
      '--log',
      join(scratch, 'neexistuje', 'nikde.jsonl'),
    ]);

    expect(code).toBe(3);
    expect(stderr).toContain('selhal');
  });

  it('bez povinných parametrů skončí kódem 2, ne tichým během', async () => {
    const { code } = await runCli(['--target', 'http://127.0.0.1:1']);
    expect(code).toBe(2);
  });

  it('nečíselná doba skončí kódem 2 a nepošle jediný požadavek', async () => {
    // **Nález nezávislé revize 3. 9. 2026, CONFIRMED spuštěním.** `NaN` udělal
    // z `now() - started >= deadlineMs` výraz, který není nikdy pravda, a
    // z `wait(NaN)` skoro nulovou pauzu: revize naměřila 5000 GETů bez
    // zastavení. Test proto **počítá požadavky** — kód 2 sám o sobě by
    // nerozlišil zastavení od zastavení až po záplavě.
    const target = await serve(healthyTarget());
    const log = join(scratch, `nan-${Date.now()}.jsonl`);

    for (const bad of [
      ['--deadline-ms', 'brzy'],
      ['--poll-ms', 'často'],
      ['--poll-ms', ''],
      ['--deadline-ms', '0'],
      ['--deadline-ms', '-5'],
      // ⚠ **Rozsah, ne jen tvar čísla** — druhá nezávislá revize 3. 9. 2026
      // spustila `--deadline-ms 999999999999` (≈ 31 let) a naměřila 314 GETů
      // za 4 s, tedy tutéž záplavu, kterou první podoba kontroly zavírala.
      // `--poll-ms 0.0001` se vytáčelo na minimu operačního systému.
      ['--deadline-ms', '9e12'],
      ['--deadline-ms', '999999999999'],
      ['--poll-ms', '0.0001'],
      ['--poll-ms', '999999'],
    ]) {
      const { code, stderr } = await runCli(['--target', target, '--log', log, ...bad]);
      expect(code).toBe(2);
      expect(stderr).toContain(bad[0]!);
    }

    // **Log zůstal nezaložený, a to je ten důkaz o požadavcích.** `record()`
    // se volá dřív než kterékoli síťování, takže soubor, který po pěti
    // pokusech neexistuje, znamená, že se běh zastavil před obojím. Přímo
    // počítat GETy by tady bylo slabší tvrzení — záplava vzniká až ve smyčce
    // za tímhle bodem.
    expect(() => readFileSync(log, 'utf8')).toThrow();
  });

  it('holý otisk u --shared míří na tutéž adresu jako tvar s cestou', async () => {
    // Druhá půlka téhož nálezu: návod v hlavičce souboru ukazoval holý otisk,
    // ale `checkSharedWorld` skládá `${target}${address}`, takže dokumentované
    // volání šlo na `https://demo.example5f3a…` a hlásilo poruchu zdravého
    // cíle. Testy do té doby posílaly jen tvar s cestou.
    const target = await serve(healthyTarget());
    const runShared = (shared: string) =>
      runCli(['--target', target, '--log', join(scratch, `sh-${Date.now()}-${shared.length}.jsonl`), '--shared', shared]);

    // Stub obsluhuje jedinou adresu snapshotu, takže obojí musí skončit na ní.
    expect((await runShared('/api/worldstream/snapshots/abc')).code).toBe(0);
    expect((await runShared('abc')).code).toBe(0);
  });
});
