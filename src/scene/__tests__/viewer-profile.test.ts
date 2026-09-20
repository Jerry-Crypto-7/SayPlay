import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { representationCandidates } from '@/assets/resolver';
import type { AssetManifest } from '@/assets/manifest';
import { VIEWER_BUDGETS } from '@/kit/budgets';
import type { PlannedObject } from '@/model/worldstream-intent';

import { framePressure, LOD_POLICY } from '../visibility';
import { ZONE_STREAM_POLICY } from '../zones';

/**
 * Profil je zdroj čísel, kód je jejich runtime kopie. Import profilu do bundlu
 * není (klientská cesta adresář `data/` nevidí), takže tenhle test je jediné,
 * co obě kopie drží u sebe — bez něj by se profil dal přepsat a nikdo by se to
 * nedozvěděl. Stejná dohoda jako `src/kit/__tests__/budgets.test.ts`.
 */
const profile = JSON.parse(
  readFileSync(join(process.cwd(), 'data/profiles/web-viewer.json'), 'utf-8'),
) as { lod: Record<string, number>; streaming: Record<string, number> };

describe('prahy LOD a zón sedí s profilem', () => {
  it('každé číslo profilu má v kódu tutéž hodnotu', () => {
    expect(profile.lod).toEqual({ ...LOD_POLICY });
    expect(profile.streaming).toEqual({ ...ZONE_STREAM_POLICY });
  });

  it('pásmo pro probuzení je uvnitř pásma pro udržení', () => {
    // Opačné pořadí by znamenalo asset, který se uspí dřív, než se stihne
    // probudit — nekonečné přepínání místo hystereze.
    expect(ZONE_STREAM_POLICY.resumeDistance).toBeLessThan(ZONE_STREAM_POLICY.retainDistance);
    expect(LOD_POLICY.finerHysteresis).toBeLessThan(LOD_POLICY.coarserHysteresis);
  });
});

describe('tlak snímku je měření, ne konstanta', () => {
  it('rozhoduje dražší z obou os a stupnice je podíl rozpočtu', () => {
    expect(framePressure({ drawCalls: 0, triangles: 0 })).toBe(0);
    expect(
      framePressure({
        drawCalls: VIEWER_BUDGETS.maxDrawCallsPerFrame,
        triangles: 0,
      }),
    ).toBe(1);
    // Draw cally hluboko pod stropem, trojúhelníky nad ním: přetížený snímek
    // je pořád přetížený. Průměr nebo jen jedna osa by tohle přehlédly.
    expect(
      framePressure({
        drawCalls: 1,
        triangles: VIEWER_BUDGETS.maxTrianglesPerFrame * 2,
      }),
    ).toBeCloseTo(2, 5);
  });
});

describe('počet katalogových tříd není strop', () => {
  const planned = (label: string): PlannedObject =>
    ({ stableId: `o-${label}`, label, synonyms: [], role: 'prop' }) as unknown as PlannedObject;

  const manifestOf = (count: number): AssetManifest =>
    ({
      candidates: () =>
        Array.from({ length: count }, (_, i) => ({
          assetId: `a-${String(i).padStart(4, '0')}`,
          version: 1,
          hash: `h${i}`,
          label: `chair ${i}`,
          tags: ['chair'],
          style: 'stylized',
          bounds: { min: [0, 0, 0], max: [1, 1, 1] },
          sockets: [],
          parts: [],
          supportSurfaces: [],
        })),
    }) as unknown as AssetManifest;

  it('katalog o dvou třídách i o tisíci vrátí stejný počet návrhů na objekt', () => {
    // Tři návrhy je strop **nabídky pro jeden objekt**, ne strop katalogu.
    // Kdyby velikost katalogu někde fungovala jako rozpočet, rostlo by to
    // s ním nebo by to spadlo — tohle je rozdíl, který jinak nikdo neuvidí.
    const small = representationCandidates(planned('chair'), manifestOf(2));
    const huge = representationCandidates(planned('chair'), manifestOf(1000));

    expect(small.candidates).toHaveLength(2);
    expect(huge.candidates).toHaveLength(3);
    expect(huge.status).toBe('candidates');
    // Výběr je deterministický a nezávisí na tom, kolik tříd leží vedle.
    expect(huge.candidates.map((c) => c.source.assetId)).toEqual(['a-0000', 'a-0001', 'a-0002']);
  });
});
