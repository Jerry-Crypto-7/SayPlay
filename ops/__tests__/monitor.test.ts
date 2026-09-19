/**
 * Oracle úlohy: **hlídač dostupnosti zapíše řádek, který `scripts/submission-check.mjs`
 * kontrola [7] umí přečíst, a selhání cíle zapíše místo toho, aby spadl.**
 *
 * Všechno tady je skutečný proces `ops/monitoring/monitor.mjs` spuštěný přes
 * CLI proti skutečným HTTP serverům na lokálních portech; čte se soubor, který
 * zapsal na disk. Nic není stubované — hlídač poběží bez dozoru a jediné, co
 * po něm zbude, je ten soubor.
 *
 * Nejsilnější tvrzení není šťastná cesta, ale dva vadné cíle vedle ní: server,
 * který odpoví 500, a port, na kterém nikdo neposlouchá. Oba musí skončit
 * v řádku jako `ok:false`. Kdyby hlídač při chybě řádek zahodil, kontrola [7]
 * by viděla stárnoucí heartbeat a hlásila by „hlídač neběží" — což je pravda
 * o něčem jiném, než co se stalo.
 */

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

const MONITOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'monitoring', 'monitor.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'uptime-monitor-'));
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Lokální cíl, který odpovídá pevným stavovým kódem. */
async function serve(status: number): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'text/plain' });
    response.end(status === 200 ? 'ok' : 'broken');
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/`;
}

/** Port, který se otevřel a hned zavřel — nikdo na něm neposlouchá. */
async function closedPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return `http://127.0.0.1:${port}/`;
}

interface Config {
  readonly targets: ReadonlyArray<{ name: string; url: string }>;
  readonly intervalSeconds: number;
  readonly heartbeatPath: string;
}

function writeConfig(name: string, config: Config): string {
  const path = join(scratch, `${name}.json`);
  writeFileSync(path, JSON.stringify(config), 'utf-8');
  return path;
}

function runCli(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [MONITOR, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('exit', (code) => done({ code, stderr }));
  });
}

function readLines(path: string): Array<{ at: string; targets: Array<{ url: string; status: number | null; ms: number; ok: boolean }> }> {
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('monitor.mjs --once', () => {
  it('writes one line naming all three targets with status, ms and ok', async () => {
    const healthy = await serve(200);
    const broken = await serve(500);
    const dead = await closedPort();
    const heartbeat = join(scratch, `all-${Date.now()}.jsonl`);
    const config = writeConfig('all', {
      targets: [
        { name: 'repository', url: healthy },
        { name: 'demo', url: broken },
        { name: 'backend', url: dead },
      ],
      intervalSeconds: 300,
      heartbeatPath: heartbeat,
    });

    const { code, stderr } = await runCli(['--once', '--config', config]);
    expect(stderr).toBe('');
    expect(code).toBe(0);

    const lines = readLines(heartbeat);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(Number.isFinite(Date.parse(line.at))).toBe(true);
    expect(line.targets.map((target) => target.url)).toEqual([healthy, broken, dead]);
    for (const target of line.targets) {
      expect(typeof target.ms).toBe('number');
      expect(target.ms).toBeGreaterThanOrEqual(0);
    }
    expect(line.targets[0]).toMatchObject({ status: 200, ok: true });
  });

  it('target failure is recorded: a 500 and an unreachable port both land as ok:false', async () => {
    const broken = await serve(500);
    const dead = await closedPort();
    const heartbeat = join(scratch, `down-${Date.now()}.jsonl`);
    const config = writeConfig('down', {
      targets: [
        { name: 'demo', url: broken },
        { name: 'backend', url: dead },
      ],
      intervalSeconds: 300,
      heartbeatPath: heartbeat,
    });

    const { code } = await runCli(['--once', '--config', config]);
    expect(code).toBe(0);

    const [line] = readLines(heartbeat);
    expect(line.targets).toHaveLength(2);
    expect(line.targets[0]).toMatchObject({ url: broken, status: 500, ok: false });
    expect(line.targets[1]).toMatchObject({ url: dead, status: null, ok: false });
  });

  it('appends: a second run adds a second line and keeps the first', async () => {
    const healthy = await serve(200);
    const heartbeat = join(scratch, `append-${Date.now()}.jsonl`);
    const config = writeConfig('append', {
      targets: [{ name: 'demo', url: healthy }],
      intervalSeconds: 300,
      heartbeatPath: heartbeat,
    });

    await runCli(['--once', '--config', config]);
    await runCli(['--once', '--config', config]);

    expect(readLines(heartbeat)).toHaveLength(2);
  });

  it('missing config: exit 2 and a message on stderr', async () => {
    const { code, stderr } = await runCli(['--once', '--config', join(scratch, 'does-not-exist.json')]);
    expect(code).toBe(2);
    expect(stderr).toContain('does-not-exist.json');
  });

  it('unreadable config: invalid JSON is exit 2, not a stack trace', async () => {
    const path = join(scratch, 'garbage.json');
    writeFileSync(path, '{ "targets": [', 'utf-8');
    const { code, stderr } = await runCli(['--once', '--config', path]);
    expect(code).toBe(2);
    expect(stderr).toContain('garbage.json');
    expect(stderr).not.toContain('    at ');
  });
});

describe('monitor.mjs --loop', () => {
  it('keeps writing a line per interval until killed', async () => {
    const healthy = await serve(200);
    const heartbeat = join(scratch, `loop-${Date.now()}.jsonl`);
    const config = writeConfig('loop', {
      targets: [{ name: 'demo', url: healthy }],
      intervalSeconds: 0.2,
      heartbeatPath: heartbeat,
    });

    const child = spawn(process.execPath, [MONITOR, '--loop', '--config', config], { stdio: 'ignore' });
    const exited = new Promise<void>((done) => child.on('exit', () => done()));
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        await new Promise((tick) => setTimeout(tick, 100));
        try {
          if (readLines(heartbeat).length >= 3) break;
        } catch {
          // Soubor ještě nevznikl — první řádek teprve přijde.
        }
      }
    } finally {
      child.kill();
      await exited;
    }

    expect(readLines(heartbeat).length).toBeGreaterThanOrEqual(3);
  });
});

it('the heartbeat path from the real config is gitignored — the repo goes public', async () => {
  const ignored = await new Promise<number | null>((done) => {
    const child = spawn('git', ['check-ignore', '-q', 'ops/monitoring/heartbeat.jsonl'], {
      cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
      stdio: 'ignore',
    });
    child.on('exit', done);
  });
  expect(ignored).toBe(0);
});
