/**
 * Rytmus (P25H, T3): beat mapa, ovládání a generátor.
 *
 * Beat mapa je z BPM a semínka, ne z hudby: beat *i* padne na tik
 * `lead + ⌊i · 3600 / bpm⌋` (60 Hz × 60 s), hustota rozhodne, které beaty
 * (a u `dense` i půldoby) nesou notu. Nota je kinematické tělo, které jede
 * po −z k liště hráče (z = 0) a dorazí na ni přesně v tiku svého beatu.
 * Ťuk vyhodnotí notu nejblíž liště: do `window` tiků od beatu je trefa
 * (body podle přesnosti + kombo), ťuk bez noty v okně i nota, která lištu
 * přejede, je minutí (prohra nebo život, kombo na nulu). Zvuk je ozdoba
 * scény – stav ani hash neovlivní.
 *
 * **Hratelné z konstrukce:** dvě noty nikdy blíž než dvě okna a tik
 * (okna se nepřekrývají a přejetá nota se nesejde s trefou další), první
 * nota až po náběhu. `checkRhythmLevel` to samé přepočítá nad hotovou úrovní.
 *
 * Tělo 0 je lišta (hráč), noty od těla 1 po řadě beatů. Vyřízené noty
 * (trefa i minutí) jsou `z` hráče v metrech, kombo je `aux1` hráče.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import { ARCADE_HZ, ARCADE_LIMITS, AXIS_MAX, type ArcadeLevel, BODY, BUTTON, type BodyInit, type ControlPiece, FLAG, type GeneratorPiece, HEADER, UNIT, bodyBase } from '../contract';
import { judgeRules } from './timing';

export const RHYTHM_DENSITIES = ['sparse', 'normal', 'dense'] as const;
export type RhythmDensity = (typeof RHYTHM_DENSITIES)[number];

export const RHYTHM = {
  /** Jízda noty za tik (9 m/s): nota je vidět pár metrů před lištou. */
  noteSpeed: 150,
  /** Náběh před první notou (3 s). */
  leadIn: 3 * ARCADE_HZ,
  lanes: 4,
  laneW: 1000,
  minBpm: 80,
  maxBpm: 160,
  minBeats: 24,
  maxBeats: 96,
  /** Výchozí okno přesnosti: ± tolik tiků od beatu (133 ms). */
  window: 8,
  /** Nejméně not – aby minutí vždy víc, než je životů. */
  minNotes: 12,
} as const;

/** Tik beatu `i` (celé tiky, bez driftu: počítá se z BPM, ne přičítáním). */
export const beatTick = (bpm: number, beat: number): number => RHYTHM.leadIn + Math.floor((beat * ARCADE_HZ * 60) / bpm);

/**
 * Dráhy (P36A T11): ťuk nese dráhu v ose vstupu – dráha `l` je osa
 * `(2l − 3) · 250`, takže nula (ťuk bez dráhy, mezerník) žádnou dráhu nejmenuje.
 * Dráha noty je její `x` (pruh `laneW` široký, střed tratě mezi prostředními).
 */
const LANE_AXIS = AXIS_MAX / RHYTHM.lanes;
export const rhythmLaneAxis = (lane: number): number => (2 * lane - (RHYTHM.lanes - 1)) * LANE_AXIS;
export const rhythmLaneOfAxis = (axis: number): number => Math.min(RHYTHM.lanes - 1, Math.max(0, Math.round((axis / LANE_AXIS + RHYTHM.lanes - 1) / 2)));
export const rhythmLaneOfX = (x: number): number => Math.round(x / RHYTHM.laneW + (RHYTHM.lanes - 1) / 2);

// ---------------------------------------------------------------------------
// Ovládání

const controlParams = z
  .object({
    window: z.int().min(1).max(30),
    /** Ťuk s dráhou bere jen notu té dráhy (žánr Rytmus, P36A T11); bez toho nejbližší notu v kterékoli. */
    lanes: z.boolean().optional(),
  })
  .strict();
export type RhythmControlParams = z.infer<typeof controlParams>;

const S = BODY;

/** Body za trefu `dt` tiků od beatu, plus kombo (za každých 8 v řadě +1, nejvýš +3). */
export function rhythmPoints(dt: number, window: number, combo: number): number {
  const accuracy = dt <= 1 ? 3 : dt * 2 <= window ? 2 : 1;
  return accuracy + Math.min(3, Math.floor(combo / 8));
}

export const rhythmControl: ControlPiece<RhythmControlParams> = {
  id: 'rhythm',
  params: controlParams,
  roles: ['player', 'target'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    const p = bodyBase(player);
    state[p + S.aux0] = 0;
    const count = state[HEADER.bodyCount] as number;
    const reach = params.window * RHYTHM.noteSpeed;
    const tapped = (input.buttons & BUTTON.TAP) !== 0;
    // Ťuk do dráhy (klávesy D/F/J/K, pozice prstu) hledá notu jen v ní; mezerník bez dráhy kteroukoli.
    const lane = params.lanes === true && input.axis !== 0 ? rhythmLaneOfAxis(input.axis) : -1;
    let resolved = 0;
    let missed = false;
    let nearest = -1;
    let nearestZ = 0;
    for (let i = 0; i < count; i += 1) {
      if (i === player) continue;
      const base = bodyBase(i);
      if (((state[base + S.flags] as number) & FLAG.alive) === 0) continue;
      const z = state[base + S.z] as number;
      if (z < -reach) {
        // Přejela lištu bez ťuku.
        state[base + S.flags] = (state[base + S.flags] as number) & ~FLAG.alive;
        resolved += 1;
        missed = true;
      } else if (tapped && z <= reach && (lane < 0 || rhythmLaneOfX(state[base + S.x] as number) === lane) && (nearest < 0 || Math.abs(z) < Math.abs(nearestZ))) {
        nearest = i;
        nearestZ = z;
      }
    }
    if (tapped && nearest >= 0) {
      const base = bodyBase(nearest);
      state[base + S.flags] = (state[base + S.flags] as number) & ~FLAG.alive;
      resolved += 1;
      const combo = (state[p + S.aux1] as number) + 1;
      state[p + S.aux1] = combo;
      if (!missed) state[p + S.aux0] = rhythmPoints(Math.round(Math.abs(nearestZ) / RHYTHM.noteSpeed), params.window, combo);
    } else if (tapped) missed = true;
    if (missed) {
      state[p + S.aux0] = -1;
      state[p + S.aux1] = 0;
    }
    state[p + S.z] = (state[p + S.z] as number) + resolved * UNIT;
  },
};

// ---------------------------------------------------------------------------
// Generátor

const generatorParams = z
  .object({
    bpm: z.int().min(RHYTHM.minBpm).max(RHYTHM.maxBpm).default(120),
    density: z.enum(RHYTHM_DENSITIES).default('normal'),
    beats: z.int().min(RHYTHM.minBeats).max(RHYTHM.maxBeats).default(48),
    window: z.int().min(1).max(30).default(RHYTHM.window),
    /** Žánr Rytmus (P36A T11): písnička houstne po třetinách (řídká → normální → hustá) místo jedné hustoty. */
    ramp: z.boolean().optional(),
    /** Žánr Rytmus: ťuk míří do dráhy (`rhythmControl` `lanes`). */
    lanes: z.boolean().optional(),
  })
  .strict();
export type RhythmLevelParams = z.infer<typeof generatorParams>;

/** Hustota doby `beat`: s `ramp` podle třetiny písničky, jinak hustota úrovně. */
const densityAt = (params: RhythmLevelParams, beat: number): RhythmDensity =>
  params.ramp === true ? (RHYTHM_DENSITIES[Math.min(2, Math.floor((3 * beat) / params.beats))] as RhythmDensity) : params.density;

/** Tiky not: beaty podle hustoty, půldoby jen u `dense` a jen když se okna nepotkají. */
export function beatMap(seed: number, params: RhythmLevelParams): number[] {
  const rng = createCompileRng(seed);
  const ticks: number[] = [];
  const minGap = 2 * params.window + 2;
  const push = (tick: number): void => {
    const last = ticks.at(-1);
    if (last === undefined || tick - last >= minGap) ticks.push(tick);
  };
  for (let beat = 0; beat < params.beats; beat += 1) {
    const on = beatTick(params.bpm, beat);
    const density = densityAt(params, beat);
    // Řídké: každá sudá doba, liché čtvrtinou; normální: 5 dob ze 6; husté: každá doba.
    const keep = density === 'sparse' ? beat % 2 === 0 || rng.int(0, 3) === 0 : density === 'normal' ? beat === 0 || rng.int(0, 5) !== 0 : true;
    if (keep) push(on);
    if (density === 'dense' && rng.int(0, 1) === 0) push(Math.floor((on + beatTick(params.bpm, beat + 1)) / 2));
  }
  return ticks.slice(0, ARCADE_LIMITS.maxBodies - 1);
}

export const rhythmLevel: GeneratorPiece<RhythmLevelParams> = {
  id: 'rhythm_level',
  params: generatorParams,
  roles: ['player', 'target'],
  cost: (params) => ({ bodies: 1 + params.beats * 2, rules: 2 }),
  generate: (seed, params) => {
    const rng = createCompileRng(seed ^ 0x5eed);
    const notes = beatMap(seed, params);
    const width = RHYTHM.lanes * RHYTHM.laneW;
    const bodies: BodyInit[] = [
      { role: 'player', kind: 'hitbar', x: 0, y: 0, z: 0, w: width, h: 200, d: 600, solid: false },
      ...notes.map(
        (tick): BodyInit => ({
          role: 'target',
          kind: 'note',
          // Pruh ze semínka; ťuk s dráhou (`lanes`) platí jen na notu v ní, jinak na nejbližší v kterémkoli pruhu.
          x: (rng.int(0, RHYTHM.lanes - 1) * 2 - (RHYTHM.lanes - 1)) * (RHYTHM.laneW / 2),
          y: 0,
          z: tick * RHYTHM.noteSpeed,
          w: 800,
          h: 300,
          d: 600,
          solid: false,
          vz: -RHYTHM.noteSpeed,
          kinematic: true,
        }),
      ),
    ];
    return { bodies, length: notes.length * UNIT };
  },
};

/** Tiky beatů zpět z hotové úrovně: nota dorazí na lištu v tiku `z / rychlost`. */
export const rhythmTicks = (level: ArcadeLevel): number[] => level.bodies.slice(1).map((body) => body.z / RHYTHM.noteSpeed);

/** Tvrzení „hratelné z konstrukce“ nad hotovou úrovní; prázdné pole = hratelná. */
export function checkRhythmLevel(level: ArcadeLevel, window: number): string[] {
  const issues: string[] = [];
  const notes = level.bodies.slice(1);
  if (notes.length < RHYTHM.minNotes) issues.push(`only ${notes.length} notes – a song needs at least ${RHYTHM.minNotes}`);
  notes.forEach((note, index) => {
    if (note.vz !== -RHYTHM.noteSpeed || note.kinematic !== true || note.z % RHYTHM.noteSpeed !== 0) issues.push(`note ${index + 1} does not arrive on a whole tick`);
  });
  const ticks = rhythmTicks(level);
  ticks.forEach((tick, index) => {
    const prev = ticks[index - 1];
    if (index === 0 && tick < RHYTHM.leadIn) issues.push(`the first note comes at tick ${tick}, before the ${RHYTHM.leadIn}-tick lead-in`);
    if (prev !== undefined && tick - prev <= 2 * window + 1) issues.push(`notes at ticks ${prev} and ${tick} are closer than two ±${window}-tick windows`);
  });
  if (ticks.at(-1) !== undefined && (ticks.at(-1) as number) + window >= ARCADE_LIMITS.maxTicks) issues.push('the song runs past the 90 s horizon');
  if (level.length !== notes.length * UNIT) issues.push(`length ${level.length} does not match ${notes.length} notes`);
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}

/** Díly světa pro kompilátor. Životů je nejvýš čtvrtina not, jinak by nečinný hráč písničku „přežil“. */
export function rhythmParts(seed: number, raw: Readonly<Record<string, unknown>>, health: number | undefined) {
  const params = rhythmLevel.params.parse(raw);
  const level = rhythmLevel.generate(seed, params);
  const notes = level.bodies.length - 1;
  const lives = health === undefined ? undefined : Math.max(1, Math.min(health, Math.floor(notes / 4)));
  const lanes = params.lanes === true ? { lanes: true } : {};
  return {
    control: { id: 'rhythm', params: { window: params.window, ...lanes } },
    bot: { id: 'rhythm_bot', params: lanes },
    level,
    rules: judgeRules(notes, lives),
    issues: checkRhythmLevel(level, params.window),
    health: lives,
  };
}
