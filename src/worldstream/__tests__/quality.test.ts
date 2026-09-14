/**
 * **Adaptivní kvalita** (P15 T26).
 *
 * `Test level: pin`. Hezký výsledek může tiše přetéct rozpočet, a hlavně:
 * **rozpočet, který se rozejde s tím, co kód doopravdy dělá, vypadá v kódu i
 * v testu úplně stejně jako rozpočet, který drží.** Tenhle soubor proto soudí
 * dvě věci, na které se okem podívat nedá:
 *
 * 1. tabulka rozpočtů odpovídá tomu, co `MESH_DETAIL` a `§23` říkají — čísla
 *    nejsou opsaná podruhé, ale porovnaná se svým zdrojem;
 * 2. úroveň se čte **jednou, před fan-outem**, takže z jedné stavby nemůže
 *    vyjít víc než jedno rozlišení.
 */

import { describe, expect, it, vi } from 'vitest';

import { MESH_DETAIL, type ShapeProgram } from '@/shape/types';
import type { MeshOrder, MeshResult } from '@/shape/mesh-client';

import { buildProxyWorld, overBudgetReason } from '../proxy';
import {
  pickStoredBlueprint,
  DEGRADE_LADDER,
  QUALITY_BUDGETS,
  QUALITY_TIERS,
  budgetFor,
  chooseQualityTier,
  degrade,
  detailLevelFor,
  everyTierIsPlayable,
  isQualityTier,
  spentBetween,
} from '../quality';
import { createSession, restoreSession } from '../session';

/* ------------------------------------------------------------------ *
 * Rozpočty proti svému zdroji.
 * ------------------------------------------------------------------ */

describe('rozpočty', () => {
  it('nejnižší úroveň je pořád hratelný svět, ne nouzový režim', () => {
    expect(everyTierIsPlayable()).toBe(true);
  });

  it('každá úroveň soudí trojúhelníky týmž stropem jako brána meshe', () => {
    // Kdyby si `quality.ts` napsalo vlastní číslo, byla by brána §12 volnější
    // nebo přísnější než rozpočet a nikdo by to nepoznal až do chvíle, kdy
    // jedno z těch dvou čísel někdo změní.
    for (const tier of QUALITY_TIERS) {
      const budget = budgetFor(tier);
      const rung = budget.detailResolution === MESH_DETAIL.high.resolution ? 'high' : 'rough';
      expect(budget.maxTrianglesPerHero).toBe(MESH_DETAIL[rung].maxTriangles);
    }
  });

  it('žádná úroveň nechce mřížku, kterou meshovač nezná', () => {
    const known = [MESH_DETAIL.rough.resolution, MESH_DETAIL.high.resolution];
    for (const tier of QUALITY_TIERS) {
      expect(known).toContain(budgetFor(tier).roughResolution);
      expect(known).toContain(budgetFor(tier).detailResolution);
    }
  });

  it('rozpočty klesají monotónně a hrdinů nikdy nepřibude', () => {
    for (let index = 1; index < QUALITY_TIERS.length; index += 1) {
      const above = budgetFor(QUALITY_TIERS[index - 1]);
      const below = budgetFor(QUALITY_TIERS[index]);
      expect(below.heroes).toBeLessThan(above.heroes);
      expect(below.maxSceneTriangles).toBeLessThan(above.maxSceneTriangles);
      expect(below.maxDrawCalls).toBeLessThan(above.maxDrawCalls);
      expect(below.textureAxis).toBeLessThan(above.textureAxis);
      expect(below.pixelRatio).toBeLessThan(above.pixelRatio);
      expect(below.detailResolution).toBeLessThanOrEqual(above.detailResolution);
    }
  });

  it('nejvyšší úroveň drží tři hrdiny pod stropem scény z §23', () => {
    const budget = budgetFor('full');
    expect(budget.heroes * budget.maxTrianglesPerHero).toBeLessThanOrEqual(
      budget.maxSceneTriangles,
    );
  });

  it('žádná úroveň nekreslí pod nativním rozlišením', () => {
    // Ratio pod 1 je jediný způsob, jak by `dpr` stupínek přestal být
    // degradací kvality a začal být rozbitý obraz. Strop nahoře je 2: víc
    // nemá na běžném displeji co přidat a zaplatilo by se to kvadraticky.
    for (const tier of QUALITY_TIERS) {
      expect(budgetFor(tier).pixelRatio).toBeGreaterThanOrEqual(1);
      expect(budgetFor(tier).pixelRatio).toBeLessThanOrEqual(2);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Žebřík degradace.
 * ------------------------------------------------------------------ */

describe('žebřík degradace', () => {
  it('vede z nejvyšší úrovně až na dno a tam skončí', () => {
    expect(degrade('full')).toBe('balanced');
    expect(degrade('balanced')).toBe('safe');
    expect(degrade('safe')).toBeNull();
  });

  it('utracené stupínky se čtou z tabulky, ne z ručního seznamu', () => {
    // `full → balanced` platí ratio a texture LOD, `balanced → safe` k tomu
    // ještě mřížku. Kdyby se tabulka změnila a tenhle rozpad zůstal, byl by to
    // žebřík, který tvrdí něco jiného, než co krok doopravdy provedl.
    expect(spentBetween('full', 'balanced')).toEqual(['dpr', 'texture-lod']);
    expect(spentBetween('balanced', 'safe')).toEqual(['dpr', 'texture-lod', 'grid']);
  });

  it('každý stupínek žebříku se aspoň jednou doopravdy utratí', () => {
    // `T37` zrušila postprocess, takže na jeho místě stál v žebříku stupínek,
    // který nemá co utratit. Tenhle test je pojistka proti tomu, aby tam takový
    // znovu vznikl: seznam se čte jako slib, ne jako historie.
    const spent = new Set(
      QUALITY_TIERS.slice(1).flatMap((tier, index) => spentBetween(QUALITY_TIERS[index], tier)),
    );
    expect([...DEGRADE_LADDER].every((rung) => spent.has(rung))).toBe(true);
  });

  it('stupínek nikdy neutratí logiku ani vstup', () => {
    expect([...DEGRADE_LADDER]).toEqual(['dpr', 'texture-lod', 'grid']);
  });

  it('materializace objednává tu příčku, kterou soudí brána', () => {
    expect(detailLevelFor('full')).toBe('high');
    expect(detailLevelFor('balanced')).toBe('high');
    // `safe` už na své cílové mřížce stojí od prvního snímku, takže mřížku
    // nezvedá — to je celý mřížkový stupínek §23.
    expect(detailLevelFor('safe')).toBe('rough');
  });
});

/* ------------------------------------------------------------------ *
 * Volba úrovně.
 * ------------------------------------------------------------------ */

describe('volba úrovně', () => {
  it('stroj, který nehlásí nic, dostane plnou úroveň', () => {
    expect(chooseQualityTier({})).toBe('full');
  });

  it('softwarový rasterizér spadne na dno bez ohledu na paměť', () => {
    expect(
      chooseQualityTier({ renderer: 'ANGLE (Google, SwiftShader Device)', deviceMemoryGb: 32 }),
    ).toBe('safe');
    expect(chooseQualityTier({ renderer: 'llvmpipe (LLVM 15.0.7, 256 bits)' })).toBe('safe');
  });

  it('skutečná GPU se za softwarovou nepovažuje', () => {
    expect(chooseQualityTier({ renderer: 'ANGLE (NVIDIA GeForce RTX 4080)' })).toBe('full');
  });

  it('málo paměti nebo jader sráží úroveň po jedné příčce', () => {
    expect(chooseQualityTier({ deviceMemoryGb: 2 })).toBe('safe');
    expect(chooseQualityTier({ cores: 2 })).toBe('safe');
    expect(chooseQualityTier({ deviceMemoryGb: 4 })).toBe('balanced');
    expect(chooseQualityTier({ cores: 4 })).toBe('balanced');
    expect(chooseQualityTier({ deviceMemoryGb: 16, cores: 16 })).toBe('full');
  });

  it('jméno úrovně z adresy se čte, netvrdí', () => {
    expect(isQualityTier('safe')).toBe(true);
    expect(isQualityTier('SAFE')).toBe(false);
    expect(isQualityTier(undefined)).toBe(false);
    expect(isQualityTier('ultra')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Úroveň před fan-outem a ve snapshotu.
 * ------------------------------------------------------------------ */

function shape(shapeId: string, priority: number): ShapeProgram {
  return {
    shapeId,
    priority,
    nodes: [{ kind: 'sphere', radius: 0.5 }],
    root: 0,
    targetBounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
    anchors: [],
  } as unknown as ShapeProgram;
}

function meshOf(): MeshResult {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    vertexCount: 3,
    triangleCount: 1,
    bounds: { min: [0, 0, 0], max: [1, 1, 0] },
    buildMs: 1,
  } as unknown as MeshResult;
}

/** Blueprint se třemi tvary a třemi objekty, které na ně míří. */
function outcomeWithThreeShapes() {
  const shapes = [shape('s-high', 9), shape('s-mid', 5), shape('s-low', 1)];
  return {
    kind: 'compiled' as const,
    result: {
      value: {
        title: 'three heroes',
        sessionSeed: 7,
        shapes,
        objects: shapes.map((program) => ({
          stableId: `o-${program.shapeId}`,
          source: { kind: 'shape' as const, shapeId: program.shapeId },
          targetBounds: program.targetBounds,
        })),
        geometry: { nodes: [], root: 0 },
      },
    },
  } as unknown as Parameters<typeof buildProxyWorld>[0];
}

describe('úroveň před meshing fan-outem', () => {
  it('objedná jen tolik tvarů, kolik úroveň unese, a v pořadí priority', async () => {
    const mesh = vi.fn<(order: MeshOrder) => Promise<MeshResult>>(async () => meshOf());
    const world = await buildProxyWorld(outcomeWithThreeShapes(), { mesh, quality: 'safe' });

    expect(mesh).toHaveBeenCalledTimes(budgetFor('safe').heroes);
    expect(mesh.mock.calls[0][0].program.shapeId).toBe('s-high');
    expect(world.kind).toBe('built');
  });

  it('nevymeshovaný tvar dostane vlastní důvod, ne „chybí"', async () => {
    const mesh = vi.fn<(order: MeshOrder) => Promise<MeshResult>>(async () => meshOf());
    const world = await buildProxyWorld(outcomeWithThreeShapes(), { mesh, quality: 'safe' });
    if (world.kind !== 'built') throw new Error('svět se nepostavil');

    const clay = world.slots.filter((entry) => entry.form.kind === 'clay');
    expect(clay).toHaveLength(2);
    for (const entry of clay) {
      if (entry.form.kind !== 'clay') throw new Error('nečekaný tvar');
      // Splynutí s chybějícím tvarem je právě ta záměna příčin, kterou musela
      // opravovat `T14`: model napsal správně, jen se to nevešlo do rozpočtu.
      expect(entry.form.reason).toBe(overBudgetReason(1));
      expect(entry.form.reason).not.toContain('missing');
    }
  });

  it('všechny objednávky jedné stavby nesou tutéž mřížku', async () => {
    const mesh = vi.fn<(order: MeshOrder) => Promise<MeshResult>>(async () => meshOf());
    await buildProxyWorld(outcomeWithThreeShapes(), { mesh, quality: 'full' });

    const resolutions = new Set(mesh.mock.calls.map(([order]) => order.resolution));
    expect(resolutions).toEqual(new Set([budgetFor('full').roughResolution]));
  });

  it('svět si úroveň nese s sebou', async () => {
    const mesh = vi.fn<(order: MeshOrder) => Promise<MeshResult>>(async () => meshOf());
    const world = await buildProxyWorld(outcomeWithThreeShapes(), { mesh, quality: 'balanced' });
    if (world.kind !== 'built') throw new Error('svět se nepostavil');

    expect(world.quality).toBe('balanced');
    expect(world.resolution).toBe(budgetFor('balanced').roughResolution);
  });

  it('bez uvedené úrovně se nic nezmění proti stavu před T26', async () => {
    const mesh = vi.fn<(order: MeshOrder) => Promise<MeshResult>>(async () => meshOf());
    const world = await buildProxyWorld(outcomeWithThreeShapes(), { mesh });
    if (world.kind !== 'built') throw new Error('svět se nepostavil');

    expect(world.quality).toBe('full');
    expect(mesh).toHaveBeenCalledTimes(3);
  });
});

describe('úroveň ve snapshotu relace', () => {
  it('snapshot ji nese a reconnect ji vrátí beze změny', () => {
    const session = createSession({ sessionId: 's1', sessionSeed: 3, quality: 'safe' });
    expect(session.snapshot().quality).toBe('safe');

    // Kdyby ji reconnect ztratil, objednal by klient tytéž tvary v jiné mřížce,
    // tedy pod jinými `contentHash` — cache by je minula a §13.3 by je odmítla.
    expect(restoreSession(session.snapshot()).snapshot().quality).toBe('safe');
  });

  it('relace bez uvedené úrovně dostane plnou', () => {
    expect(createSession({ sessionId: 's2', sessionSeed: 4 }).snapshot().quality).toBe('full');
  });
});

/**
 * `?blueprint=` smí jen ze stejného originu (P15 `G1-blueprintorigin`).
 * Odmítnutí cizí adresy vypadá na stránce stejně jako chybějící soubor —
 * „stored world failed" — takže bez tohohle pinu by se hranice dala tiše
 * vrátit a nikdo by si toho nevšiml.
 */
describe('pickStoredBlueprint pouští jen stejný origin', () => {
  const here = 'https://worldstream-sigma.vercel.app/dev/worldstream?blueprint=x';

  it('bez parametru je to ukázka, ne chyba', () => {
    expect(pickStoredBlueprint('?tier=full', here)).toBeNull();
  });

  it('relativní adresa galerie kvality projde a rozřeší se proti stránce', () => {
    expect(pickStoredBlueprint('?blueprint=%2F__quality%2Fa%2Fw1.json&tier=full', here)).toEqual({
      url: 'https://worldstream-sigma.vercel.app/__quality/a/w1.json',
    });
  });

  it.each([
    ['cizí doména', 'https://cizi.example/x.json'],
    ['protokolově relativní', '//cizi.example/x.json'],
    ['http místo https', 'http://worldstream-sigma.vercel.app/x.json'],
    ['data:', 'data:application/json,{}'],
    ['javascript:', 'javascript:alert(1)'],
  ])('%s se odmítne a nic se nestáhne', (_, raw) => {
    const picked = pickStoredBlueprint(`?blueprint=${encodeURIComponent(raw)}`, here);
    expect(picked).not.toBeNull();
    expect(picked !== null && 'url' in picked, `${raw} prošel jako adresa ke stažení`).toBe(false);
  });
});
