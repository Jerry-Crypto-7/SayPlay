/**
 * Obchod se součtem (P83E T2): ovládání, pravidlo a generátor nad simulací z `shop-level.ts`.
 *
 * - **Ovládání `shop`:** `stepShop` – ťuk zařadí věc, hrdina ji donese na pult, součet přičte cenovku.
 * - **Pravidlo `shop_total`** (tik): položení = čítač `items`; odmítnutí u trefy = ztráta života; trefený součet
 *   nebo všechny věci na pultu = výhra.
 * - **Generátor `shop_counter`:** `generateShop` – trefa má vždy řešení (`checkShopLevel`); hodiny `time_limit`,
 *   u trefy životy (`out_of_health`), u „polož N“ pilulka postupu HUD (`finish_collected` bez těla cíle nevystřelí).
 */

import { z } from 'zod';

import { type ArcadeEffect, type ControlPiece, HEADER, type ModeGeneratorPiece, type ModeParts, type PieceRef, type RulePiece, bodyBase } from '../contract';
import { KEEP, SHOP, type ShopGame, type ShopParams, checkShopLevel, generateShop, shopDone, shopGameSchema, shopParams, stepShop } from './shop-level';

export { SHOP, SHOP_LAYOUT, type ShopGame, shopGameSchema } from './shop-level';

export const shopControl: ControlPiece<ShopGame> = {
  id: 'shop',
  params: shopGameSchema,
  roles: ['player', 'collectible'],
  cost: () => ({ bodies: 0, rules: 0 }),
  step: (state, player, input, game) => stepShop(state, player, input, game),
};

export const shopTotalRule: RulePiece<ShopGame> = {
  id: 'shop_total',
  params: shopGameSchema,
  roles: ['player', 'collectible'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, game) => {
    const keep = bodyBase(game.keeper);
    const tick = state[HEADER.tick] as number;
    const effects: ArcadeEffect[] = [];
    if (state[keep + KEEP.placedAt] === tick && (state[keep + KEEP.placed] as number) > 0) effects.push({ kind: 'count', counter: 'items', amount: 1 });
    if (state[keep + KEEP.refusedAt] === tick && (state[keep + KEEP.refused] as number) > 0) effects.push({ kind: 'damage', amount: 1 });
    if (shopDone(state, game)) effects.push({ kind: 'win' });
    return effects;
  },
};

export const SHOP_RULES: Readonly<Record<string, RulePiece>> = { shop_total: shopTotalRule as RulePiece };

/** Díly světa: hrdina u pultu, věci police, pravidlo součtu, hodiny a robot, který skládá řešení. */
export function shopParts(seed: number, params: ShopParams, health?: number): ModeParts {
  const { level, game, seconds } = generateShop(seed, params);
  const aiming = game.target > 0;
  const rules: PieceRef[] = [
    { id: 'shop_total', params: game },
    { id: 'time_limit', params: { seconds } },
    aiming ? { id: 'out_of_health', params: {} } : { id: 'finish_collected', params: { need: game.count } },
  ];
  return {
    control: { id: 'shop', params: game },
    bot: { id: 'shop_bot', params: { ...game, pace: SHOP.botPace } },
    level,
    rules,
    issues: checkShopLevel(level, game),
    ...(aiming ? { health: health ?? SHOP.lives } : {}),
  };
}

export const shopCounter: ModeGeneratorPiece<ShopParams> = {
  id: 'shop_counter',
  params: shopParams,
  roles: ['player', 'collectible'],
  cost: () => ({ bodies: 2 + SHOP.items.max, rules: 3 }),
  generate: (seed, params) => shopParts(seed, params).level,
  parts: (seed, params, health) => shopParts(seed, params, health),
};

/** Slot počítadla jako číslo (pro scénu a HUD). */
export const keeperSlot = (state: Int32Array, game: ShopGame, slot: keyof typeof KEEP): number => state[bodyBase(game.keeper) + KEEP[slot]] as number;

export const shopBotParams = shopGameSchema.extend({ pace: z.int().min(1).max(600) }).strict();
export type ShopBotParams = z.infer<typeof shopBotParams>;
