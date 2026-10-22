import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOOK_IDS } from '@/play/arcade/look';
import { modelPath } from '@/play/arcade/models';
import { OBSTACLE_KINDS } from '@/play/arcade/pieces/runner';

import obstacleKits from '../obstacle-kits.json';

/**
 * Díly prostředí místo šedých kvádrů (P56B T10): každá sada má pro každou překážku běžce a pro plot
 * arény model, který leží v `public/` a nemá licenci CC BY-ND (díl se vepisuje a přebarvuje).
 */
const ROOT = process.cwd();
const disclosure = JSON.parse(readFileSync(join(ROOT, 'disclosure.json'), 'utf8')) as { entries: { name: string; license?: string }[] };
const licenseOf = new Map(disclosure.entries.map((entry) => [entry.name, entry.license]));
const kits = obstacleKits.kits as Readonly<Record<string, Readonly<Record<string, string>>>>;
const KINDS = [...OBSTACLE_KINDS, 'block'] as const;

describe('obstacle kits', () => {
  it('cover exactly the 18 sets', () => {
    expect(Object.keys(kits).sort()).toEqual([...LOOK_IDS].sort());
  });

  for (const look of LOOK_IDS) {
    it(`${look} has a model for every obstacle kind and the arena block`, () => {
      for (const kind of KINDS) expect(kits[look]?.[kind], `${look} ${kind}`).toMatch(/\S/);
    });

    it(`${look} models exist in public/ and none is CC BY-ND`, () => {
      for (const kind of KINDS) {
        const file = `public${modelPath(kits[look]![kind]!)}`;
        expect(existsSync(join(ROOT, file)), `${look} ${kind}: ${file}`).toBe(true);
        const license = licenseOf.get(file);
        expect(license, `${look} ${kind}: ${file} has no disclosure entry`).toBeDefined();
        expect(license, `${look} ${kind}: ${file}`).not.toMatch(/\bND\b|NoDerivatives/i);
      }
    });
  }
});
