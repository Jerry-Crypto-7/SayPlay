import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  ALLOWLIST_FILE,
  ARTIFACT_SKIP,
  POLLUTION,
  TAG,
  diffHashes,
  envFrom,
  executablePaths,
  hashFiles,
  normalizedBytes,
  parseAllowlist,
  unexpectedEnvKeys,
  walkFiles,
} from '../build-from-tag.mjs';

/**
 * Rozhodovací části hermetického buildu (P2 T205a).
 *
 * Celou sekvenci `npm run build:from-tag` tenhle soubor nespouští — trvá minuty
 * a potřebuje existující tag. Testuje se to, co **rozhoduje**: zámek prostředí,
 * čtení módů z tagu a porovnání dvou artefaktů. Právě tyhle tři kusy jsou to,
 * co odděluje důkaz od zeleného běhu.
 */

const scratch = mkdtempSync(join(tmpdir(), 'build-from-tag-test-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('parseAllowlist', () => {
  it('zahodí komentáře i prázdné řádky a sjednotí velikost písmen', () => {
    expect(
      parseAllowlist('# hlavička\n\nPATH\n  systemroot  \nTEMP # koncový komentář\n\n#PATHEXT\n'),
    ).toEqual({ host: ['PATH', 'SYSTEMROOT', 'TEMP'], platform: [], all: ['PATH', 'SYSTEMROOT', 'TEMP'] });
  });

  it('zakomentované jméno allowlist NEpropustí', () => {
    // Bez tohohle by `#PATHEXT` prošlo a soubor by allowlist jen předstíral.
    expect(parseAllowlist('#PATHEXT\nPATH\n').all).not.toContain('PATHEXT');
  });

  it('duplicitu započítá jednou', () => {
    expect(parseAllowlist('PATH\npath\nPATH\n').host).toEqual(['PATH']);
  });

  it('rozdělí sekce a `platform` nepřebije `host`', () => {
    // Sekce nejsou kosmetika: `host` je to, co pipeline vědomě předává, a jen
    // tam má minimalita smysl. Kdyby se jméno dalo do obou, počítá se jako
    // předávané — jinak by se dalo „přesunout" do platformy a tím ho vyjmout
    // z toho seznamu, na který se kdokoli dívá.
    const allow = parseAllowlist('[host]\nPATH\nTEMP\n[platform]\nUSERNAME\ntemp\n');
    expect(allow.host).toEqual(['PATH', 'TEMP']);
    expect(allow.platform).toEqual(['USERNAME']);
    expect(allow.all).toEqual(['PATH', 'TEMP', 'USERNAME']);
  });

  it('řádky před první sekcí patří do `host`', () => {
    expect(parseAllowlist('PATH\n[platform]\nUSERNAME\n').host).toEqual(['PATH']);
  });

  it('neznámou sekci odmítne, místo aby ji tiše spolkla', () => {
    // Překlep `[plaform]` by jinak vyrobil sekci, kterou nikdo nekontroluje.
    expect(() => parseAllowlist('[plaform]\nBUILD_VARIANT\n')).toThrow(/neznámou sekci/);
  });
});

describe('envFrom', () => {
  it('propustí jen jmenované proměnné', () => {
    expect(envFrom(['PATH', 'TEMP'], { PATH: '/bin', TEMP: '/t', AWS_SECRET_ACCESS_KEY: 'x' })).toEqual({
      PATH: '/bin',
      TEMP: '/t',
    });
  });

  it('jména proměnných porovnává bez ohledu na velikost písmen', () => {
    // Na Windows je `Path` a `PATH` táž proměnná. Kdyby se porovnávalo přesně,
    // build by přišel o `PATH` a spadl by na tom, že nenajde `node`.
    expect(envFrom(['PATH'], { Path: 'C:\\bin' })).toEqual({ Path: 'C:\\bin' });
  });

  it('nevytvoří proměnnou, kterou zdroj nemá', () => {
    expect(envFrom(['PATH', 'CI'], { PATH: '/bin', CI: undefined })).toEqual({ PATH: '/bin' });
  });
});

describe('unexpectedEnvKeys', () => {
  it('najde proměnnou, kterou build viděl a allowlist ji nejmenuje', () => {
    expect(unexpectedEnvKeys(['PATH'], ['PATH', 'BUILD_VARIANT', ''])).toEqual(['BUILD_VARIANT']);
  });

  it('nad čistou množinou nevrátí nic', () => {
    expect(unexpectedEnvKeys(['PATH', 'TEMP'], ['temp', 'PATH'])).toEqual([]);
  });
});

describe('executablePaths', () => {
  it('vybere jen mód 100755 a vezme cestu za tabulátorem', () => {
    const lsTree = [
      '100644 blob aaa\tpackage.json',
      '100755 blob bbb\t.githooks/pre-push',
      '100644 blob ccc\tsrc/app/page.tsx',
      '100755 blob ddd\tops/run it.sh',
    ].join('\n');
    expect(executablePaths(lsTree)).toEqual(['.githooks/pre-push', 'ops/run it.sh']);
  });

  it('nespoléhá na počet mezer v cestě', () => {
    expect(executablePaths('100644 blob aaa\ta b c.txt')).toEqual([]);
  });
});

describe('walkFiles a hashFiles', () => {
  const root = join(scratch, 'artifact');

  it('projde strom, seřadí a vynechá jen kořenové výjimky', () => {
    mkdirSync(join(root, 'static', 'chunks'), { recursive: true });
    mkdirSync(join(root, 'cache', 'webpack'), { recursive: true });
    mkdirSync(join(root, 'server', 'cache'), { recursive: true });
    writeFileSync(join(root, 'BUILD_ID'), 'abc');
    writeFileSync(join(root, 'trace'), 'timeline');
    writeFileSync(join(root, 'static', 'chunks', 'main.js'), 'x');
    writeFileSync(join(root, 'cache', 'webpack', 'pack'), 'y');
    writeFileSync(join(root, 'server', 'cache', 'page.js'), 'z');

    // `cache` a `trace` pryč jen v kořeni: `server/cache/page.js` je artefakt,
    // ne mezivýsledek, a vynechat ho by nechalo serverovou půlku bez kontroly.
    expect(walkFiles(root, '', ARTIFACT_SKIP)).toEqual([
      'BUILD_ID',
      'server/cache/page.js',
      'static/chunks/main.js',
    ]);
  });

  it('hashuje obsah, ne jméno', () => {
    const hashes = hashFiles(root, ['BUILD_ID', 'static/chunks/main.js']);
    expect(hashes['BUILD_ID']).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes['BUILD_ID']).not.toBe(hashes['static/chunks/main.js']);

    writeFileSync(join(root, 'BUILD_ID'), 'abd');
    expect(hashFiles(root, ['BUILD_ID'])['BUILD_ID']).not.toBe(hashes['BUILD_ID']);
  });
});

describe('normalizedBytes', () => {
  it('u JSON srovná pořadí klíčů, protože pořadí není obsah', () => {
    // `next build` skládá manifesty z paralelních workerů, takže pořadí klíčů
    // se mezi běhy liší, aniž by se lišil obsah. Naměřeno na třech souborech.
    const a = Buffer.from('{"b":1,"a":{"y":2,"x":3}}');
    const b = Buffer.from('{"a":{"x":3,"y":2},"b":1}');
    expect(normalizedBytes('x.json', a)).toBe(normalizedBytes('x.json', b));
  });

  it('u JSON NEsrovná rozdílnou hodnotu', () => {
    expect(normalizedBytes('x.json', Buffer.from('{"a":1}'))).not.toBe(
      normalizedBytes('x.json', Buffer.from('{"a":2}')),
    );
  });

  it('vyjme vygenerované klíče přesně na jmenované cestě', () => {
    const withKeys = (id: string) =>
      Buffer.from(JSON.stringify({ version: 4, preview: { previewModeId: id }, routes: { '/': 1 } }));
    expect(normalizedBytes('prerender-manifest.json', withKeys('aaa'))).toBe(
      normalizedBytes('prerender-manifest.json', withKeys('bbb')),
    );
  });

  it('tutéž hodnotu na JINÉ cestě nevyjme', () => {
    // Bez tohohle by výjimka byla vzor a dala by se pod ni schovat změna
    // chování kdekoli, kde se to pole jmenuje stejně.
    const withKeys = (id: string) => Buffer.from(JSON.stringify({ routes: { previewModeId: id } }));
    expect(normalizedBytes('prerender-manifest.json', withKeys('aaa'))).not.toBe(
      normalizedBytes('prerender-manifest.json', withKeys('bbb')),
    );
  });

  it('u souboru bez výjimky nevyjme nic', () => {
    const withKeys = (id: string) => Buffer.from(JSON.stringify({ preview: { previewModeId: id } }));
    expect(normalizedBytes('jiny-manifest.json', withKeys('aaa'))).not.toBe(
      normalizedBytes('jiny-manifest.json', withKeys('bbb')),
    );
  });

  it('u ne-JSON souboru vrací bajty beze změny', () => {
    // Kanonizace chunku by nic neznamenala a zamlčela by skutečný rozdíl.
    const bytes = Buffer.from('{"a":1}');
    expect(normalizedBytes('static/chunks/main.js', bytes)).toBe(bytes);
  });
});

describe('diffHashes', () => {
  it('rozliší chybějící soubor od změněného obsahu', () => {
    expect(diffHashes({ a: '1', b: '2', c: '3' }, { a: '1', b: 'x', d: '4' })).toEqual({
      onlyFirst: ['c'],
      onlySecond: ['d'],
      changed: ['b'],
    });
  });

  it('shodné artefakty nevrátí žádný rozdíl', () => {
    expect(diffHashes({ a: '1' }, { a: '1' })).toEqual({ onlyFirst: [], onlySecond: [], changed: [] });
  });
});

describe('allowlist v repozitáři', () => {
  const allow = parseAllowlist(readFileSync(join(process.cwd(), ALLOWLIST_FILE), 'utf-8'));

  it('je trackovaný gitem, takže ho tag ponese s sebou', () => {
    // Kdyby ležel vedle tagu, byl by vstupem buildu, který zapečetěný strom
    // nekryje — přesně ta díra, kterou má zavírat (kolo 4 review nad T205).
    // Netrackovaný soubor `git archive` nevyexportuje a pipeline spadne až v
    // kroku 4, kde už je za ním pár minut práce.
    const tracked = execFileSync('git', ['--no-replace-objects', 'ls-files', '--', ALLOWLIST_FILE], {
      encoding: 'utf-8',
    }).trim();
    expect(tracked, `${ALLOWLIST_FILE} není v gitu`).toBe(ALLOWLIST_FILE);
    expect(allow.host.length).toBeGreaterThan(0);
  });

  it('jmenuje PATH i SYSTEMROOT, jinak se na Windows nespustí ani node', () => {
    expect(allow.host).toContain('PATH');
    expect(allow.host).toContain('SYSTEMROOT');
  });

  it('jmenuje vstupy pipeline', () => {
    expect(allow.host).toContain('WORLDSMITH_BUILD_TREE');
    expect(allow.host).toContain('WORLDSMITH_ENV_REPORT');
  });

  it('nepropustí nic, co vypadá jako přístup ven', () => {
    // Allowlist, ne blocklist — tohle je kontrola, že se seznam nerozrostl.
    for (const name of allow.all) {
      expect(name, `${name} nemá v prostředí hermetického buildu co dělat`).not.toMatch(
        /KEY|TOKEN|SECRET|PASSWORD|DSN|_URL$/,
      );
    }
  });

  it('žádné z podstrčených jmen si allowlist nepovoluje', () => {
    // Bez tohohle by se záporná kontrola v pipeline dala umlčet tím, že se
    // `BUILD_VARIANT` dopíše do sekce `[platform]` — kontrola by pak procházela
    // proto, že jsme si únik povolili.
    for (const name of Object.keys(POLLUTION)) {
      expect(allow.all, `${name} je v allowlistu, takže záporná kontrola nic netvrdí`).not.toContain(
        name.toUpperCase(),
      );
    }
  });
});

describe('tag fallback-v1', () => {
  it('když existuje, je anotovaný a jeho anotace nese hash stromu', () => {
    const exists =
      execFileSync('git', ['--no-replace-objects', 'tag', '-l', TAG], { encoding: 'utf-8' }).trim() === TAG;
    if (!exists) {
      // Tag vzniká až v T205a. Do té doby se tvrdí to, co je pravda: netvrdí se nic.
      expect(exists).toBe(false);
      return;
    }

    const type = execFileSync('git', ['--no-replace-objects', 'cat-file', '-t', TAG], {
      encoding: 'utf-8',
    }).trim();
    expect(type, 'lehký tag nenese ani zprávu, ani hash stromu').toBe('tag');

    const tree = execFileSync('git', ['--no-replace-objects', 'rev-parse', `${TAG}^{tree}`], {
      encoding: 'utf-8',
    }).trim();
    const annotation = execFileSync(
      'git',
      ['--no-replace-objects', 'tag', '-l', '--format=%(contents)', TAG],
      { encoding: 'utf-8' },
    );
    expect(annotation).toContain(tree);
  });
});
