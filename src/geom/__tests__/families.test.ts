import { describe, expect, it } from 'vitest';

import { KIT_BUDGETS, PALETTES, repaint } from '@/kit';
import { compileGeomProgram, trianglesOfGeometry } from '../compile';
import { FAMILIES, familyById } from '../families';
import { instanceCounts, validateGeomProgram } from '../program';

const SEEDS = [101, 202, 303] as const;

describe('rodiny jsou čtyři a každá má vlastní vedení', () => {
  it('jsou právě čtyři a mají různá id', () => {
    expect(FAMILIES).toHaveLength(4);
    expect(new Set(FAMILIES.map((family) => family.id)).size).toBe(4);
  });

  it('žádné dvě nesdílejí paletu', () => {
    // Sdílená paleta je nejlevnější způsob, jak se dvě rodiny stanou jednou —
    // a měření odlišnosti by to odhalilo až v e2e, tedy pozdě a draho.
    expect(new Set(FAMILIES.map((family) => family.palette)).size).toBe(4);
  });

  it('každá paleta je paleta kitu', () => {
    for (const family of FAMILIES) {
      expect(Object.keys(PALETTES)).toContain(family.palette);
    }
  });

  it('každá má popsanou siluetu a pravidla proporcí', () => {
    for (const family of FAMILIES) {
      expect(family.silhouette.length).toBeGreaterThan(10);
      expect(family.proportions.footprint).toBeGreaterThan(0);
      expect(family.proportions.height).toBeGreaterThan(0);
      expect(family.proportions.pieces).toBeGreaterThan(0);
    }
  });

  it('proporce nejsou u všech stejné, jinak by nebyly pravidly', () => {
    const shapes = FAMILIES.map(
      (family) => `${family.proportions.footprint}/${family.proportions.height}`,
    );

    expect(new Set(shapes).size).toBe(4);
  });

  it('familyById najde každou a na neznámé id vrátí undefined', () => {
    for (const family of FAMILIES) expect(familyById(family.id)).toBe(family);
    expect(familyById('nic-takoveho')).toBeUndefined();
  });
});

describe('rodina vyrobí platný program pro každé semínko', () => {
  const cases = FAMILIES.flatMap((family) => SEEDS.map((seed) => [family.id, seed, family] as const));

  it.each(cases)('%s se semínkem %d dá platný program', (_id, seed, family) => {
    const doc = family.compose(seed);

    expect(validateGeomProgram(doc)).toEqual({ ok: true, issues: [] });
    expect(instanceCounts(doc.nodes)[doc.root]).toBeLessThanOrEqual(KIT_BUDGETS.maxDrawCallsPerWorld);
  });

  it.each(cases)('%s se semínkem %d postaví neprázdnou geometrii pod stropem', (_id, seed, family) => {
    const geometry = compileGeomProgram(family.compose(seed));

    expect(trianglesOfGeometry(geometry)).toBeGreaterThan(0);
    expect(trianglesOfGeometry(geometry)).toBeLessThanOrEqual(KIT_BUDGETS.maxTrianglesPerWorld);
    // Přebarvení paletou rodiny musí projít — vrchol mimo odstíny kitu by
    // znamenal, že se rodina do palety netrefí a barvu si vymyslela.
    expect(() => repaint(geometry, PALETTES[family.palette])).not.toThrow();
  });

  it.each(FAMILIES.map((family) => [family.id, family] as const))(
    '%s je pro totéž semínko pokaždé stejná',
    (_id, family) => {
      expect(family.compose(777)).toEqual(family.compose(777));
    },
  );

  it.each(FAMILIES.map((family) => [family.id, family] as const))(
    '%s se semínkem mění, jinak by semínko nebylo k ničemu',
    (_id, family) => {
      expect(family.compose(101)).not.toEqual(family.compose(202));
    },
  );

  it('žádné dvě rodiny nestaví pro totéž semínko týž program', () => {
    // Levná první linie k tomu, co e2e měří na vyrenderovaných snímcích: rodina,
    // které se podstrčí cizí geometrie a nechá si vlastní paletu, projde branou
    // odlišnosti (naměřeno 21. 8. 2026, 0,507 proti 0,514), protože o průměru
    // rozhoduje paleta. Tady to padne za dvě sekundy místo za půl minuty.
    const pairs = FAMILIES.flatMap((first, index) =>
      FAMILIES.slice(index + 1).map((second) => [first, second] as const),
    );

    for (const [first, second] of pairs) {
      expect(first.compose(303), `${first.id} a ${second.id} staví totéž`).not.toEqual(
        second.compose(303),
      );
    }
  });
});
