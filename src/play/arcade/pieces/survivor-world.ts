/**
 * Přežití ve vlnách (P66 T5) – míry, rozložení stavu a čtení stavu, které sdílí ovládání a pravidla
 * (`survivor.ts`), robot (`survivor-bot.ts`) i scéna (`SurvivorScene.tsx`). Bez chování: jen konstanty
 * a čisté funkce nad stavem, celá čísla.
 */

import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeState, BODY, FLAG, HEADER, ROLE, UNIT, bodyBase, bodyHp } from '../contract';
import { UPGRADE_OFFER, UPGRADE_STEP, type UpgradeId } from '../hooks/contract';
import { DIRECTIONS } from './arena';

// ---------------------------------------------------------------------------
// Míry

export const SURVIVOR = {
  /** Polovina šířky (x) a hloubky (z) arény: na výšku telefonu vyšší než širší. */
  halfX: 7 * UNIT,
  halfZ: 11 * UNIT,
  hero: { w: 900, h: 1600, d: 900 },
  /** Hrdina (5,7 m/s) a jak rychle se rozjede a zastaví (jednotek za tik). */
  speed: 95,
  accel: 20,
  friction: 20,
  enemy: { w: 1000, h: 1500, d: 1000 },
  boss: { w: 2200, h: 2800, d: 2200 },
  /** Střela: rozměr, výška letu, rychlost (21,6 m/s) a život. Dostřel = rychlost × život. */
  shot: { w: 350, h: 350, d: 350, y: 500, speed: 360, life: 18 },
  crystal: { w: 550, h: 550, d: 550 },
  orb: { w: 700, h: 700, d: 700, y: 200 },
  /** Rozestup ran (2,5 rány/s) – `fire_rate` ho zkrátí o `UPGRADE_STEP.fire_rate` % za stupeň. */
  fireTicks: 24,
  /** Kola (háčky): poslední je boss, ostatní vlny. */
  rounds: { min: 2, max: 5, default: 4 },
  /**
   * Hodiny celé hry (s, pravidlo `time_limit`). Kolo vlastní limit nemá – končí vyčištěním –, takže hráč, který
   * nepřátele jen vodí kolem, by vyhrál až za horizontem ověření a výzvu z výhry by server odmítl (`score/dare.ts`).
   * Hodiny běží i v přestávkách s výběrem karty, takže každá výhra padne před ně. 85 s = horizont bez jedné celé volby
   * karty (`UPGRADE_OFFER.pickTicks`): v přestávce pravidla neběží, prohra na hodinách, které doběhnou při volbě,
   * padne až po ní – pořád v horizontu. Robot světa vyhraje nejdéle za 53 s (5 kol, 40 nepřátel, semínka 1–10).
   */
  seconds: (ARCADE_LIMITS.maxTicks - UPGRADE_OFFER.pickTicks) / ARCADE_HZ,
  /** Nepřátel ve vlnách dohromady (bez bosse a jeho posil). */
  enemies: { min: 16, max: 40, default: 36 },
  /** Body za padlého nepřítele (× kombo), za krystal a za bosse. */
  points: { kill: 10, crystal: 5, boss: 200 },
  /** Krystalů naráz nejvýš; nad to padlý nepřítel krystal nenechá. */
  crystals: 12,
  /** Odhod hrdiny po zásahu (jednotek za tik). */
  knockback: 260,
  /** Nepřítel se drží aspoň tak daleko od jiného (střed ke středu). */
  separation: 1300,
  /** Příchod nepřítele nejblíž tolik od hrdiny – jinak od protějšího okraje. */
  spawnGap: 5 * UNIT,
  /** Kolik dovnitř od okraje nepřítel vstoupí. */
  inset: 600,
} as const;

/** Vlna `k` (od 0) z `waves`: HP, rychlost, skupiny po kolika, rozestup skupin (tiky) a začátek. */
export function waveShape(k: number, waves: number): { readonly hp: number; readonly speed: number; readonly group: number; readonly gap: number; readonly start: number } {
  const late = waves <= 1 ? 1 : k / (waves - 1);
  return {
    hp: k === 0 ? 1 : 2,
    speed: 48 + Math.round(14 * late),
    group: 2,
    gap: 70 - Math.round(14 * late),
    start: 30,
  };
}

/** Boss posledního kola: HP, rychlost, časy fází (tiky), útoky a posily. */
export const BOSS = {
  /** HP při třech vlnách (tři výběry vylepšení); za každou vlnu míň či víc o `hpPerWave` (`bossHpOf`). */
  hp: 30,
  hpPerWave: 1,
  speed: 42,
  /** Příchod na scénu (hodiny kola). */
  at: 45,
  approach: 80,
  /**
   * Telegraf ≥ 400 ms (UI audit P32E): 0,5 s, rozzuřený 0,43 s. Z pásu rozběhu (poloviční šíře bosse + hrdiny 1,55 m)
   * hrdina rychlostí 95 uteče s reakcí 0,2 s (1,7 m), s reakcí 0,33 s ne (0,95 m) – telegraf odliší pomalého hráče.
   */
  telegraph: 30,
  enragedTelegraph: 26,
  /** Rozběh: rychlost a délka. */
  charge: { speed: 290, ticks: 24 },
  /** Dupnutí a salva: jak dlouho boss stojí v útoku (tiky). */
  strike: 10,
  /** Dupnutí: poloměr rány (střed ke středu). */
  stomp: { radius: 3600 },
  /** Salva koulí: počet, rozzuřený, rychlost, život (tiky). */
  volley: { count: 8, enraged: 12, speed: 95, life: 150 },
  /** Po útoku stojí (tiky) – okno, kdy se dá v klidu střílet. */
  recover: 40,
  enragedRecover: 26,
  /** Rozzuří se pod tímhle podílem HP (procenta). */
  enrageAt: 50,
  /** O kolik blíž se boss počítá při výběru cíle střelby (j). */
  aimBias: 2500,
  /**
   * Posily: HP, rychlost, po kolika (po každých `grow` skupinách o jednoho víc), první a rozestup (tiky, s každou
   * skupinou o `shrink` kratší až na `minGap`), strop živých. Kolem 18 s kola jdou trojice každou sekundu: boss, který
   * do té doby nepadl (hrdina bez vylepšení rány), hrdinu zavalí.
   */
  minion: { hp: 2, speed: 64, group: 2, grow: 4, first: 230, gap: 280, minGap: 60, shrink: 50, cap: 12 },
} as const;

/**
 * HP bosse po `waves` vlnách (tolik výběrů vylepšení): nad tři vlny o `hpPerWave` víc za vlnu, pod tři o trojnásobek
 * méně – hrdina se dvěma výběry má o třetinu slabší ránu, se čtyřmi jen o pár procent silnější.
 */
export const bossHpOf = (waves: number): number => BOSS.hp + (waves >= 3 ? BOSS.hpPerWave : 3 * BOSS.hpPerWave) * (waves - 3);

/**
 * Nejvýš tolik nepřátel ve vlně `k` (od 0) hry s `waves` vlnami: víc by hrdinu obstoupilo. S méně než třemi vlnami
 * smí první (nepřátelé s 1 HP) být větší – kratší hra z věty tak netrvá jen čtvrt minuty; další vlny ne, hrdina
 * před nimi vybral méně vylepšení.
 */
export const waveCap = (k: number, waves: number): number => 10 + 4 * k + (k === 0 ? 4 * Math.max(0, 3 - waves) : 0);

export const BOSS_ATTACK_CODES = ['charge', 'stomp', 'shoot'] as const;
export type SurvivorAttack = (typeof BOSS_ATTACK_CODES)[number];

/** Fáze bosse v `aux0 & 0xf`. Čísla jsou součást hashe, nepřečíslovat. */
export const BOSS_PHASE = { enter: 0, approach: 1, telegraph: 2, act: 3, recover: 4 } as const;
export type BossPhase = (typeof BOSS_PHASE)[keyof typeof BOSS_PHASE];

/**
 * Stav přežití na těle-počítadle (mrtvá předloha za hrdinou, jako počítadlo komba): hodiny kola, kolo, které hodiny
 * měří, a cíl výstřelu tohoto tiku (+1; 0 = nevystřelil). Píše jen ovládání, pravidla čtou.
 */
export const SURVIVOR_SLOTS = { clock: BODY.x, round: BODY.y, fired: BODY.z } as const;

/** Tělesa úrovně v pořadí (indexy jsou součást hashe): hrdina, počítadlo, předlohy, pak předlohy vln. */
export const SURVIVOR_BODIES = { hero: 0, keeper: 1, shot: 2, crystal: 3, orb: 4, boss: 5, minion: 6, firstWave: 7 } as const;

/** Zásoba karet přežití: hrdina nenese náklad (`carry`). */
export const SURVIVOR_UPGRADES: readonly UpgradeId[] = ['fire_rate', 'range', 'speed', 'extra_life', 'magnet'];

/** Kolik krystalů boss nechá (kruh kolem místa pádu). */
export const BOSS_CRYSTALS = 5;

// ---------------------------------------------------------------------------
// Čtení stavu

export const alive = (state: ArcadeState, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
export const kindOf = (state: ArcadeState, body: number): number => state[bodyBase(body) + BODY.kind] as number;
/** Celočíselná délka vektoru (`Math.sqrt` je v IEEE 754 přesně zaokrouhlená – všude stejné číslo). */
export const length = (dx: number, dz: number): number => Math.floor(Math.sqrt(dx * dx + dz * dz));

export const clockOf = (state: ArcadeState, keeper: number = SURVIVOR_BODIES.keeper): number => state[bodyBase(keeper) + SURVIVOR_SLOTS.clock] as number;

/** Živí nepřátelé (vlny, posily i boss): role `enemy`, ne předlohy. */
export function enemiesOf(state: ArcadeState): number[] {
  const out: number[] = [];
  for (let i = state[HEADER.spawnBase] as number; i < (state[HEADER.bodyCount] as number); i += 1) {
    if (state[bodyBase(i) + BODY.role] === ROLE.enemy && alive(state, i)) out.push(i);
  }
  return out;
}

/** Živá těla s rolí a modelem předlohy `template` (koule, krystaly, boss). */
export function copiesOf(state: ArcadeState, template: number): number[] {
  const kind = kindOf(state, template);
  const role = state[bodyBase(template) + BODY.role];
  const out: number[] = [];
  for (let i = state[HEADER.spawnBase] as number; i < (state[HEADER.bodyCount] as number); i += 1) {
    const base = bodyBase(i);
    if (state[base + BODY.role] === role && state[base + BODY.kind] === kind && alive(state, i)) out.push(i);
  }
  return out;
}

export const isBoss = (state: ArcadeState, body: number, template: number = SURVIVOR_BODIES.boss): boolean => kindOf(state, body) === kindOf(state, template);

/** Živý boss, nebo −1. */
export const bossOf = (state: ArcadeState, template: number = SURVIVOR_BODIES.boss): number => copiesOf(state, template)[0] ?? -1;

export const bossPhaseOf = (state: ArcadeState, boss: number): BossPhase => ((state[bodyBase(boss) + BODY.aux0] as number) & 0xf) as BossPhase;
/** Index útoku v cyklu útoků bosse (`attacks` ovládání). */
export const bossAttackIndexOf = (state: ArcadeState, boss: number): number => ((state[bodyBase(boss) + BODY.aux0] as number) >> 4) & 0xf;
/** Směr zamčený na začátku telegrafu (0..31). */
export const bossAimOf = (state: ArcadeState, boss: number): number => ((state[bodyBase(boss) + BODY.aux0] as number) >> 8) & 31;
export const bossTicksLeft = (state: ArcadeState, boss: number): number => state[bodyBase(boss) + BODY.aux1] as number;

/** Je boss rozzuřený (HP pod `BOSS.enrageAt` %)? Plné HP čte z předlohy. */
export const enraged = (state: ArcadeState, boss: number, template: number = SURVIVOR_BODIES.boss): boolean => bodyHp(state, boss) * 100 < bodyHp(state, template) * BOSS.enrageAt;

/** Rozestup ran se stupněm `fire_rate`. */
export const fireTicksAt = (level: number): number => SURVIVOR.fireTicks - Math.trunc((SURVIVOR.fireTicks * UPGRADE_STEP.fire_rate * level) / 100);
/** Rychlost střely se stupněm `range` (život stejný, takže dostřel roste s ní). */
export const shotSpeedAt = (level: number): number => Math.trunc((SURVIVOR.shot.speed * (100 + UPGRADE_STEP.range * level)) / 100);
/** Dostřel – jak daleko ovládání cíl hledá. */
export const rangeAt = (level: number): number => shotSpeedAt(level) * SURVIVOR.shot.life;

/**
 * Nejbližší živý nepřítel do dostřelu `range` od hrdiny (k okraji těla), nebo −1 (shoda = nižší index). Boss se počítá
 * o `BOSS.aimBias` blíž: posily, které ho obstoupí, by jinak braly všechny rány a boss by nepadl nikdy.
 */
export function nearestEnemy(state: ArcadeState, player: number, range: number): number {
  const p = bodyBase(player);
  let best = -1;
  let bestGap = range + 1;
  for (const i of enemiesOf(state)) {
    const base = bodyBase(i);
    const reach = Math.trunc((state[base + BODY.w] as number) / 2);
    const gap = Math.max(0, length((state[base + BODY.x] as number) - (state[p + BODY.x] as number), (state[base + BODY.z] as number) - (state[p + BODY.z] as number)) - reach);
    if (gap > range) continue;
    const ranked = isBoss(state, i) ? gap - BOSS.aimBias : gap;
    if (ranked < bestGap) {
      best = i;
      bestGap = ranked;
    }
  }
  return best;
}

/** Rychlost střely z hrdiny na cíl `target` s předstihem (kam cíl dojde za dobu letu), celočíselně. */
export function aimAt(state: ArcadeState, player: number, target: number, speed: number): { readonly vx: number; readonly vz: number } {
  const p = bodyBase(player);
  const t = bodyBase(target);
  const dx = (state[t + BODY.x] as number) - (state[p + BODY.x] as number);
  const dz = (state[t + BODY.z] as number) - (state[p + BODY.z] as number);
  const flight = Math.min(SURVIVOR.shot.life, Math.trunc(length(dx, dz) / Math.max(1, speed)));
  const ax = dx + (state[t + BODY.vx] as number) * flight;
  const az = dz + (state[t + BODY.vz] as number) * flight;
  const gap = Math.max(1, length(ax, az));
  return { vx: Math.trunc((ax * speed) / gap), vz: Math.trunc((az * speed) / gap) };
}

/**
 * Kde nepřítel vstoupí: na okraji arény ve směru `dir` od hrdiny; když by to bylo blíž než `SURVIVOR.spawnGap`
 * (hrdina u stěny), od protějšího okraje. `side` posune člena skupiny kolmo na směr (jednotky).
 */
export function entryPoint(state: ArcadeState, player: number, dir: number, side: number, halfX: number, halfZ: number): { readonly x: number; readonly z: number } {
  const p = bodyBase(player);
  const hx = state[p + BODY.x] as number;
  const hz = state[p + BODY.z] as number;
  const limitX = halfX - SURVIVOR.inset;
  const limitZ = halfZ - SURVIVOR.inset;
  const edge = (d: number): { readonly x: number; readonly z: number } => {
    const { dx, dz } = DIRECTIONS[d] as { dx: number; dz: number };
    // Paprsek z hrdiny k okraji: nejkratší t (×1000), na kterém opustí obdélník.
    const tx = dx === 0 ? Number.MAX_SAFE_INTEGER : Math.trunc((((dx > 0 ? limitX : -limitX) - hx) * 1000) / dx);
    const tz = dz === 0 ? Number.MAX_SAFE_INTEGER : Math.trunc((((dz > 0 ? limitZ : -limitZ) - hz) * 1000) / dz);
    const t = Math.max(0, Math.min(tx, tz));
    const { dx: sx, dz: sz } = DIRECTIONS[(d + 8) % 32] as { dx: number; dz: number };
    const x = hx + Math.trunc((dx * t) / 1000) + Math.trunc((sx * side) / 1000);
    const zz = hz + Math.trunc((dz * t) / 1000) + Math.trunc((sz * side) / 1000);
    return { x: Math.max(-limitX, Math.min(limitX, x)), z: Math.max(-limitZ, Math.min(limitZ, zz)) };
  };
  const near = edge(dir);
  return length(near.x - hx, near.z - hz) >= SURVIVOR.spawnGap ? near : edge((dir + 16) % 32);
}
