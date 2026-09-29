/**
 * Zámek těžkých kontrol P32 (`scripts/p32/heavy.mjs`): tři autopiloty ve třech
 * worktree se nesmí překrýt buildem, Playwrightem ani celou sadou. Zámek, který
 * po pádu zůstane viset, zastaví všechny – proto tu jsou hlavně cesty selhání:
 * mrtvý držitel, spadlý příkaz, Ctrl+C.
 */

import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runHeavy } from '../p32/heavy.mjs';

const SCRIPT = join(__dirname, '..', 'p32', 'heavy.mjs');

// Příkazy pro zámek jdou přes shell (`npx` je na Windows `.cmd`), takže žádné
// `node -e` s uvozovkami a `=>` – cmd.exe by z nich udělal přesměrování.
const CHILD = `const fs = require('fs');
const [mode, a, b] = process.argv.slice(2);
if (mode === 'stamp') {
  fs.appendFileSync(a, 'start ' + Date.now() + '\\n');
  setTimeout(() => fs.appendFileSync(a, 'end ' + Date.now() + '\\n'), Number(b));
} else if (mode === 'write') fs.writeFileSync(a, 'ok');
else if (mode === 'exit') process.exit(Number(a));
else if (mode === 'hang') setTimeout(() => {}, Number(a));
`;

let dir: string;
let lockDir: string;
let child: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'p32-heavy-'));
  lockDir = join(dir, 'heavy.lock');
  child = join(dir, 'child.cjs');
  writeFileSync(child, CHILD);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const node = (...args: string[]): string[] => [process.execPath, child, ...args];

/** Spustí CLI jako samostatný proces; vrátí exit code a stderr. */
function runCli(command: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const cli = spawn(process.execPath, [SCRIPT, '--', ...command], {
      env: { ...process.env, P32_HEAVY_LOCK: lockDir, P32_HEAVY_POLL_MS: '25', ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    cli.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    cli.on('close', (code) => resolve({ code, stderr }));
  });
}

async function waitForLock(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(lockDir, 'pid')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
}

/** PID procesu, který už doběhl. */
function deadPid(): number {
  const pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
}

describe('heavy.mjs lock', () => {
  it('runs two concurrent calls one after the other', async () => {
    const log = join(dir, 'stamps.txt');
    const [a, b] = await Promise.all([runCli(node('stamp', log, '600')), runCli(node('stamp', log, '600'))]);
    expect([a.code, b.code]).toEqual([0, 0]);
    const events = readFileSync(log, 'utf8').trim().split('\n').map((line) => line.split(' ')[0]);
    // Překryv by dal start, start, end, end.
    expect(events).toEqual(['start', 'end', 'start', 'end']);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('takes over a lock whose PID is dead', async () => {
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), `${String(deadPid())}\nnext build\n`);
    const ran = join(dir, 'ran.txt');
    const result = await runCli(node('write', ran));
    expect(result.code).toBe(0);
    expect(existsSync(ran)).toBe(true);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('waits for a live holder, reports the wait, then runs once it lets go', async () => {
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), `${String(process.pid)}\nnpx vitest run\n`);
    const ran = join(dir, 'ran.txt');
    const pending = runCli(node('write', ran), { P32_HEAVY_REPORT_MS: '150' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(existsSync(ran)).toBe(false);
    rmSync(lockDir, { recursive: true, force: true });
    const result = await pending;
    expect(result.code).toBe(0);
    expect(existsSync(ran)).toBe(true);
    // Jedna zpráva hned a pak jednou za interval – ne jedna za každý pokus o zámek.
    const reports = result.stderr.split('\n').filter((line) => line.includes('waiting for'));
    expect(reports.length).toBeGreaterThanOrEqual(2);
    expect(reports.length).toBeLessThan(10);
    expect(reports[0]).toContain(`PID ${String(process.pid)}`);
    expect(reports[0]).toContain('npx vitest run');
  });

  it('takes over a live PID whose heartbeat went stale (PID reused by another process)', async () => {
    mkdirSync(lockDir);
    const pidFile = join(lockDir, 'pid');
    writeFileSync(pidFile, `${String(process.pid)}\nnext build\n`);
    const old = new Date(Date.now() - 10_000);
    utimesSync(pidFile, old, old);
    const result = await runCli(node('exit', '0'), { P32_HEAVY_STALE_MS: '2000' });
    expect(result.code).toBe(0);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('passes the command exit code through and releases the lock after a failing command', async () => {
    const result = await runCli(node('exit', '7'));
    expect(result.code).toBe(7);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('frees the lock for the next call after the holder is killed outright', async () => {
    const holder = spawn(process.execPath, [SCRIPT, '--', ...node('hang', '3000')], {
      env: { ...process.env, P32_HEAVY_LOCK: lockDir },
      stdio: 'ignore',
    });
    await waitForLock();
    expect(readFileSync(join(lockDir, 'pid'), 'utf8').split('\n')[0]).toBe(String(holder.pid));
    // Tvrdé zabití (na Windows TerminateProcess) nepustí žádný úklid – zámek zůstane.
    await new Promise<void>((resolve) => {
      holder.on('close', () => resolve());
      holder.kill('SIGKILL');
    });
    expect(existsSync(lockDir)).toBe(true);
    const result = await runCli(node('exit', '0'));
    expect(result.code).toBe(0);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('on Ctrl+C stops the command, releases the lock and exits 130', async () => {
    const signals = new EventEmitter();
    const started = Date.now();
    const pending = runHeavy(node('hang', '20000'), { lockDir, pollMs: 25, log: () => {}, signals });
    await waitForLock();
    signals.emit('SIGINT');
    await expect(pending).resolves.toBe(130);
    // Příkaz byl zastaven, ne dočkán.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(existsSync(lockDir)).toBe(false);
  });
});
