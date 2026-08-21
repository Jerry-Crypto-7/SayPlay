/**
 * Mapování výsledků řetězu na stavové kódy.
 *
 * Kontrakt samotného řetězu (pořadí článků, účtování, obě větve) drží
 * `src/server/__tests__/pipeline.test.ts`. Tady se testuje jen to, co přidává
 * HTTP vrstva — a co by jinak nikdo neověřil, protože rozdíl mezi 404 a 502 se
 * v žádném jiném testu neprojeví.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { frozenPrompts } from '../../../../model/client';

const promptsRead = frozenPrompts();
if (!promptsRead.ok) throw new Error(`frozen prompts unreadable: ${promptsRead.detail}`);
const FROZEN_CREATE = promptsRead.value.find((record) => record.kind === 'create');
if (FROZEN_CREATE === undefined) throw new Error('the frozen corpus carries no create prompt');

const temporary: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ResponseBody {
  readonly requestId: string;
  readonly branch?: string;
  readonly emission?: unknown;
  readonly costUsd?: number;
  readonly error?: { readonly code: string; readonly message: string; readonly category?: string };
}

/**
 * Načte routu nad daným prostředím.
 *
 * Strop si routa drží jako stav procesu, takže se modul musí načíst až po
 * prostředí — a **jedno načtení je jedna instance stropu**. Test, který chce
 * ověřit hromadění útraty přes víc požadavků, proto volá `POST` z jednoho
 * načtení opakovaně, ne `post()` dvakrát.
 */
async function loadRoute(env: Record<string, string> = {}) {
  // Každé načtení začíná od čistého prostředí, jinak by druhé v jednom testu
  // zdědilo nastavení prvního a tvrdilo něco jiného, než co se měří.
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  const { POST } = await import('../route');
  return async (body: string) => {
    const response = await POST(new Request('http://127.0.0.1/api/generate', { method: 'POST', body }));
    return { status: response.status, json: (await response.json()) as ResponseBody };
  };
}

async function post(body: string, env: Record<string, string> = {}) {
  return (await loadRoute(env))(body);
}

function controlFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'worldsmith-route-'));
  temporary.push(dir);
  const path = join(dir, 'spend-cap.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('POST /api/generate', () => {
  it('vydá emisi z offline větve, když prostředí neříká jinak', async () => {
    const { status, json } = await post(JSON.stringify({ prompt: FROZEN_CREATE.prompt }));
    expect(status).toBe(200);
    expect(json.branch).toBe('mock');
    expect(typeof json.emission).toBe('object');
    expect(json.costUsd).toBe(0);
  });

  it('prompt mimo zmrazený korpus je 404, ne chyba serveru', async () => {
    // Poctivé „na tohle odpověď nemám". Fallback z P2 se věší sem, ne dovnitř
    // generování.
    const { status, json } = await post(JSON.stringify({ prompt: 'svět, na který záznam nikdy nebyl' }));
    expect(status).toBe(404);
    expect(json.error?.code).toBe('NO_SOURCE');
  });

  it('odmítnutý prompt je 400, ne 500', async () => {
    const { status, json } = await post(JSON.stringify({ prompt: '   ' }));
    expect(status).toBe(400);
    expect(json.error?.code).toBe('PROMPT_REFUSED');
    expect(json.error?.category).toBe('EMPTY');
  });

  it('chybějící pole prompt je taky odmítnutí, ne pád', async () => {
    const { status, json } = await post(JSON.stringify({}));
    expect(status).toBe(400);
    expect(json.error?.category).toBe('NOT_TEXT');
  });

  it('tělo, které není JSON, je 400', async () => {
    const { status, json } = await post('{ tohle není JSON');
    expect(status).toBe(400);
    expect(json.error?.code).toBe('MALFORMED_BODY');
  });

  it('vyčerpaný rozpočet je 429 a nikam se nevolá', async () => {
    // Koncový bod je nedosažitelná adresa schválně: kdyby strop odmítal až po
    // volání, spadlo by to na DNS a test by prošel z jiného důvodu.
    const { status, json } = await post(JSON.stringify({ prompt: 'bludiště s klíčem' }), {
      WORLDSMITH_BRANCH: 'live',
      WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
      WORLDSMITH_MODEL_KEY: 'test-key',
      WORLDSMITH_USD_PER_MTOK_OUT: '15',
      WORLDSMITH_SPEND_CAP_USD: '0',
    });
    expect(status).toBe(429);
    expect(json.error?.code).toBe('CAP_EXHAUSTED');
  });

  it('útrata se sčítá přes požadavky — strop je stav procesu, ne požadavku', async () => {
    // Strop, který se rodí s každým požadavkem, je dekorace: první volání by ho
    // nikdy nevyčerpalo a další by o něm nevědělo. Rozpočet je proto nastavený
    // přesně na jedno volání.
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        Response.json({ content: [{ type: 'text', text: '{"emitted":true}' }], usage: { input_tokens: 100, output_tokens: 200 } }),
      ),
    );

    const call = await loadRoute({
      WORLDSMITH_BRANCH: 'live',
      WORLDSMITH_MODEL_ENDPOINT: 'https://upstream.invalid/v1/messages',
      WORLDSMITH_MODEL_KEY: 'test-key',
      WORLDSMITH_USD_PER_MTOK_OUT: '15',
      // Výslovná nula, protože připíchnutých 0,12 USD níž má znamenat PŘESNĚ
      // jeden nejhorší případ. Nevyplněná cena vstupu se od 21. 8. 2026
      // dopočítá z ceny výstupu (dřív byla nula), takže bez tohohle řádku by
      // rezervace zahrnula i ~3000 vstupních tokenů a odmítla už první volání.
      WORLDSMITH_USD_PER_MTOK_IN: '0',
      WORLDSMITH_MAX_OUTPUT_TOKENS: '8000',
      // 8000 tokenů × 15 USD/Mtok = 0,12 USD, tedy přesně jeden nejhorší případ.
      WORLDSMITH_SPEND_CAP_USD: '0.12',
    });

    const first = await call(JSON.stringify({ prompt: 'bludiště s klíčem' }));
    expect(first.status).toBe(200);

    const second = await call(JSON.stringify({ prompt: 'bludiště s klíčem' }));
    expect(second.status).toBe(429);
    expect(second.json.error?.code).toBe('CAP_EXHAUSTED');
  });

  it('rozbitý vypínač je 503, ne tichý průchod bez stropu', async () => {
    const { status, json } = await post(JSON.stringify({ prompt: FROZEN_CREATE.prompt }), {
      WORLDSMITH_SPEND_CAP_FILE: controlFile('{ rozbito'),
    });
    expect(status).toBe(503);
    expect(json.error?.code).toBe('CONTROL_UNREADABLE');
  });

  it('živá větev bez konfigurace je 503, a offline větev tím netrpí', async () => {
    const unconfigured = await post(JSON.stringify({ prompt: FROZEN_CREATE.prompt }), {
      WORLDSMITH_BRANCH: 'live',
    });
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.json.error?.code).toBe('BRANCH_UNCONFIGURED');

    const offline = await post(JSON.stringify({ prompt: FROZEN_CREATE.prompt }));
    expect(offline.status).toBe(200);
  });

  it('každá odpověď nese korelační ID', async () => {
    const ok = await post(JSON.stringify({ prompt: FROZEN_CREATE.prompt }));
    const bad = await post(JSON.stringify({ prompt: '' }));
    expect(typeof ok.json.requestId).toBe('string');
    expect(typeof bad.json.requestId).toBe('string');
    expect(ok.json.requestId).not.toBe(bad.json.requestId);
  });
});
