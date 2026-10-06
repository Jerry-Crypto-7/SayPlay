/**
 * Vlny arény (P36A T4): sběr, útěk i souboj přicházejí po vlnách a každá další
 * je těžší – víc pronásledovatelů nebo soupeřů, rychlejších, s víc HP.
 *
 * **Stav vlny je ve snímku:** pořadí běžící vlny nese čítač `WAVE_COUNTER`
 * (0 = první vlna), přestávku souboje `PAUSE_COUNTER`. Pravidlo `arena_waves`
 * je jediné, kdo je zvedá; ovládání a roboti z nich jen čtou (rychlost
 * pronásledovatelů a soupeřů roste s vlnou).
 *
 * **Náhoda jen při stavbě:** místa věcí každé vlny a místa, odkud vbíhají noví
 * pronásledovatelé a soupeři, losuje generátor ze streamu `spawn` (`pure-rand`)
 * a nese je v parametrech pravidla. Za běhu se jen vybere místo nejdál od
 * hráče – celočíselně, bez náhody.
 *
 * Svět bez pravidla `arena_waves` (každá dřív uložená hra) čítače nikdy nezvedne,
 * takže ovládání i roboti v něm jedou jako dřív.
 */

import { z } from 'zod';

import type { CompileRng } from '@/play/compile/rng';

import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeCounter, type ArcadeEffect, BODY, COUNTER, FLAG, HEADER, HP_MAX, ROLE, type RulePiece, TARGET_STATE_MAX, UNIT, bodyBase, bodyHp, targetStateOf } from '../contract';

/**
 * Čítač vlny: náboje (`ammo`) aréna, útěk ani souboj nikdy nenesou – patří
 * střelbě doplňku `+shoot`, který žánr Aréna nedává, pravidla ze specu ho
 * jmenovat nesmí (`RULE_COUNTERS`) a HUD ho ukazuje jen u střelby a hodu.
 * Živá změna „víc nábojů“ ho ve světě s vlnami nepřičte (`live.ts`).
 */
export const WAVE_COUNTER = 'ammo' satisfies ArcadeCounter;

/**
 * Přestávka mezi vlnami souboje (tiky do další): `reserve` souboj nečte (ochrana
 * útěku v témže slotu patří jen útěku, ten na přestávku nečeká).
 */
export const PAUSE_COUNTER = 'reserve' satisfies ArcadeCounter;

/** Pořadí běžící vlny (0 = první). */
export const waveOf = (state: Int32Array): number => state[HEADER.counters + COUNTER[WAVE_COUNTER]] as number;

/**
 * Nejvíc vln arény a nejvíc věcí v jedné vlně (= strop počtu věcí útěku a
 * sběru). Kol úkolu může být víc (`rounds`): kolo jedné palačinky trvá 2 s.
 */
export const WAVE_LIMITS = { waves: 12, rounds: 24, items: 30, spots: 16 } as const;

/**
 * Délka útěku a sběru ve vlnách. Robot sebere vlnu N věcí bez pronásledovatelů
 * asi za `calm + calmPerItem × N` s, s nimi za `chased + chasedPerItem × N +
 * perChaser × (pronásledovatelé − 1)` s; nad `denseFrom` věcí leží blíž u sebe
 * a každá další se počítá napůl (sonda P36A T4, 8 semínek: bez pronásledovatelů
 * 3 věci ~5,6 s, 10 ~13 s, 30 ~24 s; s jedním 3 ~10 s, 10 ~20 s, 20 ~25 s; se
 * dvěma 3 ~11–12 s, 10 ~18–21 s, 20 ~33 s). Vln je nejmíň tolik, aby odhad
 * celé hry dosáhl `target + targetPerItem × N` s, pokud další vlna nepřetáhne
 * `ceiling` – víc věcí ve větě tak dá delší hru.
 */
export const WAVE_PLAN = {
  calm: 2,
  calmPerItem: 1.1,
  chased: 6,
  chasedPerItem: 1.2,
  perChaser: 1.5,
  denseFrom: 12,
  target: 34,
  targetPerItem: 1,
  ceiling: 72,
  min: 2,
  /** Sběr: první pronásledovatel vběhne s druhou vlnou, touhle rychlostí (útěk má svou z věty). */
  collectSpeed: 55,
  /** Útěk: každá druhá vlna přivede pronásledovatele navíc, nejvýš do `escapeChasers` (víc jich přivede jen věta). */
  escapeChasers: 3,
  /** Sběr: pronásledovatel přiběhne s druhou a čtvrtou vlnou, nejvýš `collectChasers`. */
  collectChasers: 2,
  /** O kolik je poslední vlna rychlejší než první (rozloženo po vlnách, aspoň 1 za vlnu). */
  speedRise: 12,
  /** Věci dalších vln leží aspoň tak daleko od stěny: v rohu u pronásledovatele by je hráč nesebral. */
  itemInset: 3 * UNIT,
  /**
   * …a aspoň tak daleko od středu: hráč, který před pronásledovatelem krouží
   * arénou, má pronásledovatele vždy uvnitř kruhu, takže věc uprostřed nesebere
   * nikdy (sonda P36A T4: 4 ze 40 semínek sběru 5 věcí robot kroužil do konce hodin).
   */
  itemHole: 7 * UNIT,
  /** Hodiny sběru: odhad × `clockFactor` + `clockMargin`, nejvýš `clockMax` (pod horizontem ověření 90 s). */
  clockFactor: 1.5,
  clockMargin: 15,
  clockMax: 88,
  /** Přežití: tolik vln (na třetinách času) a délka `survivalBase + survivalPerChaser × pronásledovatelé`, aspoň `survivalMin`. */
  survivalWaves: 3,
  survivalBase: 20,
  survivalPerChaser: 10,
  survivalMin: 35,
} as const;

/**
 * Pronásledovatelů ve vlně `wave` (0 = první): útěk začíná s počtem z věty a
 * každá druhá vlna přidá jednoho do `escapeChasers`; sběr začíná bez nich a
 * přidá jednoho s druhou a čtvrtou vlnou.
 */
export const wavesChasers = (start: number, wave: number): number =>
  start === 0 ? Math.min(WAVE_PLAN.collectChasers, Math.ceil(wave / 2)) : Math.min(Math.max(start, WAVE_PLAN.escapeChasers), start + Math.floor(wave / 2));

/** Odhad robota na vlnu `items` věcí s `chasers` pronásledovateli (s). */
function waveSeconds(items: number, chasers: number): number {
  const counted = Math.min(items, WAVE_PLAN.denseFrom) + Math.max(0, items - WAVE_PLAN.denseFrom) / 2;
  return chasers === 0 ? WAVE_PLAN.calm + WAVE_PLAN.calmPerItem * counted : WAVE_PLAN.chased + WAVE_PLAN.chasedPerItem * counted + WAVE_PLAN.perChaser * (chasers - 1);
}

/** Odhad robota na prvních `waves` vln po `items` věcech, útěk začíná s `start` pronásledovateli (sběr 0). */
export function itemWaveSeconds(items: number, start: number, waves: number): number {
  let seconds = 0;
  for (let wave = 0; wave < waves; wave += 1) seconds += waveSeconds(items, wavesChasers(start, wave));
  return seconds;
}

/** Kolik vln po `items` věcech: nejmíň na cíl délky, nejvýš po strop; `items × vlny` unese `grow_to` (≤ 100). */
export function itemWaveCount(items: number, start: number): number {
  const most = Math.max(WAVE_PLAN.min, Math.min(WAVE_LIMITS.waves, Math.floor(100 / items)));
  const target = WAVE_PLAN.target + WAVE_PLAN.targetPerItem * items;
  let count = WAVE_PLAN.min;
  while (count < most && itemWaveSeconds(items, start, count) < target && itemWaveSeconds(items, start, count + 1) <= WAVE_PLAN.ceiling) count += 1;
  return count;
}

/** Hodiny sběru ve vlnách (s): robot je stihne s rezervou, nečinný hráč na nich prohraje. */
export const collectClock = (items: number, waves: number): number =>
  Math.min(WAVE_PLAN.clockMax, Math.round(itemWaveSeconds(items, 0, waves) * WAVE_PLAN.clockFactor + WAVE_PLAN.clockMargin));

/** O kolik zrychlí každá další vlna, aby poslední byla o `speedRise` rychlejší. */
export const waveSpeedStep = (waves: number): number => Math.max(1, Math.round(WAVE_PLAN.speedRise / (waves - 1)));

/** Délka přežití podle počtu pronásledovatelů z věty (2 = dřívějších 40 s). */
export const survivalSeconds = (chasers: number): number => Math.max(WAVE_PLAN.survivalMin, WAVE_PLAN.survivalBase + WAVE_PLAN.survivalPerChaser * chasers);

/**
 * Místa vstupu: čtyři rohy a středy čtyř stran čtverce o polovině `edge`,
 * středy posunuté podél strany o los ±1 m. Za běhu se bere to nejdál od hráče.
 */
export function entrySpots(rng: CompileRng, edge: number): number[] {
  const spots: number[] = [];
  for (const [sx, sz] of [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]] as const) {
    const along = rng.int(-UNIT, UNIT);
    spots.push(sx === 0 ? along : sx * edge, sz === 0 ? along : sz * edge);
  }
  return spots;
}

/**
 * Místa věcí jedné vlny (x, z po dvojicích) uvnitř `±edge`, aspoň `gap` od
 * sebe a aspoň `WAVE_PLAN.itemHole` od středu; strop pokusů jen pojistka.
 */
export function wavePositions(rng: CompileRng, count: number, edge: number, gap: number): number[] {
  const placed: number[] = [];
  for (let k = 0; k < count; k += 1) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const x = rng.int(-edge, edge);
      const z = rng.int(-edge, edge);
      if (x * x + z * z < WAVE_PLAN.itemHole * WAVE_PLAN.itemHole) continue;
      let free = true;
      for (let i = 0; i < placed.length && free; i += 2) free = (x - placed[i]!) ** 2 + (z - placed[i + 1]!) ** 2 >= gap * gap;
      if (!free) continue;
      placed.push(x, z);
      break;
    }
  }
  return placed;
}

const body = z.int().min(0).max(ARCADE_LIMITS.maxBodies - 1);

const waveParams = z
  .object({
    /** Physical entry distance; the first reinforcement starts two metres farther away. */
    entryDistance: z.int().min(6000).max(20000).optional(),
    /**
     * Kdy přijde další vlna: `items` = hráč sebral všechny věci vlny, `ticks` =
     * nastal tik vlny (`at`), `enemies` = všichni soupeři leží a doběhla přestávka,
     * `targets` = všechny cíle úkolu jsou v konečném stavu `done` (kolo úkolu).
     */
    until: z.enum(['items', 'ticks', 'enemies', 'targets']),
    /** Kolo úkolu: konečný stav cíle (`states − 1`). */
    done: z.int().min(1).max(TARGET_STATE_MAX).optional(),
    /**
     * Předlohy kopií (index těla úrovně): věc, pronásledovatel, soupeř. V kole
     * úkolu je `item` předloha cíle: hotové cíle zmizí a nové přijdou na místa
     * vlny; bez ní se tytéž cíle vrátí do stavu 0 (stanoviště).
     */
    item: body.optional(),
    chaser: body.optional(),
    enemy: body.optional(),
    /** Místa vstupu nových pronásledovatelů a soupeřů: x, z po dvojicích. */
    spots: z.array(z.int()).max(2 * WAVE_LIMITS.spots),
    /** Přestávka souboje mezi poslední ranou vlny a další vlnou (tiky). */
    pause: z.int().min(1).max(5 * ARCADE_HZ).optional(),
    /** Vlny od druhé: věci (x, z po dvojicích), noví pronásledovatelé, noví soupeři, HP soupeřů, tik začátku. */
    waves: z
      .array(
        z
          .object({
            items: z.array(z.int()).max(2 * WAVE_LIMITS.items).optional(),
            chasers: z.int().min(0).max(4).optional(),
            enemies: z.int().min(0).max(3).optional(),
            hp: z.int().min(1).max(HP_MAX).optional(),
            at: z.int().min(1).max(ARCADE_LIMITS.maxTicks).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(WAVE_LIMITS.rounds - 1),
  })
  .strict();
export type WaveParams = z.infer<typeof waveParams>;

const aliveWith = (state: Int32Array, role: number): number[] => {
  const found: number[] = [];
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const base = bodyBase(i);
    if (state[base + BODY.role] === role && ((state[base + BODY.flags] as number) & FLAG.alive) !== 0) found.push(i);
  }
  return found;
};

/**
 * Místa vstupu od nejvzdálenějšího od hráče (shoda: nižší index). Celá čísla:
 * druhá mocnina vzdálenosti v aréně 40 × 40 m je pod 2^53, takže přesná.
 */
export function spotsAway(state: Int32Array, player: number, spots: readonly number[]): number[] {
  const p = bodyBase(player);
  const px = state[p + BODY.x] as number;
  const pz = state[p + BODY.z] as number;
  const order = Array.from({ length: Math.floor(spots.length / 2) }, (_, k) => k);
  const far = (k: number): number => (spots[2 * k]! - px) ** 2 + (spots[2 * k + 1]! - pz) ** 2;
  return order.sort((a, b) => far(b) - far(a) || a - b);
}

/** Kopie předlohy `template` na místech vstupu nejdál od hráče (víc kopií = další místa v pořadí). */
function enter(state: Int32Array, player: number, spots: readonly number[], template: number, count: number, entryDistance?: number): ArcadeEffect[] {
  const order = spotsAway(state, player, spots);
  return Array.from({ length: count }, (_, k): ArcadeEffect => {
    const at = order[k % order.length]!;
    let x = spots[2 * at]!, z = spots[2 * at + 1]!;
    if (entryDistance !== undefined) {
      const p = bodyBase(player), px = state[p + BODY.x]!, pz = state[p + BODY.z]!;
      const dx = x - px, dz = z - pz;
      const distance = Math.max(Math.abs(dx), Math.abs(dz));
      // Stay on the segment to the seeded entry point, inside the convex arena.
      if (distance > entryDistance) {
        x = px + Math.trunc(dx * entryDistance / distance);
        z = pz + Math.trunc(dz * entryDistance / distance);
      }
    }
    return { kind: 'spawn', template, x, y: 0, z, vx: 0, vy: 0, vz: 0 };
  });
}

/**
 * Další vlna (spouštěč `counter`, po kontaktech i zásazích tiku): sebrané
 * všechny věci, nastal její tik, nebo všichni soupeři leží a doběhla přestávka.
 * Vydá kopie věcí na losovaných místech, nové pronásledovatele a soupeře na
 * místech nejdál od hráče, ležícím soupeřům vrátí HP vlny (vstanou) a zvedne
 * čítač vlny. Po poslední vlně nedělá nic – výhru hlásí pravidlo cíle.
 */
export const arenaWaves: RulePiece<WaveParams> = {
  id: 'arena_waves',
  params: waveParams,
  roles: ['player', 'collectible', 'chaser', 'enemy', 'target'],
  trigger: 'counter',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params): readonly ArcadeEffect[] => {
    const next = params.waves[waveOf(state)];
    if (next === undefined) return [];
    const effects: ArcadeEffect[] = [];
    if (params.until === 'items' && aliveWith(state, ROLE.collectible).length > 0) return [];
    if (params.until === 'targets') {
      const targets = aliveWith(state, ROLE.target);
      if (targets.some((i) => targetStateOf(state, i) < (params.done ?? 1))) return [];
      // Hotové cíle: s předlohou zmizí (nové přijdou níž), bez ní začnou znovu od stavu 0.
      for (const i of targets) effects.push(params.item === undefined ? { kind: 'stateChange', body: i, state: 0 } : { kind: 'despawn', body: i });
    }
    if (params.until === 'ticks' && (state[HEADER.tick] as number) + 1 < (next.at ?? 0)) return [];
    if (params.until === 'enemies') {
      const enemies = aliveWith(state, ROLE.enemy);
      if (enemies.length === 0 || enemies.some((i) => bodyHp(state, i) > 0)) return [];
      // Přestávka: poslední rána vlny dopadne, soupeř padne a hráč si oddechne.
      const left = state[HEADER.counters + COUNTER[PAUSE_COUNTER]] as number;
      if (left === 0) return [{ kind: 'count', counter: PAUSE_COUNTER, amount: params.pause ?? 1 }];
      effects.push({ kind: 'count', counter: PAUSE_COUNTER, amount: -1 });
      if (left > 1) return effects;
      // Ležící soupeři vstanou s HP vlny (léčení jde jen nahoru); noví se kopírují už z uzdraveného.
      for (const i of enemies) effects.push({ kind: 'heal', body: i, hp: next.hp ?? 1 });
      if (params.enemy !== undefined) effects.push(...enter(state, player, params.spots, params.enemy, next.enemies ?? 0));
    }
    const items = next.items ?? [];
    if (params.item !== undefined) {
      for (let k = 0; k + 1 < items.length; k += 2) effects.push({ kind: 'spawn', template: params.item, x: items[k]!, y: 0, z: items[k + 1]!, vx: 0, vy: 0, vz: 0 });
    }
    if (params.chaser !== undefined) effects.push(...enter(state, player, params.spots, params.chaser, next.chasers ?? 0, params.entryDistance === undefined ? undefined : params.entryDistance + Math.max(0, 1 - waveOf(state)) * 2000));
    effects.push({ kind: 'count', counter: WAVE_COUNTER, amount: 1 });
    return effects;
  },
};
