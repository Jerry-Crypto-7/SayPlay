import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Production artifact only: run npm run build before using an external target.
 * The normal Playwright config already builds. This test owns its own next start
 * process and a fresh on-disk store; it never restarts the configured webServer.
 */
const MOVEMENTS = [
  { id: 'drive', control: 'steer', sentence: 'game in a car with shooting and racing' },
  { id: 'glide', control: 'glide', sentence: 'a fish swims through a coral reef' },
  { id: 'walker', control: 'walker', sentence: 'a cat sneaks past guards to steal a fish' },
  { id: 'ball', control: 'ball', sentence: 'a penguin plays football against a walrus' },
] as const;

const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function unusedPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const address = socket.address();
  if (address === null || typeof address === 'string') throw new Error('No local TCP port allocated');
  await new Promise<void>((resolve, reject) => socket.close(error => error === undefined ? resolve() : reject(error)));
  return address.port;
}

async function stopOwned(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
  await stopped;
  clearTimeout(force);
}

async function startOwned(port: number, storeDir: string, logPath: string): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', PLAY_STORE_DIR: storeDir, PLAY_READER: 'off', WORLDSMITH_BRANCH: 'off',
    KV_REST_API_URL: '', KV_REST_API_TOKEN: '', WORLDSMITH_SPEND_STORE_URL: '', WORLDSMITH_SPEND_STORE_TOKEN: '',
    PLAY_FAILURES_DIR: join(storeDir, 'failures') };
  // Presence of VERCEL would intentionally select a volatile store instead.
  delete env.VERCEL;
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(logPath, { flags: 'a' });
  child.stdout?.pipe(log, { end: false }); child.stderr?.pipe(log, { end: false });
  child.once('exit', () => log.end());
  let ready = false, failed: Error | null = null;
  child.stdout?.on('data', data => { if (String(data).includes('Ready in')) ready = true; });
  child.once('error', error => { failed = error; log.end(); });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (failed !== null) throw failed;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Owned next start exited (${child.exitCode ?? child.signalCode}); see ${logPath}`);
    if (ready) {
      const healthy = await fetch(`http://127.0.0.1:${port}/play`, { signal: AbortSignal.timeout(2000) }).then(response => response.ok, () => false);
      if (healthy) return child;
    }
    await pause(200);
  }
  await stopOwned(child);
  throw new Error(`Owned next start did not become ready; see ${logPath}`);
}

async function sceneWins(page: Page, url: string, control: string): Promise<{ runState: string; tick: number }> {
  await page.goto(url);
  const stage = page.getByTestId('arcade-stage');
  await expect(stage).toHaveAttribute('data-control', control, { timeout: 60_000 });
  await expect(stage).toHaveAttribute('data-player-x', /.+/, { timeout: 60_000 });
  await expect(stage.locator('canvas')).toBeVisible();
  await page.waitForFunction(() => window.__playShell !== undefined);
  if (control === 'ball') await page.waitForFunction(() => (window.__playShell as unknown as { physicsReady(): boolean }).physicsReady());
  // Existing ArcadePlay probe replays this published world's real bot inputs.
  const won = await page.evaluate(() => window.__playShell!.playWitness());
  expect(won.runState).toBe('won');
  expect(won.tick).toBeGreaterThan(0);
  return { runState: won.runState, tick: won.tick };
}

test('P41 all native movements publish, play and survive an owned server restart', async ({ page, playwright }, testInfo) => {
  test.setTimeout(300_000);
  const buildId = readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim();
  const storeDir = mkdtempSync(join(tmpdir(), 'p41-movements-store-'));
  mkdirSync(testInfo.outputDir, { recursive: true });
  const logPath = testInfo.outputPath('owned-next.log');
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} ${message.location().url}`); });
  const saved: { id: string; control: string; versionId: string; url: string; spec: unknown; won: { runState: string; tick: number } }[] = [];
  let child: ChildProcess | null = null;
  const pids: number[] = [];
  const api = await playwright.request.newContext({ baseURL: origin });
  try {
    child = await startOwned(port, storeDir, logPath); pids.push(child.pid!);
    for (const movement of MOVEMENTS) {
      const response = await api.post('/api/play/games', { data: { sentence: movement.sentence, seed: 1 } });
      expect(response.status(), await response.text()).toBe(201);
      const published = await response.json() as { versionId: string; url: string };
      const repeated = await api.post('/api/play/games', { data: { sentence: movement.sentence, seed: 1 } });
      expect(repeated.status(), await repeated.text()).toBe(200);
      expect((await repeated.json() as { versionId: string }).versionId).toBe(published.versionId);
      const fetched = await api.get(`/api/play/games/${published.versionId}`);
      expect(fetched.status()).toBe(200);
      const game = await fetched.json() as { spec: { control?: string } };
      expect(game.spec.control).toBe(movement.control);
      const again = await api.get(`/api/play/games/${published.versionId}`);
      expect(again.status()).toBe(200);
      expect((await again.json() as { spec: unknown }).spec).toEqual(game.spec);
      const url = new URL(published.url, origin).href;
      const won = await sceneWins(page, url, movement.control);
      saved.push({ id: movement.id, control: movement.control, versionId: published.versionId, url, spec: game.spec, won });
    }
    await page.goto('about:blank');
    await stopOwned(child); child = null;
    child = await startOwned(port, storeDir, logPath); pids.push(child.pid!);
    expect(pids[1]).not.toBe(pids[0]);
    for (const game of saved) {
      const fetched = await api.get(`/api/play/games/${game.versionId}`);
      expect(fetched.status(), await fetched.text()).toBe(200);
      expect((await fetched.json() as { spec: unknown }).spec).toEqual(game.spec);
      expect(await sceneWins(page, game.url, game.control)).toEqual(game.won);
    }
    expect(errors).toEqual([]);
  } finally {
    if (child !== null) await stopOwned(child);
    await api.dispose();
    await testInfo.attach('movement-restart-evidence', { body: JSON.stringify({ buildId, storeDir, ownedPids: pids, games: saved, errors }, null, 2), contentType: 'application/json' });
    await testInfo.attach('owned-next-log', { path: logPath, contentType: 'text/plain' });
  }
});
