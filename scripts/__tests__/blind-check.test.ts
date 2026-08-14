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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'blind-check.mjs');
const CLEAN_AUTHOR = ['-c', 'user.name=worldsmith', '-c', 'user.email=worldsmith@users.noreply.github.com'];
const ACCOUNT = 'anon-account';
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
  writeFileSync(
    join(dir, 'blind-check.config.json'),
    JSON.stringify({ account: ACCOUNT, identityTokens: ['johndoe'] }),
    'utf8',
  );
  writeFileSync(join(dir, 'README.md'), '# world builder\n\nNic, co by jmenovalo autora.\n', 'utf8');
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

function blindCheck(cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });
    return { code: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? -1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
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
  it('vrátí 0 a všech šest kontrol projde', () => {
    const result = blindCheck(makeRepo());
    expect(result.out).toContain('Všech 6 kontrol prošlo');
    expect(failedChecks(result.out)).toEqual([]);
    expect(result.code).toBe(0);
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

  it('[4] SECURITY-FINDINGS.md v historii', () => {
    // Bez `acmecorp`/`acme` uvnitř, jinak by shodil i kontrolu 3 a tenhle test
    // by netvrdil nic o kontrole 4.
    const dir = makeRepo({ extraFile: { name: 'SECURITY-FINDINGS.md', body: 'interní nález\n' } });
    const result = blindCheck(dir);
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([4]);
  });

  it('[5] remote míří na jiný účet', () => {
    const result = blindCheck(makeRepo({ remote: 'https://github.com/real-name/world.git' }));
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([5]);
  });

  it('[5] repozitář bez remote se neprohlásí za v pořádku', () => {
    const result = blindCheck(makeRepo({ remote: null }));
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual([5]);
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
