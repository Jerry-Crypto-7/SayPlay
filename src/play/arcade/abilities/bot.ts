/**
 * Robot akcí (P46A T6): krok, který obal robota `addon_bot` udělá po
 * základním robotovi a doplňcích. Vidí stav o `recent.length` tiků starý,
 * takže polohy předpovídá jejich rychlostí. Střílí jako robot `+shoot`,
 * udeří a sebere, co bude v dosahu, a dash nebo štít zapne před nárazem.
 *
 * Ochranné akce a úder se dokážou jen dotykem, kterému se základní robot
 * vyhýbá. Proto robot s připravenou akcí neuhne tělu, které na hrdinu míří:
 * nechá ho přijít a akci zmáčkne včas. Akce ho ochrání, takže tah nic nestojí.
 */

import { shootStep } from '../addons';
import { ABILITY_SLOTS, AXIS_MAX, type AbilityId, type ArcadeInput, type ArcadeObservation, BODY, BUTTON, FLAG, HEADER, type PieceRef, ROLE, UNIT, bodyBase } from '../contract';
import { ABILITY_BUTTONS, ABILITY_TIMING, type AbilityBot, abilityActive, abilityCooldown } from './state';
import { inStrikeReach } from './strike';

/** Jak daleko dopředu (tiky po zmáčknutí) robot hlídá tělo, kvůli kterému neuhne. */
const COMMIT_TICKS = 24;
/** Na řízení dál: auto potřebuje čas zatočit ke stopě nepřítele. */
const STEER_COMMIT_TICKS = 75;

/** Čím se kdo vyhýbá – robot v nasazení tyhle vstupy zahodí. */
const EVADE: Readonly<Record<string, number>> = {
  runner_bot: BUTTON.LEFT | BUTTON.RIGHT | BUTTON.TAP | BUTTON.DOWN,
  platform_bot: BUTTON.TAP | BUTTON.UP,
  steer_bot: 0,
};

const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** První tik v `from..to` (od pozorování), kdy se hrdina a tělo dotknou, když oba letí dál svou rychlostí; jinak −1. */
function contactAt(state: Int32Array, player: number, body: number, from: number, to: number): number {
  const p = bodyBase(player);
  const b = bodyBase(body);
  const at = (base: number, axis: number, speed: number, t: number): number => (state[base + axis] as number) + (state[base + speed] as number) * t;
  const py = state[p + BODY.y] as number;
  const by = state[b + BODY.y] as number;
  if (!(py < by + (state[b + BODY.h] as number) && by < py + (state[p + BODY.h] as number))) return -1;
  for (let t = from; t <= to; t += 1) {
    const dx = Math.abs(at(b, BODY.x, BODY.vx, t) - at(p, BODY.x, BODY.vx, t));
    const dz = Math.abs(at(b, BODY.z, BODY.vz, t) - at(p, BODY.z, BODY.vz, t));
    if (dx * 2 < (state[p + BODY.w] as number) + (state[b + BODY.w] as number) && dz * 2 < (state[p + BODY.d] as number) + (state[b + BODY.d] as number)) return t;
  }
  return -1;
}

/** Živá těla rolí `roles` kromě hrdiny. */
function bodiesOf(state: Int32Array, player: number, roles: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    if (i !== player && roles.includes(state[bodyBase(i) + BODY.role] as number) && alive(state, i)) out.push(i);
  }
  return out;
}

interface Slot {
  readonly id: AbilityId;
  readonly button: number;
  /** Tik (od pozorování), kdy akce naposled začala z vlastního stisku v `recent`, jinak −1. */
  readonly pressed: number;
  /** Je akce v tiku zmáčknutí (`recent.length`) připravená? */
  readonly ready: boolean;
  /** Poslední tik (od pozorování), ve kterém je akce ještě aktivní. */
  readonly activeUntil: number;
}

function slotsOf(observation: ArcadeObservation, params: AbilityBot): Slot[] {
  const { state, recent } = observation;
  const n = recent.length;
  return params.ids.map((id, slot) => {
    const button = ABILITY_BUTTONS[slot] as number;
    let pressed = -1;
    recent.forEach((seen, j) => {
      if ((seen.buttons & button) !== 0) pressed = j;
    });
    const timing = ABILITY_TIMING[id];
    const cooldown = abilityCooldown(state, params.keeper, slot);
    const ready = pressed < 0 ? cooldown <= n : pressed + timing.cooldown <= n;
    const activeUntil = pressed >= 0 ? pressed + timing.active - 1 : abilityActive(state, params.keeper, slot) - 1;
    return { id, button, pressed, ready, activeUntil };
  });
}

/** Jak daleko od stopy smí na řízení tělo ležet, aby k němu robot zatočil. */
const STEER_SEEK = 3 * UNIT;

/**
 * Řízení jede po závodní stopě a nepříteli by se minulo i bez úhybu: tělo
 * před autem blízko stopy dostane odhad dotyku podle vzdálenosti a robot k němu zatočí.
 */
function aheadAt(state: Int32Array, player: number, body: number, from: number, to: number): number {
  const p = bodyBase(player);
  const b = bodyBase(body);
  const vz = Math.max(1, state[p + BODY.vz] as number);
  const dz = (state[b + BODY.z] as number) - (state[p + BODY.z] as number) - Math.floor(((state[p + BODY.d] as number) + (state[b + BODY.d] as number)) / 2);
  // Soupeřovo auto (pohyblivý `enemy`) není cíl – honička za ním by prohrála závod.
  if (((state[b + BODY.flags] as number) & FLAG.kinematic) !== 0) return -1;
  if (dz < 0 || Math.abs((state[b + BODY.x] as number) - (state[p + BODY.x] as number)) > STEER_SEEK) return -1;
  const at = Math.ceil(dz / vz);
  return at >= from && at <= to ? at : -1;
}

/** Tělo, kterému robot neuhne, a tik dotyku – nejbližší ze `targets` na kolizním kurzu. */
function oncoming(observation: ArcadeObservation, targets: readonly number[], horizon: number, steer: boolean): { body: number; at: number } | null {
  const { state, player } = observation;
  const n = observation.recent.length;
  let best: { body: number; at: number } | null = null;
  for (const body of targets) {
    const at = steer ? aheadAt(state, player, body, n, n + horizon) : contactAt(state, player, body, n, n + horizon);
    if (at >= 0 && (best === null || at < best.at)) best = { body, at };
  }
  return best;
}

const STRUCK = [ROLE.enemy, ROLE.chaser];
const LOOT = [ROLE.collectible, ROLE.enemy];

/**
 * Krok akcí. `base` = základní robot pod obaly (podle něj se pozná, čím se uhýbá).
 * Vrací vstup s tlačítky akcí a bez úhybu, když robot nechává tělo přijít.
 */
export function abilityStep(observation: ArcadeObservation, input: ArcadeInput, base: PieceRef, params: AbilityBot): ArcadeInput {
  const { state, player, recent } = observation;
  const n = recent.length;
  const harm = params.harm.map((role) => ROLE[role]);
  const steer = base.id === 'steer_bot';
  let buttons = input.buttons;
  /** Tělo, kterému robot neuhne (−1 = uhýbá jako obvykle). */
  let hold = -1;
  for (const slot of slotsOf(observation, params)) {
    if (slot.id === 'shoot') {
      // Robot `+shoot` mačká FIRE; tady stejné rozhodnutí na tlačítko akce.
      const seen = { ...observation, recent: recent.map((r) => ((r.buttons & slot.button) !== 0 ? { ...r, buttons: r.buttons | BUTTON.FIRE } : r)) };
      if ((shootStep(seen, { buttons: 0, axis: input.axis }, base).buttons & BUTTON.FIRE) !== 0) buttons |= slot.button;
      continue;
    }
    if (slot.id === 'strike' || slot.id === 'grab') {
      const reach = bodiesOf(state, player, slot.id === 'strike' ? STRUCK : LOOT);
      const active = ABILITY_TIMING[slot.id].active;
      const lands = reach.some((body) => Array.from({ length: active }, (_v, k) => n + k).some((t) => inStrikeReach(state, player, body, t)));
      if (slot.ready && lands) buttons |= slot.button;
      // Úder a krádež nepřítele chtějí, aby přišel: s připravenou akcí neuhnout tomu, co míří na hrdinu.
      const threat = oncoming(observation, bodiesOf(state, player, slot.id === 'strike' ? STRUCK : [ROLE.enemy]), steer ? STEER_COMMIT_TICKS : COMMIT_TICKS, steer);
      if (threat !== null && (slot.ready || slot.activeUntil >= threat.at)) hold = threat.body;
      continue;
    }
    const threat = oncoming(observation, bodiesOf(state, player, harm), steer ? STEER_COMMIT_TICKS : COMMIT_TICKS, steer);
    // Dash i štít (blok) chrání jen po okno: zmáčknout, až dotyk padne do jeho první půlky.
    // Náboj štítu spotřebovaný v posledních tikách robot ještě nevidí – riziko jednoho zásahu.
    const active = ABILITY_TIMING[slot.id].active;
    if (threat !== null && slot.ready && threat.at >= n + 1 && threat.at <= n + Math.floor(active / 2)) buttons |= slot.button;
    if (threat !== null && (slot.ready || slot.activeUntil >= threat.at)) hold = threat.body;
  }
  if (hold < 0) return { buttons, axis: input.axis };
  const evade = EVADE[base.id] ?? 0;
  if (!steer) return { buttons: buttons & ~evade, axis: input.axis };
  const dx = (state[bodyBase(hold) + BODY.x] as number) - (state[bodyBase(player) + BODY.x] as number);
  return { buttons: buttons & ~BUTTON.DOWN, axis: Math.max(-AXIS_MAX, Math.min(AXIS_MAX, Math.trunc((dx * AXIS_MAX) / UNIT))) };
}
