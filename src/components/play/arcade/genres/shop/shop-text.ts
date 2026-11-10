/**
 * Texty obchodu se součtem (P83E T3): cenovka věci, součet v HUD („$7.50“, u trefy „$7.50 / $12.00“). Hodnoty jsou
 * v jednotkách hry (`shop-level.ts`: cena v půlkách dolaru, váha a prosté číslo celé). Sdílí je scéna, dotykový
 * adaptér (cenovky v DOM), HUD a e2e.
 */

import { type ArcadeWorld, nativeRule } from '@/play/arcade/contract';
import { type ShopGame, type ShopUnit, totalOf } from '@/play/arcade/pieces/shop-level';

import type { HudCounter } from '../../../ui/GameHud';

/** Hodnota v jednotkách hry jako text cenovky: „$1.50“, „3 kg“, „7“. */
export function tagText(value: number, unit: ShopUnit): string {
  if (unit === 'price') return `$${(value / 2).toFixed(2)}`;
  return unit === 'weight' ? `${String(value)} kg` : String(value);
}

/** Hra obchodu ve světě, jinak `null`. */
export const shopGameOf = (world: ArcadeWorld): ShopGame | null => (nativeRule(world.rules, 'shop_total')?.params as ShopGame | undefined) ?? null;

/** Součet v HUD: jen u obchodu; u trefy i cíl. */
export function shopTotalCounter(world: ArcadeWorld, state: Int32Array): HudCounter | null {
  const game = shopGameOf(world);
  if (game === null) return null;
  const total = totalOf(state, game);
  const text = game.target > 0 ? `${tagText(total, game.unit)} / ${tagText(game.target, game.unit)}` : tagText(total, game.unit);
  return { label: 'total', count: total, text };
}
