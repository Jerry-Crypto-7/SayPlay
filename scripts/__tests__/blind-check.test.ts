/**
 * `blind-check.mjs` je brána před nahráním, takže jediné, co o ní chceme vědět,
 * je **jestli doopravdy zastaví znečištěný repozitář**. Test proto nesahá na
 * vnitřek skriptu: postaví skutečný git repozitář v dočasném adresáři, znečistí
 * v něm právě jednu věc a spustí skript jako proces.
 *
 * Každý negativní případ tvrdí dvě věci současně: **cílová kontrola selhala**
 * a **žádná jiná ne**. Bez té druhé poloviny by test prošel i skriptu, který
 * hlásí `FAIL` na všechno — a takový skript neměří nic.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'blind-check.mjs');
const CLEAN_AUTHOR = ['-c', 'user.name=worldsmith', '-c', 'user.email=worldsmith@users.noreply.github.com'];
const ACCOUNT = 'anon-account';

/**
 * **Zástupná jména organizátora — `AcmeCorp` ve fixturách.** Skutečná žijí od
 * 19. 8. 2026 už jen v `blind-check.config.json`, který je v `.gitignore`. Test,
 * který by je nesl, by je vrátil zpátky do veřejného repozitáře, tedy přesně
 * tam, odkud je kontrola 3 má držet venku.
 *
 * Dvojice je schválně dlouhý i krátký token: `acmecorp` se hledá jako
 * podřetězec, `acme` na hranici slova. Pokrývá obě větve `SUBSTRING_MIN_LEN`.
 */
const PUBLIC_TOKENS = ['acmecorp', 'acme'] as const;

const created: string[] = [];

interface Fixture {
  /** Přepíše jméno autora i committera. */
  readonly identity?: string;
  /** Znečistí VÝHRADNĚ committera, autor zůstane čistý. */
  readonly committerName?: string;
  /** Nenastaví `user.email` lokálně v repu. */
  readonly noLocalEmail?: boolean;
  /** Obsah trackovaného souboru navíc. */
  readonly extraFile?: { readonly name: string; readonly body: string };
  /** URL remote; `null` znamená žádný remote. */
  readonly remote?: string | null;
  /** Zakázané tokeny identity v configu. Default je jeden dlouhý (`johndoe`). */
  readonly identityTokens?: readonly string[];
  /** Zakázaná jména organizátora v configu. Default je `PUBLIC_TOKENS`. */
  readonly publicTokens?: readonly string[];
  /** Config vznikne, ale klíč `publicTokens` v něm vůbec nebude. */
  readonly omitPublicTokens?: boolean;
  /** Config vůbec nevznikne — brána nemá proti čemu identitu hledat. */
  readonly noConfig?: boolean;
  /** Obsah `README.md`; jinak neutrální text bez jakéhokoli jména. */
  readonly readme?: string;
}

// `Record<string, string>`, ne `NodeJS.ProcessEnv` — ten je v tomhle projektu
// rozšířený o povinné `NODE_ENV`, takže by prázdný default neprošel `tsc`.
function run(cwd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, ...env } });
}

function makeRepo(fixture: Fixture = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'blind-check-'));
  created.push(dir);

  run(dir, ['init', '-b', 'main']);
  // Config skriptu je v `.gitignore`, přesně jako v ostrém repu.
  writeFileSync(join(dir, '.gitignore'), 'blind-check.config.json\n', 'utf8');
  if (!fixture.noConfig) {
    writeFileSync(
      join(dir, 'blind-check.config.json'),
      JSON.stringify({
        account: ACCOUNT,
        ...(fixture.omitPublicTokens ? {} : { publicTokens: fixture.publicTokens ?? PUBLIC_TOKENS }),
        identityTokens: fixture.identityTokens ?? ['johndoe'],
      }),
      'utf8',
    );
  }
  writeFileSync(join(dir, 'README.md'), fixture.readme ?? '# world builder\n\nNic, co by jmenovalo autora.\n', 'utf8');
  if (fixture.extraFile) {
    // Jméno smí být cesta (`evals/live/RUN/responses/C01.json`) — kontrola 6 se
    // ptá právě na trackované soubory pod konkrétním adresářem.
    const target = join(dir, fixture.extraFile.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, fixture.extraFile.body, 'utf8');
  }

  if (!fixture.noLocalEmail) {
    run(dir, ['config', '--local', 'user.email', 'worldsmith@users.noreply.github.com']);
    run(dir, ['config', '--local', 'user.name', 'worldsmith']);
  }

  const identity = fixture.identity
    ? ['-c', `user.name=${fixture.identity}`, '-c', 'user.email=someone@example.com']
    : CLEAN_AUTHOR;
  const env: Record<string, string> = fixture.committerName
    ? { GIT_COMMITTER_NAME: fixture.committerName, GIT_COMMITTER_EMAIL: 'someone@example.com' }
    : {};

  run(dir, ['add', '-A']);
  run(dir, [...identity, 'commit', '-m', 'chore: initial'], env);

  const remote = fixture.remote === undefined ? `https://github.com/${ACCOUNT}/world.git` : fixture.remote;
  if (remote) run(dir, ['remote', 'add', 'origin', remote]);

  return dir;
}

/**
 * Další commit s vlastní dvojicí autor/committer. Oddělené od `makeRepo`,
 * protože kontrola 1 čte celou historii, ne jen HEAD.
 */
function addCommit(dir: string, who: { author: string; committer?: string }): void {
  const [, name = '', email = ''] = who.author.match(/^(.*?)\s*<(.*)>$/) ?? [];
  const [, cName = '', cEmail = ''] = who.committer ? (who.committer.match(/^(.*?)\s*<(.*)>$/) ?? []) : [];
  writeFileSync(join(dir, 'NOTE.md'), 'Druhý commit.\n', 'utf8');
  run(dir, ['add', '-A']);
  run(
    dir,
    ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', 'chore: second'],
    who.committer ? { GIT_COMMITTER_NAME: cName, GIT_COMMITTER_EMAIL: cEmail } : {},
  );
}

function blindCheck(
  cwd: string,
  env: Record<string, string> = {},
  args: string[] = [],
): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? -1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

/**
 * Spustí skript tak, jak ho spouští `pre-push`: s proměnnou režimu a s dvojicí
 * argumentů, kterou git hooku podává (jméno cíle, adresa cíle).
 *
 * Adresa se předává **zvlášť od nastaveného remote** — celý smysl kontroly 5 je,
 * že tyhle dvě věci nemusí být totéž.
 */
function pushHook(cwd: string, target: string | null): { code: number; out: string } {
  const args = target === null ? [] : ['origin', target];
  return blindCheck(cwd, { BLIND_CHECK_HOOK: 'pre-push' }, args);
}

/** Vrátí id kontrol, které v tom výstupu selhaly. */
function failedChecks(out: string): number[] {
  return [...out.matchAll(/^FAIL {2}\[(\d)]/gm)].map((match) => Number(match[1]));
}

afterAll(() => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows drží read-only git objekty; uklidí je temp, není to selhání testu.
    }
  }
});

describe('blind-check propustí čistý repozitář', () => {
  it('z hooku vrátí 0 a proběhne všech šest kontrol', () => {
    const result = pushHook(makeRepo(), `https://github.com/${ACCOUNT}/world.git`);
    expect(result.out).toContain('6 z 6 kontrol prošlo');
    expect(result.out).not.toContain('SKIP');
    expect(failedChecks(result.out)).toEqual([]);
    expect(result.code).toBe(0);
  });

  /**
   * Ruční běh zůstává použitelný — jinak by si ho nikdo nespustil a brána by
   * existovala jen v okamžiku pushe. Cíl pushe ale ručně znát nejde, takže se
   * kontrola 5 přeskočí a **shrnutí to musí říct**: „všech 6 prošlo" nad během,
   * kde jedna kontrola neběžela, je přesně to tvrzení, na které se někdo spolehne.
   */
  it('ručně spuštěný vrátí 0, ale kontrolu cíle přeskočí a napíše to', () => {
    const result = blindCheck(makeRepo());
    expect(result.code).toBe(0);
    expect(failedChecks(result.out)).toEqual([]);
    expect(result.out).toContain('SKIP  [5]');
    expect(result.out).toContain('5 z 6 kontrol prošlo');
    expect(result.out).toContain('1 přeskočeno');
  });
});

describe('a každou z šesti kontrol umí shodit zvlášť', () => {
  it('[1] zakázaný token v identitě autora', () => {
    const result = blindCheck(makeRepo({ identity: 'acme-person' }));
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([1]);
    expect(result.out).toContain('author obsahuje zakázaný token');
  });

  /**
   * Samostatný případ, protože autor a committer jsou dvě různá pole a plete
   * si je i git sám: `commit --amend` cizím strojem přepíše jen committera.
   * Kontrola, která čte jen `%an`, tuhle cestu ven nevidí.
   */
  it('[1] zakázaný token VÝHRADNĚ v committerovi, autor čistý', () => {
    const result = blindCheck(makeRepo({ committerName: 'acme-person' }));
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([1]);
    expect(result.out).toContain('committer obsahuje zakázaný token');
    expect(result.out).not.toContain('author obsahuje zakázaný token');
  });

  /**
   * Merge přes web GitHubu je jediná identita navíc, kterou si repozitář
   * vyrobí sám: autorem je anonymní účet, committerem `GitHub`. Dokud brána
   * počítala identity, padala na tom napořád a nešlo pushnout vůbec nic.
   * Obojí patří k tomu účtu, takže se z počítání vyjímá — hledání zakázaných
   * tokenů jím ale prochází dál, což pojistí případ pod tímhle.
   */
  it('[1] merge přes web GitHubu neprozrazuje autora', () => {
    const dir = makeRepo();
    addCommit(dir, {
      author: `${ACCOUNT} <${ACCOUNT}@users.noreply.github.com>`,
      committer: 'GitHub <noreply@github.com>',
    });
    const result = blindCheck(dir);
    expect(result.code).toBe(0);
    expect(failedChecks(result.out)).toEqual([]);
  });

  /**
   * Druhá polovina té výjimky. Kdyby se počítání identit vypnulo místo zúžení,
   * tenhle případ by prošel — a přesně jím se autor prozradí: cizí jméno bez
   * jediného zakázaného tokenu, které do historie nepatří.
   */
  it('[1] cizí identita bez zakázaného tokenu pořád zastaví push', () => {
    const dir = makeRepo();
    addCommit(dir, { author: 'stranger <stranger@example.com>' });
    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([1]);
    expect(result.out).toContain('různých identit');
  });

  it('[2] chybějící lokální identita v repu', () => {
    const result = blindCheck(makeRepo({ noLocalEmail: true }));
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([2]);
  });

  it('[3] jméno organizátora v commitnutém obsahu', () => {
    const dir = makeRepo({ extraFile: { name: 'notes.md', body: 'Postaveno pro AcmeCorp.\n' } });
    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([3]);
  });

  it('[3] výjimka je přesně dva soubory, ne celé scripts/', () => {
    const dir = makeRepo({ extraFile: { name: 'scripts/jiny.mjs', body: '// Postaveno pro AcmeCorp.\n' } });
    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([3]);
  });

  it('[3] vlastní tokeny brány se nepočítají jako únik', () => {
    // Skript a jeho test ta jména nést MUSÍ — hledá je. Bez výjimky je kontrola
    // nenulová vždycky a přestane se lišit od skutečného úniku.
    const dir = makeRepo({ extraFile: { name: 'scripts/blind-check.mjs', body: '// hledá AcmeCorp a ACME\n' } });
    const result = blindCheck(dir);
    expect(failedChecks(result.out)).toEqual([]);
    expect(result.code).toBe(0);
  });

  it('[3] jméno vyškrtnuté v HEAD, ale živé v rodiči', () => {
    // Push nahrává historii, ne snímek. Sken jen nad HEAD tenhle stav prohlásí
    // za čistý, zatímco `git log -p` to jméno ukáže komukoli.
    const dir = makeRepo({ extraFile: { name: 'notes.md', body: 'Postaveno pro AcmeCorp.\n' } });
    writeFileSync(join(dir, 'notes.md'), 'Postaveno pro nikoho konkrétního.\n', 'utf8');
    run(dir, ['add', '-A']);
    run(dir, [...CLEAN_AUTHOR, 'commit', '-m', 'docs: scrub']);

    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([3]);
  });

  it('[6] credentials přidané a v dalším commitu smazané', () => {
    // `git add -f .env.local`, commit, `git rm`, commit. HEAD je čistý, klíč je
    // v rodiči — a push nahraje rodiče taky.
    const dir = makeRepo({ extraFile: { name: '.env.local', body: 'OPENAI_API_KEY=xxx\n' } });
    run(dir, ['rm', '.env.local']);
    run(dir, [...CLEAN_AUTHOR, 'commit', '-m', 'chore: remove']);

    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([6]);
  });

  it('[6] credentials vzniklé PŘEJMENOVÁNÍM, ne přidáním', () => {
    // `git mv notes.txt .env.local` je pro diff `R`, ne `A`. Bez `--no-renames`
    // se `.env.local` v seznamu cest neobjeví — přestože v HEAD je a nahraje se.
    const dir = makeRepo({ extraFile: { name: 'notes.txt', body: 'DB_PASSWORD=tajne\n' } });
    run(dir, ['mv', 'notes.txt', '.env.local']);
    run(dir, [...CLEAN_AUTHOR, 'commit', '-m', 'chore: rename']);

    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([6]);
  });

  it('[6] cesta přidaná jen v merge commitu', () => {
    // Bez `-m` nevypíše `--name-only` u merge commitu nic, takže evil merge
    // propašuje cestu, kterou nenese ani jedna větev.
    const dir = makeRepo();
    run(dir, ['checkout', '-qb', 'vetev']);
    writeFileSync(join(dir, 'jine.md'), 'nic\n', 'utf8');
    run(dir, ['add', '-A']);
    run(dir, [...CLEAN_AUTHOR, 'commit', '-m', 'docs: branch']);
    run(dir, ['checkout', '-q', 'main']);
    run(dir, [...CLEAN_AUTHOR, 'merge', '--no-ff', '--no-commit', 'vetev']);
    writeFileSync(join(dir, '.env.local'), 'AWS_SECRET_ACCESS_KEY=tajne\n', 'utf8');
    run(dir, ['add', '-f', '.env.local']);
    run(dir, [...CLEAN_AUTHOR, 'commit', '-m', 'chore: merge']);

    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([6]);
  });

  it('[6] tvar API klíče přežívá ve smazaném souboru', () => {
    const shaped = `${'sk'}-abcdefghijklmnopqrstuvwxyz0123`;
    const dir = makeRepo({ extraFile: { name: 'config.ts', body: `const key = '${shaped}';\n` } });
    writeFileSync(join(dir, 'config.ts'), 'const key = process.env.KEY;\n', 'utf8');
    run(dir, ['add', '-A']);
    run(dir, [...CLEAN_AUTHOR, 'commit', '-m', 'fix: read key from env']);

    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([6]);
  });

  it('[3] zásah v revizi až za hranicí dávky se pořád najde', () => {
    // Revize se `git grep` předávají jako argumenty a Windows má na argv tvrdý
    // limit: naměřeno 700 revizí → 78 zásahů, 800 revizí → nula, protože
    // execFileSync vyhodil a kontrola prohlásila za čistou historii, kterou
    // nikdy neotevřela. Dávky to řeší; tenhle test je zmenší, aby hranici
    // překročilo pět commitů místo stopadesáti.
    const dir = makeRepo({ extraFile: { name: 'notes.md', body: 'Postaveno pro AcmeCorp.\n' } });
    writeFileSync(join(dir, 'notes.md'), 'Nic konkrétního.\n', 'utf8');
    run(dir, ['add', '-A']);
    run(dir, [...CLEAN_AUTHOR, 'commit', '-m', 'docs: scrub']);
    for (let index = 0; index < 4; index += 1) {
      run(dir, [...CLEAN_AUTHOR, 'commit', '--allow-empty', '-m', `chore: ${index}`]);
    }

    // `rev-list --all` vypisuje od nejnovější, takže znečištěný kořen leží až
    // v druhé dávce. S jednou dávkou na všechno by tenhle test neměřil nic.
    const result = blindCheck(dir, { BLIND_CHECK_REV_CHUNK: '2' });
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([3]);
  });

  it('[3] a [6] rozbitá historie je selhání, ne prázdný nález', () => {
    // Kontroly nad historií skládají seznam revizí z `git rev-list --all`.
    // Kdyby se chyba gitu četla jako prázdný výstup, hlásily by čistou historii,
    // kterou nikdy neotevřely — tedy zelenou nad repozitářem, o kterém nic nevědí.
    const dir = makeRepo();
    writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), 'tohle není objekt\n', 'utf8');

    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(expect.arrayContaining([3, 6]));
    expect(result.out).toContain('historii se nepodařilo přečíst');
  });

  it('[3] a [6] nečitelný objekt je selhání, i když git vrátí „žádná shoda"', () => {
    // `git grep` vrací 1 jak při nulovém nálezu, tak když blob nešlo přečíst —
    // rozdíl je jen na stderr. Číst obojí stejně by znamenalo hlásit čistou
    // historii nad soubory, které nikdo neotevřel.
    const dir = makeRepo();
    const blob = execFileSync('git', ['rev-parse', 'HEAD:README.md'], { cwd: dir, encoding: 'utf8' }).trim();
    rmSync(join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true });

    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(expect.arrayContaining([3, 6]));
    expect(result.out).toContain('git grep nad historií selhal');
  });

  it('[5] skutečné jméno autora v adrese, organizátor nikde', () => {
    // `identityTokens` z configu, ne jen PUBLIC_TOKENS: účet sedí, jméno
    // organizátora v URL není, a jméno autora přesto jde ven.
    const result = pushHook(makeRepo(), `https://github.com/${ACCOUNT}/johndoe-hackathon.git`);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([5]);
  });

  it('[5] token v NÁZVU repozitáře, účet přitom správný', () => {
    // Adresu dostane hodnotitel dřív než obsah, a strom o svém vlastním URL nic
    // neví — kontrola 3 ho proto najít nemůže.
    const result = pushHook(makeRepo(), `https://github.com/${ACCOUNT}/Hackathon-AcmeCorp.git`);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([5]);
  });

  it('[4] SECURITY-FINDINGS.md v historii', () => {
    // Bez zakázaných jmen organizátora uvnitř, jinak by shodil i kontrolu 3 a tenhle test
    // by netvrdil nic o kontrole 4.
    const dir = makeRepo({ extraFile: { name: 'SECURITY-FINDINGS.md', body: 'interní nález\n' } });
    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([4]);
  });

  it('[5] cíl pushe míří na jiný účet', () => {
    const result = pushHook(makeRepo(), 'https://github.com/real-name/world.git');
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([5]);
  });

  /**
   * Tohle je ten nález celý: `git push https://github.com/<jméno>/x.git HEAD`.
   * Nastavený remote je čistý a zůstává čistý — kontrola, která čte `git remote -v`,
   * tady projde a push jde ven pod adresou se skutečným jménem.
   */
  it('[5] podvržená adresa v argv projde, i když nastavený remote je čistý', () => {
    const dir = makeRepo({ remote: `https://github.com/${ACCOUNT}/world.git` });
    const result = pushHook(dir, 'https://github.com/johndoe/worldsmith.git');
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([5]);
    expect(result.out).toContain('johndoe/worldsmith.git');
  });

  /**
   * Fail-closed. Hook, který argumenty zahodí, je rozbitý hook — a mlčení by
   * znamenalo push bez jediné kontroly cíle. Rozhoduje prostředí, ne počet
   * argumentů, takže tenhle běh nesmí spadnout do „ruční spuštění, přeskočit".
   */
  it('[5] hook bez předané adresy selže, nepřeskočí se', () => {
    const result = pushHook(makeRepo(), null);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([5]);
    expect(result.out).not.toContain('SKIP');
    expect(result.out).toContain('hook nepředal adresu');
  });

  /**
   * Nastavený remote už se nesoudí vůbec — kontrola má právě jeden vstup, a to
   * ten od gitu. Bez tohohle případu by prošla i implementace, která k adrese
   * přidá `git remote -v` „pro jistotu", a ta by hlásila cizí remote, na který
   * se nepushuje. Falešný nález v hooku = `--no-verify`, tedy obě brány pryč.
   */
  it('[5] špinavý NASTAVENÝ remote nález nedělá, když se pushuje jinam', () => {
    const dir = makeRepo({ remote: 'https://github.com/johndoe/soukromy-fork.git' });
    const result = pushHook(dir, `https://github.com/${ACCOUNT}/world.git`);
    expect(result.code).toBe(0);
    expect(failedChecks(result.out)).toEqual([]);
  });

  // Kontrola 6 přibyla s T18: repozitář od té chvíle poprvé sousedí se
  // skutečnými credentials a se syrovými odpověďmi poskytovatele. Obojí brání
  // `.gitignore`, a to je jedna editace od toho, aby nebránil nic.
  it('[6] soubor s credentials je trackovaný', () => {
    const result = blindCheck(makeRepo({ extraFile: { name: '.env.local', body: 'OPENAI_API_KEY=abc\n' } }));
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([6]);
  });

  it('[6] .env.example je vzor bez hodnot a projít MÁ', () => {
    // Kontrola polarity: kdyby vzor padal taky, ostrý repozitář by neprošel
    // nikdy a kontrola by se musela vypnout — tedy zmizet.
    const result = blindCheck(makeRepo({ extraFile: { name: '.env.example', body: 'OPENAI_API_KEY=\n' } }));
    expect(result.code).toBe(0);
    expect(failedChecks(result.out)).toEqual([]);
  });

  it('[6] syrová odpověď poskytovatele je trackovaná', () => {
    const result = blindCheck(
      makeRepo({ extraFile: { name: 'evals/live/RUN/responses/C01.json', body: '{"raw":{}}\n' } }),
    );
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([6]);
  });

  it('[6] .ENV.local velkými písmeny je pořád soubor s credentials', () => {
    // Na Windows i macOS je to funkční env soubor. Case-sensitive vzor by ho
    // minul a brána by propustila přesně to, kvůli čemu vznikla.
    const result = blindCheck(makeRepo({ extraFile: { name: '.ENV.local', body: 'OPENAI_API_KEY=abc\n' } }));
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([6]);
  });

  it('[6] cesta s diakritikou se neschová za uvozovky gitu', () => {
    // `ls-tree` bez `-z` cesty s ne-ASCII znaky uvozuje a vedoucí uvozovka
    // rozbije porovnání prefixu — soubor by branou prošel.
    const result = blindCheck(
      makeRepo({ extraFile: { name: 'evals/live/RUN/responses/Cžluťoučký.json', body: '{"raw":{}}\n' } }),
    );
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([6]);
  });

  it('[6] vývojový report z profilu předplatného je trackovaný', () => {
    // Leží v `evals/` vedle oficiálního `kill-gate-report.json`. Commitnutý ve
    // veřejném repu je to levné číslo na místě, kde ho někdo přečte jako
    // výsledek brány — přesně ta záměna, proti které profily vznikly.
    const result = blindCheck(
      makeRepo({ extraFile: { name: 'evals/dev-report.subscription.json', body: '{"profile":"subscription"}\n' } }),
    );
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([6]);
  });

  it('[6] oficiální kill-gate-report.json commitnutelný ZŮSTÁVÁ', () => {
    // Je to deliverable T21. Kdyby ho nová kontrola chytila taky, brána by
    // blokovala právě ten artefakt, kvůli kterému celý plán existuje.
    const result = blindCheck(
      makeRepo({ extraFile: { name: 'evals/kill-gate-report.json', body: '{"profile":"api"}\n' } }),
    );
    expect(result.code).toBe(0);
    expect(failedChecks(result.out)).toEqual([]);
  });

  it('[6] evals/live/.gitkeep je součást struktury a projít MÁ', () => {
    const result = blindCheck(makeRepo({ extraFile: { name: 'evals/live/.gitkeep', body: '' } }));
    expect(result.code).toBe(0);
    expect(failedChecks(result.out)).toEqual([]);
  });

  it('[6] řetězec ve tvaru API klíče v commitnutém obsahu', () => {
    // Skládá se za běhu, aby literál ve tvaru klíče **nebyl v tomhle souboru**.
    // Napsaný přímo by ho kontrola 6 našla v našem vlastním repozitáři a brána
    // by hlásila nález na svém vlastním testu — což je přesně ta past, do které
    // spadla kontrola 3 (viz poznámka u ní). Do dočasného repa se zapíše
    // skutečný tvar, takže test testuje pořád totéž.
    const shaped = `${'sk'}-abcdefghijklmnopqrstuvwxyz0123`;
    const result = blindCheck(makeRepo({ extraFile: { name: 'config.ts', body: `const key = '${shaped}';\n` } }));
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([6]);
  });
});

/**
 * Kontrola 3 hledala do 17. 8. 2026 v obsahu jen jména organizátora. Identitu autora
 * kryla kontrola 1 (`%an`/`%ae`) a kontrola 5 (adresa remote) — **obsah nekryl
 * nikdo**, takže commit se skutečným jménem v `README.md`, v `package.json` →
 * `author` nebo v komentáři prošel všemi šesti kontrolami zeleně.
 *
 * Testy níž drží tři různá tvrzení a je potřeba mít je oddělená: že se jméno
 * hledá **v celé historii**, že se **krátký token nehledá jako podřetězec**
 * (jinak by brána hlásila nález pořád a někdo by ji vypnul), a že se nalezené
 * jméno **nedostane do výpisu**.
 */
describe('kontrola 3 hledá i skutečné jméno autora, ne jen jméno organizátora', () => {
  it('[3] jméno autora v README.md', () => {
    const dir = makeRepo({ readme: '# world builder\n\nAutor: johndoe\n' });
    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([3]);
    expect(result.out).toContain('nese jméno autora');
  });

  /**
   * **Výpis brány je sám kanál úniku.** Nález se hlásí cestou (`git grep -l`),
   * nikdy nalezeným řádkem — ten řádek je právě to jméno, které se schovává, a
   * výstup jde do terminálu, do logu hooku a do artefaktu, který si někdo
   * rozbalí. Kontrola, která svůj nález vytiskne, ho tím zveřejní.
   */
  it('[3] nález jméno nevypíše, hlásí jen cestu', () => {
    const dir = makeRepo({ readme: '# world builder\n\nAutor: johndoe\n' });
    const result = blindCheck(dir);
    expect(failedChecks(result.out)).toEqual([3]);
    expect(result.out).not.toContain('johndoe');
    expect(result.out).toContain('README.md');
  });

  it('[3] jméno jen v rodičovském commitu, HEAD čistý', () => {
    // Push nahrává historii, ne snímek. Přesně tenhle tvar leží v ostrém repu:
    // soubor přidaný jedním commitem a smazaný druhým. Šest kontrol ho nevidělo.
    const dir = makeRepo({ extraFile: { name: 'diag.test.ts', body: '// fixture: johndoe\n' } });
    run(dir, ['rm', 'diag.test.ts']);
    run(dir, [...CLEAN_AUTHOR, 'commit', '-m', 'chore: drop the throwaway diagnostic test']);

    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([3]);
    expect(result.out).not.toContain('johndoe');
  });

  /**
   * Výjimka pro `scripts/blind-check.mjs` a jeho test platí jen na jméno
   * organizátora — ty tokeny mít MUSÍ, hledá je. Skutečné jméno autora v nich
   * nemá co dělat, a kdyby ho neslo, je to nález jako každý jiný.
   */
  it('[3] jméno autora ve vlastním skriptu brány je nález taky', () => {
    const dir = makeRepo({ extraFile: { name: 'scripts/blind-check.mjs', body: '// johndoe\n' } });
    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([3]);
  });

  /**
   * Naměřeno v ostrém repu: tříznakový token sedí jako podřetězec na 540 míst,
   * jako celé slovo na 2. Brána, která hlásí 540 zásahů pokaždé, se přestane
   * rozlišovat od skutečného úniku a někdo ji obejde `--no-verify` — což vypne
   * i clean-room kontrolu vedle. Proto se krátký token hledá `git grep -w`.
   */
  it('[3] krátký token jako podřetězec uvnitř slova PROJDE', () => {
    const dir = makeRepo({
      identityTokens: ['zqx'],
      extraFile: { name: 'notes.md', body: 'Slovo bezqxovy token neobsahuje samostatně.\n' },
    });
    const result = blindCheck(dir);
    expect(result.code).toBe(0);
    expect(failedChecks(result.out)).toEqual([]);
  });

  it('[3] týž krátký token jako celé slovo SPADNE', () => {
    // Druhá polovina předchozího případu. Bez ní by prošla i implementace, která
    // krátké tokeny přeskočí úplně — a to je kontrola, co nekontroluje nic.
    const dir = makeRepo({
      identityTokens: ['zqx'],
      extraFile: { name: 'notes.md', body: 'Podepsáno: zqx, konec.\n' },
    });
    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([3]);
  });

  it('[3] hranice je pět znaků: pětiznakový token se hledá jako podřetězec', () => {
    const dir = makeRepo({
      identityTokens: ['zqxvw'],
      extraFile: { name: 'notes.md', body: 'Slitý tvar bezqxvwovy.\n' },
    });
    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([3]);
  });

  it('[3] hranice je pět znaků: čtyřznakový už jen na hranici slova', () => {
    const dir = makeRepo({
      identityTokens: ['zqxv'],
      extraFile: { name: 'notes.md', body: 'Slitý tvar bezqxvovy.\n' },
    });
    const result = blindCheck(dir);
    expect(result.code).toBe(0);
    expect(failedChecks(result.out)).toEqual([]);
  });

  /**
   * Fail-closed. Bez configu se identita nedá hledat vůbec, a kontrola, která
   * to mlčky vezme jako „nic jsem nenašla", je zelená nad polovinou nevykonané
   * práce. Kontrola 1 padá ze stejného důvodu — proto se čeká přesně dvojice.
   */
  it('[3] bez configu selže, nemlčí', () => {
    const result = blindCheck(makeRepo({ noConfig: true }));
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([1, 3]);
    expect(result.out).toContain('blind-check.config.json chybí');
  });

  /**
   * **Nová díra, kterou otevřel přesun jmen organizátora do configu (19. 8. 2026).**
   *
   * Dokud byla v kódu, nešla vypnout. Teď jdou z configu — a config se dá
   * upravit. Prázdný seznam by z kontroly 3 udělal hledání ničeho a zelená by
   * pak znamenala jen to, že se nehledalo; přesně ta tichá zelená, kvůli které
   * se brána staví. Proto je prázdný i chybějící seznam **selhání configu**, ne
   * povolení, a padá na něm stejná dvojice kontrol jako u chybějícího souboru.
   *
   * Obě větve zvlášť: klíč s prázdným polem a klíč, který tam vůbec není. Sejdou
   * se až v `loadConfig`, takže jedna z nich by sama o sobě druhou nepokryla,
   * kdyby se ta funkce rozdělila.
   */
  it('[3] prázdný seznam jmen organizátora je selhání, ne povolení', () => {
    const result = blindCheck(makeRepo({ publicTokens: [] }));
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([1, 3]);
    expect(result.out).toContain('nemá publicTokens');
  });

  it('[3] chybějící klíč publicTokens je selhání, ne povolení', () => {
    const result = blindCheck(makeRepo({ omitPublicTokens: true }));
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([1, 3]);
    expect(result.out).toContain('nemá publicTokens');
  });
});

/**
 * Kontrola 5 je jen tak silná, jak silné je její napojení: adresu jí může podat
 * výhradně hook. Testy výš dokazují, co skript s podanou adresou udělá — tenhle
 * dokazuje, že mu ji hook vůbec podá.
 *
 * **Co tenhle test nedokazuje:** že sh ten řádek opravdu provede. Skutečný push
 * se otestovat nedá — každá adresa, na kterou by šel poslat, kontrolou 5 padá,
 * takže by běh dopadl stejně i s rozbitým hookem a test by neměřil nic.
 */
describe('pre-push hook napojí kontrolu na cíl, který mu podal git', () => {
  const hook = readFileSync(join(process.cwd(), '.githooks', 'pre-push'), 'utf8');

  it('předá skriptu své argumenty', () => {
    expect(hook).toMatch(/node scripts\/blind-check\.mjs "\$@"/);
  });

  it('označí běh jako hook, aby chybějící adresa byla selhání', () => {
    expect(hook).toMatch(/BLIND_CHECK_HOOK=pre-push/);
    expect(hook).toMatch(/export BLIND_CHECK_HOOK/);
  });
});
