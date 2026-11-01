/**
 * Hratelnost střelnice z očí z konstrukce (P68-F T2): `checkRailfpsLevel` přepočítá nad hotovou úrovní a rozvrhem
 * vln, že rychlý hráč (reakce robota) stihne každou vlnu vyčistit – nepřátele v pořadí podle toho, kdy by došli,
 * s otočkou z nejhoršího natočení a s rozestupem ran – a že celá hra se vejde do časového limitu. Prázdné pole =
 * hratelná. Generátor ji volá nad každou úrovní, publikační brána odmítne úroveň s hláškou.
 */

import { ARCADE_LIMITS, type ArcadeLevel } from '../contract';
import { ROUNDS } from '../hooks/contract';
import {
  HEIGHT_ROWS,
  RAILFPS,
  RAILFPS_BODIES,
  RAILFPS_LIMIT_TICKS,
  RAILFPS_RIG_KIND,
  YAW,
  bossSpeedOf,
  enemySpeedAt,
  walkTicks,
} from './railfps-world';

/** Příchod: hodiny kola, předloha (terč, nepřítel, boss), sektor −4..4, řádek výšky 0..2, vzdálenost. */
export type RailfpsArrival = readonly [at: number, template: number, sector: number, row: number, distance: number];

/** Rezerva na konci hry před časovým limitem (tiky). */
const END_MARGIN = 2 * 60;

/**
 * Nejrychlejší vyčištění vlny `k` (tiky hodin kola), nebo hláška, kterého nepřítele hráč nestihne. Nepřátelé jdou
 * v pořadí podle termínu (poslední tik, kdy je zásah ještě před `reach`), terče po nich; před každým cílem reakce
 * robota, otočka a rozestup ran, boss `bossHp` ran za sebou. První otočka vlny jde přes celý oblouk.
 */
export function waveClearTicks(wave: readonly RailfpsArrival[], k: number): { readonly ticks: number; readonly late: string[] } {
  const late: string[] = [];
  const enemies = wave
    .filter(([, template]) => template !== RAILFPS_BODIES.target)
    .map(([at, template, sector, , distance]) => {
      const boss = template === RAILFPS_BODIES.boss;
      return { at, sector, boss, deadline: at + walkTicks(distance, boss ? bossSpeedOf(enemySpeedAt(k)) : enemySpeedAt(k)) - 1 };
    })
    .sort((a, b) => a.deadline - b.deadline || a.at - b.at);
  const targets = wave.filter(([, template]) => template === RAILFPS_BODIES.target).map(([at, , sector]) => ({ at, sector }));
  let t = 0;
  let cur = Number.NaN;
  let lastShot = -RAILFPS.fireInterval;
  const shoot = (at: number, sector: number, shots: number): number => {
    const turn = Number.isNaN(cur) ? 2 * YAW.maxSector : Math.abs(sector - cur);
    t = Math.max(t, at) + RAILFPS.botReaction + turn * YAW.turnTicks;
    t = Math.max(t, lastShot + RAILFPS.fireInterval);
    t += (shots - 1) * RAILFPS.fireInterval;
    lastShot = t;
    cur = sector;
    return t;
  };
  enemies.forEach((enemy, index) => {
    const hit = shoot(enemy.at, enemy.sector, enemy.boss ? RAILFPS.bossHp : 1);
    if (hit > enemy.deadline) late.push(`wave ${String(k + 1)}: ${enemy.boss ? 'the boss' : `enemy ${String(index + 1)}`} reaches the player ${String(hit - enemy.deadline)} ticks before a quick player can turn and fire`);
  });
  for (const target of targets) shoot(target.at, target.sector, 1);
  return { ticks: t, late };
}

/** Tvrzení „hratelné z konstrukce“ nad úrovní střelnice z očí a rozvrhem vln; prázdné pole = hratelná. */
export function checkRailfpsLevel(level: ArcadeLevel, waves: readonly (readonly RailfpsArrival[])[]): string[] {
  const issues: string[] = [];
  const { bodies } = level;
  if (bodies[RAILFPS_BODIES.player]?.role !== 'player') issues.push('no player');
  if (bodies[RAILFPS_BODIES.keeper]?.kind !== RAILFPS_RIG_KIND || bodies[RAILFPS_BODIES.keeper]?.template !== true) issues.push('no aim keeper');
  if (bodies[RAILFPS_BODIES.target]?.role !== 'target' || bodies[RAILFPS_BODIES.target]?.template !== true) issues.push('no target template');
  if (bodies[RAILFPS_BODIES.enemy]?.role !== 'enemy' || bodies[RAILFPS_BODIES.enemy]?.template !== true) issues.push('no enemy template');
  if (bodies[RAILFPS_BODIES.boss]?.role !== 'enemy' || bodies[RAILFPS_BODIES.boss]?.template !== true || (bodies[RAILFPS_BODIES.boss]?.hp ?? 0) < 1) issues.push('no boss template with HP');
  if (waves.length < RAILFPS.waves.min || waves.length > ROUNDS.max) issues.push(`${String(waves.length)} waves – the game needs ${String(RAILFPS.waves.min)} to ${String(ROUNDS.max)}`);

  let total = 0;
  let enemies = 0;
  let busiest = 0;
  waves.forEach((wave, k) => {
    const name = `wave ${String(k + 1)}`;
    if (wave.length === 0) issues.push(`${name} brings nothing`);
    busiest = Math.max(busiest, wave.length);
    wave.forEach(([at, template, sector, row, distance], n) => {
      const what = `${name} item ${String(n + 1)}`;
      if (!Number.isInteger(sector) || Math.abs(sector) > YAW.maxSector) issues.push(`${what} stands in sector ${String(sector)}, outside -${String(YAW.maxSector)}..${String(YAW.maxSector)}`);
      if (!Number.isInteger(row) || row < 0 || row >= HEIGHT_ROWS.length) issues.push(`${what} floats in row ${String(row)}, outside 0..${String(HEIGHT_ROWS.length - 1)}`);
      if (at < 1 || (n > 0 && at < (wave[n - 1] as RailfpsArrival)[0])) issues.push(`${what} is out of order`);
      if (distance > RAILFPS.range || distance <= RAILFPS.reach) issues.push(`${what} appears ${String(distance)} units away, outside the shooting band`);
      if (template === RAILFPS_BODIES.target) total += 1;
      else if (template === RAILFPS_BODIES.enemy || template === RAILFPS_BODIES.boss) {
        total += 1;
        enemies += 1;
        if (row !== 0) issues.push(`${what} is an enemy off the ground`);
      } else issues.push(`${what} is not a target or an enemy`);
    });
  });
  if (total === 0) issues.push('nothing to shoot');
  if (enemies === 0) issues.push('no enemy – a player who does nothing would never lose');

  let ticks = 0;
  waves.forEach((wave, k) => {
    const clear = waveClearTicks(wave, k);
    issues.push(...clear.late);
    ticks += Math.max(clear.ticks, (wave.at(-1) ?? [0])[0]) + 1;
  });
  ticks += Math.max(0, waves.length - 1) * ROUNDS.breakTicks;
  if (ticks > RAILFPS_LIMIT_TICKS - END_MARGIN) issues.push(`a quick player needs ${(ticks / 60).toFixed(1)} s, over the ${String(RAILFPS.seconds)} s limit`);
  const capacity = bodies.length + (level.spawnSlots ?? 0);
  if (capacity > ARCADE_LIMITS.maxBodies) issues.push(`${String(capacity)} bodies exceed the ${String(ARCADE_LIMITS.maxBodies)} body limit`);
  if (busiest > (level.spawnSlots ?? 0)) issues.push(`a wave of ${String(busiest)} does not fit ${String(level.spawnSlots ?? 0)} spawn slots`);
  return issues;
}
