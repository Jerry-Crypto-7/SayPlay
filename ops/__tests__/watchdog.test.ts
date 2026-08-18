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
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * **Chyba `process.kill(pid, 0)` se v testu VYROBÍ, ne půjčí od cizího procesu.**
 *
 * Dřív se ta vlastnost měřila přes `--pid 4`, tedy systémový proces Windows.
 * To má dvě vady najednou. Za prvé je to jediné místo v celé sadě závislé na
 * stroji, na kterém vzniklo: PID 4 na Linuxu, na macOS ani v kontejneru běžně
 * neexistuje, `process.kill` tam vrátí `ESRCH` a test 15 s čeká na `gave-up`,
 * kterého se nedočká. Za druhé — a to je horší — aserce je tam, kde ten proces
 * je **dostupný**, splněná i bez `EPERM`: dostupný proces je taky živý, takže
 * větev, kvůli které test existuje, se vůbec nemusí projít.
 *
 * Předehra proto `process.kill` pro signál 0 nahradí a hodí přesně ten errno,
 * který se testuje. Hlídaný PID je vlastní PID testu, takže na existenci ničeho
 * cizího nezávisí ani jeden běh. Nic se nepředstírá o watchdogu samotném —
 * pořád je to skutečný druhý proces, který si zapisuje na skutečný disk.
 */
const KILL_STUB = join(scratch, 'kill-stub.mjs');
writeFileSync(
  KILL_STUB,
  [
    'const code = process.env.WATCHDOG_TEST_KILL_CODE;',
    'const watched = Number(process.env.WATCHDOG_TEST_KILL_PID);',
    'const real = process.kill.bind(process);',
    'process.kill = (pid, signal) => {',
    // Jen hlídaný PID, ne každý. Předehra, která odpoví na cokoliv, dělá
    // z argumentu `--pid` ozdobu: test by pak prošel i nad watchdogem, který
    // se ptá na úplně jiný proces.
    '  if (signal === 0 && pid === watched) {',
    '    const error = new Error("watchdog test stub: " + code);',
    '    error.code = code;',
    '    throw error;',
    '  }',
    '  return real(pid, signal);',
    '};',
    '',
    // Konec řádku přes `String.fromCharCode(10)` — zpětné lomítko by tenhle
    // soubor prošlo jako escape sekvence a rozpadlo řetězec.
  ].join(String.fromCharCode(10)),
  'utf-8',
);

/** Watchdog, jehož sonda na JEDEN zadaný PID selže zadaným `errno`. */
function watchdogWithKillErrno(errno: string, watchedPid: number, args: string[]): ChildProcess {
  return track(
    spawn(
      process.execPath,
      ['--import', pathToFileURL(KILL_STUB).href, WATCHDOG, '--pid', String(watchedPid), ...args],
      {
        stdio: 'ignore',
        env: { ...process.env, WATCHDOG_TEST_KILL_CODE: errno, WATCHDOG_TEST_KILL_PID: String(watchedPid) },
      },
    ),
  );
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

  it.each(['EPERM', 'EACCES'])('odepřený přístup (%s) se počítá jako živý proces, ne jako mrtvý', async (errno) => {
    // Kdyby watchdog četl odepřený přístup jako smrt, ohlásil by pád procesu,
    // který se má dobře — a to je celá třída falešných poplachů u nasazení, kde
    // watchdog běží pod jiným uživatelem než hlídaná služba. `EPERM` je to, co
    // vrací Windows na systémový proces; `EACCES` je pojistka pro platformy, kde
    // by libuv odepřený `OpenProcess` mapoval takhle. Obě větve se měří stejně,
    // protože obě jsou v `alive()` napsané a ani jedna nemá vlastní důkaz.
    const logPath = join(scratch, `odepreno-${errno}.jsonl`);
    watchdogWithKillErrno(errno, process.pid, ['--log', logPath, '--interval-ms', '50', '--max-ms', '300']);

    expect(await waitForRecord(logPath, (record) => record.event === 'gave-up')).not.toBeNull();
    expect(records(logPath).some((record) => record.event === 'process-gone')).toBe(false);
  }, 30_000);

  it('neexistující proces (ESRCH) se naopak počítá jako mrtvý', async () => {
    // Kontrolní skupina k oběma testům nad ní, a je to ta část, bez které by
    // netvrdily nic. Tentýž PID, tentýž způsob, jak se chyba vyrobí — liší se
    // jen `errno`. Watchdog, který by prostě všechno považoval za živé, projde
    // oběma testy nad tímhle a spadne až tady.
    const logPath = join(scratch, 'esrch.jsonl');
    watchdogWithKillErrno('ESRCH', process.pid, ['--log', logPath, '--interval-ms', '50', '--max-ms', '300']);

    const gone = await waitForRecord(logPath, (record) => record.event === 'process-gone');
    expect(gone).toMatchObject({ detected: 'at-start' });
    expect(records(logPath).some((record) => record.event === 'gave-up')).toBe(false);
  }, 30_000);

  it('předehra odpovídá jen za hlídaný PID — na cizí se ptá skutečného jádra', async () => {
    // Kdyby předehra odpovídala na cokoliv, byl by argument `--pid` ozdoba: oba
    // testy nad tímhle by prošly i nad watchdogem, který se ptá na úplně jiný
    // proces. Tady je `errno` nastavené pro PID, který se NEhlídá — hlídaný
    // běží a živý ho musí vrátit skutečné `process.kill`.
    const logPath = join(scratch, 'jen-hlidany.jsonl');
    const watched = idleProcess();

    track(
      spawn(
        process.execPath,
        [
          '--import',
          pathToFileURL(KILL_STUB).href,
          WATCHDOG,
          '--pid',
          String(watched.pid),
          '--log',
          logPath,
          '--interval-ms',
          '50',
          '--max-ms',
          '300',
        ],
        {
          stdio: 'ignore',
          env: { ...process.env, WATCHDOG_TEST_KILL_CODE: 'ESRCH', WATCHDOG_TEST_KILL_PID: String(process.pid) },
        },
      ),
    );

    expect(await waitForRecord(logPath, (record) => record.event === 'gave-up')).not.toBeNull();
    expect(records(logPath).some((record) => record.event === 'process-gone')).toBe(false);
  }, 30_000);

  // **Skutečné `EPERM` z jádra, tam kde ho jádro umí vyrobit.** Předehra nad
  // tímhle testem je poctivá, ale vyrábí si chybu sama, takže sada `alive()`
  // by se jinak měřila jen proti errnům, které si test vymyslel. Windows umí
  // `EPERM` doopravdy (systémový proces PID 4), Linux, macOS ani kontejner ne —
  // PID 4 tam běžně neexistuje a vrátil by `ESRCH`. Přeskakuje se proto podle
  // platformy a s uvedeným důvodem, ne mlčky.
  const kernelEperm = process.platform === 'win32' ? it : it.skip;
  kernelEperm(
    'skutečné EPERM z jádra se počítá jako živý proces (jen Windows — jinde ho nejde vyrobit)',
    async () => {
      const logPath = join(scratch, 'kernel-eperm.jsonl');
      track(
        spawn(
          process.execPath,
          [WATCHDOG, '--pid', '4', '--log', logPath, '--interval-ms', '50', '--max-ms', '300'],
          { stdio: 'ignore' },
        ),
      );

      expect(await waitForRecord(logPath, (record) => record.event === 'gave-up')).not.toBeNull();
      expect(records(logPath).some((record) => record.event === 'process-gone')).toBe(false);
    },
    30_000,
  );

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
