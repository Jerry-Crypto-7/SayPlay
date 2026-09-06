/**
 * **Jedna odpověď na otázku „co změna nechá být", ne dvě.**
 *
 * Chování `preservedBy()` soudí sada nad routou
 * (`src/app/api/worldstream/__tests__/changes.test.ts`), kde projde skutečnými
 * dveřmi i skutečným dokumentem. Tenhle soubor hlídá to druhé, co se testem
 * přes dveře chytit nedá: že **druhá** obrazovka, na které se ta věta ukazuje,
 * počítá touž funkcí, a ne vlastním odhadem.
 *
 * ⚠ **Je to lexikální brána a je to schválně** (`T35-preservedattr`). Do
 * 6. 9. 2026 `/dev/refine` seznam počítalo jako „všechno kromě cíle", tedy
 * přesně tu nepravdu, kterou blokující nález nezávislé revize v routě zavřel —
 * a nevšiml si toho nikdo, protože scénář té stránky vyrábí seznam, který
 * **náhodou vychází stejně**. E2e sada nad ní je proto zelená nad oběma
 * výpočty a rozdíl neuvidí; jediné, co ho vidí, je zdroj.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const REFINE_PAGE = join(process.cwd(), 'src/app/dev/refine/page.tsx');

describe('/dev/refine počítá „co změna nechá být" sdílenou funkcí', () => {
  const source = readFileSync(REFINE_PAGE, 'utf8');

  it('volá preservedBy z @/worldstream/preserved', () => {
    expect(source).toContain("from '@/worldstream/preserved'");
    expect(source).toContain('preserved: preservedBy(');
  });

  /**
   * Kontrola k předchozímu: import sám nestačí, protože vedle něj může
   * doopravdy stát i druhý výpočet. Zakázaný je **tvar** té staré nepravdy —
   * filtr objektů podle nerovnosti s cílem.
   */
  it('nepočítá seznam sám filtrem „všechno kromě cíle"', () => {
    expect(source).not.toMatch(/objects[\s\S]{0,80}\.filter\([\s\S]{0,80}stableId !==/);
  });
});
