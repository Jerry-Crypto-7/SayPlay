import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requestStage } from '../src/model/worldstream-prompt';

/**
 * **Živá větev nad falešným poskytovatelem** – sdílené mezi specy, které
 * potřebují prohnat fixturu skutečnou routou `POST /api/worldstream/sessions`
 * a jejími branami, ne ji podstrčit přes `page.route`.
 *
 * Vzniklo přesunem z `worldstream-session.spec.ts` (P16 T6), kde tyhle tři
 * funkce bydlely; `look-binding.spec.ts` (P22 T12) je druhý volající a kopie
 * by se rozešla při první změně proměnných prostředí.
 */

/** Volný port: krátce se na něm poslouchá a zase pustí. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
}

export interface FixtureAnswers {
  readonly planner: Record<string, unknown>;
  readonly compiler: Record<string, unknown>;
}

/**
 * Falešný poskytovatel ve formátu Anthropic Messages, který odpovídá
 * z fixtury a **počítá volání**. Odpověď vybírá podle fáze požadavku
 * (`requestStage`), ne podle pořadí – dvě relace by jinak sdílely čítač.
 */
export function fakeUpstream(answers: FixtureAnswers): { readonly server: Server; readonly calls: () => number } {
  let calls = 0;
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    request.on('end', () => {
      calls += 1;
      const body = JSON.parse(raw) as { model: string; system: string; messages: { content: string }[] };
      const stage = requestStage({ model: body.model, system: body.system, user: body.messages[0].content });
      const answer = stage === 'planner' ? answers.planner : answers.compiler;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify(answer) }],
        usage: { input_tokens: 1_000, output_tokens: 2_000 },
        stop_reason: 'end_turn',
      }));
    });
  });
  return { server, calls: () => calls };
}

/**
 * Druhý `next start` nad týmž buildem, s živou větví namířenou na falešného
 * poskytovatele. Hlavní server z `playwright.config.ts` běží bez klíče
 * (`cloudEmitter()` → `null`), takže se cache odpovědí u něj vůbec nezeptá;
 * tenhle proces je jediná cesta, jak ji doopravdy prohnat routou.
 *
 * `VERCEL_ENV=production` bez `VERCEL` dá knihu stropu v paměti procesu
 * (`.env.example` u `WORLDSMITH_SPEND_STORE_URL`), tedy strop, který platí
 * a nic sdíleného nepotřebuje. Cena je nastavená tak, aby dvě volání stála
 * zlomek stropu a odmítnutí nebylo příčinou ničeho, co se tu měří.
 */
export async function startLiveServer(upstreamPort: number): Promise<{ readonly url: string; stop(): void }> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORLDSMITH_MODEL_ENDPOINT: `http://127.0.0.1:${String(upstreamPort)}/v1/messages`,
    WORLDSMITH_MODEL_KEY: 'e2e-fake-upstream',
    WORLDSMITH_MODEL_PROFILE: 'api',
    WORLDSMITH_MODEL: 'e2e-fixture-model',
    WORLDSMITH_USD_PER_MTOK_IN: '1',
    WORLDSMITH_USD_PER_MTOK_OUT: '1',
    WORLDSMITH_SPEND_CAP_USD: '5',
    WORLDSMITH_ANSWER_CACHE: '',
    WORLDSMITH_SPEND_STORE_URL: '',
    WORLDSMITH_SPEND_STORE_TOKEN: '',
    KV_REST_API_URL: '',
    KV_REST_API_TOKEN: '',
    VERCEL_ENV: 'production',
    // Bez Upstash by sdílel `data/play/store` (P40 T3) s hlavním serverem.
    PLAY_STORE_DIR: mkdtempSync(join(tmpdir(), 'play-store-live-')),
  };
  delete env.VERCEL;
  // Playwright překládá spec do CJS, takže `import.meta.url` tu není; cesta
  // jde od kořene repozitáře, odkud se `playwright test` spouští.
  const nextBin = join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
  const child: ChildProcess = spawn(process.execPath, [nextBin, 'start', '--port', String(port), '--hostname', '127.0.0.1'], {
    env,
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  const url = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next start exited early:\n${output}`);
    try {
      const probe = await fetch(`${url}/api/build-id`);
      if (probe.ok) break;
    } catch {
      // Ještě neposlouchá.
    }
    if (Date.now() > deadline) throw new Error(`next start did not come up in time:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    url,
    stop() {
      // Podle PID, nikdy podle jména – a se stromem, protože `next start`
      // na Windows drží pod sebou vlastní pracovní proces.
      if (process.platform === 'win32' && child.pid !== undefined) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      else child.kill('SIGTERM');
    },
  };
}
