/**
 * Kola „Round N of M“ (P66 T3, kontrakt `hooks/contract.ts`): úroveň má `rounds` kol a vyhraje se až po posledním.
 *
 * **Konec kola** hlásí žánr jedním ze tří signálů (`clear` v parametrech `hooks`):
 * - `wave` – žánr ve vlnách (`arena_waves`, obrana pruhů) zvedl čítač vlny (`waveOf`) nad běžící kolo: kolo = vlna;
 * - `win` – pravidlo žánru vyhlásilo výhru; před posledním kolem z ní je jen vyčištěné kolo a žánr podle
 *   `roundOf` postaví další (nové žánry);
 * - `goal` (P66 T10) – postup žánru ke cíli (`goal`: skóre sběru, padlí nepřátelé střelnice) dosáhl značky kola:
 *   kola jsou stejné díly cíle průběhu (`pacing-parts`), takže výhra na skóre přijde až po poslední značce.
 *
 * Výhra před posledním kolem neplatí v žádném z nich; prohra platí kdykoli, podle pravidla žánru.
 *
 * **Přestávka po vyčištěném kole** (`round_clear`): svět stojí – ovládání, pravidla ani fyzika neběží, jen odpočet
 * a volba karty. Bez nabídky trvá `ROUNDS.breakTicks`, s nabídkou do volby, nejdéle `UPGRADE_OFFER.pickTicks`.
 * Pak hned `round_start` dalšího kola, bez nového načtení. Tik běží dál (záznam vstupů i `time_limit` ho čtou),
 * takže přestávka se hodinám hry počítá.
 *
 * **Hodiny světa** (`clock`, P66 T10): žánr, který pouští věci v pevných ticích (pochod střelnice, vlny obrany),
 * čte tik bez přestávek (`worldTickOf`) – jinak by přestávka posunula rozvrh proti zastaveným tělům, a co vyšlo
 * na tik v přestávce, by nevyšlo vůbec. Přestávky počítá počítadlo háčků (`CLOCK_SLOTS.paused`).
 */

import { createStreams, nextInt } from '@/sim/rng';

import { BODY, COUNTER, FLAG, HEADER, RUN_STATE, bodyBase, type ArcadeInput } from '../contract';
import { waveOf } from '../pieces/waves';
import { HOOK_SLOTS, ROUNDS, UPGRADE_OFFER, type HookEffect } from './contract';
import type { HookParams } from './index';
import { openOffer, pickedCard, takeCard } from './upgrades';

const at = (keeper: number, slot: number): number => bodyBase(keeper) + slot;

/** Index běžícího (v přestávce právě vyčištěného) kola 0..`rounds`−1. */
export const roundOf = (state: Int32Array, keeper: number): number => state[at(keeper, HOOK_SLOTS.round)] as number;
/** Stojí svět v přestávce po vyčištěném kole? */
export const inBreak = (state: Int32Array, keeper: number): boolean => (state[at(keeper, HOOK_SLOTS.breakLeft)] as number) > 0;

/** Slot počítadla háčků mimo kontrakt `HOOK_SLOTS`: kolik tiků už přestávky trvaly (jen s `clock`). */
export const CLOCK_SLOTS = { paused: BODY.aux1 } as const;

/**
 * Tik světa: tik hry bez přestávek. Kus žánru s počítadlem háčků `keeper` (parametr `hooks`) podle něj pouští věci
 * v pevných ticích; bez něj (uložené hry, svět bez háčků) je to tik hry beze změny.
 */
export const worldTickOf = (state: Int32Array, keeper: number | undefined): number =>
  (state[HEADER.tick] as number) - (keeper === undefined ? 0 : (state[at(keeper, CLOCK_SLOTS.paused)] as number));

/** Postup ke značkám kol `goal`: vlna, skóre, nebo padlí soupeři role `role` (`need` minus živí, jako průběh `fallen`). */
function goalDone(state: Int32Array, goal: NonNullable<HookParams['goal']>): number {
  if (goal.by === 'wave') return waveOf(state);
  if (goal.by === 'score') return state[HEADER.counters + COUNTER.score] as number;
  let alive = 0;
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (state[base + BODY.role] === goal.role && ((state[base + BODY.flags] as number) & FLAG.alive) !== 0) alive += 1;
  }
  return goal.need - alive;
}

/**
 * Rozvrh kol: semínko obsahu každého kola ze streamu `rounds` hry `seed` (žánr z něj staví mřížku či frontu kola,
 * jako řetěz mikroher semínka svých kol). Při stavbě, ne za běhu.
 */
export function roundSeeds(seed: number, rounds: number): number[] {
  const stream = createStreams(seed).rounds;
  return Array.from({ length: rounds }, () => nextInt(stream, 0, 0x7fffffff));
}

/** Kolo `round` je vyčištěné: zpráva a hláška, přestávka – s nabídkou z pořadí té přestávky, jinak jen odpočet. */
function clearRound(state: Int32Array, params: HookParams, round: number, out: HookEffect[]): void {
  out.push({ kind: 'round_clear', round, rounds: params.rounds }, { kind: 'callout', callout: 'round_clear' });
  if (round === params.rounds - 1) return;
  const order = params.upgrades?.offers[round];
  if (order === undefined) {
    state[at(params.keeper, HOOK_SLOTS.breakLeft)] = ROUNDS.breakTicks;
    return;
  }
  out.push({ kind: 'upgrade_offer', offer: openOffer(state, params.keeper, order) });
  state[at(params.keeper, HOOK_SLOTS.breakLeft)] = UPGRADE_OFFER.pickTicks;
}

/**
 * Kola na konci tiku, po všech průchodech pravidel: v tiku 0 začne první kolo; výhra před posledním kolem se vrátí
 * na běh (u `win` je to konec kola), výhra v posledním kole platí; u `wave` kolo skončí, když žánr zvedl vlnu.
 */
export function roundsEnd(state: Int32Array, params: HookParams, out: HookEffect[]): void {
  const round = roundOf(state, params.keeper);
  if (state[HEADER.tick] === 0) out.push({ kind: 'round_start', round: 0, rounds: params.rounds });
  const run = state[HEADER.runState];
  if (run === RUN_STATE.lost) return;
  const last = round === params.rounds - 1;
  if (run === RUN_STATE.won) {
    if (last) {
      clearRound(state, params, round, out);
      return;
    }
    state[HEADER.runState] = RUN_STATE.running;
    if (params.clear === 'win') clearRound(state, params, round, out);
    return;
  }
  if (params.clear === 'wave' && !last && waveOf(state) > round) clearRound(state, params, round, out);
  else if (params.clear === 'goal' && params.goal !== undefined && !last && goalDone(state, params.goal) >= (params.goal.marks[round] as number)) clearRound(state, params, round, out);
}

/**
 * Tik přestávky (svět stojí): volba karty ze vstupu, jinak odpočet a po `pickTicks` karta `defaultCard`; bez nabídky
 * jen odpočet. Na konci přestávky hned `round_start` dalšího kola.
 */
export function breakTick(state: Int32Array, input: ArcadeInput, params: HookParams): HookEffect[] {
  const out: HookEffect[] = [];
  const breakLeft = at(params.keeper, HOOK_SLOTS.breakLeft);
  const pickLeft = at(params.keeper, HOOK_SLOTS.pickLeft);
  if (params.clock === true) state[at(params.keeper, CLOCK_SLOTS.paused)] = (state[at(params.keeper, CLOCK_SLOTS.paused)] as number) + 1;
  if ((state[pickLeft] as number) > 0) {
    let card = pickedCard(input);
    if (card < 0) {
      state[pickLeft] = (state[pickLeft] as number) - 1;
      if (state[pickLeft] === 0) card = UPGRADE_OFFER.defaultCard;
    }
    // Volba kartu vezme a přestávku ukončí; odpočet do ní dál neběží.
    if (card >= 0) {
      takeCard(state, params.keeper, card, out, params.lifeCap);
      state[breakLeft] = 1;
    }
  }
  state[breakLeft] = (state[breakLeft] as number) - 1;
  if (state[breakLeft] === 0) {
    const next = roundOf(state, params.keeper) + 1;
    state[at(params.keeper, HOOK_SLOTS.round)] = next;
    out.push({ kind: 'round_start', round: next, rounds: params.rounds });
  }
  return out;
}
