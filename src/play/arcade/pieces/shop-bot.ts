/**
 * Robot obchodu (P83E T2): když hrdina nic nenese, na nic nejde a fronta je prázdná, po `pace` tikách (od startu
 * i od posledního položení) klepne na věc police. U „polož N“ na první věc police, u trefy na první, se kterou pult
 * součet vezme (`fits`: nepřeteče a zbytek police cíl ještě trefí) – robot tak cíl trefí vždy a nikdy neztratí život.
 */

import { type ArcadeInput, BODY, BUTTON, type BotPiece, HEADER, NO_INPUT, bodyBase, bodyHp, targetStateOf } from '../contract';
import { axisOfCell } from './lanes';
import { type ShopBotParams, shopBotParams } from './shop';
import { KEEP, SHOP_STATE, fits, shelfValues } from './shop-level';

/** Reakce robota (tiky): jako ostatní roboti knihovny. */
export const SHOP_BOT_REACTION = 8;

/** Místo police, na které robot klepne, nebo −1. */
export function shopPick(state: Int32Array, game: ShopBotParams): number {
  const total = state[bodyBase(game.keeper) + KEEP.total] as number;
  for (let item = game.first; item < game.first + game.count; item += 1) {
    if (targetStateOf(state, item) !== SHOP_STATE.shelf) continue;
    const value = bodyHp(state, item);
    const rest = shelfValues(state, game);
    rest.splice(rest.indexOf(value), 1);
    if (fits(game, total, value, rest)) return item - game.first;
  }
  return -1;
}

export const shopBot: BotPiece<ShopBotParams> = {
  id: 'shop_bot',
  params: shopBotParams,
  roles: ['player', 'collectible'],
  reactionTicks: SHOP_BOT_REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, tick, recent }, game): ArcadeInput => {
    if (recent.some((input) => (input.buttons & BUTTON.TAP) !== 0)) return NO_INPUT;
    const keep = bodyBase(game.keeper);
    if ((state[HEADER.held] as number) > 0 || (state[keep + KEEP.walking] as number) > 0) return NO_INPUT;
    for (let item = game.first; item < game.first + game.count; item += 1) {
      if ((state[bodyBase(item) + BODY.aux1] as number) > 0 && targetStateOf(state, item) === SHOP_STATE.shelf) return NO_INPUT;
    }
    const placed = state[keep + KEEP.placed] as number;
    if (tick < game.pace || (placed > 0 && tick - (state[keep + KEEP.placedAt] as number) < game.pace)) return NO_INPUT;
    const slot = shopPick(state, game);
    return slot < 0 ? NO_INPUT : { buttons: BUTTON.TAP, axis: axisOfCell(slot) };
  },
};
