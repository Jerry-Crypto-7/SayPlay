/**
 * Napětí hry pro hudbu (P37B T5): poslední život, poslední sekundy limitu,
 * nebo pronásledovatel či nepřítel blízko hráče. Jen čte stav po tiku – do
 * relace, stavu ani hashe nic nepíše; hudba je ozdoba mimo stav.
 *
 * Napětí drží `HOLD_TICKS` po posledním důvodu: soupeř, který se hráči
 * vzdaluje a zase blíží, by jinak smyčky přepínal každou sekundu.
 */

import { ARCADE_HZ, BODY, COUNTER, FLAG, HEADER, ROLE, RUN_STATE, UNIT, bodyBase } from '@/play/arcade/contract';

/** Poslední sekundy limitu, ve kterých hudba přitvrdí. */
export const LAST_SECONDS = 10;
/** Pronásledovatel nebo nepřítel blíž než tohle (m, vodorovně) = napětí. */
export const NEAR_M = 3;
/** Jak dlouho napětí doznívá po posledním důvodu: 4 s. */
export const HOLD_TICKS = 4 * ARCADE_HZ;

const THREATS: ReadonlySet<number> = new Set([ROLE.chaser, ROLE.enemy]);

/** Je hra v tomto tiku napjatá? `livesStart` = životy na startu, `limitSeconds` = limit nebo přežití (`null` = bez času). */
export function tenseNow(state: Int32Array, livesStart: number, limitSeconds: number | null): boolean {
  if (state[HEADER.runState] !== RUN_STATE.running) return false;
  const lives = state[HEADER.counters + COUNTER.health] as number;
  if (livesStart > 1 && lives === 1) return true;
  const seconds = (state[HEADER.tick] as number) / ARCADE_HZ;
  if (limitSeconds !== null && limitSeconds - seconds <= LAST_SECONDS) return true;
  const player = bodyBase(state[HEADER.player] as number);
  const px = state[player + BODY.x] as number;
  const pz = state[player + BODY.z] as number;
  const near = NEAR_M * UNIT;
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (!THREATS.has(state[base + BODY.role] as number) || ((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
    if (Math.hypot((state[base + BODY.x] as number) - px, (state[base + BODY.z] as number) - pz) < near) return true;
  }
  return false;
}

/** Napětí s doznějem: vrací funkci, která pro každý nový stav řekne, má-li hrát napjatá smyčka. */
export function createTension(livesStart: number, limitSeconds: number | null): (state: Int32Array) => boolean {
  let lastTense = -Infinity;
  return (state) => {
    const tick = state[HEADER.tick] as number;
    // Restart (tik zpět) začíná bez napětí.
    if (tick < lastTense) lastTense = -Infinity;
    if (tenseNow(state, livesStart, limitSeconds)) lastTense = tick;
    return state[HEADER.runState] === RUN_STATE.running && tick - lastTense < HOLD_TICKS;
  };
}
