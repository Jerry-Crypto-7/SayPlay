/**
 * Oracle úlohy: **hlídaný proces se doopravdy zabije a watchdog to zaznamená.**
 *
 * Nic z toho není napodobenina. Spustí se skutečný potomek, skutečný watchdog
 * jako druhý proces, potomek se zabije signálem a čte se soubor, který watchdog
 * na disk zapsal. „`process.kill` byl zavolán" by byl proxy; tohle je oracle.
 *
 * ## Poslední test je ten, kvůli kterému soubor existuje
 *
 * `hlídač uvnitř hlídaného procesu nezaznamená vlastní smrt` je kontrolní
 * skupina. Bez ní by první test prošel i nad in-process hlídačem — a přesně to
 * je vada, kterou má AC vyloučit. S ní je rozdíl mezi oběma návrhy **měřený**,
 * ne tvrzený: tentýž způsob zabití, tentýž soubor, jednou záznam a podruhé nic.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

const WATCHDOG = join(process.cwd(), 'ops', 'watchdog', 'watchdog.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'watchdog-test-'));
const spawned: ChildProcess[] = [];

afterEach(() => {
  for (const child of spawned.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function track(child: ChildProcess): ChildProcess {
  spawned.push(child);
  return child;
}

/** Potomek, který nic nedělá a sám od sebe neskončí. */
function idleProcess(): ChildProcess {
  return track(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
}

/** Řádkový JSON, který watchdog zatím zapsal. */
function records(logPath: string): Array<Record<string, unknown>> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Počká, až v logu je záznam splňující podmínku. Vrátí `null` po vypršení. */
async function waitForRecord(
  logPath: string,
  matches: (record: Record<string, unknown>) => boolean,
  timeoutMs = 15_000,
): Promise<Record<string, unknown> | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const found = records(logPath).find(matches);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

describe('watchdog', () => {
  it('zabitý hlídaný proces se zaznamená — hlídač ho přežije', async () => {
    const logPath = join(scratch, 'gone.jsonl');
    const watched = idleProcess();

    const watchdog = track(
      spawn(process.execPath, [WATCHDOG, '--pid', String(watched.pid), '--log', logPath, '--interval-ms', '50'], {
        stdio: 'ignore',
      }),
    );

    expect(await waitForRecord(logPath, (record) => record.event === 'watching')).not.toBeNull();

    watched.kill('SIGKILL');

    const gone = await waitForRecord(logPath, (record) => record.event === 'process-gone');
    expect(gone).not.toBeNull();
    expect(gone).toMatchObject({ pid: watched.pid, detected: 'while-watching' });

    // Watchdog byl v okamžiku zápisu naživu — což je totéž jako říct, že
    // neběžel uvnitř toho, co hlídal.
    expect(watchdog.exitCode === null || watchdog.exitCode === 0).toBe(true);
  }, 30_000);

  it('hlídač uvnitř hlídaného procesu nezaznamená vlastní smrt', async () => {
    // Kontrolní skupina, ne ozdoba. Tentýž způsob zabití, tentýž tvar zápisu —
    // jen hlídač bydlí uvnitř. Kdyby tenhle test nebyl, prošel by ten první i
    // nad návrhem, který AC vylučuje.
    const logPath = join(scratch, 'in-process.jsonl');
    const inProcess = track(
      spawn(
        process.execPath,
        [
          '-e',
          `const {appendFileSync}=require('node:fs');` +
            `setInterval(()=>{try{process.kill(process.pid,0)}catch{appendFileSync(${JSON.stringify(logPath)},'{"event":"process-gone"}\\n')}},50);`,
        ],
        { stdio: 'ignore' },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    inProcess.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(records(logPath)).toEqual([]);
  }, 30_000);

  it('proces, který byl mrtvý už při startu, se zaznamená taky', async () => {
    const logPath = join(scratch, 'already.jsonl');
    const watched = idleProcess();
    const pid = watched.pid;
    watched.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 500));

    track(
      spawn(process.execPath, [WATCHDOG, '--pid', String(pid), '--log', logPath, '--interval-ms', '50'], {
        stdio: 'ignore',
      }),
    );

    const gone = await waitForRecord(logPath, (record) => record.event === 'process-gone');
    expect(gone).toMatchObject({ detected: 'at-start' });
  }, 30_000);

  it('watchdog se sám ukončí, když hlídaný proces žije dál', async () => {
    // Bez tohohle by každý spuštěný watchdog přežil svůj běh a hromadily by se.
    const logPath = join(scratch, 'gave-up.jsonl');
    const watched = idleProcess();

    track(
      spawn(
        process.execPath,
        [WATCHDOG, '--pid', String(watched.pid), '--log', logPath, '--interval-ms', '50', '--max-ms', '200'],
        { stdio: 'ignore' },
      ),
    );

    expect(await waitForRecord(logPath, (record) => record.event === 'gave-up')).not.toBeNull();
    expect(records(logPath).some((record) => record.event === 'process-gone')).toBe(false);
  }, 30_000);

  it('bez povinných parametrů skončí chybou, ne tichým během naprázdno', async () => {
    const code = await new Promise<number | null>((resolve) => {
      const child = track(spawn(process.execPath, [WATCHDOG, '--log', join(scratch, 'x.jsonl')], { stdio: 'ignore' }));
      child.on('exit', resolve);
    });

    expect(code).toBe(2);
  }, 30_000);
});
