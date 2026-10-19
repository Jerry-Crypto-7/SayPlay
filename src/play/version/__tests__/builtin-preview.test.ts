/**
 * Kurátorský pool feedu (P54A T3): každá vestavěná hra nese skript náhledu
 * robota, který po přehrání skončí v uloženém hashi, a oba snímky karty.
 * Prázdný nebo černý snímek projde každou kontrolou existence souboru – proto
 * spodní mez velikosti: jednobarevné WebP 720×1280 má pod 1 KB.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { preloadPhysics } from '@/play/arcade/compile';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { loadRapier } from '@/play/arcade/physics/world';

import thumbs from '@/components/play/feed/feed-thumbs.json';

import { BUILTIN_GAMES } from '../builtin';
import { decodePreview } from '../preview';

const THUMBS = join(process.cwd(), 'public/feed-thumbs');

describe('vestavěný pool feedu', () => {
  beforeAll(async () => {
    await Promise.all(BUILTIN_GAMES.map((game) => preloadPhysics(game.spec, loadRapier)));
  });

  it('má aspoň 40 her z aspoň 6 žánrů', () => {
    expect(BUILTIN_GAMES.length).toBeGreaterThanOrEqual(40);
    // Hra bez žánru (starší ovládání, např. `ball`) se počítá podle ovládání.
    expect(new Set(BUILTIN_GAMES.map((game) => game.spec.genre?.id ?? game.spec.control)).size).toBeGreaterThanOrEqual(6);
  });

  it('každá hra má náhled, jehož přehrání skončí v uloženém hashi', () => {
    for (const game of BUILTIN_GAMES) {
      const { title } = game.version;
      if (game.preview === undefined || game.arcade === undefined) throw new Error(`${title} has no preview or arcade world`);
      const preview = decodePreview(game.preview);
      expect(replay(game.arcade, preview.inputs, ARCADE_LIBRARY, preview.endTick).hash, title).toBe(preview.hash);
    }
  }, 120_000);

  it('každá hra má snímek na výšku i na šířku, ne prázdný a do 40 KB', () => {
    for (const game of BUILTIN_GAMES) {
      for (const suffix of ['p', 'l']) {
        const file = join(THUMBS, `${game.version.versionId}-${suffix}.webp`);
        const bytes = statSync(file).size;
        expect(bytes, file).toBeGreaterThan(3 * 1024);
        expect(bytes, file).toBeLessThanOrEqual(40 * 1024);
        expect(readFileSync(file).subarray(8, 12).toString('latin1'), file).toBe('WEBP');
      }
    }
  });

  it('feed zná snímky právě těchto her (`feed-thumbs.json`, T8) – jiná hra by dostala 404 místo obrázku odkazu', () => {
    expect([...thumbs].sort()).toEqual(BUILTIN_GAMES.map((game) => game.version.versionId).sort());
  });
});
