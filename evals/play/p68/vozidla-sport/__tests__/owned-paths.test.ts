/**
 * P68V T1: hlídač vlastnictví. Hlídač, který pustí cizí cestu, vypadá jako ochrana a nechá pruh tiše
 * změnit sdílený soubor; proto tři cesty (vlastní, sdílený klasifikátor, plán) i přes skutečný příkaz.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { foreignPaths } from '../owned-paths.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'owned-paths.mjs');

const run = (stdin: string) => spawnSync(process.execPath, [SCRIPT], { input: stdin, encoding: 'utf8' });

describe('P68V owned paths', () => {
  it('lets the lane own its game files and nothing shared', () => {
    expect(foreignPaths(['src/play/arcade/pieces/stunt-impact.ts'])).toEqual([]);
    expect(foreignPaths(['src/play/genre/classify.ts'])).toEqual(['src/play/genre/classify.ts']);
    expect(foreignPaths(['plans/x.md'])).toEqual(['plans/x.md']);
  });

  it('covers every path family the plan hands to the lane', () => {
    const own = [
      'src/play/genre/stunt.ts',
      'src/play/genre/minigolf.ts',
      'src/play/genre/__tests__/stunt-module.test.ts',
      'src/play/arcade/pieces/minigolf-bot.ts',
      'src/play/arcade/__tests__/minigolf-replay.test.ts',
      'src/components/play/arcade/genres/stunt/StuntScene.tsx',
      'src/components/play/arcade/genres/minigolf/__tests__/minigolf-touch.test.ts',
      'e2e/play-stunt.spec.ts',
      'e2e/fixtures/p68-minigolf-spec.json',
      'evals/play/p68/vozidla-sport/integration.md',
    ];
    expect(foreignPaths(own)).toEqual([]);
  });

  it('refuses near misses: shared registries, other lanes, other games', () => {
    const shared = [
      'src/play/genre/contract.ts',
      'src/play/arcade/pieces/steer.ts',
      'src/play/arcade/physics/step.ts',
      'src/components/play/arcade/ArcadeStage.tsx',
      'src/components/play/arcade/genres/railfps/RailfpsScene.tsx',
      'evals/play/p68/README.md',
      'evals/play/p68/stavba/integration.md',
      'e2e/play-drive.spec.ts',
      'e2e/hud-labels.ts',
      'playwright.config.ts',
      'public/models/car.glb',
      'src/play/arcade/pieces/stunt/inner.ts',
    ];
    expect(foreignPaths(shared)).toEqual(shared);
  });

  it('exits 0 on own paths, 1 with the foreign path printed otherwise', () => {
    expect(run('src/play/arcade/pieces/stunt.ts\nevals/play/p68/vozidla-sport/dev.json\n').status).toBe(0);
    const bad = run('src/play/arcade/pieces/stunt.ts\r\nsrc/play/genre/classify.ts\r\n');
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('src/play/genre/classify.ts');
    expect(bad.stdout).not.toContain('pieces/stunt.ts');
  });

  it('accepts an empty diff', () => {
    expect(run('').status).toBe(0);
  });
});
