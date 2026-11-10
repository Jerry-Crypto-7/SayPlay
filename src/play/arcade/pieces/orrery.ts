/**
 * Klikací simulace (P83C T2, typ `orrery`): věc k prozkoumání, ne hra se sbíráním. Na scéně stojí 2–9 věcí z věty,
 * pořád se hýbou (oběh, kruh, řada, rozházené) a klepnutí na věc ji „probudí“: ukáže jmenovku a změní její stav podle
 * věty – svítí, zrychlí, nebo vyroste. Druhé a třetí klepnutí na tutéž věc efekt stupňuje (stupeň 1–3), čtvrté nic
 * nepřidá. Výhra = probuzené všechny věci; prohra žádná, rychlost dává jen bonus skóre (`score_bonus`).
 *
 * **Vstup:** klepnutí míří na věc, ne na místo. Dotykový adaptér scény najde věc pod prstem a pošle `TAP` s číslem věci
 * v ose (`axisOfCell`, osa 1 = věc 0), takže záznam, Dare ani serverový replay nový vstup nepotřebují. Klávesnice:
 * šipky vlevo / vpravo posunou kurzor po věcech, mezerník (`TAP` s osou 0) klepne na věc pod kurzorem.
 *
 * **Stav (vše v simulovaném tiku, žádné hodiny):**
 * - věc = tělo role `target`, druh `orrery<i>` (= id role specu, vazba role tak najde popisek z věty); stupeň v HP
 *   (`hp = stupeň + 1`), vlastní fáze (točení, houpání, plování) v `aux0`, poloha a velikost v `x/z/w/h/d`;
 * - počítadlo klepnutí (mrtvá předloha): `x` = klepnutí, `y` = poslední věc + 1, `z` = tik posledního klepnutí;
 * - počítadlo drah (mrtvá předloha): fáze drah 0–2 v `x/y/z`;
 * - hráč: `aux0` = kurzor, `aux1` = věc klepnutá v tomto tiku + 1 (0 = nic).
 *
 * **Pohyb:** úhel je fáze v jednotkách 1/2^20 otáčky, sinus z pevné celočíselné tabulky (`sin1e4`) – `Math.sin` nemusí
 * být v každém prohlížeči bit po bitu stejný. Dráha je tuhá: věci na jedné dráze drží rozestup, takže se nepřekrývají
 * ani na telefonu (věcí víc než tři se rozdělí na tři dráhy, `shellCounts`). „Rychlejší“ zrychlí vlastní točení věci
 * a dráhu, na které věc leží (násobek podle nejvyššího stupně věcí dráhy).
 */

import { z } from 'zod';

import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeLevel,
  BODY,
  BUTTON,
  type BodyInit,
  type ControlPiece,
  HEADER,
  type ModeGeneratorPiece,
  type ModeParts,
  type PieceRef,
  type RulePiece,
  bodyBase,
  bodyHp,
} from '../contract';
import { createCompileRng } from '@/play/compile/rng';
import { cellOfAxis } from './lanes';

export const ORRERY_LAYOUTS = ['orbit', 'ring', 'row', 'scatter'] as const;
export type OrreryLayout = (typeof ORRERY_LAYOUTS)[number];
export const ORRERY_ANSWERS = ['glow', 'faster', 'bigger'] as const;
export type OrreryAnswer = (typeof ORRERY_ANSWERS)[number];

export const ORRERY = {
  things: { min: 2, max: 9, default: 5 },
  /** Nejvyšší stupeň věci; čtvrté klepnutí nic nepřidá. */
  maxLevel: 3,
  /** Body za probuzení věci a za každý další stupeň. */
  points: 100,
  levelPoints: 25,
  /** Bonus za čas (`score_bonus`): 5 bodů za každou sekundu pod touto hranicí. */
  parSeconds: 60,
  /** Nejvíc drah oběhu. */
  shells: 3,
} as const;

/** Rozměry světa (jednotky jádra, 1000 = 1 m). */
export const ORRERY_LAYOUT = {
  /** Věc a střed (slunce, jádro) na začátku. */
  thing: 1200,
  hub: 2000,
  /**
   * Poloměry drah oběhu; rozestup 2,4 m drží věci sousedních drah od sebe i na telefonu 390 × 844 (≥ 44 px mezi
   * středy, i když se při oběhu srovnají za sebou – `e2e/play-orrery.spec.ts`; 2,2 m dalo 39 px).
   */
  shellRadius: [2600, 5000, 7400],
  /** Poloměr kruhu (`ring`). */
  ringRadius: 4800,
  /** Rozestup věcí v řadě a řad za sebou; víc než `rowMost` věcí jde do dvou řad. */
  rowGap: 2600,
  rowMost: 5,
  /** Buňka rozházené mřížky, náhodný posun domova v ní a poloměr plování. */
  scatterCell: 3400,
  scatterJitter: 300,
  drift: 400,
} as const;

/** Fáze: 2^20 dílků na otáčku. */
export const PHASE_FULL = 1 << 20;
const QUARTER_STEPS = 64;
/** sin(i × 90° / 64) × 10 000 pro i = 0..64; napevno, ne z `Math.sin`. */
const QUARTER = [
  0, 245, 491, 736, 980, 1224, 1467, 1710, 1951, 2191, 2430, 2667, 2903, 3137, 3369, 3599, 3827, 4052, 4276, 4496, 4714, 4929, 5141, 5350, 5556, 5758, 5957, 6152, 6344,
  6532, 6716, 6895, 7071, 7242, 7410, 7572, 7730, 7883, 8032, 8176, 8315, 8449, 8577, 8701, 8819, 8932, 9040, 9142, 9239, 9330, 9415, 9495, 9569, 9638, 9700, 9757, 9808,
  9853, 9892, 9925, 9952, 9973, 9988, 9997, 10000,
] as const;
/** Krok tabulky (256 na otáčku) a zbytek fáze pod ním. */
const STEP_SHIFT = 12;
const STEP_MASK = (1 << STEP_SHIFT) - 1;
const tableAt = (i: number): number => {
  const k = i & 255;
  const quarter = k >> 6;
  const r = k & 63;
  // `0 - x`, ne `-x`: záporná nula by se v testech i JSON lišila od nuly.
  return quarter === 0 ? QUARTER[r]! : quarter === 1 ? QUARTER[QUARTER_STEPS - r]! : quarter === 2 ? 0 - QUARTER[r]! : 0 - QUARTER[QUARTER_STEPS - r]!;
};
/** sin(fáze) × 10 000, lineárně mezi kroky tabulky; jen celá čísla. */
export function sin1e4(phase: number): number {
  const p = ((phase % PHASE_FULL) + PHASE_FULL) % PHASE_FULL;
  const i = p >> STEP_SHIFT;
  const a = tableAt(i);
  const b = tableAt(i + 1);
  return a + Math.trunc(((b - a) * (p & STEP_MASK)) / (1 << STEP_SHIFT));
}
export const cos1e4 = (phase: number): number => sin1e4(phase + PHASE_FULL / 4);
/** `radius` × sin / cos fáze v jednotkách světa. */
const along = (radius: number, value1e4: number): number => Math.trunc((radius * value1e4) / 10000);

/** Rychlost fáze za tik pro dobu otáčky `seconds`. */
const perTick = (seconds: number): number => Math.round(PHASE_FULL / (seconds * ARCADE_HZ));
/** Doby otáčky drah oběhu (vnitřní nejrychlejší), kruhu a vlastního točení věci (s). */
const SHELL_SECONDS = [9, 14, 21] as const;
const RING_SECONDS = 24;
const SPIN_SECONDS = 4;

const body = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);
const phase = z.int().min(0).max(PHASE_FULL - 1);
const speed = z.int().min(1).max(PHASE_FULL);
const coord = z.int().min(-20000).max(20000);

const thingSchema = z
  .object({
    /** Dráha 0–2, −1 = stojí ve středu nebo na svém domově (řada, rozházené). */
    shell: z.int().min(-1).max(ORRERY.shells - 1),
    /** Místo na dráze (fáze navíc k fázi dráhy). */
    slot: phase,
    /** Domov v řadě a v rozházené mřížce. */
    hx: coord,
    hz: coord,
    /** Velikost na začátku (stupeň 0). */
    size: z.int().min(100).max(5000),
    /** Vlastní točení (fáze za tik, stupeň 0). */
    spin: speed,
  })
  .strict();

const gameShape = {
  first: body,
  count: z.int().min(ORRERY.things.min).max(ORRERY.things.max),
  board: body,
  orbits: body,
  layout: z.enum(ORRERY_LAYOUTS),
  answer: z.enum(ORRERY_ANSWERS),
  hub: z.boolean(),
  /** Rychlosti drah (fáze za tik, stupeň 0). */
  shells: z.array(speed).max(ORRERY.shells),
  things: z.array(thingSchema).min(ORRERY.things.min).max(ORRERY.things.max),
};
export const orreryGameSchema = z.object(gameShape).strict();
export type OrreryGame = z.infer<typeof orreryGameSchema>;

/** Stupeň věci `index` (0 = ještě nebyla klepnutá, 1–3 = probuzená). */
export const levelOf = (state: Int32Array, game: Pick<OrreryGame, 'first'>, index: number): number => bodyHp(state, game.first + index) - 1;
/** Kolik věcí je probuzených. */
export function wokenCount(state: Int32Array, game: Pick<OrreryGame, 'first' | 'count'>): number {
  let woken = 0;
  for (let index = 0; index < game.count; index += 1) if (levelOf(state, game, index) > 0) woken += 1;
  return woken;
}
/** Věc klepnutá v tomto tiku (0..count−1), jinak `null`. */
export const tappedThing = (state: Int32Array, player: number): number | null => {
  const tapped = state[bodyBase(player) + BODY.aux1] as number;
  return tapped > 0 ? tapped - 1 : null;
};
/** Kurzor klávesnice. */
export const cursorOf = (state: Int32Array, player: number): number => state[bodyBase(player) + BODY.aux0] as number;

/** Násobek rychlosti dráhy `shell`: 1 + nejvyšší stupeň jejích věcí, když věta zrychluje; jinak 1. */
function shellBoost(state: Int32Array, game: OrreryGame, shell: number): number {
  if (game.answer !== 'faster') return 1;
  let most = 0;
  game.things.forEach((thing, index) => {
    if (thing.shell === shell) most = Math.max(most, levelOf(state, game, index));
  });
  return 1 + most;
}

/** Rozestaví věci podle fází (stav po posunu fází v tomto tiku). */
export function layoutThings(state: Int32Array, game: OrreryGame): void {
  const orbits = bodyBase(game.orbits);
  game.things.forEach((thing, index) => {
    const base = bodyBase(game.first + index);
    const level = levelOf(state, game, index);
    const own = state[base + BODY.aux0] as number;
    let x = thing.hx;
    let z = thing.hz;
    if (thing.shell >= 0) {
      const radius = game.layout === 'ring' ? ORRERY_LAYOUT.ringRadius : (ORRERY_LAYOUT.shellRadius[thing.shell] as number);
      const angle = (state[orbits + thing.shell] as number) + thing.slot;
      x = along(radius, cos1e4(angle));
      z = along(radius, sin1e4(angle));
    } else if (game.layout === 'scatter') {
      // Rozházené věci plují po malém kruhu kolem domova; `slot` = kde na něm začínají.
      x = thing.hx + along(ORRERY_LAYOUT.drift, cos1e4(own + thing.slot));
      z = thing.hz + along(ORRERY_LAYOUT.drift, sin1e4(own + thing.slot));
    }
    state[base + BODY.x] = x;
    state[base + BODY.z] = z;
    const size = game.answer === 'bigger' ? Math.trunc((thing.size * (5 + level)) / 5) : thing.size;
    state[base + BODY.w] = size;
    state[base + BODY.h] = size;
    state[base + BODY.d] = size;
  });
}

// ---------------------------------------------------------------------------
// Ovládání

/**
 * Ovládání: kurzor (šipky), klepnutí na věc (osa = věc + 1; osa 0 = věc pod kurzorem), počítadlo klepnutí, posun fází
 * drah a vlastního točení věcí a jejich rozestavení.
 */
export const orreryControl: ControlPiece<OrreryGame> = {
  id: 'orrery',
  params: orreryGameSchema,
  roles: ['player', 'target'],
  cost: () => ({ bodies: 0, rules: 0 }),
  step: (state, player, input, game) => {
    const hero = bodyBase(player);
    let cursor = cursorOf(state, player);
    if ((input.buttons & BUTTON.LEFT) !== 0) cursor = (cursor + game.count - 1) % game.count;
    if ((input.buttons & BUTTON.RIGHT) !== 0) cursor = (cursor + 1) % game.count;
    let tapped = -1;
    if ((input.buttons & BUTTON.TAP) !== 0) {
      const target = input.axis > 0 ? cellOfAxis(input.axis) : cursor;
      if (target >= 0 && target < game.count) {
        tapped = target;
        cursor = target;
      }
    }
    state[hero + BODY.aux0] = cursor;
    state[hero + BODY.aux1] = tapped + 1;
    if (tapped >= 0) {
      const board = bodyBase(game.board);
      state[board + BODY.x] = (state[board + BODY.x] as number) + 1;
      state[board + BODY.y] = tapped + 1;
      state[board + BODY.z] = state[HEADER.tick] as number;
    }
    const orbits = bodyBase(game.orbits);
    game.shells.forEach((rate, shell) => {
      state[orbits + shell] = ((state[orbits + shell] as number) + rate * shellBoost(state, game, shell)) % PHASE_FULL;
    });
    game.things.forEach((thing, index) => {
      const base = bodyBase(game.first + index);
      const boost = game.answer === 'faster' ? 1 + levelOf(state, game, index) : 1;
      state[base + BODY.aux0] = ((state[base + BODY.aux0] as number) + thing.spin * boost) % PHASE_FULL;
    });
    layoutThings(state, game);
  },
};

// ---------------------------------------------------------------------------
// Pravidlo

const tapParams = z
  .object({
    ...gameShape,
    points: z.int().min(1).max(1000),
    levelPoints: z.int().min(0).max(1000),
  })
  .strict();
export type OrreryTapParams = z.infer<typeof tapParams>;

/**
 * Klepnutí (tik): věc klepnutá v tomto tiku pod stupněm 3 dostane stupeň navíc (`heal` na HP stupně + 1, jen nahoru),
 * první stupeň body za probuzení a čítač `items`, další stupně body navíc. Probuzení poslední spící věci = výhra.
 */
export const orreryTapRule: RulePiece<OrreryTapParams> = {
  id: 'orrery_tap',
  params: tapParams,
  roles: ['player', 'target'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const index = tappedThing(state, player);
    if (index === null) return [];
    const level = levelOf(state, params, index);
    if (level >= ORRERY.maxLevel) return [];
    const thing = params.first + index;
    const effects: ArcadeEffect[] = [{ kind: 'heal', body: thing, hp: level + 2 }];
    if (level > 0) return [...effects, { kind: 'score', amount: params.levelPoints }];
    effects.push({ kind: 'score', amount: params.points }, { kind: 'count', counter: 'items', amount: 1 });
    if (wokenCount(state, params) + 1 === params.count) effects.push({ kind: 'win' });
    return effects;
  },
};

export const ORRERY_RULES: Readonly<Record<string, RulePiece>> = { orrery_tap: orreryTapRule as RulePiece };

// ---------------------------------------------------------------------------
// Generátor

export const orreryParams = z
  .object({
    things: z.int().min(ORRERY.things.min).max(ORRERY.things.max).default(ORRERY.things.default),
    layout: z.enum(ORRERY_LAYOUTS).default('orbit'),
    answer: z.enum(ORRERY_ANSWERS).default('glow'),
    /** První věc stojí ve středu (slunce, jádro, lampa); jen u `orbit` a `ring`. */
    hub: z.boolean().default(false),
  })
  .strict();
export type OrreryParams = z.infer<typeof orreryParams>;

/** Tempo robota (tiky mezi klepnutími): divák stihne přečíst jmenovku. */
export const ORRERY_BOT_PACE = 60;

/** Kolik věcí na kterou dráhu: do tří po jedné, víc rovnoměrně na tři dráhy (vnější dostanou zbytek). */
export function shellCounts(orbiters: number): number[] {
  if (orbiters <= ORRERY.shells) return new Array<number>(orbiters).fill(1);
  const base = Math.floor(orbiters / ORRERY.shells);
  const extra = orbiters % ORRERY.shells;
  return Array.from({ length: ORRERY.shells }, (_, shell) => base + (shell >= ORRERY.shells - extra ? 1 : 0));
}

/** Věci hry: dráha, místo na ní, domov a vlastní točení podle uspořádání; náhoda jen při stavbě. */
export function orreryThings(seed: number, params: OrreryParams): { readonly things: OrreryGame['things']; readonly shells: number[] } {
  const rng = createCompileRng(seed, 'layout');
  const { thing: size } = ORRERY_LAYOUT;
  const count = params.things;
  const spinOf = (): number => Math.round((perTick(SPIN_SECONDS) * rng.int(80, 120)) / 100);
  const hub = params.hub && (params.layout === 'orbit' || params.layout === 'ring');
  const things: OrreryGame['things'][number][] = [];
  if (hub) things.push({ shell: -1, slot: 0, hx: 0, hz: 0, size: ORRERY_LAYOUT.hub, spin: spinOf() });
  const left = count - things.length;
  let shells: number[] = [];
  if (params.layout === 'orbit' || params.layout === 'ring') {
    const counts = params.layout === 'ring' ? [left] : shellCounts(left);
    shells = counts.map((_, shell) => perTick(params.layout === 'ring' ? RING_SECONDS : (SHELL_SECONDS[shell] as number)));
    counts.forEach((on, shell) => {
      const offset = rng.int(0, PHASE_FULL - 1);
      for (let k = 0; k < on; k += 1) things.push({ shell, slot: (offset + Math.floor((k * PHASE_FULL) / on)) % PHASE_FULL, hx: 0, hz: 0, size, spin: spinOf() });
    });
  } else if (params.layout === 'row') {
    const rows = count > ORRERY_LAYOUT.rowMost ? 2 : 1;
    const front = Math.ceil(count / rows);
    for (let index = 0; index < count; index += 1) {
      const row = index < front ? 0 : 1;
      const inRow = row === 0 ? front : count - front;
      const k = row === 0 ? index : index - front;
      const hz = rows === 1 ? 0 : (row === 0 ? -1 : 1) * (ORRERY_LAYOUT.rowGap / 2);
      things.push({ shell: -1, slot: 0, hx: ((2 * k - (inRow - 1)) * ORRERY_LAYOUT.rowGap) / 2, hz, size, spin: spinOf() });
    }
  } else {
    const cols = count <= 4 ? 2 : 3;
    const rows = Math.ceil(count / cols);
    const cells = rng.shuffle(Array.from({ length: cols * rows }, (_, cell) => cell)).slice(0, count);
    const { scatterCell: cell, scatterJitter: jitter } = ORRERY_LAYOUT;
    for (const at of cells) {
      const col = at % cols;
      const row = Math.floor(at / cols);
      const hx = ((2 * col - (cols - 1)) * cell) / 2 + rng.int(-jitter, jitter);
      const hz = ((2 * row - (rows - 1)) * cell) / 2 + rng.int(-jitter, jitter);
      things.push({ shell: -1, slot: rng.int(0, PHASE_FULL - 1), hx: Math.trunc(hx), hz: Math.trunc(hz), size, spin: spinOf() });
    }
  }
  return { things, shells };
}

/** Kam až věci sahají od středu (m jádra): scéna podle toho rámuje záběr. */
export function orreryExtent(game: Pick<OrreryGame, 'layout' | 'things' | 'answer'>): number {
  const grow = game.answer === 'bigger' ? (5 + ORRERY.maxLevel) / 5 : 1;
  let most = 0;
  for (const thing of game.things) {
    const half = (thing.size * grow) / 2;
    const reach = thing.shell >= 0 ? (game.layout === 'ring' ? ORRERY_LAYOUT.ringRadius : (ORRERY_LAYOUT.shellRadius[thing.shell] as number)) : Math.hypot(thing.hx, thing.hz) + (game.layout === 'scatter' ? ORRERY_LAYOUT.drift : 0);
    most = Math.max(most, reach + half);
  }
  return Math.ceil(most);
}

/** Tvrzení o hotové úrovni: věcí je tolik, kolik hra čeká, a vejdou se do mezí jádra. */
export function checkOrreryLevel(level: ArcadeLevel, game: OrreryGame): string[] {
  const issues: string[] = [];
  if (game.things.length !== game.count) issues.push(`orrery: ${game.things.length} things for a count of ${game.count}`);
  for (let index = 0; index < game.count; index += 1) {
    const init = level.bodies[game.first + index];
    if (init?.role !== 'target' || init.kind !== orreryKind(index)) issues.push(`orrery: body ${game.first + index} is not thing ${index}`);
  }
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}

/** Druh těla věci `index` = id její role ve specu (`orrery0`–`orrery8`). */
export const orreryKind = (index: number): string => `orrery${index}`;

/**
 * Díly světa: hrdina (stojí stranou, scéna ho nekreslí), věci, počítadlo klepnutí a drah, pravidlo `orrery_tap`,
 * pilulka postupu HUD (`finish_collected` – tělo cíle svět nemá, takže nevystřelí) a bonus za čas (`score_bonus`).
 */
export function orreryParts(seed: number, params: OrreryParams): ModeParts {
  const { things, shells } = orreryThings(seed, params);
  const extent = orreryExtent({ layout: params.layout, things, answer: params.answer });
  const hero: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: extent + 2000, w: 800, h: 1600, d: 800, solid: false };
  const bodies: BodyInit[] = [hero];
  const first = bodies.length;
  const draft = { first, layout: params.layout, answer: params.answer, things, shells } as const;
  things.forEach((thing, index) => bodies.push({ role: 'target', kind: orreryKind(index), x: thing.hx, y: 0, z: thing.hz, w: thing.size, h: thing.size, d: thing.size, solid: false, hp: 1 }));
  const board = bodies.length;
  bodies.push({ role: 'thing', kind: 'player', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true });
  const orbits = bodies.length;
  bodies.push({ role: 'thing', kind: 'player', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true });
  const game: OrreryGame = { ...draft, count: things.length, board, orbits, hub: params.hub && things[0]?.shell === -1 && (params.layout === 'orbit' || params.layout === 'ring') };
  // Výchozí polohy = rozestavení v tiku 0, ať první snímek ukáže věci na drahách, ne ve středu.
  const level: ArcadeLevel = { bodies: bodies.map((init, index) => (index >= first && index < first + things.length ? placed(init, game, index - first) : init)), length: 0 };
  const rules: PieceRef[] = [
    { id: 'orrery_tap', params: { ...game, points: ORRERY.points, levelPoints: ORRERY.levelPoints } },
    // T7: pilulka i konec hry říkají „explored“, ne „collected“ – tady se nic nesbírá.
    { id: 'finish_collected', params: { need: game.count, noun: 'explored' } },
    { id: 'score_bonus', params: { lives: 0, limit: ORRERY.parSeconds * ARCADE_HZ, target: 0 } },
  ];
  const bot: PieceRef = { id: 'orrery_bot', params: { ...game, pace: ORRERY_BOT_PACE } };
  return { control: { id: 'orrery', params: game }, bot, level, rules, issues: checkOrreryLevel(level, game) };
}

/** Výchozí poloha věci `index` (fáze 0, stupeň 0) – tatáž úvaha jako `layoutThings`. */
function placed(init: BodyInit, game: OrreryGame, index: number): BodyInit {
  const thing = game.things[index] as OrreryGame['things'][number];
  if (thing.shell >= 0) {
    const radius = game.layout === 'ring' ? ORRERY_LAYOUT.ringRadius : (ORRERY_LAYOUT.shellRadius[thing.shell] as number);
    return { ...init, x: along(radius, cos1e4(thing.slot)), z: along(radius, sin1e4(thing.slot)) };
  }
  if (game.layout === 'scatter') return { ...init, x: thing.hx + along(ORRERY_LAYOUT.drift, cos1e4(thing.slot)), z: thing.hz + along(ORRERY_LAYOUT.drift, sin1e4(thing.slot)) };
  return init;
}

export const orreryScene: ModeGeneratorPiece<OrreryParams> = {
  id: 'orrery_scene',
  params: orreryParams,
  roles: ['player', 'target'],
  cost: (params) => ({ bodies: 3 + params.things, rules: 3 }),
  generate: (seed, params) => orreryParts(seed, params).level,
  parts: (seed, params) => orreryParts(seed, params),
};
