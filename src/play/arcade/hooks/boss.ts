/**
 * Moment bosse (P66 T3). Boss sám se nepíše znovu: přivede ho finále průběhu (`pacing-parts`, pravidlo `pacing`
 * kopií předlohy bosse) a útočí útoky `BOSS_ATTACKS` (pravidlo `boss_beat`). Háček jen pozná chvíli, kdy kopie
 * předlohy bosse vstoupila do hry, a vydá `boss_enter` s hláškou `boss`. Kdy to je (poslední vlna nebo kolo),
 * rozhoduje rozvrh finále žánru.
 */

import { type ArcadeEffect, BODY, FLAG, HEADER, type PieceRef, bodyBase, nativeRule } from '../contract';
import type { HookEffect } from './contract';

/** Předloha bosse finále, jak ji nese `boss_beat` (i pod obalem složené hry); bez finále `undefined`. */
export const bossTemplateOf = (rules: readonly PieceRef[]): number | undefined => nativeRule(rules, 'boss_beat')?.params.boss as number | undefined;

/** Živá kopie předlohy `template` na místě vstupu (`spawn` ji tam položil); bez nálezu předloha sama. */
function copyAt(state: Int32Array, template: number, x: number, z: number): number {
  const kind = state[bodyBase(template) + BODY.kind];
  for (let i = state[HEADER.spawnBase] as number; i < (state[HEADER.bodyCount] as number); i += 1) {
    const base = bodyBase(i);
    if (((state[base + BODY.flags] as number) & FLAG.alive) !== 0 && state[base + BODY.kind] === kind && state[base + BODY.x] === x && state[base + BODY.z] === z) return i;
  }
  return template;
}

/** `boss_enter` a hláška za každý `spawn` předlohy bosse v efektech tiku. */
export function bossEntries(state: Int32Array, effects: readonly ArcadeEffect[], boss: number, out: HookEffect[]): void {
  for (const effect of effects) {
    if (effect.kind !== 'spawn' || effect.template !== boss) continue;
    out.push({ kind: 'boss_enter', body: copyAt(state, boss, effect.x, effect.z) }, { kind: 'callout', callout: 'boss' });
  }
}
