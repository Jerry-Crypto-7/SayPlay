/**
 * Načasování (P25H, T1): ovládání, generátor a pravidlo `judge`.
 *
 * Jezdec (kyvadlo jádra: kinematické tělo s periodou) jezdí tam a zpět po x
 * mezi ±A a ťuk ho zastaví. Přesnost = odchylka od středu cíle; v toleranci
 * je trefa (body podle přesnosti, další kolo), mimo ni nebo po dvou
 * celých kyvech bez ťuku minutí (kolo se opakuje, prohra nebo život).
 * Režimy se liší jen tím, co scéna kreslí a co zbude po trefě:
 *
 * - `stack` – blok na věž; přečnívající část se usekne, další blok je užší;
 * - `precision` – ručička na liště („stop the bar“), značka tam, kde stála;
 * - `bridge` – lávka roste k protějšímu sloupu a zpět, ťuk ji zastaví.
 *
 * **Hratelné z konstrukce:** kyv začíná na kraji a perioda je sudá, takže
 * jezdec projde přesně středem cíle, a tolerance je širší než dráha za tik
 * (každý průjezd má v okně aspoň jeden tik). `checkTimingLevel` to samé
 * přepočítá nad hotovou úrovní.
 *
 * Rozložení těl je pevné (`TIMING_SLOTS`): hráč (podstavec), jezdec, cíl a
 * pak předlohy značek po jedné na kolo – předloha nese start kola (kraj a
 * směr ze semínka) a po trefě ji ovládání oživí jako položený blok.
 * Uběhlá kola jsou `z` hráče v metrech, takže HUD i pravidlo `judge` čtou
 * postup stejně jako u tratí.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import { ARCADE_LIMITS, type ArcadeLevel, BODY, BUTTON, type BodyInit, type ControlPiece, FLAG, type GeneratorPiece, type PieceRef, type RulePiece, UNIT, bodyBase } from '../contract';
import { PLATFORM_FEEL } from './platform';

export const TIMING_MODES = ['stack', 'precision', 'bridge'] as const;
export type TimingMode = (typeof TIMING_MODES)[number];
export const TIMING_SPEEDS = ['slow', 'normal', 'fast'] as const;
export type TimingSpeed = (typeof TIMING_SPEEDS)[number];

export const TIMING = {
  /** Dráha jezdce za tik podle rychlosti. */
  speed: { slow: 40, normal: 60, fast: 90 } as Readonly<Record<TimingSpeed, number>>,
  /** Přibližná amplituda kyvu (střed → kraj); přesnou dá sudá perioda. */
  amplitude: 3000,
  /** Výchozí tolerance: půlka okna kolem středu cíle. */
  tolerance: 300,
  /** Nejužší tolerance, kterou smí spec chtít – širší než dráha za tik i u `fast`. */
  minSpecTolerance: 100,
  maxTolerance: 1500,
  baseH: 600,
  blockH: 600,
  blockW: 2400,
  /** Užší blok věž nedostane, ať je pořád vidět. */
  minBlockW: 400,
  depth: 2400,
  minRounds: 3,
  /** Žánr Načasování (P36A T11) hraje 30–40 kol; uložené hry jich mají nejvýš 15. */
  maxRounds: 40,
  /** O kolik jednotek za tik je jezdec v posledním kole rychlejší než v prvním (`rise`). */
  rise: 40,
} as const;

/** Indexy těl úrovně. */
export const TIMING_SLOTS = { slider: 1, target: 2, marks: 3 } as const;

/** Body za trefu: do čtvrtiny tolerance 3, do půlky 2, jinak 1. */
export function timingPoints(offset: number, tolerance: number): number {
  return offset * 4 <= tolerance ? 3 : offset * 2 <= tolerance ? 2 : 1;
}

/** Tiky jednoho kyvu (sudé číslo): za tolik tiků dojede jezdec z kraje na kraj. */
export const timingPeriod = (speed: number): number => 2 * Math.round(TIMING.amplitude / speed);

/** Kolik tiků kyvu padne do okna: body mřížky `−A + k·s` v ±tolerance kolem středu. */
export const timingWindowTicks = (speed: number, tolerance: number): number => 2 * Math.floor(tolerance / speed) + 1;

// ---------------------------------------------------------------------------
// Ovládání

const controlParams = z
  .object({
    mode: z.enum(TIMING_MODES),
    rounds: z.int().min(1).max(TIMING.maxRounds),
    /** Odpuštění brzkého a pozdního ťuku (P37A T7, `forgivenX`); bez něj platí jen okno – uložený svět beze změny. */
    feel: z.literal(2).optional(),
  })
  .strict();
export type TimingControlParams = z.infer<typeof controlParams>;

const S = BODY;

/**
 * Odpuštění `feel: 2` (P37A T7) se stejnými okny jako skok skákačky
 * (`PLATFORM_FEEL`): ťuk mimo okno platí, když do něj jezdec dojede nejvýš za
 * `bufferTicks` tiků (brzký stisk), nebo z něj vyjel nejvýš před `coyoteTicks`
 * tiky (pozdní). Platí jako trefa na kraji okna (1 bod); vrací tu polohu, jinak `null`.
 */
export function forgivenX(x: number, vx: number, center: number, tolerance: number): number | null {
  const side = Math.sign(x - center);
  const coming = Math.sign(vx) === -side;
  const ticks = coming ? PLATFORM_FEEL.bufferTicks : PLATFORM_FEEL.coyoteTicks;
  return Math.abs(x - center) - tolerance <= ticks * Math.abs(vx) ? center + side * tolerance : null;
}

/**
 * Jezdec na start kola `round`: kraj, směr a rychlost z předlohy, nový kyv.
 * Perioda podle rychlosti kola – úroveň s `rise` zrychluje po kolech; ve
 * světě bez něj mají všechna kola rychlost jezdce, takže perioda zůstane.
 */
function startRound(state: Int32Array, round: number): void {
  const slider = bodyBase(TIMING_SLOTS.slider);
  const mark = bodyBase(TIMING_SLOTS.marks + round);
  state[slider + S.x] = state[mark + S.x] as number;
  state[slider + S.y] = state[mark + S.y] as number;
  state[slider + S.vx] = state[mark + S.vx] as number;
  state[slider + S.aux0] = 0;
  state[slider + S.aux1] = timingPeriod(Math.abs(state[mark + S.vx] as number));
}

/**
 * Ťuk vyhodnotí polohu jezdce na začátku tiku (před integrací). Výsledek
 * jde do `aux0` hráče (body trefy, −1 minutí, 0 nic) – jen na tento tik,
 * pravidlo `judge` ho v témž tiku přečte. `aux1` hráče = tiky kola.
 */
export const timingControl: ControlPiece<TimingControlParams> = {
  id: 'timing',
  params: controlParams,
  roles: ['player', 'platform', 'target'],
  cost: (params) => ({ bodies: 3 + params.rounds, rules: 0 }),
  step: (state, player, input, params) => {
    const p = bodyBase(player);
    state[p + S.aux0] = 0;
    const done = Math.floor((state[p + S.z] as number) / UNIT);
    if (done >= params.rounds) return;
    const slider = bodyBase(TIMING_SLOTS.slider);
    const target = bodyBase(TIMING_SLOTS.target);
    const elapsed = (state[p + S.aux1] as number) + 1;
    if ((input.buttons & BUTTON.TAP) === 0) {
      // Dva celé kyvy bez ťuku = minutí; jinak by nečinný hráč visel do horizontu.
      if (elapsed <= 2 * (state[slider + S.aux1] as number)) {
        state[p + S.aux1] = elapsed;
        return;
      }
      state[p + S.aux0] = -1;
      state[p + S.aux1] = 0;
      startRound(state, done);
      return;
    }
    state[p + S.aux1] = 0;
    const center = state[target + S.x] as number;
    const tolerance = Math.floor((state[target + S.w] as number) / 2);
    let x = state[slider + S.x] as number;
    if (Math.abs(x - center) > tolerance) {
      const forgiven = params.feel === 2 ? forgivenX(x, state[slider + S.vx] as number, center, tolerance) : null;
      if (forgiven === null) {
        state[p + S.aux0] = -1;
        startRound(state, done);
        return;
      }
      x = forgiven;
    }
    const offset = Math.abs(x - center);
    state[p + S.aux0] = timingPoints(offset, tolerance);
    const mark = bodyBase(TIMING_SLOTS.marks + done);
    const width = state[slider + S.w] as number;
    state[mark + S.flags] = (state[mark + S.flags] as number) | FLAG.alive;
    state[mark + S.vx] = 0;
    if (params.mode === 'stack') {
      // Usekne se, co přečnívá přes blok pod ním: položí se průnik, další blok je stejně úzký.
      const kept = Math.max(TIMING.minBlockW, width - offset);
      state[mark + S.x] = Math.trunc(x / 2);
      state[mark + S.w] = kept;
      state[slider + S.w] = kept;
    } else state[mark + S.x] = x;
    state[p + S.z] = (state[p + S.z] as number) + UNIT;
    if (done + 1 < params.rounds) startRound(state, done + 1);
    else {
      state[slider + S.vx] = 0;
      state[slider + S.aux1] = 0;
    }
  },
};

// ---------------------------------------------------------------------------
// Pravidlo

const judgeParams = z
  .object({
    goal: z.int().min(1).max(ARCADE_LIMITS.maxBodies),
    miss: z.enum(['lose', 'damage']),
    /** Náhlá smrt (finále průběhu P45C T14): v posledních `sudden` úkolech minutí prohrává i se životy. Bez hodnoty žádná. */
    sudden: z.int().min(1).max(ARCADE_LIMITS.maxBodies).optional(),
    /** Šampion duelu (finále P47A T6): trefa po víc než `after` splněných úkolech je i zásah těla `body` za 1 HP. Bez hodnoty žádný. */
    champion: z.object({ body: z.int().min(0).max(ARCADE_LIMITS.maxBodies - 1), after: z.int().min(0).max(ARCADE_LIMITS.maxBodies) }).strict().optional(),
    /** Duel s akcí úder (P47B T8): zásah soupeře je sloveso věty – čte ho jen důkaz slovesa. */
    verb: z.literal('strike').optional(),
  })
  .strict();

/**
 * Výsledek ťuku z `aux0` hráče → efekty: trefa = body, minutí = prohra nebo
 * život (v posledních `sudden` úkolech vždy prohra). `goal` splněných úkolů
 * (`z` hráče v metrech) = výhra. Sdílí ho načasování, rytmus i souboj – všechna
 * tři ovládání píšou výsledek stejně. Se šampionem duelu (`champion`) je trefa
 * na posledního soupeře i efekt `hit` na jeho tělo, před výhrou téhož tiku.
 */
export const judgeRule: RulePiece<z.infer<typeof judgeParams>> = {
  id: 'judge',
  params: judgeParams,
  roles: ['player'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const p = bodyBase(player);
    const result = state[p + S.aux0] as number;
    const effects: ({ kind: 'score'; amount: number } | { kind: 'hit'; body: number; by: number; amount: number } | { kind: 'damage'; amount: number } | { kind: 'lose' } | { kind: 'win' })[] = [];
    const done = Math.floor((state[p + S.z] as number) / UNIT);
    const sudden = params.sudden !== undefined && done >= params.goal - params.sudden;
    if (result > 0) {
      effects.push({ kind: 'score', amount: result });
      if (params.champion !== undefined && done > params.champion.after) effects.push({ kind: 'hit', body: params.champion.body, by: player, amount: 1 });
    } else if (result < 0) effects.push(params.miss === 'lose' || sudden ? { kind: 'lose' } : { kind: 'damage', amount: 1 });
    if ((state[p + S.z] as number) >= params.goal * UNIT) effects.push({ kind: 'win' });
    return effects;
  },
};

/** Pravidla her s `judge`: minutí bez životů prohrává, se životy ubírá. */
export function judgeRules(goal: number, health?: number): PieceRef[] {
  const rules: PieceRef[] = [{ id: 'judge', params: { goal, miss: health === undefined ? 'lose' : 'damage' } }];
  if (health !== undefined) rules.push({ id: 'out_of_health', params: {} });
  return rules;
}

// ---------------------------------------------------------------------------
// Generátor

const generatorParams = z
  .object({
    mode: z.enum(TIMING_MODES).default('stack'),
    speed: z.enum(TIMING_SPEEDS).default('normal'),
    // Generátor pustí i toleranci pod dráhou za tik – `checkTimingLevel` ji odmítne s důvodem.
    tolerance: z.int().min(10).max(TIMING.maxTolerance).default(TIMING.tolerance),
    rounds: z.int().min(TIMING.minRounds).max(TIMING.maxRounds).default(8),
    /** Žánr Načasování (P36A T11): každé kolo rychlejší, v posledním o `TIMING.rise`; bez něj stálá rychlost. */
    rise: z.boolean().optional(),
    /** Odpuštění ťuku (P37A T7) – čte ho ovládání, úroveň ne. */
    feel: z.literal(2).optional(),
  })
  .strict();
export type TimingLevelParams = z.infer<typeof generatorParams>;

/** Rychlost jezdce v kole `round`: s `rise` roste rovnoměrně od rychlosti úrovně. */
export function timingSpeedOf(params: TimingLevelParams, round: number): number {
  const base = TIMING.speed[params.speed];
  return params.rise === true && params.rounds > 1 ? base + Math.floor((TIMING.rise * round) / (params.rounds - 1)) : base;
}

/**
 * Úroveň s rychlostí jezdce po kolech `speeds` (průběh P45C T14): jezdec a
 * předlohy kol začnou na kraji kyvu své rychlosti, stranu nechá ze semínka.
 * Rozložení těl i počet kol se nemění.
 */
export function timingLevelAtSpeeds(level: ArcadeLevel, speeds: readonly number[]): ArcadeLevel {
  const edge = (side: number, speed: number): Pick<BodyInit, 'x' | 'vx'> => ({ x: side * ((timingPeriod(speed) * speed) / 2), vx: -side * speed });
  const sideOf = (body: BodyInit): number => (body.x < 0 ? -1 : 1);
  const bodies = level.bodies.map((body, index): BodyInit => {
    if (index === TIMING_SLOTS.slider) return { ...body, ...edge(sideOf(body), speeds[0] as number), period: timingPeriod(speeds[0] as number) };
    const round = index - TIMING_SLOTS.marks;
    return round >= 0 && round < speeds.length ? { ...body, ...edge(sideOf(body), speeds[round] as number) } : body;
  });
  return { ...level, bodies };
}

const KINDS: Readonly<Record<TimingMode, { readonly base: string; readonly slider: string; readonly w: number }>> = {
  stack: { base: 'base', slider: 'block', w: TIMING.blockW },
  precision: { base: 'bar', slider: 'needle', w: 200 },
  bridge: { base: 'pillar', slider: 'plank', w: 400 },
};

export const timingLevel: GeneratorPiece<TimingLevelParams> = {
  id: 'timing_level',
  params: generatorParams,
  roles: ['player', 'platform', 'target'],
  cost: (params) => ({ bodies: 3 + params.rounds, rules: 2 }),
  generate: (seed, params) => {
    const rng = createCompileRng(seed);
    const speed = timingSpeedOf(params, 0);
    const period = timingPeriod(speed);
    const amplitude = (period * speed) / 2;
    const kinds = KINDS[params.mode];
    const heightOf = (round: number): number => TIMING.baseH + (params.mode === 'stack' ? round * TIMING.blockH : 0);
    // Každé kolo začne na kraji svého kyvu, stranu určí semínko.
    const starts = Array.from({ length: params.rounds }, () => (rng.int(0, 1) === 0 ? -1 : 1));
    const first = starts[0] as number;
    const edgeOf = (round: number): { readonly speed: number; readonly amplitude: number } => {
      const own = timingSpeedOf(params, round);
      return { speed: own, amplitude: (timingPeriod(own) * own) / 2 };
    };
    const bodies: BodyInit[] = [
      { role: 'player', kind: kinds.base, x: 0, y: 0, z: 0, w: TIMING.blockW, h: TIMING.baseH, d: TIMING.depth, solid: false },
      {
        role: 'platform',
        kind: kinds.slider,
        x: first * amplitude,
        y: heightOf(0),
        z: 0,
        w: kinds.w,
        h: TIMING.blockH,
        d: TIMING.depth,
        solid: false,
        vx: -first * speed,
        kinematic: true,
        period,
      },
      { role: 'target', kind: 'zone', x: 0, y: TIMING.baseH, z: 0, w: 2 * params.tolerance, h: 40, d: TIMING.depth, solid: false },
      ...starts.map((side, round): BodyInit => {
        const edge = edgeOf(round);
        return {
          role: 'platform',
          kind: kinds.slider,
          x: side * edge.amplitude,
          y: heightOf(round),
          z: 0,
          w: kinds.w,
          h: TIMING.blockH,
          d: TIMING.depth,
          solid: false,
          vx: -side * edge.speed,
          template: true,
        };
      }),
    ];
    return { bodies, length: params.rounds * UNIT };
  },
};

/** Pravidla načasování. */
export const timingRules = (rounds: number, health?: number): PieceRef[] => judgeRules(rounds, health);

/** Díly světa pro kompilátor: parametry specu → ovládání, robot, úroveň, pravidla a nálezy kontroly. */
export function timingParts(seed: number, raw: Readonly<Record<string, unknown>>, health: number | undefined) {
  const params = timingLevel.params.parse(raw);
  const level = timingLevel.generate(seed, params);
  return {
    control: { id: 'timing', params: { mode: params.mode, rounds: params.rounds, ...(params.feel === undefined ? {} : { feel: params.feel }) } },
    bot: { id: 'timing_bot', params: {} },
    level,
    rules: timingRules(params.rounds, health),
    issues: checkTimingLevel(level),
  };
}

/** Tvrzení „hratelné z konstrukce“ nad hotovou úrovní; prázdné pole = hratelná. */
export function checkTimingLevel(level: ArcadeLevel): string[] {
  const issues: string[] = [];
  const m = (units: number): string => `${(units / UNIT).toFixed(2)} m`;
  const slider = level.bodies[TIMING_SLOTS.slider];
  const target = level.bodies[TIMING_SLOTS.target];
  const marks = level.bodies.slice(TIMING_SLOTS.marks);
  if (slider === undefined || target === undefined || slider.kinematic !== true || target.role !== 'target') return ['level: expected a moving slider and a target after the player'];
  const speed = Math.abs(slider.vx ?? 0);
  const period = slider.period ?? 0;
  const amplitude = (period * speed) / 2;
  const tolerance = Math.floor(target.w / 2);
  if (speed === 0 || period === 0 || period % 2 !== 0) issues.push(`the slider must swing with an even period, got ${period} ticks at ${m(speed)} per tick`);
  if (tolerance <= speed) issues.push(`the tolerance ${m(tolerance)} is not wider than one tick of travel (${m(speed)}) – a tap on the right moment can still miss`);
  if (Math.abs(target.x) + tolerance > amplitude) issues.push(`the target window reaches past the swing (${m(amplitude)} each way)`);
  if (marks.length === 0) issues.push('no rounds to play');
  if (marks[0] !== undefined && Math.abs(marks[0].vx ?? 0) !== speed) issues.push('round 1 does not start at the speed of the slider');
  marks.forEach((mark, round) => {
    // Kyv kola (`rise` ho zrychluje) musí začít na kraji a mířit ke středu, jinak ho kyvadlo jádra přežene za kraj.
    const own = Math.abs(mark.vx ?? 0);
    const reach = (timingPeriod(own) * own) / 2;
    if (own === 0 || Math.abs(mark.x) !== reach || Math.sign(mark.vx ?? 0) !== -Math.sign(mark.x)) issues.push(`round ${round + 1} does not start at the edge of the swing`);
    else if (own !== speed && tolerance <= own) issues.push(`round ${round + 1}: the tolerance ${m(tolerance)} is not wider than one tick of travel (${m(own)})`);
  });
  if (level.length !== marks.length * UNIT) issues.push(`length ${level.length} does not match ${marks.length} rounds`);
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}
