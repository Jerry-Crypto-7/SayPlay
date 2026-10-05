/**
 * Co hrdina viditelně dělá (P37-0): míchá, stříká, skládá… `none` = dnešní hra.
 * Seznam rozšiřuje jen řídicí session. Jen vzhled – jádro, dílky ani pravidla ho nečtou.
 *
 * Vlastní modul bez závislostí (P37A T3): čte ho `spec.ts` i smlouva žánrů
 * (`genre/contract.ts`), která se do `spec.ts` načítá – ze `spec.ts` by ho
 * smlouva dostala dřív, než vznikne.
 */

import { z } from 'zod';

export const HERO_ACTIONS = ['none', 'stir', 'spray', 'stack', 'carry', 'sweep', 'throw', 'dig', 'paint', 'chop', 'water', 'knit', 'fix'] as const;
export type HeroAction = (typeof HERO_ACTIONS)[number];
export const heroActionSchema = z.enum(HERO_ACTIONS);
