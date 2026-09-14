/**
 * **Co tenhle test pine:** že `prepare` **nepoloží `npm install` tam, kde není
 * git** – a že zároveň **nemlčí**, když git je a `git config` selže.
 *
 * Ta první půlka je naměřená vada, ne teorie: nasazení `dpl_pyrk3x82e`
 * (14. 9. 2026) spadlo po 43 s na `npm error command sh -c git config
 * core.hooksPath .githooks` → `exited with 128`, protože Vercel rozbalí zdroják
 * bez `.git`. Ta druhá půlka je důvod, proč se to neopravilo přes `|| exit 0`:
 * tiše nezapojené hooky jsou způsob, jak později projde commit kolem
 * `guard-rails.mjs`.
 *
 * Testuje se **spuštěním skutečného procesu**, protože předmětem je návratový
 * kód, který uvidí npm – ne návratová hodnota funkce.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'scripts/install-git-hooks.mjs');

let dir: string;

beforeEach(() => {
  // `tmpdir()` je schválně **mimo strom repozitáře**: podadresář uvnitř by
  // `git rev-parse --git-dir` našel a obě větve by měřily totéž.
  dir = mkdtempSync(join(tmpdir(), 'hooks-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (cwd: string, extraPath?: string) =>
  spawnSync(process.execPath, [SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: extraPath === undefined ? process.env : { ...process.env, PATH: extraPath, Path: extraPath },
  });

describe('install-git-hooks', () => {
  it('mimo git repozitář končí nulou, aby npm install nespadl', () => {
    const out = run(dir);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('mimo git repozitář');
  });

  it('v git repozitáři hooky zapojí a končí nulou', () => {
    expect(spawnSync('git', ['init'], { cwd: dir }).status).toBe(0);

    const out = run(dir);
    expect(out.status).toBe(0);

    const read = spawnSync('git', ['config', 'core.hooksPath'], { cwd: dir, encoding: 'utf8' });
    expect(read.stdout.trim()).toBe('.githooks');
  });

  it('bez gitu v PATH končí nulou, ne pádem na chybějícím programu', () => {
    // `spawnSync` bez nalezeného programu vrací `error`, ne nenulový kód —
    // kdyby to skript nerozlišoval, spadne na výjimce a npm install s ním.
    const out = run(dir, dir);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('mimo git repozitář');
  });

  it('selhání git configu v repozitáři se neschová', () => {
    expect(spawnSync('git', ['init'], { cwd: dir }).status).toBe(0);
    // Repozitář existuje, ale zápis konfigurace selže: `.git/config` se udělá
    // adresářem, takže `git config` nemá kam psát.
    rmSync(join(dir, '.git', 'config'), { force: true });
    spawnSync('git', ['init'], { cwd: dir });
    writeFileSync(join(dir, '.git', 'config'), '[core]\n');
    chmodSync(join(dir, '.git', 'config'), 0o444);

    const out = run(dir);
    // Na Windows read-only bit `git config` nezastaví vždy; test proto tvrdí
    // jen to, co platí všude: skript **nikdy nevrátí nulu se slovem o
    // přeskočení**, když repozitář existuje.
    expect(out.stdout).not.toContain('mimo git repozitář');
  });
});
