/**
 * Strážce vlastních souborů pruhu P68-S (T1). Strážce, který pustí každou cestu, vypadá stejně jako funkční, proto test
 * podstrčí sdílený soubor (musí neprojít) i vlastní soubor hry (musí projít), čistou funkcí i přes `--stdin`.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { foreignPaths, isOwnPath } from '../own-files.mjs';

const SCRIPT = join(process.cwd(), 'evals', 'play', 'p68', 'stavba', 'own-files.mjs');
const run = (input: string) => spawnSync(process.execPath, [SCRIPT, '--stdin'], { input, encoding: 'utf8' });

const OWN = [
  'src/play/genre/buildshift.ts',
  'src/play/genre/drawsave.ts',
  'src/play/arcade/pieces/buildshift.ts',
  'src/play/arcade/pieces/buildshift-world.ts',
  'src/play/arcade/pieces/buildshift-bot.ts',
  'src/play/arcade/pieces/drawsave-world.ts',
  'src/components/play/arcade/genres/buildshift/BuildshiftScene.tsx',
  'src/components/play/arcade/genres/buildshift/__tests__/buildshift-camera.test.ts',
  'src/components/play/arcade/genres/drawsave/DrawsaveScene.tsx',
  'e2e/play-buildshift.spec.ts',
  'e2e/play-drawsave.spec.ts',
  'e2e/fixtures/p68-buildshift-spec.json',
  'e2e/fixtures/p68-drawsave-spec.json',
  'src/play/arcade/__tests__/buildshift.test.ts',
  'src/play/arcade/__tests__/buildshift-bot.test.ts',
  'src/play/arcade/__tests__/drawsave.test.ts',
  'src/play/genre/__tests__/buildshift.test.ts',
  'src/play/genre/__tests__/drawsave.test.ts',
  'evals/play/p68/stavba/README.md',
  'evals/play/p68/stavba/__tests__/own-files.test.ts',
];

const SHARED = [
  'src/play/genre/classify.ts',
  'src/play/genre/contract.ts',
  'src/play/genre/modules.ts',
  'src/play/genre/defense.ts',
  'src/play/genre/buildshift-extra.ts',
  'src/play/arcade/library.ts',
  'src/play/arcade/pieces/lanes.ts',
  'src/play/arcade/pieces/sub/buildshift.ts',
  'src/play/arcade/__tests__/p68-hash.test.ts',
  'src/play/compose/stage-registry.ts',
  'src/components/play/arcade/ArcadeStage.tsx',
  'src/components/play/arcade/genres/survivor/SurvivorScene.tsx',
  'src/components/play/arcade/genres/touch-registry.ts',
  'e2e/play-survivor.spec.ts',
  'e2e/fixtures/p66-survivor-spec.json',
  'e2e/hud-labels.ts',
  'evals/play/p68/README.md',
  'evals/play/p68/vozidla-sport/integration.md',
  'playwright.config.ts',
  'package.json',
  'public/models/oven.glb',
];

describe('P68-S own-files guard', () => {
  it('accepts every path the lane owns', () => {
    for (const path of OWN) expect(isOwnPath(path), path).toBe(true);
    expect(foreignPaths(OWN)).toEqual([]);
  });

  it('rejects every shared path, including near misses of the own globs', () => {
    for (const path of SHARED) expect(isOwnPath(path), path).toBe(false);
    expect(foreignPaths([...OWN, ...SHARED])).toEqual(SHARED);
  });

  it('treats Windows separators and blank lines like the git output', () => {
    expect(foreignPaths(['src\\play\\genre\\buildshift.ts', '', '  '])).toEqual([]);
    expect(foreignPaths(['src\\play\\genre\\classify.ts'])).toEqual(['src/play/genre/classify.ts']);
  });

  it('exits 1 and names the shared file read from stdin', () => {
    const bad = run('src/play/genre/buildshift.ts\nsrc/play/genre/classify.ts\n');
    expect(bad.status).toBe(1);
    expect(bad.stdout + bad.stderr).toContain('src/play/genre/classify.ts');
  });

  it('exits 0 for own files read from stdin', () => {
    const good = run('src/play/genre/buildshift.ts\nevals/play/p68/stavba/dev.json\n');
    expect(good.stderr).toBe('');
    expect(good.status).toBe(0);
  });
});
