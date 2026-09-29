/**
 * Pravidlo `interact` (pahýl P32-0 T4, naplní P32G T1): hráč v dosahu cíle
 * drží „Use“ (`BUTTON.INTERACT`) a stav cíle se posune o 1 (efekt `stateChange`,
 * stav 0..2 v `flags` těla). Ve specu je to spouštěč `when: {interact: …}`,
 * `do` platí, když cíl dojde do konečného stavu.
 *
 * Soubor nezávisí na `schema.ts` ani `compile.ts` – oba si odsud berou schémata,
 * takže by import zpět udělal cyklus.
 */

import { z } from 'zod';

import { ARCADE_HZ, type ArcadeEffect, type RuleContext } from '../contract';

const states = z.union([z.literal(2), z.literal(3)]);

/** Spouštěč ve specu: `role` = cíle, `radius` v celých metrech, `hold` v ticích, `order` = cíle v pořadí. */
export const interactWhen = (role: z.ZodString) =>
  z
    .object({
      interact: z.object({ role, radius: z.int().min(1).max(20), hold: z.int().min(0).max(5 * ARCADE_HZ), states, order: z.boolean().optional() }).strict(),
    })
    .strict();

/** Po překladu: `role` = kód jádra, `radius` v jednotkách. */
export const compiledInteractWhen = z
  .object({
    interact: z.object({ role: z.int().min(0).max(255), radius: z.int().min(0), hold: z.int().min(0), states, order: z.boolean().optional() }).strict(),
  })
  .strict();
export type CompiledInteract = z.infer<typeof compiledInteractWhen>['interact'];

/**
 * Jeden tik pravidla (spouštěč `press`, vstup je v `ctx.input`). `reached` vrátí
 * efekty `do` pravidla pro cíl, který právě došel do konečného stavu.
 * Pahýl: nic nevydá.
 */
export function interactFire(_ctx: RuleContext, _interact: CompiledInteract, _reached: (body: number) => readonly ArcadeEffect[]): readonly ArcadeEffect[] {
  return [];
}
