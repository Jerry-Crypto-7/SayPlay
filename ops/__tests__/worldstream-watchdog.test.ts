/**
 * Oracle úlohy: **hlídač pozná server, který odpovídá a hry nemá.**
 *
 * Nejsilnější tvrzení souboru proto není šťastná cesta, ale kontrolní skupina
 * pod ní: cíl, který na **každý** požadavek odpoví 200 a tělem, které vypadá
 * skoro správně, musí spadnout. Kdyby prošel, byl by tenhle hlídač jen dražší ping.
 *
 * ## Co je tady oracle a co proxy
 *
 * **Oracle** je poslední blok: skutečný proces hlídače, spuštěný přes CLI proti
 * skutečnému HTTP serveru na skutečném portu, a čte se soubor, který zapsal na
 * disk. Nic z toho není napodobenina.
 *
 * **Proxy** jsou bloky nad ním: `probeWorldstream` se stubovaným `fetch`. Jsou
 * tam proto, že cesty selhání se přes skutečný server vyrábějí těžko a bez nich
 * by se měřila jediná větev — ta šťastná.
 */

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error — `.mjs` bez typů, importuje se schválně jako zdroj pravdy.
import { PROBE_FAILURES, probeWorldstream } from '../watchdog/worldstream.mjs';

const WATCHDOG = join(dirname(fileURLToPath(import.meta.url)), '..', 'watchdog', 'worldstream.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'worldstream-watchdog-'));
const servers: Server[] = [];

it('aborts a probe whose health response body never completes', async () => {
  let signal: AbortSignal | undefined;
  const verdict = await probeWorldstream({ target: 'http://127.0.0.1:1', timeoutMs: 15,
    fetchImpl: async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return { status: 200, json: () => new Promise(() => {}) };
    } });
  expect(verdict).toMatchObject({ ok: false, reason: 'PROBE_TIMEOUT' });
  expect(signal?.aborted).toBe(true);
});

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

const GAME = '/api/play/games/abc';

/** Zdravý cíl: health připravený a publikovaná arkádová hra s hratelným světem. */
function healthyTarget(overrides: Record<string, Reply> = {}): Record<string, Reply> {
  return {
    'GET /api/health': { status: 200, body: { ready: true, elapsedMs: 3 } },
    [`GET ${GAME}`]: {
      status: 200,
      body: { version: { versionId: 'abc', title: 'Knight vs Hydra' }, spec: { title: 'Knight vs Hydra' }, blueprint: null, arcade: { bot: {} } },
    },
    ...overrides,
  };
}

/** `fetch`, který odpovídá z tabulky. Zaznamenává, co se ho kdo ptal. */
function stubFetch(table: Record<string, Reply>) {
  const seen: { method: string; path: string }[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname;
    seen.push({ method, path });
    const reply = table[`${method} ${path}`];
    if (reply === undefined) return new Response('null', { status: 404 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, seen };
}

function probe(table: Record<string, Reply>, game: string | null = GAME) {
  const { impl, seen } = stubFetch(table);
  return {
    seen,
    run: () =>
      probeWorldstream({ target: 'http://target.test', fetchImpl: impl, game }) as Promise<{
        ok: boolean;
        reason?: string;
        detail?: string;
        checks: Record<string, unknown>;
      }>,
  };
}

/* ------------------------------------------------------------------ *
 * Šťastná cesta.
 * ------------------------------------------------------------------ */

describe('zdravý cíl projde oběma patry', () => {
  it('health je připravený a hra se dá stáhnout zpátky', async () => {
    const { run, seen } = probe(healthyTarget());
    const verdict = await run();

    expect(verdict.ok).toBe(true);
    expect(verdict.checks.game).toEqual({ address: GAME, title: 'Knight vs Hydra' });
    // Pořadí je součást tvrzení: nezdravý cíl se nemá zatěžovat čtením hry.
    expect(seen.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /api/health', `GET ${GAME}`]);
  });

  it('mřížková hra nese svět v `blueprint`, ne v `arcade`', async () => {
    const { run } = probe(healthyTarget({ [`GET ${GAME}`]: { status: 200, body: { spec: {}, blueprint: { objects: [] } } } }));
    expect((await run()).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Kontrolní skupina — kvůli tomuhle blok existuje.
 * ------------------------------------------------------------------ */

describe('HTTP 200 není oracle živosti', () => {
  it('hra, která přijde s 200 a bez světa, spadne', async () => {
    const { run } = probe(healthyTarget({ [`GET ${GAME}`]: { status: 200, body: { spec: {}, blueprint: null } } }));
    const verdict = await run();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('GAME_UNREADABLE');
  });

  it('cíl, který na všechno odpoví 200 a prázdnem, spadne', async () => {
    const { run } = probe({ 'GET /api/health': { status: 200, body: { ready: true } }, [`GET ${GAME}`]: { status: 200, body: {} } });
    const verdict = await run();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('GAME_UNREADABLE');
  });

  it('hra, která zmizela, je porucha — ne klid', async () => {
    const { run } = probe(healthyTarget({ [`GET ${GAME}`]: { status: 404, body: { error: { code: 'NOT_FOUND' } } } }));
    const verdict = await run();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('GAME_UNREADABLE');
    expect(verdict.detail).toBe('game answered 404');
  });

  it('nepřipravený server se čtením hry vůbec neobtěžuje', async () => {
    const { run, seen } = probe(healthyTarget({ 'GET /api/health': { status: 503, body: { ready: false, reason: 'WRITE_FAILED' } } }));
    const verdict = await run();
    expect(verdict.reason).toBe('HEALTH_NOT_READY');
    expect(seen.map((call) => call.path)).toEqual(['/api/health']);
  });

  it('každý důvod, který prober vrátí, je z uzavřeného seznamu', async () => {
    for (const table of [{ 'GET /api/health': { status: 500, body: null } }, healthyTarget({ [`GET ${GAME}`]: { status: 500, body: null } })]) {
      const verdict = await probe(table).run();
      expect(PROBE_FAILURES).toContain(verdict.reason);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Peníze.
 * ------------------------------------------------------------------ */

describe('hlídač nic netvoří', () => {
  it('neodejde jediný POST – nová hra by na nasazení s klíčem spustila placenou AI verzi', async () => {
    const { run, seen } = probe(healthyTarget());
    expect((await run()).ok).toBe(true);
    expect(seen.some((call) => call.method !== 'GET')).toBe(false);
  });

  it('bez hry zkontroluje jen připravenost, a nic si nevymyslí', async () => {
    const { run, seen } = probe(healthyTarget(), null);
    const verdict = await run();
    expect(verdict.ok).toBe(true);
    expect(verdict.checks.game).toBeUndefined();
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
  it('zdravý cíl bez parametrů: kód 0 a řádek v logu, který nese, co se ověřilo', async () => {
    const target = await serve(healthyTarget());
    const log = join(scratch, `ok-${Date.now()}.jsonl`);

    const { code } = await runCli(['--target', target, '--log', log]);
    expect(code).toBe(0);

    const lines = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.event)).toEqual(['watchdog.started', 'watchdog.ok']);
    expect(lines[1].checks.health.ready).toBe(true);
  });

  /**
   * **Nejen dokumentovaná cesta, ale celá hloubka, kterou `--log` dovoluje.**
   *
   * Mutační kontrola 3. 9. 2026 nechala jednoho přeživšího: zúžení vzoru
   * v `.gitignore` z `ops/**' + '/*.jsonl` na `ops/*.jsonl` nechalo sadu celou
   * zelenou, protože jediné tvrzení se ptalo na jedinou cestu. `--log` přitom
   * bere cestu libovolnou, takže `ops/logs/w.jsonl` by šel commitnout — a je to
   * týž soubor s cílovou URL a názvy her.
   */
  it.each([
    ['dokumentovaná cesta', 'ops/worldstream-watchdog.jsonl'],
    ['cesta o patro níž, kterou `--log` taky dovolí', 'ops/logs/w.jsonl'],
  ])('%s je gitignorovaná, ne jen zamýšlená', async (_label, path) => {
    // **Rozhoduje návratový kód, ne vypsaný řádek.** Repozitář jde podle
    // `RULES.md` §2 ven a tenhle soubor nese cílovou URL i názvy her.
    const ignored = await new Promise<number | null>((done) => {
      const child = spawn('git', ['check-ignore', '-q', path], {
        cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
        stdio: 'ignore',
      });
      child.on('exit', done);
    });

    expect(ignored).toBe(0);
  });

  it('cíl, který hru nemá: kód 5 a příčina zapsaná jménem', async () => {
    const target = await serve(healthyTarget({ [`GET ${GAME}`]: { status: 404, body: null } }));
    const log = join(scratch, `bad-${Date.now()}.jsonl`);

    const { code } = await runCli(['--target', target, '--log', log, '--game', 'abc']);
    expect(code).toBe(5);

    const last = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1) as string);
    expect(last).toMatchObject({ event: 'watchdog.failed', reason: 'GAME_UNREADABLE', detail: 'game answered 404' });
  });

  it('nezapisovatelný log shodí hlídače hned na startu, ne až u poruchy', async () => {
    const target = await serve(healthyTarget());
    const { code, stderr } = await runCli(['--target', target, '--log', join(scratch, 'neexistuje', 'nikde.jsonl')]);

    expect(code).toBe(3);
    expect(stderr).toContain('selhal');
  });

  it('bez povinných parametrů skončí kódem 2, ne tichým během', async () => {
    const { code } = await runCli(['--target', 'http://127.0.0.1:1']);
    expect(code).toBe(2);
  });

  it('strop mimo rozsah skončí kódem 2 a nesáhne na log ani na síť', async () => {
    const target = await serve(healthyTarget());
    const log = join(scratch, `nan-${Date.now()}.jsonl`);

    for (const bad of ['brzy', '', '0', '-5', '9e12']) {
      const { code, stderr } = await runCli(['--target', target, '--log', log, '--timeout-ms', bad]);
      expect(code).toBe(2);
      expect(stderr).toContain('--timeout-ms');
    }
    // `record()` se volá dřív než kterékoli síťování, takže nezaložený log znamená, že se běh zastavil před obojím.
    expect(() => readFileSync(log, 'utf8')).toThrow();
  });

  it('holé id u --game míří na tutéž adresu jako tvar s cestou', async () => {
    const target = await serve(healthyTarget());
    const runGame = (game: string) => runCli(['--target', target, '--log', join(scratch, `g-${Date.now()}-${game.length}.jsonl`), '--game', game]);

    // Stub obsluhuje jedinou adresu hry, takže obojí musí skončit na ní.
    expect((await runGame(GAME)).code).toBe(0);
    expect((await runGame('abc')).code).toBe(0);
  });
});
