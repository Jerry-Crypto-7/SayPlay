import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createShim, type ShimOptions } from '../codex-shim.mjs';

/**
 * P16 T6 – most je za tunelem veřejně dosažitelný, nikdo ho nehlídá, drží klíč
 * a spouští proces na předplatném. Testy volají skutečný HTTP server; falešný je
 * jen příkaz codexu (`fake-codex.mjs`), a ten si zapisuje každé spuštění.
 */
const FAKE = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const KEY = 'k'.repeat(40);
const servers: Server[] = [];
const spawnLogs: (() => Spawn[])[] = [];

interface Spawn { pid: number; args: string[]; cwd: string; cwdEntries: number; envKeys: string[]; stdin: string; grandchild?: number }

afterEach(async () => {
  // Rozbitý most (i mutace) by nechal viset falešné procesy napořád – uklidí se tady.
  for (const pid of spawnLogs.splice(0).flatMap((spawns) => spawns().flatMap((spawn) => [spawn.pid, spawn.grandchild ?? 0])))
    if (pid !== 0 && alive(pid)) process.kill(pid);
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function start(mode: string, options: Partial<ShimOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shim-test-'));
  const log = join(dir, 'spawns.jsonl');
  const server = createShim({
    key: KEY, model: 'gpt-6-astra', effort: 'high', runsFile: join(dir, 'runs.json'),
    command: { file: process.execPath, prefix: [FAKE, mode, log] }, log: () => {}, ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const spawns = (): Spawn[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  spawnLogs.push(spawns);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`, spawns };
}

const body = (content = 'a harbor at dusk') => JSON.stringify({
  model: 'claude-opus-5', max_tokens: 10, output_config: { effort: 'low' }, system: 'SYSTEM', messages: [{ role: 'user', content }],
});

function post(url: string, { key = KEY as string | null, payload = body(), signal }: { key?: string | null; payload?: string; signal?: AbortSignal } = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(key === null ? {} : { 'x-api-key': key }) }, body: payload, signal });
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, what: string, ms = 8_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('codex shim', () => {
  it('answers in the Messages format with the pinned model and effort, whatever the body asks for', async () => {
    const shim = await start('ok');
    const response = await post(shim.url);
    expect(response.status).toBe(200);
    const answer = await response.json();
    expect(answer).toMatchObject({ type: 'message', role: 'assistant', model: 'gpt-6-astra', content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 120, output_tokens: 30 } });
    const [spawn] = shim.spawns();
    expect(spawn.args[spawn.args.indexOf('--model') + 1]).toBe('gpt-6-astra');
    expect(spawn.args).toContain('model_reasoning_effort="high"');
    expect(spawn.args.join(' ')).not.toMatch(/claude-opus-5|effort="low"/);
    // Bez nich codex nabízí skriptovacího hostitele a `view_image` (kanárek 15. 9. 2026); platí jen za `exec`.
    for (const feature of ['view_image', 'image_generation', 'code_mode_host'])
      expect(spawn.args.indexOf(`features.${feature}=false`), feature).toBeGreaterThan(spawn.args.indexOf('exec'));
    expect(spawn.stdin).toBe('SYSTEM\n\na harbor at dusk');
    expect(JSON.stringify(spawn), 'the key reached the child').not.toContain(KEY);
  });

  it('refuses to start with a budget or limit that is not a whole number', () => {
    const base = { key: KEY, model: 'gpt-6-astra', effort: 'high', runsFile: join(tmpdir(), 'unused.json') };
    expect(() => createShim({ ...base, dailyRuns: Number('15O') })).toThrow(/dailyRuns/);
    expect(() => createShim({ ...base, maxConcurrent: 0 })).toThrow(/maxConcurrent/);
  });

  it('fails closed with 503 on a damaged run counter and keeps serving', async () => {
    const runsFile = join(mkdtempSync(join(tmpdir(), 'shim-test-')), 'runs.json');
    writeFileSync(runsFile, '{"day":"2026-09-15","ru');
    const shim = await start('ok', { runsFile });
    expect((await post(shim.url)).status).toBe(503);
    expect((await post(shim.url)).status).toBe(503);
    expect(shim.spawns()).toHaveLength(0);
  });

  it('returns the slot when a run ends', async () => {
    const shim = await start('hang', { maxConcurrent: 1, timeoutMs: 1_500 });
    expect((await post(shim.url)).status).toBe(504);
    expect((await post(shim.url)).status, 'the first run kept its slot').toBe(504);
  }, 20_000);

  it('refuses a missing or wrong key with 401 and never starts codex', async () => {
    const shim = await start('ok');
    expect((await post(shim.url, { key: null })).status).toBe(401);
    expect((await post(shim.url, { key: `${KEY}x` })).status).toBe(401);
    expect((await post(shim.url, { key: 'k'.repeat(39) })).status).toBe(401);
    expect(shim.spawns()).toHaveLength(0);
  });

  it('runs codex in an empty scratch directory without the shim key or app secrets in its environment', async () => {
    const shim = await start('ok');
    process.env.CODEX_SHIM_KEY = KEY;
    process.env.WORLDSMITH_MODEL_KEY = 'app-secret';
    try {
      expect((await post(shim.url)).status).toBe(200);
    } finally {
      delete process.env.CODEX_SHIM_KEY;
      delete process.env.WORLDSMITH_MODEL_KEY;
    }
    const [spawn] = shim.spawns();
    expect(spawn.cwdEntries).toBe(0);
    expect(spawn.args[spawn.args.indexOf('--cd') + 1]).not.toBe(process.cwd());
    expect(spawn.envKeys).not.toContain('CODEX_SHIM_KEY');
    expect(spawn.envKeys).not.toContain('WORLDSMITH_MODEL_KEY');
    expect(existsSync(spawn.args[spawn.args.indexOf('--cd') + 1]), 'the scratch directory outlived the run').toBe(false);
  });

  it('rejects a body over 1 MB with 413 and never starts codex', async () => {
    const shim = await start('ok');
    expect((await post(shim.url, { payload: body('x'.repeat(1_100_000)) })).status).toBe(413);
    expect(shim.spawns()).toHaveLength(0);
  });

  it('maps a failing or refusing codex to 502', async () => {
    const failing = await start('fail');
    const failed = await post(failing.url);
    expect(failed.status).toBe(502);
    expect((await failed.json()).error.message).toBe('codex_failed');
    const refusing = await start('rejected');
    const refused = await post(refusing.url);
    expect(refused.status).toBe(502);
    expect((await refused.json()).error.message).toBe('codex_rejected');
  });

  it('stops starting codex once the daily run budget is spent', async () => {
    const shim = await start('ok', { dailyRuns: 1 });
    expect((await post(shim.url)).status).toBe(200);
    const second = await post(shim.url);
    expect(second.status).toBe(429);
    expect((await second.json()).error.message).toBe('SHIM_BUDGET_EXHAUSTED');
    expect(shim.spawns()).toHaveLength(1);
  });

  it('answers 429 while two codex runs are in flight, without burning the daily budget', async () => {
    const shim = await start('hang', { dailyRuns: 2 });
    const callers = [new AbortController(), new AbortController()];
    const pending = callers.map((caller) => post(shim.url, { signal: caller.signal }).catch(() => null));
    await until(() => shim.spawns().length === 2, 'two runs');
    const third = await post(shim.url);
    expect(third.status).toBe(429);
    expect((await third.json()).error.message).toBe('busy');
    for (const caller of callers) caller.abort();
    await Promise.all(pending);
    await until(() => shim.spawns().every((spawn) => !alive(spawn.grandchild!)), 'the trees to die');
    expect(shim.spawns()).toHaveLength(2);
  }, 20_000);

  it('kills the whole codex process tree after the timeout and answers 504', async () => {
    const shim = await start('hang', { timeoutMs: 1_500 });
    const response = await post(shim.url);
    expect(response.status).toBe(504);
    expect((await response.json()).error.message).toBe('codex_timeout');
    const [spawn] = shim.spawns();
    await until(() => !alive(spawn.pid) && !alive(spawn.grandchild!), 'the tree to die');
  }, 20_000);

  it('kills the whole codex process tree when the caller disconnects', async () => {
    const shim = await start('hang');
    const caller = new AbortController();
    const pending = post(shim.url, { signal: caller.signal }).catch(() => null);
    await until(() => shim.spawns().length === 1, 'the run');
    caller.abort();
    await pending;
    const [spawn] = shim.spawns();
    await until(() => !alive(spawn.pid) && !alive(spawn.grandchild!), 'the tree to die');
  }, 20_000);
});
