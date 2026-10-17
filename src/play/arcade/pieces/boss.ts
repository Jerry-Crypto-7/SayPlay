/**
 * Boss (P45C): pravidlo `boss_beat` – kdo komu ubere.
 *
 * Tělo a útoky bosse jsou chování `boss` (`behaviours/boss.ts`, hýbe jím
 * `pacing_control`, výstřely a dupnutí zraní přes pravidlo `pacing`). Tady:
 * dotek (`boss_beat`, spouštěč `contact`) nebo výstřel hráče (`boss_beat_hit`,
 * spouštěč `hit`) v okně `recover` ubere bossovi 1 HP; dotek během útoku zraní
 * hráče s milostí, dotek mimo útok a okno nedělá nic (každý zásah hráče má
 * varování). Padlý boss vydá to, co hra k výhře potřebuje – kopie předlohy
 * `drop` (poslední věci cíle) nebo body skóre; sám je padlý soupeř. Výhru
 * nikdy nevydá: finále je poslední krok k vítězství, které hra už má.
 */

import { z } from 'zod';

import { type ArcadeEffect, BODY, HIT_GRACE, type RuleContext, type RulePiece, bodyBase, bodyHp } from '../contract';
import { behaviourMemoOf, behaviourPhaseOf, matches } from './behaviours';
import { bossOpen } from './behaviours/boss';

export const bossBeatParams = z
  .object({
    /** Předloha bosse (index těla); boss se pozná podle jejího podpisu. */
    boss: z.int().min(1),
    /** Padlý boss vydá `count` kopií předlohy `template` v řadě přes svou šířku. */
    drop: z.object({ template: z.int().min(1), count: z.int().min(1).max(8) }).strict().optional(),
    /** Padlý boss přičte body skóre. */
    score: z.int().min(1).optional(),
  })
  .strict();
export type BossBeatParams = z.infer<typeof bossBeatParams>;

/** Úder do bosse v okně (i úder akcí hrdiny, P46B T8); poslední HP = boss zmizí a vydá kořist. */
export function blow(state: Int32Array, boss: number, by: number, p: BossBeatParams): ArcadeEffect[] {
  const effects: ArcadeEffect[] = [{ kind: 'hit', body: boss, by, amount: 1 }];
  if (bodyHp(state, boss) > 1) return effects;
  effects.push({ kind: 'despawn', body: boss });
  const base = bodyBase(boss);
  const x = state[base + BODY.x] as number;
  const w = state[base + BODY.w] as number;
  const drop = p.drop;
  if (drop !== undefined) {
    for (let k = 0; k < drop.count; k += 1) {
      effects.push({ kind: 'spawn', template: drop.template, x: x + Math.trunc(((2 * k - drop.count + 1) * w) / (2 * drop.count)), y: 0, z: state[base + BODY.z] as number, vx: 0, vy: 0, vz: 0 });
    }
  }
  if (p.score !== undefined) effects.push({ kind: 'score', amount: p.score });
  return effects;
}

function fire({ state, player, other, source }: RuleContext, p: BossBeatParams): readonly ArcadeEffect[] {
  if (other < 0 || !matches(state, other, p.boss)) return [];
  const phase = behaviourPhaseOf(state, other);
  if (bossOpen(state, other, phase, behaviourMemoOf(state, other))) return blow(state, other, source < 0 ? player : source, p);
  // Výstřel hráče mimo okno neudělá nic; dotek zraní jen během útoku.
  return source < 0 && phase === 'act' ? [{ kind: 'damage', amount: 1, grace: HIT_GRACE }] : [];
}

export const bossBeat: RulePiece<BossBeatParams> = { id: 'boss_beat', trigger: 'contact', params: bossBeatParams, roles: [], cost: () => ({ bodies: 0, rules: 1 }), fire };

/** Totéž pro žánry se střelbou: projektil hráče, který bosse zasáhl. Projektil končí jen na terči, nepříteli nebo pevném tělese – boss střelnice musí mít takovou roli. */
export const bossBeatHit: RulePiece<BossBeatParams> = { ...bossBeat, id: 'boss_beat_hit', trigger: 'hit' };
