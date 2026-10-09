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
 * chování (4 bity) | prostor (1 bit) | odpočet fáze (11 bitů) | paměť chování
 * (11 bitů, přežije fáze), `aux1` = zamčený cíl.
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
import { ARENA, DIRECTIONS, ESCAPE, directionOfAxis } from '../arena';
import { predict } from '../arena-bot';
import { ambusher } from './ambusher';
import { boss } from './boss';
import { flanker, overlaps } from './flanker';
import { guardian } from './guardian';
import { sniper } from './sniper';
import { swarm } from './swarm';

export { overlaps };

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

/** Jak scéna varování kreslí: čára výpadu, přejezd do pruhu, zamčená přímka výstřelu, chvění, kruh dosahu… */
export type TelegraphKind = 'dash' | 'lane' | 'line' | 'shake' | 'ring' | 'cluster';

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
  /** Paměť chování přes všechny fáze (0–`MEMO_MASK`); strážce v ní drží hlídanou věc. */
  readonly memo: number;
}

/** Krok ovládání: navíc intenzita průběhu a hrana plochy. */
export interface BehaviourStep extends BehaviourView {
  /** Intenzita v promile dnešní úrovně (`intensityAt`). */
  readonly intensity: number;
  /** Polovina strany plochy (`plane`), když ji základní ovládání zná. */
  readonly half?: number;
  /** Zapíše paměť chování (`memo` od dalšího tiku). */
  remember(memo: number): void;
}

export interface Behaviour {
  readonly id: string;
  readonly telegraph: Readonly<Record<BehaviourSpace, TelegraphKind>>;
  readonly ticks: Readonly<Record<BehaviourSpace, PhaseTicks>>;
  /** Výchozí předloha těla; její role, model a rozměry jsou podpis. */
  readonly body: BodyInit;
  /** Předloha výstřelu (role `hazard`, jiný podpis než tělo); `effects` ho vydá jako `spawn` předlohy `ref.shot`. */
  readonly shot?: BodyInit;
  /** Hejno: kolik těl přijde jedním spawnem rozvrhu, na jednom místě po `spacing` od sebe. */
  readonly group?: { readonly size: number; readonly spacing: number };
  /** Délka tohoto varování (boss ji zkracuje zásahy); bez metody `ticks.telegraph`, nikdy pod `TELEGRAPH_MIN`. */
  warnTicks?(view: BehaviourStep): number;
  /** Druh varování podle útoku, který přijde; bez metody `telegraph[space]`. */
  kindOf?(view: BehaviourView): TelegraphKind;
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
  /** Jak tělo vidí základní robot: věc, ke které jde (bezpečnou cestou), pronásledovatel, kterému se vyhne; bez metody vůbec. */
  seenAs?(view: BehaviourView): 'collectible' | 'chaser' | undefined;
}

/** Kód chování = pořadí + 1. Je součást hashe: nové jen na konec, nepřečíslovat. */
export const BEHAVIOUR_IDS = ['flanker', 'sniper', 'ambusher', 'guardian', 'swarm', 'boss'] as const;
export type BehaviourId = (typeof BEHAVIOUR_IDS)[number];
export const BEHAVIOURS: Readonly<Record<BehaviourId, Behaviour>> = { flanker, sniper, ambusher, guardian, swarm, boss };

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
/** Odpočet fáze: 11 bitů (nejvýš 2047 tiků). */
const LEFT_MASK = 0x7ff;
/** Paměť chování: 11 bitů nad odpočtem (index těla + 1; `maxBodies` je 256). */
const MEMO_SHIFT = 20;
const MEMO_MASK = 0x7ff;
/** Cíl v `aux1`: `x / 16` v horních, `z / 64` v dolních 16 bitech (±524 m, ±2 km – trať 90 s se vejde). */
const AIM_X = 16;
const AIM_Z = 64;

const packAim = (x: number, z: number): number => ((Math.trunc(x / AIM_X) & 0xffff) << 16) | (Math.trunc(z / AIM_Z) & 0xffff);
const aimOf = (packed: number): { x: number; z: number } => ({ x: (packed >> 16) * AIM_X, z: ((packed << 16) >> 16) * AIM_Z });

export const behaviourPhaseOf = (state: ArcadeState, body: number): BehaviourPhase => PHASES[(state[bodyBase(body) + BODY.aux0] as number) & PHASE_MASK] as BehaviourPhase;
const codeOf = (aux0: number): number => (aux0 >> CODE_SHIFT) & CODE_MASK;
const memoOf = (aux0: number): number => (aux0 >> MEMO_SHIFT) & MEMO_MASK;

/** Paměť chování těla (pro testy a scénu). */
export const behaviourMemoOf = (state: ArcadeState, body: number): number => memoOf(state[bodyBase(body) + BODY.aux0] as number);

function viewOf(state: ArcadeState, body: number, player: number): BehaviourView {
  const base = bodyBase(body);
  const aux0 = state[base + BODY.aux0] as number;
  return { state, body, player, space: (aux0 & TRACK_BIT) !== 0 ? 'track' : 'plane', phase: PHASES[aux0 & PHASE_MASK] as BehaviourPhase, ticksLeft: (aux0 >> LEFT_SHIFT) & LEFT_MASK, aim: aimOf(state[base + BODY.aux1] as number), memo: memoOf(aux0) };
}

/** Fáze, kód, prostor a odpočet; paměť zůstane. */
function write(state: ArcadeState, body: number, code: number, space: BehaviourSpace, phase: BehaviourPhase, ticksLeft: number): void {
  const at = bodyBase(body) + BODY.aux0;
  state[at] = BEHAVIOUR_PHASE[phase] | (code << CODE_SHIFT) | (space === 'track' ? TRACK_BIT : 0) | (ticksLeft << LEFT_SHIFT) | (memoOf(state[at] as number) << MEMO_SHIFT);
}

function remember(state: ArcadeState, body: number, memo: number): void {
  const at = bodyBase(body) + BODY.aux0;
  state[at] = ((state[at] as number) & ~(MEMO_MASK << MEMO_SHIFT)) | ((memo & MEMO_MASK) << MEMO_SHIFT);
}

/** Varování pro scénu: jen ve fázi `telegraph`, jinak `null`. */
export function telegraphOf(state: ArcadeState, body: number): { readonly kind: TelegraphKind; readonly ticksLeft: number; readonly aim: { readonly x: number; readonly z: number } } | null {
  const id = BEHAVIOUR_IDS[codeOf(state[bodyBase(body) + BODY.aux0] as number) - 1];
  if (id === undefined) return null;
  const view = viewOf(state, body, state[HEADER.player] as number);
  const behaviour = BEHAVIOURS[id];
  return view.phase === 'telegraph' ? { kind: behaviour.kindOf?.(view) ?? behaviour.telegraph[view.space], ticksLeft: view.ticksLeft, aim: view.aim } : null;
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
export function matches(state: ArcadeState, body: number, template: number): boolean {
  const a = bodyBase(body);
  const b = bodyBase(template);
  for (const slot of SIGNATURE) if (state[a + slot] !== state[b + slot]) return false;
  return true;
}

/**
 * Živá těla chování `[tělo, chování, kód, odkaz]` ve vzestupném pořadí těl; hráč a předlohy ne.
 * Robot, ovládání i pravidlo to volají každý tik: model předlohy se porovná dřív než celý podpis.
 */
function actors(state: ArcadeState, player: number, refs: readonly BehaviourRef[]): (readonly [number, Behaviour, number, BehaviourRef])[] {
  const found: (readonly [number, Behaviour, number, BehaviourRef])[] = [];
  const bodies = state[HEADER.bodyCount] as number;
  const kinds = refs.map((ref) => state[bodyBase(ref.template) + BODY.kind] as number);
  for (let body = 0; body < bodies; body += 1) {
    const base = bodyBase(body);
    if (body === player || ((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
    const kind = state[base + BODY.kind] as number;
    for (let k = 0; k < refs.length; k += 1) {
      const ref = refs[k] as BehaviourRef;
      if (kinds[k] !== kind || !matches(state, body, ref.template)) continue;
      found.push([body, BEHAVIOURS[ref.id], BEHAVIOUR_IDS.indexOf(ref.id) + 1, ref]);
      break;
    }
  }
  return found;
}

/** Indexy živých těl chování (pro scénu a testy). */
export const behaviourBodies = (state: ArcadeState, player: number, refs: readonly BehaviourRef[]): number[] => [...actors(state, player, refs)].map(([body]) => body);

/** Indexy živých výstřelů chování: těla s podpisem některé předlohy `shot`, každé jednou. */
export function shotBodies(state: ArcadeState, player: number, refs: readonly BehaviourRef[]): number[] {
  const shots = refs.flatMap((ref) => (ref.shot === undefined ? [] : [ref.shot]));
  const found: number[] = [];
  if (shots.length === 0) return found;
  const kinds = shots.map((shot) => state[bodyBase(shot) + BODY.kind] as number);
  const bodies = state[HEADER.bodyCount] as number;
  for (let body = 0; body < bodies; body += 1) {
    if (body === player || !alive(state, body)) continue;
    const kind = state[bodyBase(body) + BODY.kind] as number;
    if (shots.some((shot, k) => kinds[k] === kind && matches(state, body, shot))) found.push(body);
  }
  return found;
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
    const step = (phase: BehaviourPhase, ticksLeft: number, aim = before.aim): BehaviourStep => ({ ...before, space, phase, ticksLeft, aim, intensity, ...(half === undefined ? {} : { half }), remember: (memo) => remember(state, body, memo) });
    let view = step(before.phase, before.ticksLeft);
    if (view.phase === 'idle') {
      if (behaviour.ready(view)) {
        const aim = behaviour.aim(view);
        state[bodyBase(body) + BODY.aux1] = packAim(aim.x, aim.z);
        view = step('telegraph', Math.max(TELEGRAPH_MIN, behaviour.warnTicks?.(view) ?? ticks.telegraph), aimOf(state[bodyBase(body) + BODY.aux1] as number));
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

/**
 * `pacing_bot`: pozorování pro základního robota – těla chování s `seenAs`
 * v kopii stavu s rolí, jak je má vidět (otevřený boss = věc, útočící boss =
 * pronásledovatel). Bez takového těla totéž pozorování.
 */
export function seenByBase(observation: ArcadeObservation, refs: readonly BehaviourRef[]): ArcadeObservation {
  let state: ArcadeState | null = null;
  for (const [body, behaviour] of actors(observation.state, observation.player, refs)) {
    const role = behaviour.seenAs?.(viewOf(observation.state, body, observation.player));
    if (role === undefined) continue;
    state ??= observation.state.slice();
    state[bodyBase(body) + BODY.role] = ROLE[role];
  }
  return state === null ? observation : { ...observation, state };
}

/**
 * Uhnutí před chováním nesmí hráče poslat pronásledovatelům do rukou: tah po
 * uhnutí musí `ticks` tiků držet mezeru `gap` (okraj k okraji, po osách) od
 * pronásledovatelů, kteří jdou rovnou na hráče nejvyšší rychlostí `speed`
 * (vzor plánovače útěku `arena-bot.ts`). Naměřeno P45C T12 na 19 sestavách
 * arény × 20 semínek: 45 tiků a 1 m – robot bez profilu prohrál 2/380 (dřív
 * pronásledovatel do 3 m 22/230; 60 tiků a 2 m 5/380, uhnutí pak často
 * neplatilo a strážce zasáhl).
 */
export const CHASER_CHECK = { ticks: 45, sample: 5, gap: UNIT, speed: ESCAPE.chaserSpeed.max, half: ARENA.half } as const;

/** Nejmenší mezera tahu `input` k živým pronásledovatelům (role `chaser`) v horizontu; bez nich nekonečno. */
export function chaserClearance(observation: ArcadeObservation, input: ArcadeInput): number {
  const { state, player, recent } = observation;
  const lag = recent.length;
  const size = state[bodyBase(player) + BODY.w] as number;
  const chasers: { x: number; z: number; reach: number }[] = [];
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (state[base + BODY.role] !== ROLE.chaser || !alive(state, body)) continue;
    chasers.push({ x: (state[base + BODY.x] as number) + (state[base + BODY.vx] as number) * lag, z: (state[base + BODY.z] as number) + (state[base + BODY.vz] as number) * lag, reach: ((state[base + BODY.w] as number) + size) / 2 });
  }
  if (chasers.length === 0) return Number.POSITIVE_INFINITY;
  const me = predict(state, player, recent);
  const direction = directionOfAxis(input.axis);
  const dir = direction < 0 ? { dx: 0, dz: 0 } : (DIRECTIONS[direction] as { dx: number; dz: number });
  const { ticks, sample, speed, half } = CHASER_CHECK;
  const limit = half - Math.ceil(size / 2);
  const clamp = (value: number): number => Math.max(-limit, Math.min(limit, value));
  let px = me.x;
  let pz = me.z;
  let clear = Number.POSITIVE_INFINITY;
  for (let t = sample; t <= ticks; t += sample) {
    px = clamp(px + Math.trunc((dir.dx * ARENA.speed * sample) / 1000));
    pz = clamp(pz + Math.trunc((dir.dz * ARENA.speed * sample) / 1000));
    for (const chaser of chasers) {
      const dx = px - chaser.x;
      const dz = pz - chaser.z;
      const far = Math.sqrt(dx * dx + dz * dz);
      const run = Math.min(far, speed * sample);
      if (far > 0) {
        chaser.x += (dx * run) / far;
        chaser.z += (dz * run) / far;
      }
      clear = Math.min(clear, Math.max(Math.abs(px - chaser.x), Math.abs(pz - chaser.z)) - chaser.reach);
    }
  }
  return clear;
}

/**
 * `pacing_bot`: vstup základního robota upravený krokem robota každého těla
 * chování (vzestupně). Pronásledovatelé mají přednost: uhnutí, které by hráče
 * zahnalo k nim (nebo ho zastavilo, než doběhnou), neplatí a hraje útěk
 * základního robota.
 */
export function dodge(observation: ArcadeObservation, refs: readonly BehaviourRef[], control: string, input: ArcadeInput): ArcadeInput {
  let out = input;
  for (const [body, behaviour] of actors(observation.state, observation.player, refs)) out = behaviour.botStep(viewOf(observation.state, body, observation.player), out, control, observation.recent);
  return out.axis === input.axis || chaserClearance(observation, out) >= CHASER_CHECK.gap ? out : input;
}
