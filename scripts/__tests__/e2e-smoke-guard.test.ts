/**
 * Prázdná `FALLBACK_SMOKE_URL` nesmí vyrobit zelený běh, který nic nedokázal.
 *
 * `playwright.config.ts` proměnnou soudil pravdivostně a
 * `e2e/worldstream-session.spec.ts` porovnáním s `undefined`. Na
 * `FALLBACK_SMOKE_URL=""` se ti dva rozešli: config nastartoval lokální server,
 * spec se přesto **celý přeskočil**, a sada skončila zeleně, aniž spustila
 * jediný test. Nález nezávislé revize 2. 9. 2026.
 *
 * Vada je právě v tom rozporu, ne v jedné z těch dvou podmínek, takže se tady
 * tvrdí obojí: co `deployedTarget()` vrátí, a že **z něj čtou oba** — přímé
 * `process.env.FALLBACK_SMOKE_URL` kdekoliv jinde než v helperu je návrat
 * druhého nezávislého čtenáře, tedy návrat té vady.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { deployedTarget } from '../../e2e/smoke-target';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const before = process.env.FALLBACK_SMOKE_URL;

afterEach(() => {
  if (before === undefined) delete process.env.FALLBACK_SMOKE_URL;
  else process.env.FALLBACK_SMOKE_URL = before;
});

describe('deployedTarget', () => {
  it('prázdná proměnná znamená nenastaveno, ne adresu ""', () => {
    process.env.FALLBACK_SMOKE_URL = '';
    expect(deployedTarget()).toBeUndefined();
  });

  it('nenastavená proměnná znamená nenastaveno', () => {
    delete process.env.FALLBACK_SMOKE_URL;
    expect(deployedTarget()).toBeUndefined();
  });

  it('skutečnou adresu vrátí beze změny', () => {
    process.env.FALLBACK_SMOKE_URL = 'https://worldstream.example/';
    expect(deployedTarget()).toBe('https://worldstream.example/');
  });
});

describe('o adrese rozhoduje jedno místo', () => {
  // Tenhle test nejdřív ověří, že vůbec čte soubory: nula přečtených souborů
  // je selhání, ne čistý výsledek.
  // Spec `worldstream-session` odešel se starým studiem (P44D T3); config zůstal.
  const readers = ['playwright.config.ts'];

  it('config ani spec nečtou proměnnou přímo', () => {
    const sources = readers.map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));

    expect(sources).toHaveLength(1);
    for (const source of sources) {
      expect(source.text.length).toBeGreaterThan(0);
      expect(source.path + ': ' + String(source.text.includes('process.env.FALLBACK_SMOKE_URL'))).toBe(
        source.path + ': false',
      );
      expect(source.text).toContain('deployedTarget()');
    }
  });
});
