/**
 * Výběr 1 ze 3 vylepšení mezi koly (P66 T3, kontrakt `hooks/contract.ts`).
 *
 * **Náhoda jen při stavbě:** nabídky losuje `drawOffers` ze streamu `upgrades` (`pure-rand`) a nese je v parametrech
 * pravidla `hooks` – na každou přestávku jedno pořadí celé zásoby žánru. Za běhu se z něj jen vezmou první tři
 * vylepšení pod stropem (`UPGRADE_OFFER.maxLevel`), celočíselně a bez náhody.
 *
 * **Volba je vstup v záznamu:** tlačítka `UPGRADE_PICK_BUTTONS` v tiku přestávky. Kdo do `pickTicks` nevybere,
 * dostane kartu `defaultCard` (0) – nečinný hráč i robot jsou tak deterministické.
 *
 * **Co jádro samo promítne do hrdiny:** `speed` (posun navíc podle rychlosti hrdiny), `magnet` (věci v dosahu letí
 * k hrdinovi), `extra_life` (+1 život při volbě) a `fire_rate` na ráně, jejíž rozestup ovládání píše do těla hráče
 * (`Swing`, úder souboje). `range` a `carry` jsou jen stupně ve stavu – čte je ovládání nebo pravidlo žánru, které
 * ví, co je jeho dostřel a náklad (`upgradeLevel`); totéž `fire_rate` žánru s vlastní ranou.
 */

import { z } from 'zod';

import { createStreams, nextInt } from '@/sim/rng';

import {
  ARCADE_LIMITS,
  type ArcadeInput,
  BODY,
  type BotPiece,
  COUNTER,
  FLAG,
  HEADER,
  NO_INPUT,
  ROLE,
  bodyBase,
} from '../contract';
import { MAGNET } from '../powerups/magnet';

import { HOOK_SLOTS, LEVEL_BITS, OFFER_BITS, UPGRADES, UPGRADE_OFFER, UPGRADE_PICK_BUTTONS, UPGRADE_STEP, type HookEffect, type UpgradeId } from './contract';

/** Pořadí, ve kterém robot karty bere: nejdřív život, pak rána a pohyb, náklad nakonec. Pevné, takže deterministické. */
export const UPGRADE_PRIORITY: readonly UpgradeId[] = ['extra_life', 'fire_rate', 'speed', 'range', 'magnet', 'carry'];

/** Všechna tlačítka volby karty naráz. */
export const PICK_MASK = UPGRADE_PICK_BUTTONS.reduce((mask: number, button) => mask | button, 0);

const LEVEL_MASK = (1 << LEVEL_BITS) - 1;
const CODE_MASK = (1 << OFFER_BITS) - 1;

/**
 * Pořadí zásoby `pool` na každou z `breaks` přestávek ze streamu `upgrades` hry `seed` (Fisher–Yates). Pořadí, ne
 * hotové tři karty: co je na stropu, rozhodne až stav v okamžiku nabídky.
 */
export function drawOffers(seed: number, pool: readonly UpgradeId[], breaks: number): UpgradeId[][] {
  const stream = createStreams(seed).upgrades;
  return Array.from({ length: breaks }, () => {
    const order = [...pool];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = nextInt(stream, 0, i);
      [order[i], order[j]] = [order[j] as UpgradeId, order[i] as UpgradeId];
    }
    return order;
  });
}

const slot = (keeper: number, at: number): number => bodyBase(keeper) + at;
const levelShift = (id: UpgradeId): number => UPGRADES.indexOf(id) * LEVEL_BITS;

/** Stupeň vylepšení `id` (0 = nevzaté) v počítadle háčků `keeper`. Čtou ho i kusy žánrů (rána, dostřel, náklad). */
export const upgradeLevel = (state: Int32Array, keeper: number, id: UpgradeId): number => ((state[slot(keeper, HOOK_SLOTS.levels)] as number) >>> levelShift(id)) & LEVEL_MASK;

/** Tři karty právě otevřené nabídky, nebo `null`, když se nic nenabízí. */
export function offerOf(state: Int32Array, keeper: number): readonly [UpgradeId, UpgradeId, UpgradeId] | null {
  const packed = state[slot(keeper, HOOK_SLOTS.offer)] as number;
  if (packed === 0) return null;
  const card = (k: number): UpgradeId => UPGRADES[((packed >>> (k * OFFER_BITS)) & CODE_MASK) - 1] as UpgradeId;
  return [card(0), card(1), card(2)];
}

/**
 * Nabídka z pořadí `order`: první tři vylepšení pod stropem; když jich pod stropem zbývá míň, doplní se ze stropových
 * (volba pak stupeň nezvedne, ale nabídka má vždy tři různé karty).
 */
export function openOffer(state: Int32Array, keeper: number, order: readonly UpgradeId[]): readonly [UpgradeId, UpgradeId, UpgradeId] {
  const open = order.filter((id) => upgradeLevel(state, keeper, id) < UPGRADE_OFFER.maxLevel);
  const cards = [...open, ...order.filter((id) => !open.includes(id))].slice(0, UPGRADE_OFFER.size) as [UpgradeId, UpgradeId, UpgradeId];
  state[slot(keeper, HOOK_SLOTS.offer)] = cards.reduce((packed, id, k) => packed | ((UPGRADES.indexOf(id) + 1) << (k * OFFER_BITS)), 0);
  state[slot(keeper, HOOK_SLOTS.pickLeft)] = UPGRADE_OFFER.pickTicks;
  return cards;
}

/** Karta, kterou vstup tiku volí (nejnižší stisknutá), nebo −1. */
export function pickedCard(input: ArcadeInput): number {
  return UPGRADE_PICK_BUTTONS.findIndex((button) => (input.buttons & button) !== 0);
}

/** Vezme kartu `card` otevřené nabídky: stupeň nahoru (nejvýš strop), `extra_life` hned přidá život; nabídka se zavře. */
export function takeCard(state: Int32Array, keeper: number, card: number, out: HookEffect[]): void {
  const offer = offerOf(state, keeper);
  if (offer === null) return;
  const upgrade = offer[card] as UpgradeId;
  const level = upgradeLevel(state, keeper, upgrade);
  if (level < UPGRADE_OFFER.maxLevel) {
    const at = slot(keeper, HOOK_SLOTS.levels);
    state[at] = (state[at] as number) + (1 << levelShift(upgrade));
    if (upgrade === 'extra_life') state[HEADER.counters + COUNTER.health] = (state[HEADER.counters + COUNTER.health] as number) + UPGRADE_STEP.extra_life;
  }
  state[slot(keeper, HOOK_SLOTS.offer)] = 0;
  state[slot(keeper, HOOK_SLOTS.pickLeft)] = 0;
  out.push({ kind: 'upgrade_pick', card, upgrade });
}

const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

/**
 * Promítnutí vylepšení do hrdiny na začátku tiku, před ovládáním (ovládání pak hrdinu udrží v aréně):
 * `speed` = posun navíc o `UPGRADE_STEP.speed` % rychlosti za stupeň – rychlost sama se nemění, takže se nesčítá
 * tik po tiku ani u ovládání se zrychlováním; `magnet` = živé sbírané věci do `stupeň × UPGRADE_STEP.magnet` letí
 * k hrdinovi krokem magnetu power-upu (`MAGNET.pull`). Fyzikální tělesa drží Rapier, ty nechá.
 */
export function boostHero(state: Int32Array, player: number, keeper: number): void {
  const p = bodyBase(player);
  const speed = upgradeLevel(state, keeper, 'speed');
  if (speed > 0) {
    state[p + BODY.x] = (state[p + BODY.x] as number) + Math.trunc(((state[p + BODY.vx] as number) * UPGRADE_STEP.speed * speed) / 100);
    state[p + BODY.z] = (state[p + BODY.z] as number) + Math.trunc(((state[p + BODY.vz] as number) * UPGRADE_STEP.speed * speed) / 100);
  }
  const magnet = upgradeLevel(state, keeper, 'magnet');
  if (magnet === 0) return;
  const reach = magnet * UPGRADE_STEP.magnet;
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const b = bodyBase(i);
    const flags = state[b + BODY.flags] as number;
    if (state[b + BODY.role] !== ROLE.collectible || (flags & FLAG.alive) === 0 || (flags & FLAG.physics) !== 0) continue;
    const dx = (state[p + BODY.x] as number) - (state[b + BODY.x] as number);
    const dz = (state[p + BODY.z] as number) - (state[b + BODY.z] as number);
    if (dx * dx + dz * dz > reach * reach) continue;
    state[b + BODY.x] = (state[b + BODY.x] as number) + clamp(dx, MAGNET.pull);
    state[b + BODY.z] = (state[b + BODY.z] as number) + clamp(dz, MAGNET.pull);
  }
}

/** Rozestup rány hrdiny, kterou ovládání žánru píše do slotu `slot` těla hráče v plné délce `ticks` (úder souboje). */
export interface Swing {
  readonly slot: number;
  readonly ticks: number;
}

/**
 * `fire_rate` na ráně ovládání (konec tiku): rozestup, který ovládání právě nastavilo na plnou délku, se zkrátí
 * o `UPGRADE_STEP.fire_rate` % za stupeň. Další tik ho ovládání odpočítává od kratšího.
 */
export function shortenSwing(state: Int32Array, player: number, keeper: number, swing: Swing): void {
  const level = upgradeLevel(state, keeper, 'fire_rate');
  const at = bodyBase(player) + swing.slot;
  if (level > 0 && state[at] === swing.ticks) state[at] = swing.ticks - Math.trunc((swing.ticks * UPGRADE_STEP.fire_rate * level) / 100);
}

/** Karta, kterou robot z nabídky bere: první podle `UPGRADE_PRIORITY`. */
export const priorityCard = (offer: readonly UpgradeId[]): number =>
  offer.indexOf(UPGRADE_PRIORITY.find((id) => offer.includes(id)) as UpgradeId);

const wrapped = z
  .object({
    base: z.object({ id: z.string(), params: z.record(z.string(), z.unknown()) }).strict(),
    keeper: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1),
  })
  .strict();
type Wrapped = z.infer<typeof wrapped>;

/** Parametry robota pod obalem, přečtené jednou: obal běží každý tik (jako `paramsOf` v `pieces/mirror.ts`). */
const parsed = new WeakMap<object, unknown>();
function paramsOf(piece: BotPiece, raw: Readonly<Record<string, unknown>>): unknown {
  if (!parsed.has(raw)) parsed.set(raw, piece.params.parse(raw));
  return parsed.get(raw);
}

/**
 * Robot s háčky: v přestávce s nabídkou stiskne jednou kartu podle `UPGRADE_PRIORITY`, jinak v přestávce nic
 * (svět stojí); mimo přestávku rozhoduje robot pod obalem. Vidí stav starý `reactionTicks` jako každý robot:
 * stisk, který ve stavu ještě není vidět, nese `recent`, takže kartu nemačká znovu.
 */
export function makeHooksBot(bots: Readonly<Record<string, BotPiece>>): BotPiece<Wrapped> {
  return {
    id: 'hooks_bot',
    params: wrapped,
    roles: ['player'],
    // Všichni základní roboti reagují s 8 tiky (`makeAddonBot`); obal musí vidět stejně staré stavy.
    reactionTicks: 8,
    cost: () => ({ bodies: 0, rules: 0 }),
    decide: (observation, params) => {
      const { state, recent } = observation;
      if ((state[slot(params.keeper, HOOK_SLOTS.breakLeft)] as number) > 0) {
        const offer = offerOf(state, params.keeper);
        if (offer === null || recent.some((input) => (input.buttons & PICK_MASK) !== 0)) return NO_INPUT;
        return { buttons: UPGRADE_PICK_BUTTONS[priorityCard(offer)] as number, axis: 0 };
      }
      const base = bots[params.base.id];
      if (base === undefined) throw new Error(`arcade: unknown bot ${params.base.id}`);
      return base.decide(observation, paramsOf(base, params.base.params));
    },
  };
}
