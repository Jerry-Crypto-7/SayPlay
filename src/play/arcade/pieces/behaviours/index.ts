/**
 * Chování nepřátel (P45C): společný rámec.
 *
 * Tělo chování se pozná podle **podpisu** své předlohy – role, model a
 * rozměry (`w/h/d`); dvě chování se stejným podpisem stavba odmítne
 * (`duplicateSignature`). Každé chování běží stejným automatem fází
 * `idle → telegraph → act → recover → idle`: do `act` (jediná fáze, která
 * smí zranit) se jde jen přes celý `telegraph` (aspoň `TELEGRAPH_MIN` tiků)
 * a cíl úderu se zamkne na jeho začátku – uhnout jde vždy.
 *
 * Stav nese tělo samo (vzor `FIGHT_PHASE`): `aux0` = fáze (4 bity) | kód
 * chování (4 bity) | prostor (1 bit) | odpočet fáze, `aux1` = zamčený cíl.
 * Tělo chování proto nesmí být `kinematic` – jádro by `aux1` četlo jako
 * periodu kyvadla. Hýbe s ním `pacing_control`, zraní pravidlo `pacing`,
 * uhýbá `pacing_bot`; kdo ho kreslí, čte `telegraphOf`.
 *
 * Zásah jde jen z pravidla `pacing`: role těla chování proto nesmí být role,
 * na kterou má žánr vlastní pravidlo kontaktu (`hit` s `hazard` u skákačky…).
 * Totéž platí pro výstřel chování (`shot`): má vlastní předlohu a podpis,
 * zásah i úklid za hranou plochy dělá pravidlo `pacing` (`behaviourEffects`).
 */

import { z } from 'zod';

import { type ArcadeEffect, type ArcadeInput, type ArcadeObservation, type ArcadeState, BODY, type BodyInit, FLAG, HEADER, HIT_GRACE, ROLE, UNIT, bodyBase } from '../../contract';
import { flanker } from './flanker';
import { sniper } from './sniper';

/** Nejkratší varování před úderem: 0,5 s. */
export const TELEGRAPH_MIN = 30;

/** Fáze v `aux0 & 0xf`. Čísla jsou součást hashe, nepřečíslovat. */
export const BEHAVIOUR_PHASE = { idle: 0, telegraph: 1, act: 2, recover: 3 } as const;
export type BehaviourPhase = keyof typeof BEHAVIOUR_PHASE;
const PHASES: readonly BehaviourPhase[] = ['idle', 'telegraph', 'act', 'recover'];

/** `plane` = volný pohyb po ploše, `track` = trať po +z s pruhy. */
export type BehaviourSpace = 'plane' | 'track';

/** Prostor chování podle základního ovládání žánru. */
export const BEHAVIOUR_SPACE: Readonly<Record<string, BehaviourSpace>> = {
  move_free: 'plane', walker: 'plane', fight: 'plane',
  runner: 'track', platform: 'track', flap: 'track', steer: 'track', glide: 'track',
};

/** Jak scéna varování kreslí: čára výpadu, přejezd do pruhu, zamčená přímka výstřelu… */
export type TelegraphKind = 'dash' | 'lane' | 'line';

export interface PhaseTicks {
  /** Aspoň `TELEGRAPH_MIN`. */
  readonly telegraph: number;
  readonly act: number;
  readonly recover: number;
}

/** Co chování o svém těle vidí. */
export interface BehaviourView {
  readonly state: ArcadeState;
  readonly body: number;
  readonly player: number;
  readonly space: BehaviourSpace;
  readonly phase: BehaviourPhase;
  /** Tiky do konce fáze; v `idle` 0. */
  readonly ticksLeft: number;
  /** Cíl zamčený na začátku `telegraph`. */
  readonly aim: { readonly x: number; readonly z: number };
}

/** Krok ovládání: navíc intenzita průběhu a hrana plochy. */
export interface BehaviourStep extends BehaviourView {
  /** Intenzita v promile dnešní úrovně (`intensityAt`). */
  readonly intensity: number;
  /** Polovina strany plochy (`plane`), když ji základní ovládání zná. */
  readonly half?: number;
}

export interface Behaviour {
  readonly id: string;
  readonly telegraph: Readonly<Record<BehaviourSpace, TelegraphKind>>;
  readonly ticks: Readonly<Record<BehaviourSpace, PhaseTicks>>;
  /** Výchozí předloha těla; její role, model a rozměry jsou podpis. */
  readonly body: BodyInit;
  /** Předloha výstřelu (role `hazard`, jiný podpis než tělo); `effects` ho vydá jako `spawn` předlohy `ref.shot`. */
  readonly shot?: BodyInit;
  /** V `idle`: je čas varovat? */
  ready(view: BehaviourStep): boolean;
  /** Na začátku `telegraph`: kam úder půjde. */
  aim(view: BehaviourStep): { readonly x: number; readonly z: number };
  /** V `act`: úder skončil dřív (minul, doběhl). */
  done(view: BehaviourStep): boolean;
  /** Rychlost těla v této fázi (`vx/vy/vz`); integruje jádro. */
  move(view: BehaviourStep): void;
  /** Pravidlo `pacing`: efekty těla v tomto tiku; bez metody `strike`. */
  effects?(view: BehaviourView, ref: BehaviourRef): readonly ArcadeEffect[];
  /** Robot: jak uhnout. `control` = základní ovládání, `recent` = stisky, které ve stavu ještě nejsou. */
  botStep(view: BehaviourView, input: ArcadeInput, control: string, recent: readonly ArcadeInput[]): ArcadeInput;
}

/** Kód chování = pořadí + 1. Je součást hashe: nové jen na konec, nepřečíslovat. */
export const BEHAVIOUR_IDS = ['flanker', 'sniper'] as const;
export type BehaviourId = (typeof BEHAVIOUR_IDS)[number];
export const BEHAVIOURS: Readonly<Record<BehaviourId, Behaviour>> = { flanker, sniper };

/** Chování ve světě: id a index předlohy, ze které se čte podpis; `shot` = předloha výstřelu. */
export const behaviourRefSchema = z.object({ id: z.enum(BEHAVIOUR_IDS), template: z.int().min(1), shot: z.int().min(1).optional() }).strict();
export type BehaviourRef = z.infer<typeof behaviourRefSchema>;

// ---------------------------------------------------------------------------
// Stav v `aux0` / `aux1`

const PHASE_MASK = 0xf;
const CODE_SHIFT = 4;
const CODE_MASK = 0xf;
const TRACK_BIT = 1 << 8;
const LEFT_SHIFT = 9;
/** Cíl v `aux1`: `x / 16` v horních, `z / 64` v dolních 16 bitech (±524 m, ±2 km – trať 90 s se vejde). */
const AIM_X = 16;
const AIM_Z = 64;

const packAim = (x: number, z: number): number => ((Math.trunc(x / AIM_X) & 0xffff) << 16) | (Math.trunc(z / AIM_Z) & 0xffff);
const aimOf = (packed: number): { x: number; z: number } => ({ x: (packed >> 16) * AIM_X, z: ((packed << 16) >> 16) * AIM_Z });

export const behaviourPhaseOf = (state: ArcadeState, body: number): BehaviourPhase => PHASES[(state[bodyBase(body) + BODY.aux0] as number) & PHASE_MASK] as BehaviourPhase;
const codeOf = (aux0: number): number => (aux0 >> CODE_SHIFT) & CODE_MASK;

function viewOf(state: ArcadeState, body: number, player: number): BehaviourView {
  const base = bodyBase(body);
  const aux0 = state[base + BODY.aux0] as number;
  return { state, body, player, space: (aux0 & TRACK_BIT) !== 0 ? 'track' : 'plane', phase: PHASES[aux0 & PHASE_MASK] as BehaviourPhase, ticksLeft: aux0 >> LEFT_SHIFT, aim: aimOf(state[base + BODY.aux1] as number) };
}

function write(state: ArcadeState, body: number, code: number, space: BehaviourSpace, phase: BehaviourPhase, ticksLeft: number): void {
  state[bodyBase(body) + BODY.aux0] = BEHAVIOUR_PHASE[phase] | (code << CODE_SHIFT) | (space === 'track' ? TRACK_BIT : 0) | (ticksLeft << LEFT_SHIFT);
}

/** Varování pro scénu: jen ve fázi `telegraph`, jinak `null`. */
export function telegraphOf(state: ArcadeState, body: number): { readonly kind: TelegraphKind; readonly ticksLeft: number; readonly aim: { readonly x: number; readonly z: number } } | null {
  const id = BEHAVIOUR_IDS[codeOf(state[bodyBase(body) + BODY.aux0] as number) - 1];
  if (id === undefined) return null;
  const view = viewOf(state, body, state[HEADER.player] as number);
  return view.phase === 'telegraph' ? { kind: BEHAVIOURS[id].telegraph[view.space], ticksLeft: view.ticksLeft, aim: view.aim } : null;
}

// ---------------------------------------------------------------------------
// Podpis

const SIGNATURE = [BODY.role, BODY.kind, BODY.w, BODY.h, BODY.d] as const;

/** Podpis předlohy ve stavbě: role, model, rozměry. */
export const signatureOf = (body: BodyInit): string => [body.roleCode ?? ROLE[body.role], body.kind, body.w, body.h, body.d].join(':');

/** První podpis, který mají dvě předlohy chování, nebo `null`. */
export function duplicateSignature(bodies: readonly BodyInit[]): string | null {
  const seen = new Set<string>();
  for (const body of bodies) {
    const signature = signatureOf(body);
    if (seen.has(signature)) return signature;
    seen.add(signature);
  }
  return null;
}

const alive = (state: ArcadeState, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Živé tělo se stejným podpisem jako předloha `template`. */
function matches(state: ArcadeState, body: number, template: number): boolean {
  const a = bodyBase(body);
  const b = bodyBase(template);
  return SIGNATURE.every((slot) => state[a + slot] === state[b + slot]);
}

/** Živá těla chování `[tělo, chování, kód, odkaz]` ve vzestupném pořadí těl; hráč a předlohy ne. */
function* actors(state: ArcadeState, player: number, refs: readonly BehaviourRef[]): Generator<readonly [number, Behaviour, number, BehaviourRef]> {
  const bodies = state[HEADER.bodyCount] as number;
  for (let body = 0; body < bodies; body += 1) {
    if (body === player || !alive(state, body)) continue;
    const ref = refs.find((candidate) => matches(state, body, candidate.template));
    if (ref !== undefined) yield [body, BEHAVIOURS[ref.id], BEHAVIOUR_IDS.indexOf(ref.id) + 1, ref];
  }
}

/** Indexy živých těl chování (pro scénu a testy). */
export const behaviourBodies = (state: ArcadeState, player: number, refs: readonly BehaviourRef[]): number[] => [...actors(state, player, refs)].map(([body]) => body);

/** Indexy živých výstřelů chování: těla s podpisem některé předlohy `shot`, každé jednou. */
export function shotBodies(state: ArcadeState, player: number, refs: readonly BehaviourRef[]): number[] {
  const shots = refs.flatMap((ref) => (ref.shot === undefined ? [] : [ref.shot]));
  const found: number[] = [];
  if (shots.length === 0) return found;
  const bodies = state[HEADER.bodyCount] as number;
  for (let body = 0; body < bodies; body += 1) if (body !== player && alive(state, body) && shots.some((shot) => matches(state, body, shot))) found.push(body);
  return found;
}

/** Překrývají se kvádry těl `a` a `b` (střed spodní stěny, celé rozměry)? */
export function overlaps(state: ArcadeState, a: number, b: number): boolean {
  const p = bodyBase(a);
  const q = bodyBase(b);
  const apart = (slot: 'x' | 'z', size: 'w' | 'd'): boolean => Math.abs((state[p + BODY[slot]] as number) - (state[q + BODY[slot]] as number)) * 2 >= (state[p + BODY[size]] as number) + (state[q + BODY[size]] as number);
  if (apart('x', 'w') || apart('z', 'd')) return false;
  const py = state[p + BODY.y] as number;
  const qy = state[q + BODY.y] as number;
  return py < qy + (state[q + BODY.h] as number) && qy < py + (state[p + BODY.h] as number);
}

// ---------------------------------------------------------------------------
// Krok ovládání, pravidla a robota

/**
 * `pacing_control`: posune automat fází každého těla chování a nechá ho
 * nastavit rychlost. Do `act` jen po celém `telegraph`; `act` končí
 * odpočtem, `done`, nebo dotykem hráče (jeden zásah na výpad).
 */
export function stepBehaviours(state: ArcadeState, player: number, refs: readonly BehaviourRef[], space: BehaviourSpace, intensity: number, half?: number): void {
  for (const [body, behaviour, code] of actors(state, player, refs)) {
    const ticks = behaviour.ticks[space];
    const before = viewOf(state, body, player);
    const step = (phase: BehaviourPhase, ticksLeft: number, aim = before.aim): BehaviourStep => ({ ...before, space, phase, ticksLeft, aim, intensity, ...(half === undefined ? {} : { half }) });
    let view = step(before.phase, before.ticksLeft);
    if (view.phase === 'idle') {
      if (behaviour.ready(view)) {
        const aim = behaviour.aim(view);
        state[bodyBase(body) + BODY.aux1] = packAim(aim.x, aim.z);
        view = step('telegraph', Math.max(TELEGRAPH_MIN, ticks.telegraph), aimOf(state[bodyBase(body) + BODY.aux1] as number));
      }
    } else {
      const left = view.ticksLeft - 1;
      if (view.phase === 'telegraph') view = left > 0 ? step('telegraph', left) : step('act', ticks.act);
      else if (view.phase === 'act') view = left > 0 && !behaviour.done(view) && !overlaps(state, body, player) ? step('act', left) : step('recover', ticks.recover);
      else view = left > 0 ? step('recover', left) : step('idle', 0);
    }
    write(state, body, code, space, view.phase, view.ticksLeft);
    behaviour.move(view);
  }
}

/** Výchozí úder: tělo v `act`, které se dotýká hráče, ubere život s milostí. */
export const strike = (view: BehaviourView): readonly ArcadeEffect[] =>
  view.phase === 'act' && overlaps(view.state, view.body, view.player) ? [{ kind: 'damage', amount: 1, grace: HIT_GRACE }] : [];

/** Výstřel bez známé plochy zmizí, když letí od hráče a je od něj dál než tohle. */
const SHOT_PASSED = 3 * UNIT;

/** Výstřel opustil hru: za hranou plochy `half`, bez ní minul hráče a letí pryč. */
function shotGone(state: ArcadeState, shot: number, player: number, half: number | undefined): boolean {
  const s = bodyBase(shot);
  const x = state[s + BODY.x] as number;
  const z = state[s + BODY.z] as number;
  if (half !== undefined) return Math.abs(x) > half || Math.abs(z) > half;
  const p = bodyBase(player);
  const rx = x - (state[p + BODY.x] as number);
  const rz = z - (state[p + BODY.z] as number);
  return rx * (state[s + BODY.vx] as number) + rz * (state[s + BODY.vz] as number) > 0 && rx * rx + rz * rz > SHOT_PASSED * SHOT_PASSED;
}

/**
 * Pravidlo `pacing`: efekty všech těl chování v tomto tiku, pak výstřely –
 * dotek hráče ubere život s milostí a výstřel zmizí, výstřel mimo hru
 * (`shotGone`, `half` = polovina strany plochy, když ji hra zná) zmizí.
 */
export function behaviourEffects(state: ArcadeState, player: number, refs: readonly BehaviourRef[], half?: number): ArcadeEffect[] {
  const effects: ArcadeEffect[] = [];
  for (const [body, behaviour, , ref] of actors(state, player, refs)) {
    const view = viewOf(state, body, player);
    effects.push(...(behaviour.effects === undefined ? strike(view) : behaviour.effects(view, ref)));
  }
  for (const shot of shotBodies(state, player, refs)) {
    if (overlaps(state, shot, player)) effects.push({ kind: 'damage', amount: 1, grace: HIT_GRACE }, { kind: 'despawn', body: shot });
    else if (shotGone(state, shot, player, half)) effects.push({ kind: 'despawn', body: shot });
  }
  return effects;
}

/** `pacing_bot`: vstup základního robota upravený krokem robota každého těla chování (vzestupně). */
export function dodge(observation: ArcadeObservation, refs: readonly BehaviourRef[], control: string, input: ArcadeInput): ArcadeInput {
  let out = input;
  for (const [body, behaviour] of actors(observation.state, observation.player, refs)) out = behaviour.botStep(viewOf(observation.state, body, observation.player), out, control, observation.recent);
  return out;
}
