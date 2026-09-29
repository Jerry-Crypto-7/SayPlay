/**
 * Jeden zámek pro těžké kontroly napříč worktree P32 (P32D T1).
 *
 * Tři autopiloty ve třech worktree pouštějí build, Playwright a celou vitest
 * sadu. Souběžně si berou CPU a časové testy padají pod zátěží, ne kvůli
 * regresi (paměť `full-suite-alone-before-push`). Skript pustí příkaz až po
 * získání zámku a vrátí jeho exit code:
 *
 *   node scripts/p32/heavy.mjs -- npx vitest run
 *
 * Zámek je adresář (`mkdir` je atomický i na Windows) se souborem `pid`: první
 * řádek PID držitele, druhý jeho příkaz pro hlášení čekání. Držitel každou
 * šestinu `P32_HEAVY_STALE_MS` obnoví čas souboru. Zámek se převezme, když
 * držitel neběží, nebo když jeho čas zestárl – Windows recykluje PID rychle a
 * cizí proces se stejným číslem by zámek jinak držel donekonečna.
 *
 * Proměnné (testy je přepisují): `P32_HEAVY_LOCK` (výchozí
 * `D:/caches/p32-heavy.lock`), `P32_HEAVY_POLL_MS`, `P32_HEAVY_REPORT_MS`,
 * `P32_HEAVY_STALE_MS`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_LOCK = 'D:/caches/p32-heavy.lock';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Držitel zámku, nebo `null`, když zámek zrovna neexistuje. */
function readOwner(lockDir) {
  const file = join(lockDir, 'pid');
  try {
    const [pid, command = ''] = readFileSync(file, 'utf8').split('\n');
    return { pid: Number(pid), command: command.trim(), heartbeatAt: statSync(file).mtimeMs };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Adresář bez souboru: držitel je mezi `mkdir` a zápisem PID, nebo zámek právě zmizel.
  try {
    return { pid: Number.NaN, command: '', heartbeatAt: statSync(lockDir).mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: proces běží, jen patří jinému uživateli.
    return error.code === 'EPERM';
  }
}

function isStale(owner, staleMs) {
  if (Date.now() - owner.heartbeatAt > staleMs) return true;
  return Number.isInteger(owner.pid) && owner.pid > 0 && !isAlive(owner.pid);
}

/**
 * Smaže mrtvý zámek. Dva čekající můžou mrtvého držitele uvidět naráz; bez
 * strážce by druhý smazal zámek, který si mezitím vzal první.
 */
function takeOver(lockDir, staleMs, log) {
  const guard = `${lockDir}.takeover`;
  try {
    mkdirSync(guard);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Strážce po pádu přesně uprostřed převzetí – po stejné lhůtě jako zámek.
    try {
      if (Date.now() - statSync(guard).mtimeMs > staleMs) rmSync(guard, { recursive: true, force: true });
    } catch {
      // Mezitím zmizel sám.
    }
    return;
  }
  try {
    const owner = readOwner(lockDir);
    if (owner && isStale(owner, staleMs)) {
      rmSync(lockDir, { recursive: true, force: true });
      log(`[p32-heavy] took over a stale lock from PID ${String(owner.pid)} (${owner.command || 'unknown command'})`);
    }
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

/** Příkaz jako jeden řádek pro shell – `npx` je na Windows `.cmd` a bez shellu nejde spustit. */
function commandLine(args) {
  return args
    .map((arg) => {
      if (/^[\w@%+=:,./\\-]+$/.test(arg)) return arg;
      if (process.platform === 'win32') return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
      return `'${arg.replace(/'/g, `'\\''`)}'`;
    })
    .join(' ');
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Na Windows je dítě `cmd.exe`; bez `/T` by build pod ním běžel dál.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

/**
 * Spustí `command` pod zámkem a vrátí jeho exit code (130 po Ctrl+C).
 *
 * @param {string[]} command
 * @param {{ lockDir?: string, pollMs?: number, reportMs?: number, staleMs?: number,
 *   log?: (line: string) => void, signals?: NodeJS.EventEmitter }} [options]
 */
export async function runHeavy(command, options = {}) {
  const {
    lockDir = DEFAULT_LOCK,
    pollMs = 1000,
    reportMs = 60_000,
    staleMs = 180_000,
    log = (line) => process.stderr.write(`${line}\n`),
    signals = process,
  } = options;
  const line = commandLine(command);
  const content = `${String(process.pid)}\n${line}\n${randomUUID()}\n`;
  const pidFile = join(lockDir, 'pid');

  let interrupted = false;
  let child = null;
  const onSignal = () => {
    interrupted = true;
    if (child) stop(child);
  };
  for (const signal of SIGNALS) signals.on(signal, onSignal);

  let held = false;
  let heartbeat = null;
  try {
    mkdirSync(dirname(lockDir), { recursive: true });
    const started = Date.now();
    let reportedAt = Number.NEGATIVE_INFINITY;
    while (!interrupted) {
      try {
        mkdirSync(lockDir);
        writeFileSync(pidFile, content);
        held = true;
        break;
      } catch (error) {
        // EPERM/EACCES: Windows ještě dokončuje smazání předchozího zámku.
        if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      }
      const owner = readOwner(lockDir);
      if (owner && isStale(owner, staleMs)) takeOver(lockDir, staleMs, log);
      else if (owner && Date.now() - reportedAt >= reportMs) {
        const waited = Math.round((Date.now() - started) / 1000);
        log(`[p32-heavy] waiting for ${lockDir} – held by PID ${String(owner.pid)} (${owner.command || 'unknown command'}), ${String(waited)} s so far`);
        reportedAt = Date.now();
      }
      await sleep(pollMs);
    }
    if (!held || interrupted) return 130;

    heartbeat = setInterval(() => {
      const now = new Date();
      try {
        utimesSync(pidFile, now, now);
      } catch {
        // Zámek někdo převzal; příkaz už běží, dokončí se.
      }
    }, staleMs / 6);
    heartbeat.unref();

    return await new Promise((resolve) => {
      child = spawn(line, { stdio: 'inherit', shell: true });
      child.on('error', (error) => {
        log(`[p32-heavy] could not start ${line}: ${error.message}`);
        resolve(1);
      });
      child.on('close', (code, signal) => {
        if (interrupted) resolve(130);
        else if (code !== null) resolve(code);
        else resolve(128 + (constants.signals[signal] ?? 0));
      });
    });
  } finally {
    for (const signal of SIGNALS) signals.off(signal, onSignal);
    if (heartbeat) clearInterval(heartbeat);
    if (held) {
      let mine = false;
      try {
        mine = readFileSync(pidFile, 'utf8') === content;
      } catch {
        // Zámek už neexistuje.
      }
      if (mine) rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const at = process.argv.indexOf('--');
  const command = at === -1 ? [] : process.argv.slice(at + 1);
  if (command.length === 0) {
    process.stderr.write('usage: node scripts/p32/heavy.mjs -- <command…>\n');
    process.exit(2);
  }
  const env = (name) => (process.env[name] ? Number(process.env[name]) : undefined);
  process.exitCode = await runHeavy(command, {
    lockDir: process.env.P32_HEAVY_LOCK || DEFAULT_LOCK,
    pollMs: env('P32_HEAVY_POLL_MS'),
    reportMs: env('P32_HEAVY_REPORT_MS'),
    staleMs: env('P32_HEAVY_STALE_MS'),
  });
}
