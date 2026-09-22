/**
 * `chaser`: pronásledovatel míří tam, kde je hráč; dotyk prohraje nebo zraní.
 *
 * Runtime umí jen `moveTo` na **statický soket**, polohu hráče vidí jen přes
 * `inZone`. Každá buňka mřížky je proto soket i zóna (`chase_<x>_<y>`) a
 * vstup hráče do buňky pošle pronásledovatele na ni. Hráč, který stojí, je
 * tím chycen vždy: buď ho pronásledovatel dožene v buňce, do které vstoupil,
 * nebo – stojí-li od začátku na spawnu – ho tam pošle `onSeen` (viditelnost
 * je bez blokovaných buněk vždy pravda, takže hrana vystřelí hned v prvním
 * tiku). Pásma z mapy (`chase_zN`, 12 na mřížku) by běžícího hráče nechytila
 * o nic líp: každý nový `moveTo` resetuje prodlevu `ticks`, takže se
 * pronásledovatel hýbe jen tehdy, když hráč přestane měnit cíl.
 *
 * Pravidel je `width × height + 2` na instanci – nad odhadem registru
 * (`12 × count + 1`); rozvržení z T2 drží mřížku pod ~80 buňkami u fixtur.
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import { PLAYER_SOCKET } from '../sim';
import type { MechanicAdapter, SurfaceAction, SurfaceRule } from '../types';
import { DAMAGE_COUNTER } from './health';

/** Tiky prodlevy před prvním krokem; potom 1 buňka za tik (`settle`). */
export const CHASER_DELAY: Readonly<Record<'slow' | 'normal' | 'fast', number>> = { slow: 12, normal: 8, fast: 5 };
/**
 * Prodleva prvního rozjezdu (3 s). S `CHASER_DELAY` byl hráč chycen na ticku
 * 17, dřív než stihl přečíst zadání (QA 22. 9. 2026). Další kroky honičky
 * zůstávají rychlé – prodlouží se jen start.
 */
export const CHASER_START_GRACE = 60;

type Params = z.infer<(typeof MECHANICS)['chaser']['params']>;

export const cellSocket = (x: number, y: number): string => `chase_${x}_${y}`;

export const chaser: MechanicAdapter<Params> = (params, ctx) => {
  const rules: Record<string, SurfaceRule> = {};
  const ticks = CHASER_DELAY[params.speed];
  const hasHealth = ctx.spec.mechanics.some((mechanic) => mechanic.id === 'health');
  const hit: SurfaceAction = params.catchEffect === 'damage' && hasHealth ? { kind: 'addCounter', ref: DAMAGE_COUNTER, by: 1 } : { kind: 'lose' };
  const sockets: Record<string, readonly [number, number]> = {};
  for (let y = 0; y < ctx.layout.height; y += 1) for (let x = 0; x < ctx.layout.width; x += 1) sockets[cellSocket(x, y)] = [x, y];

  for (const id of ctx.instances(params.role)) {
    for (const socket of Object.keys(sockets)) {
      const follow = `chaser.${id}.${socket}`;
      rules[follow] = {
        id: follow,
        phase: 0,
        priority: 0,
        event: { kind: 'onEnterZone', entity: ctx.player, zone: socket },
        condition: null,
        actions: [{ kind: 'moveTo', target: id, socket, ticks }],
      };
    }
    const start = `chaser.${id}.start`;
    rules[start] = {
      id: start,
      phase: 0,
      priority: 0,
      event: { kind: 'onSeen', agent: id, target: ctx.player },
      condition: null,
      actions: [{ kind: 'moveTo', target: id, socket: PLAYER_SOCKET, ticks: Math.max(ticks, CHASER_START_GRACE) }],
    };
    const touch = `chaser.${id}.touch`;
    rules[touch] = { id: touch, phase: 1, priority: 0, event: { kind: 'onCollide', a: id, b: ctx.player }, condition: null, actions: [hit] };
  }
  return { rules, sockets };
};
