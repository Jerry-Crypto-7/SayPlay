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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

// Odvozeno od TOHOHLE souboru, ne od `process.cwd()`. Pracovní adresář je
// vlastnost spuštění, ne repozitáře — test by se rozpadl, jakmile ho někdo
// pustí odjinud než z kořene.
const WATCHDOG = join(dirname(fileURLToPath(import.meta.url)), '..', 'watchdog', 'watchdog.mjs');
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

/** Spustí watchdog a počká na jeho konec. Vrátí návratový kód a `stderr`. */
async function runWatchdog(args: string[]): Promise<{ code: number | null; stderr: string }> {
  const child = track(spawn(process.execPath, [WATCHDOG, ...args], { stdio: ['ignore', 'ignore', 'pipe'] }));
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')));
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { code, stderr };
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
    //
    // **Nejdřív se ale prokáže, že se hlídač vůbec rozběhl.** Bez toho tvrdí
    // prázdný log jen to, že se něco nestalo — a stejně prázdný by byl, kdyby
    // dítě spadlo na syntaktické chybě. Recenze to změřila: se záměrně rozbitým
    // zdrojem dítěte procházel celý soubor zeleně, takže aserce nehlídala nic.
    const logPath = join(scratch, 'in-process.jsonl');
    // Konec řádku se skládá přes `String.fromCharCode(10)`, ne zpětným lomítkem.
    // Zdroj dítěte prochází šablonovým řetězcem TypeScriptu, který escape sekvenci
    // rozvine — a z konce řádku se tak stane skutečný nový řádek uprostřed
    // řetězce dítěte, tedy syntaktická chyba. Přesně to ticho, které tenhle test
    // má vyloučit, a přesně na tom se tenhle test poprvé zasekl.
    const NL = 'String.fromCharCode(10)';
    const write = (event: string): string =>
      `appendFileSync(log, JSON.stringify({event:${JSON.stringify(event)}}) + ${NL});`;
    const source =
      `const {appendFileSync}=require('node:fs');` +
      `const log=${JSON.stringify(logPath)};` +
      write('in-process-started') +
      `setInterval(()=>{try{process.kill(process.pid,0)}catch{${write('process-gone')}}},50);`;

    const inProcess = track(spawn(process.execPath, ['-e', source], { stdio: 'ignore' }));

    const started = await waitForRecord(logPath, (record) => record.event === 'in-process-started');
    expect(started, 'in-process hlídač se vůbec nerozběhl — test by pak netvrdil nic').not.toBeNull();

    inProcess.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(records(logPath).some((record) => record.event === 'process-gone')).toBe(false);
  }, 30_000);

  it('proces, který byl mrtvý už při startu, se zaznamená taky', async () => {
    const logPath = join(scratch, 'already.jsonl');
    // Dítě skončí samo a čeká se na jeho `exit`, ne na pevný spánek. Pevný
    // spánek je závod se strojem; událost je fakt.
    const watched = idleProcess();
    const pid = watched.pid;
    watched.kill('SIGKILL');
    await new Promise((resolve) => watched.on('exit', resolve));

    track(
      spawn(process.execPath, [WATCHDOG, '--pid', String(pid), '--log', logPath, '--interval-ms', '50'], {
        stdio: 'ignore',
      }),
    );

    const gone = await waitForRecord(logPath, (record) => record.event === 'process-gone');
    expect(gone).toMatchObject({ detected: 'at-start' });
    // `watching` se zapisuje jako první vždycky — je to zároveň kontrola, že do
    // logu jde zapsat. Bez ní by se nezapisovatelná cesta projevila až u poruchy.
    expect(records(logPath)[0]).toMatchObject({ event: 'watching' });
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

  it('chráněný proces se počítá jako živý, ne jako mrtvý', async () => {
    // PID 4 je systémový proces Windows: existuje, ale `OpenProcess` na něj
    // běžný účet nedostane. Naměřeno: `process.kill(4, 0)` hlásí `EPERM`. Kdyby
    // watchdog odepřený přístup četl jako smrt, ohlásil by pád procesu, který
    // se má dobře — a to je celá třída falešných poplachů u nasazení, kde
    // watchdog běží pod jiným uživatelem než hlídaná služba.
    const logPath = join(scratch, 'chraneny.jsonl');
    track(
      spawn(
        process.execPath,
        [WATCHDOG, '--pid', '4', '--log', logPath, '--interval-ms', '50', '--max-ms', '300'],
        { stdio: 'ignore' },
      ),
    );

    expect(await waitForRecord(logPath, (record) => record.event === 'gave-up')).not.toBeNull();
    expect(records(logPath).some((record) => record.event === 'process-gone')).toBe(false);
  }, 30_000);

  it('bez `--max-ms` watchdog nehlídá jen chvíli — výchozí je bez omezení', async () => {
    // Hlídač, který se po minutě sám vypne, přestane hlídat přesně v tu chvíli,
    // kdy je provoz nejdelší. Výchozí hodnota je proto `0`, tedy bez omezení, a
    // stojí to zapsané v prvním záznamu, takže to jde přečíst i po incidentu.
    const logPath = join(scratch, 'bez-limitu.jsonl');
    const watched = idleProcess();
    track(
      spawn(process.execPath, [WATCHDOG, '--pid', String(watched.pid), '--log', logPath, '--interval-ms', '50'], {
        stdio: 'ignore',
      }),
    );

    const watching = await waitForRecord(logPath, (record) => record.event === 'watching');
    expect(watching).toMatchObject({ maxMs: 0 });
  }, 30_000);

  it('nezapisovatelná cesta logu skončí kódem 3 a hláškou, ne tichým pádem', async () => {
    // Watchdog se spouští s `stdio: 'ignore'` a nikdo se na něj nedívá, takže
    // pád bez zápisu vypadá zvenčí přesně jako klidný provoz — tedy jako to
    // jediné, co má tenhle soubor vyloučit. Naměřeno recenzí: dřív z toho byla
    // neodchycená `ENOENT`, kód 1 a prázdný log.
    const watched = idleProcess();
    const { code, stderr } = await runWatchdog([
      '--pid',
      String(watched.pid),
      '--log',
      join(scratch, 'neexistujici-adresar', 'w.jsonl'),
    ]);

    expect(code).toBe(3);
    expect(stderr).toContain('selhal');
  }, 30_000);

  it('bez povinných parametrů skončí chybou, ne tichým během naprázdno', async () => {
    const code = await new Promise<number | null>((resolve) => {
      const child = track(spawn(process.execPath, [WATCHDOG, '--log', join(scratch, 'x.jsonl')], { stdio: 'ignore' }));
      child.on('exit', resolve);
    });

    expect(code).toBe(2);
  }, 30_000);
});
