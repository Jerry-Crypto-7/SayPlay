/**
 * Obě brány z T300 jsou skripty, které něco zastaví — jediné, co o nich chceme
 * vědět, je **jestli to doopravdy zastaví**. Testy proto sahají na vnitřek jen
 * u čistých funkcí (hranice slov, stripování komentářů); chování brány se měří
 * spuštěním procesu nad skutečným dočasným stromem.
 *
 * Každý negativní případ tvrdí dvě věci současně: **cílová kontrola selhala** a
 * **žádná jiná ne**. Bez té druhé poloviny by test prošel i bráně, která hlásí
 * `FAIL` na všechno — a taková brána neměří nic.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { findHits, parseList } from '../cleanroom-check.mjs';
import { hostsIn, noticesFor, stripComments } from '../license-gate.mjs';

const LICENSE_GATE = join(process.cwd(), 'scripts', 'license-gate.mjs');
const CLEANROOM = join(process.cwd(), 'scripts', 'cleanroom-check.mjs');
const created: string[] = [];

interface Registry {
  entries: Record<string, unknown>[];
}

function run(script: string, cwd: string, args: string[] = []): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' }) };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

/** Které kontroly selhaly, podle čísel v `FAIL  [n]`. */
function failedChecks(out: string): number[] {
  return [...out.matchAll(/^FAIL {2}\[(\d+)]/gm)].map((match) => Number(match[1])).sort((a, b) => a - b);
}

function write(dir: string, name: string, body: string): void {
  const target = join(dir, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body, 'utf8');
}

/**
 * Minimální strom: lockfile se dvěma balíčky a jedním voláním ven. `--sync` z něj
 * udělá platný registr, takže výchozí stav testu je zelený a každý případ níž
 * kazí právě jednu věc.
 */
function makeRepo(lockExtra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'license-gate-'));
  created.push(dir);

  write(
    dir,
    'package-lock.json',
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: '0.0.0' },
        'node_modules/left-pad': {
          version: '1.0.0',
          license: 'MIT',
          resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz',
        },
        'node_modules/copyleft-thing': {
          version: '2.0.0',
          license: 'LGPL-3.0-or-later',
          resolved: 'https://registry.npmjs.org/copyleft-thing/-/copyleft-thing-2.0.0.tgz',
        },
        ...lockExtra,
      },
    }),
  );
  write(dir, 'src/client.ts', "export const url = 'https://api.fixture-provider.io/v1';\n");
  return dir;
}

function readRegistry(dir: string): Registry {
  return JSON.parse(readFileSync(join(dir, 'disclosure.json'), 'utf8')) as Registry;
}

function writeRegistry(dir: string, registry: Registry): void {
  writeFileSync(join(dir, 'disclosure.json'), `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

/**
 * `--sync` a pak doplnění toho, co odvodit nejde: `reviewNote` u copyleftu a
 * ruční `api` položka. Vrací zelený strom.
 */
function makeGreenRepo(): string {
  const dir = makeRepo();
  run(LICENSE_GATE, dir, ['--sync']);

  const registry = readRegistry(dir);
  for (const entry of registry.entries) {
    if (String(entry.license).includes('LGPL')) entry.reviewNote = 'nativní binárka, neběží v prohlížeči, nemodifikovaná';
  }
  registry.entries.push({
    name: 'example provider',
    kind: 'api',
    source: 'https://api.fixture-provider.io',
    authorOrProvider: 'Example Provider Inc.',
    license: 'komerční ToS',
    requiredNotices: ['žádné pro volajícího'],
    attribution: 'Example Provider Inc.',
    reviewNote: 'podmínky přečteny, volá to jen harness',
  });
  writeRegistry(dir, registry);
  // DISCLOSURE.md musí odpovídat registru, takže se po ruční úpravě přegeneruje.
  run(LICENSE_GATE, dir, ['--sync']);
  return dir;
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe('license-gate: zelený výchozí stav', () => {
  it('projde nad stromem, který má registr i DISCLOSURE.md v pořádku', () => {
    const { code, out } = run(LICENSE_GATE, makeGreenRepo());
    expect(failedChecks(out)).toEqual([]);
    expect(code).toBe(0);
  });

  it('DISCLOSURE.md se generuje a nese všech pět tříd jako nadpisy', () => {
    const rendered = readFileSync(join(makeGreenRepo(), 'DISCLOSURE.md'), 'utf8');
    expect(rendered).toContain('GENEROVÁNO');
    for (const title of ['Knihovny', 'Assety', 'Modely', 'Datasety', 'Externí služby']) {
      expect(rendered).toContain(`## ${title}`);
    }
  });
});

describe('license-gate: tvar registru (kontrola 1)', () => {
  it('selže na prázdném řetězci v povinném poli', () => {
    const dir = makeGreenRepo();
    const registry = readRegistry(dir);
    registry.entries[0].attribution = '   ';
    writeRegistry(dir, registry);

    const { code, out } = run(LICENSE_GATE, dir);
    // Kontrola 6 selže s ní: DISCLOSURE.md vykreslený z rozbitého registru
    // přestane sedět. To je vlastnost, ne škoda — a test to říká nahlas.
    expect(failedChecks(out)).toEqual([1, 6]);
    expect(out).toContain('pole "attribution" chybí nebo je prázdné');
    expect(code).toBe(1);
  });

  it('selže na prázdném POLI requiredNotices, ne jen na chybějícím', () => {
    const dir = makeGreenRepo();
    const registry = readRegistry(dir);
    registry.entries[0].requiredNotices = [];
    writeRegistry(dir, registry);

    const { out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toContain(1);
    expect(out).toContain('pole "requiredNotices" chybí nebo je prázdné');
  });

  it('selže na kind mimo pět povolených tříd', () => {
    const dir = makeGreenRepo();
    const registry = readRegistry(dir);
    registry.entries.push({
      name: 'něco',
      kind: 'plugin',
      source: 'x',
      authorOrProvider: 'x',
      license: 'MIT',
      requiredNotices: ['x'],
      attribution: 'x',
    });
    writeRegistry(dir, registry);

    const { out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toContain(1);
    expect(out).toContain('není jedna z');
  });
});

describe('license-gate: licence (kontrola 2)', () => {
  it('selže na licenci mimo whitelist', () => {
    const dir = makeGreenRepo();
    const registry = readRegistry(dir);
    const target = registry.entries.find((entry) => entry.license === 'MIT');
    target!.license = 'SSPL-1.0';
    target!.requiredNotices = ['neznámé'];
    writeRegistry(dir, registry);
    run(LICENSE_GATE, dir, ['--sync']);
    // `--sync` odvozené položky přepíše zpátky, takže se mutace zapíše až po něm.
    const after = readRegistry(dir);
    after.entries.find((entry) => String(entry.name).startsWith('left-pad'))!.license = 'SSPL-1.0';
    writeRegistry(dir, after);

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toContain(2);
    expect(out).toContain('není na whitelistu');
    expect(code).toBe(1);
  });

  it('copyleft bez reviewNote neprojde, s reviewNote projde', () => {
    const dir = makeGreenRepo();
    const registry = readRegistry(dir);
    const copyleft = registry.entries.find((entry) => String(entry.license).includes('LGPL'));
    expect(copyleft, 'fixtura musí obsahovat copyleft položku').toBeDefined();

    delete copyleft!.reviewNote;
    writeRegistry(dir, registry);
    const without = run(LICENSE_GATE, dir);
    expect(failedChecks(without.out)).toContain(2);
    expect(without.out).toContain('reviewNote');

    copyleft!.reviewNote = 'nativní binárka mimo prohlížečový bundle';
    writeRegistry(dir, registry);
    expect(failedChecks(run(LICENSE_GATE, dir).out)).not.toContain(2);
  });

  it('api položka bez reviewNote neprojde, i když licence není prázdná', () => {
    const dir = makeGreenRepo();
    const registry = readRegistry(dir);
    delete registry.entries.find((entry) => entry.kind === 'api')!.reviewNote;
    writeRegistry(dir, registry);

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toContain(2);
    expect(out).toContain('se neredistribuuje, ale "reviewNote" je u něj povinný');
    expect(code).toBe(1);
  });

  it('selže, když balíček licenci vůbec nedeklaruje', () => {
    const dir = makeRepo({ 'node_modules/no-license': { version: '1.0.0', resolved: 'https://registry.fixture.io/x.tgz' } });
    run(LICENSE_GATE, dir, ['--sync']);

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toContain(2);
    expect(out).toContain('licence není deklarovaná');
    expect(code).toBe(1);
  });
});

describe('license-gate: pokrytí (kontroly 3 a 5)', () => {
  it('selže, když závislost z lockfilu v registru chybí', () => {
    const dir = makeGreenRepo();
    const registry = readRegistry(dir);
    registry.entries = registry.entries.filter((entry) => !String(entry.name).startsWith('left-pad'));
    writeRegistry(dir, registry);

    const { out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toContain(3);
    expect(out).toContain('není v registru');
  });

  it('selže i opačným směrem: položka registru, která už není v lockfilu', () => {
    const dir = makeGreenRepo();
    const registry = readRegistry(dir);
    registry.entries.push({
      name: 'duch@9.9.9',
      kind: 'library',
      source: 'https://registry.fixture.io/duch.tgz',
      authorOrProvider: 'nikdo',
      license: 'MIT',
      requiredNotices: ['copyright notice'],
      attribution: 'nikdo',
    });
    writeRegistry(dir, registry);

    const { out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toContain(3);
    expect(out).toContain('už není v lockfilu');
  });

  it('selže, když kód volá hostitele bez položky kind: api', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/other.ts', "await fetch('https://neregistrovany-host.io/v1/go');\n");

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('neregistrovany-host.io');
    expect(code).toBe(1);
  });

  it('hostitel jen v komentáři volání není, takže bránu neshodí', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/doc.ts', "// viz https://jen-v-komentari.io/docs\nexport const x = 1;\n");

    expect(failedChecks(run(LICENSE_GATE, dir).out)).toEqual([]);
  });

  it('hostitel v testovém souboru se neposuzuje', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/thing.test.ts', "await fetch('https://jen-v-testu.io/x');\n");

    expect(failedChecks(run(LICENSE_GATE, dir).out)).toEqual([]);
  });
});

describe('license-gate: DISCLOSURE.md je výpis, ne text (kontrola 6)', () => {
  it('selže, když někdo soubor upraví ručně', () => {
    const dir = makeGreenRepo();
    const path = join(dir, 'DISCLOSURE.md');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nRučně dopsaná věta.\n`, 'utf8');

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([6]);
    expect(out).toContain('rozešel s registrem');
    expect(code).toBe(1);
  });

  it('selže, když soubor chybí úplně', () => {
    const dir = makeGreenRepo();
    rmSync(join(dir, 'DISCLOSURE.md'));

    expect(failedChecks(run(LICENSE_GATE, dir).out)).toEqual([6]);
  });
});

describe('license-gate: čisté funkce', () => {
  it('stripComments nechá URL v řetězci a zahodí ji v komentáři na témž řádku', () => {
    const stripped = stripComments("const u = 'https://ostra.io/x'; // https://komentar.io/y\n");
    expect(stripped).toContain('ostra.io');
    expect(stripped).not.toContain('komentar.io');
  });

  it('stripComments neuřízne řetězec, který obsahuje //', () => {
    expect(stripComments("const u = 'https://a.io//b';\n")).toContain('a.io//b');
  });

  it('hostsIn vynechá loopback i jména vyhrazená pro dokumentaci', () => {
    const hosts = hostsIn(
      "fetch('http://localhost:3000/a'); fetch('https://127.0.0.1/b'); fetch('https://example.com/c'); fetch('https://vyhrazena.test/d'); fetch('https://opravdu-ostra.io/e');",
    );
    expect([...hosts]).toEqual(['opravdu-ostra.io']);
  });

  it('noticesFor rozloží složenou licenci na notices všech částí', () => {
    const notices = noticesFor('Apache-2.0 AND LGPL-3.0-or-later');
    expect(notices).toContain('označení změn');
    expect(notices).toContain('dostupnost zdrojů knihovny');
  });

  it('noticesFor u neznámé licence nevrátí nic — a prázdné pole shodí kontrolu 1', () => {
    expect(noticesFor('SSPL-1.0')).toEqual([]);
  });
});

describe('cleanroom-check: fail-closed', () => {
  it('CHYBĚJÍCÍ seznam je selhání, ne přeskočení kontroly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleanroom-'));
    created.push(dir);
    write(dir, 'src/a.ts', 'export const x = 1;\n');

    const { code, out } = run(CLEANROOM, dir);
    expect(code).toBe(1);
    expect(out).toContain('chybí');
    expect(out).toContain('NEPŘESKAKUJE');
  });

  it('seznam jen s komentáři je taky selhání — prázdný projde čímkoli', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleanroom-'));
    created.push(dir);
    write(dir, 'scripts/cleanroom-forbidden.txt', '# jen komentář\n\n# a další\n');
    write(dir, 'src/a.ts', 'export const x = 1;\n');

    const { code, out } = run(CLEANROOM, dir);
    expect(code).toBe(1);
    expect(out).toContain('neobsahuje jediný identifikátor');
  });
});

describe('cleanroom-check: nenaplněný seznam se musí přiznat', () => {
  function repo(list: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cleanroom-'));
    created.push(dir);
    write(dir, 'scripts/cleanroom-forbidden.txt', list);
    write(dir, 'src/a.ts', 'export const x = 1;\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    return dir;
  }

  it('prázdný seznam s direktivou projde, ale hlásí, že nehlídá nic', () => {
    const { code, out } = run(CLEANROOM, repo('# hlavička\n#!unprovisioned\n'));
    expect(code).toBe(0);
    expect(out).toContain('POZOR');
    expect(out).toContain('nehlídá nic');
  });

  it('direktiva se nehledá jako identifikátor, jinak by shodila vlastní commit', () => {
    const dir = repo('#!unprovisioned\n');
    // Přesně ta situace, která shodila první verzi: řetězec direktivy stojí ve
    // skenovaném souboru. Nálezem být nesmí.
    write(dir, 'src/b.ts', "export const marker = '#!unprovisioned';\n");

    const { code, out } = run(CLEANROOM, dir);
    expect(code).toBe(0);
    expect(out).not.toContain('src/b.ts');
  });

  it('naplněný seznam s zapomenutou direktivou hlásí, že direktiva lže', () => {
    const { out } = run(CLEANROOM, repo('#!unprovisioned\nAcmeEcaActionRunner\n'));
    expect(out).toContain('pořád je označený');
  });

  it('naplněný seznam bez direktivy nehlásí nic', () => {
    const { code, out } = run(CLEANROOM, repo('AcmeEcaActionRunner\n'));
    expect(code).toBe(0);
    expect(out).not.toContain('POZOR');
  });
});

describe('cleanroom-check: nálezy', () => {
  /**
   * Skutečný git repozitář, ne jen adresář: kontrola bere soubory z
   * `git ls-files`, aby ignorované soubory (`SECURITY-FINDINGS.md`) nehlásila.
   * Fixtura tím jede stejnou cestou jako ostrý běh.
   */
  function repoWith(identifiers: string, source: string, gitignore = ''): string {
    const dir = mkdtempSync(join(tmpdir(), 'cleanroom-'));
    created.push(dir);
    write(dir, 'scripts/cleanroom-forbidden.txt', identifiers);
    write(dir, 'src/a.ts', source);
    if (gitignore) write(dir, '.gitignore', gitignore);
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    return dir;
  }

  it('ignorovaný soubor se neskenuje — jinak by nález nešlo nikdy opravit', () => {
    const dir = repoWith('AcmeEcaActionRunner\n', 'export const x = 1;\n', 'tajne.md\n');
    write(dir, 'tajne.md', 'Interní dokument, zmiňuje AcmeEcaActionRunner.\n');

    const { code, out } = run(CLEANROOM, dir);
    expect(code).toBe(0);
    expect(out).not.toContain('tajne.md');
  });

  it('mimo git repozitář je to selhání, ne sken prázdné množiny', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleanroom-nogit-'));
    created.push(dir);
    write(dir, 'scripts/cleanroom-forbidden.txt', 'AcmeEcaActionRunner\n');
    write(dir, 'src/a.ts', 'new AcmeEcaActionRunner();\n');

    const { code, out } = run(CLEANROOM, dir);
    expect(code).toBe(1);
    expect(out).toContain('git ls-files selhal');
  });

  it('najde zakázaný identifikátor a vypíše soubor i řádek', () => {
    const { code, out } = run(CLEANROOM, repoWith('AcmeEcaActionRunner\n', 'const a = 1;\nnew AcmeEcaActionRunner();\n'));
    expect(code).toBe(1);
    expect(out).toContain('src/a.ts:2');
    expect(out).toContain('AcmeEcaActionRunner');
  });

  it('shoduje celá slova, takže Reactor netrefí identifikátor Actor', () => {
    const { code, out } = run(CLEANROOM, repoWith('Actor\n', 'class Reactor {}\nconst ActorId = 1;\n'));
    expect(code).toBe(0);
    expect(out).toContain('žádný nález');
  });

  it('sám seznam se neskenuje, jinak by hlásil nález pokaždé', () => {
    const { code } = run(CLEANROOM, repoWith('AcmeEcaActionRunner\n', 'export const x = 1;\n'));
    expect(code).toBe(0);
  });

});

describe('cleanroom-check: čisté funkce', () => {
  it('parseList zahodí komentáře a prázdné řádky', () => {
    expect(parseList('# hlavička\n\nAlfa\n  Beta  \n# konec\n')).toEqual(['Alfa', 'Beta']);
  });

  it('findHits vrací číslo řádku od jedničky', () => {
    expect(findHits('nic\nAlfa tady\n', ['Alfa'])).toEqual([{ identifier: 'Alfa', line: 2 }]);
  });

  it('findHits nebere podřetězec uvnitř delšího identifikátoru', () => {
    expect(findHits('const AlfaBeta = 1;\nconst x_Alfa_y = 2;\n', ['Alfa'])).toEqual([]);
  });

  it('findHits bere identifikátor oddělený tečkou nebo závorkou', () => {
    expect(findHits('eca.Alfa(1);\n', ['Alfa'])).toEqual([{ identifier: 'Alfa', line: 1 }]);
  });
});
