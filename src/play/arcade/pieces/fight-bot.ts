/**
 * Robot souboje (P32E T3) – věrohodný hráč pro ověření režimu `fight`.
 *
 * Svět vidí 8 tiků starý (`reactionTicks`); vlastní polohu si dopočítá z toho,
 * co od té doby zmáčkl (`predict`, pohyb je týž jako v aréně), nepřátele posune
 * o jejich rychlost. Nepřítel, který telegrafuje a hráče by zasáhl: je-li v
 * dosahu a úder připravený, udeří ho (vrávorání úder zruší), jinak uhne
 * stranou a od něj, ke středu nádvoří. Jinak s připraveným úderem jde na
 * nejbližšího nepřítele a udeří; bez něj drží odstup těsně za jeho dosahem.
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, BUTTON, type BotPiece, bodyBase, bodyHp } from '../contract';
import { ARENA, DIRECTIONS, arenaAxis } from './arena';
import { predict } from './arena-bot';
import { FIGHT, FIGHT_PHASE, attackCooldownOf, enemiesOf, inArc, phaseOf, phaseTicksLeft, strikeDirectionOf } from './fight';

const REACTION = 8;
/** Rezerva k dosahu úderu nepřítele, ve které robot už uhýbá. */
const THREAT_MARGIN = 800;
/** O tolik blíž než dosah úderu robot útočí – nepřítel se za reakci pohne. */
const REACH_MARGIN = 300;
/** Rezerva tiků (rozjezd, zpoždění), se kterou robot vkročí telegrafujícímu nepříteli pod úder. */
const STEP_IN = 6;
/** Bez připraveného úderu drží odstup v tomhle pásu (střed ke středu). */
const HOLD = { near: FIGHT.engage + 400, far: FIGHT.engage + 1000 } as const;

const botParams = z.object({}).strict();

export const fightBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'fight_bot',
  params: botParams,
  roles: ['player', 'enemy'],
  // Obal doplňků (`addon_bot`) počítá s 8 tiky u každého základního robota.
  reactionTicks: REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, recent }) => {
    const me = predict(state, player, recent);
    const lag = recent.length;
    const ready = attackCooldownOf(state, player) <= lag && recent.every((input) => (input.buttons & BUTTON.ATTACK) === 0);
    const strike = (dx: number, dz: number): ArcadeInput => ({ buttons: BUTTON.ATTACK, axis: arenaAxis(dx, dz) });

    let nearest: { dx: number; dz: number; gap: number } | null = null;
    let threat: { dx: number; dz: number; gap: number; left: number; locked: number } | null = null;
    for (const i of enemiesOf(state)) {
      if (bodyHp(state, i) === 0) continue;
      const base = bodyBase(i);
      const phase = phaseOf(state, i);
      // Stojí-li (telegraf), je tam i teď; jinak ho posunout o rychlost za reakci.
      const moves = phase !== FIGHT_PHASE.telegraph;
      const dx = (state[base + BODY.x] as number) + (moves ? (state[base + BODY.vx] as number) * lag : 0) - me.x;
      const dz = (state[base + BODY.z] as number) + (moves ? (state[base + BODY.vz] as number) * lag : 0) - me.z;
      const gap = Math.hypot(dx, dz);
      if (nearest === null || gap < nearest.gap) nearest = { dx, dz, gap };
      if (phase !== FIGHT_PHASE.telegraph) continue;
      const locked = strikeDirectionOf(state, i);
      const left = phaseTicksLeft(state, i) - lag;
      if (!inArc(-dx, -dz, locked, FIGHT.strikeReach + THREAT_MARGIN, 0)) continue;
      if (threat === null || left < threat.left) threat = { dx, dz, gap, left, locked };
    }
    if (nearest === null) return { buttons: 0, axis: 0 };

    if (threat !== null) {
      if (ready && threat.gap <= FIGHT.attackReach - REACH_MARGIN) return strike(threat.dx, threat.dz);
      // Dojde-li do dosahu dřív, než úder padne, vkročí mu pod něj.
      if (ready && threat.left > (threat.gap - FIGHT.attackReach + REACH_MARGIN) / ARENA.speed + STEP_IN) return { buttons: 0, axis: arenaAxis(threat.dx, threat.dz) };
      // Uhnout: kolmo na zamčený směr, na stranu blíž středu, a přitom od nepřítele.
      const dir = DIRECTIONS[threat.locked]!;
      const side = -me.x * dir.dz + me.z * dir.dx >= 0 ? 1 : -1;
      return { buttons: 0, axis: arenaAxis(side * dir.dz + dir.dx, -side * dir.dx + dir.dz) };
    }
    if (ready) return nearest.gap <= FIGHT.attackReach - REACH_MARGIN ? strike(nearest.dx, nearest.dz) : { buttons: 0, axis: arenaAxis(nearest.dx, nearest.dz) };
    if (nearest.gap > HOLD.far) return { buttons: 0, axis: arenaAxis(nearest.dx, nearest.dz) };
    if (nearest.gap < HOLD.near) return { buttons: 0, axis: arenaAxis(-nearest.dx, -nearest.dz) };
    return { buttons: 0, axis: 0 };
  },
};
