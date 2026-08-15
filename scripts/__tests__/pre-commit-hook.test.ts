/**
 * `.githooks/pre-commit` má od 15. 8. 2026 vlastní logiku, a proto vlastní test.
 *
 * Vada, kterou hlídá: dřív tu bylo `set -e`, takže první selhavší brána tu druhou
 * nespustila. Jakmile clean-room brána začala nad nenaplněným seznamem správně
 * selhávat, licenční registr se přestal kontrolovat úplně — a jediná cesta dál
 * byla `--no-verify`, která vypne obě. Přísnější brána vypnula tu druhou.
 *
 * Brány se nahrazují útržky, které jen vypíšou značku a skončí zadaným kódem.
 * Testuje se hook, ne to, co brány měří — na to mají vlastní sadu.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const HOOK = join(process.cwd(), '.githooks', 'pre-commit');
const created: string[] = [];

/** Útržek místo brány: vypíše značku a skončí zadaným kódem. */
function stub(dir: string, name: string, marker: string, code: number): void {
  const target = join(dir, 'scripts', name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `console.log('${marker}');\nprocess.exit(${code});\n`, 'utf8');
}

function runHook(licenseCode: number, cleanroomCode: number): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pre-commit-'));
  created.push(dir);
  mkdirSync(join(dir, '.githooks'), { recursive: true });
  copyFileSync(HOOK, join(dir, '.githooks', 'pre-commit'));
  chmodSync(join(dir, '.githooks', 'pre-commit'), 0o755);
  stub(dir, 'license-gate.mjs', 'LICENSE-RAN', licenseCode);
  stub(dir, 'cleanroom-check.mjs', 'CLEANROOM-RAN', cleanroomCode);

  try {
    const out = execFileSync('sh', ['.githooks/pre-commit'], { cwd: dir, encoding: 'utf8' });
    return { code: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? -1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe('pre-commit: jedna brána nesmí vypnout druhou', () => {
  it('obě brány zelené — commit projde', () => {
    const { code, out } = runHook(0, 0);
    expect(out).toContain('LICENSE-RAN');
    expect(out).toContain('CLEANROOM-RAN');
    expect(code).toBe(0);
  });

  it('padlá licenční brána clean-room bránu PŘESTO spustí', () => {
    // Přesně to, co `set -e` neumělo: po prvním nenulovém návratu skript končil.
    const { code, out } = runHook(1, 0);
    expect(out).toContain('LICENSE-RAN');
    expect(out).toContain('CLEANROOM-RAN');
    expect(code).toBe(1);
  });

  it('padlá clean-room brána nezakryje výsledek licenční', () => {
    const { code, out } = runHook(0, 1);
    expect(out).toContain('LICENSE-RAN');
    expect(out).toContain('CLEANROOM-RAN');
    expect(code).toBe(1);
  });

  it('obě padlé — obě se ohlásí a exit je pořád 1, ne součet', () => {
    const { code, out } = runHook(1, 1);
    expect(out).toContain('LICENSE-RAN');
    expect(out).toContain('CLEANROOM-RAN');
    expect(code).toBe(1);
  });

  it('při selhání řekne, že --no-verify vypne obě brány', () => {
    expect(runHook(1, 0).out).toContain('--no-verify');
  });

  it('hook promíjí nenaplněný seznam, aby kvůli němu nikdo nesahal po --no-verify', () => {
    // Prominutí se předává jen clean-room bráně a jen tady. Samostatný běh
    // (`npm run gate:cleanroom`, CI) proměnnou nedostane a selže.
    const dir = mkdtempSync(join(tmpdir(), 'pre-commit-waiver-'));
    created.push(dir);
    mkdirSync(join(dir, '.githooks'), { recursive: true });
    copyFileSync(HOOK, join(dir, '.githooks', 'pre-commit'));
    stub(dir, 'license-gate.mjs', 'LICENSE-RAN', 0);
    writeFileSync(
      join(dir, 'scripts', 'cleanroom-check.mjs'),
      "console.log(process.env.CLEANROOM_ALLOW_UNPROVISIONED === '1' ? 'WAIVED' : 'NOT-WAIVED');\n",
      'utf8',
    );

    // Proměnná se v dětském prostředí schválně maže: kdyby ji zdědil po vitest,
    // test by prošel i hooku, který ji vůbec nepředává.
    const out = execFileSync('sh', ['.githooks/pre-commit'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, CLEANROOM_ALLOW_UNPROVISIONED: '' },
    });
    expect(out).toContain('WAIVED');
    expect(out).not.toContain('NOT-WAIVED');
  });

  it('prominutí NEDOSTANE licenční brána — je to výjimka pro jednu z nich', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pre-commit-scope-'));
    created.push(dir);
    mkdirSync(join(dir, '.githooks'), { recursive: true });
    copyFileSync(HOOK, join(dir, '.githooks', 'pre-commit'));
    stub(dir, 'cleanroom-check.mjs', 'CLEANROOM-RAN', 0);
    writeFileSync(
      join(dir, 'scripts', 'license-gate.mjs'),
      "console.log(process.env.CLEANROOM_ALLOW_UNPROVISIONED === '1' ? 'LEAKED' : 'SCOPED');\n",
      'utf8',
    );

    const out = execFileSync('sh', ['.githooks/pre-commit'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, CLEANROOM_ALLOW_UNPROVISIONED: '' },
    });
    expect(out).toContain('SCOPED');
  });
});
