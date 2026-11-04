/**
 * Herní aserce nad stopou stavu (P68 T5): nezávislá kontrola požadovaných akcí z `evals/play/p68/assertions.json`.
 *
 * `traceRun` přehraje svět s jedním z tří hráčů (robot hry, nečinný hráč, slabý robot `BOT_PROFILES.novice`) a zapíše
 * po každém tiku kopii celého stavu jádra (role, polohy, výšky a rychlosti těl, čítače), vstup, `yawStep` z držáku
 * `railfps` a výsledek. Robot jen vyrobí záznam vstupů (`runBot`); stopa vzniká jeho přehráním přes `step` bez
 * sledování efektů, takže `win` či `score`, které pravidlo vydá, do stopy nejdou a důkazem akce být nemůžou. Výsledek
 * běhu (`outcome`) důkazem je, ale jen pro požadavky na výsledek.
 *
 * `assertGame` vyhodnotí strojovou kontrolu `check` každého požadavku nad stopou a vrátí `{ id, pass, evidence }`.
 * Konvence, které kontroly čtou (cíl = role `goal`, trosky = fyzikální tělesa, míček = `FLAG.ball`, držák = model
 * `RAILFPS_KEEPER_ROLE`, chráněné tělo = hráč), jsou popsané u každého druhu kontroly níž.
 */

import assertionsJson from '../../../evals/play/p68/assertions.json';
import { DRAWSAVE_STROKE, P68_MAX_TICKS, RAILFPS_KEEPER_ROLE, RAILFPS_SLOTS, RAILFPS_YAW_STEPS, STUNT_DEBRIS_MAX } from '../genre/p68-contract';

import { type ArcadeCounter, type ArcadeInput, type ArcadeState, type ArcadeWorld, BODY, BODY_STRIDE, BUTTON, type BotPiece, COUNTER, FLAG, HEADER, HEADER_SIZE, type InputEvent, NO_INPUT, ROLE, UNIT, bodyBase, bodyHp, underlyingRule } from './contract';
import { type ArcadeLibrary, type ArcadeOutcome, instantiate, loadProgram, outcomeOf, step } from './kernel';
import { ARCADE_LIBRARY } from './library';
import { releasePhysics } from './physics/step';
import { badLayout, serveWithLayout } from './pieces/buildshift-bot';
import { MINIGOLF_BOT } from './pieces/minigolf-bot';
import { DRAWSAVE, cellOf, colOf, heroCellOf } from './pieces/drawsave-world';
import { axisOfCell } from './pieces/lanes';

/** Slot těla úrovně podle indexu těla (pořadí těl je součást hashe hry) a jména slotu `BODY`. */
export interface BodySlot {
  readonly body: number;
  readonly slot: keyof typeof BODY;
}
import { runBot } from './verify';

// ---------------------------------------------------------------------------
// Stopa

export const TRACE_DRIVERS = ['bot', 'idle', 'weak-bot'] as const;
export type TraceDriver = (typeof TRACE_DRIVERS)[number];

export interface TraceFrame {
  /** Tik stavu (`HEADER.tick`); snímek 0 je počáteční stav. */
  readonly tick: number;
  /** Vstup, který tento stav vyrobil (krok z tiku `tick − 1`); snímek 0 má `NO_INPUT`. */
  readonly input: ArcadeInput;
  /** Kopie celého stavu jádra po kroku: role, polohy, výšky, rychlosti, příznaky těl a čítače. */
  readonly state: ArcadeState;
  /** `RAILFPS_SLOTS.yawStep` na držáku `RAILFPS_KEEPER_ROLE`; `null` = svět držák nemá. */
  readonly yawStep: number | null;
  readonly outcome: ArcadeOutcome;
}

export interface StateTrace {
  readonly driver: TraceDriver;
  readonly world: ArcadeWorld;
  readonly frames: readonly TraceFrame[];
  /** Řídký záznam vstupů (tik vstupu, jako `BotRun.inputs`). */
  readonly inputs: readonly InputEvent[];
  readonly outcome: ArcadeOutcome;
  readonly endTick: number;
  readonly maxTicks: number;
}

const kindIndex = (world: ArcadeWorld, kind: string): number => world.kinds.indexOf(kind);
const capacity = (state: ArcadeState): number => (state.length - HEADER_SIZE) / BODY_STRIDE;
const slot = (state: ArcadeState, body: number, at: number): number => state[bodyBase(body) + at] as number;
const isAlive = (state: ArcadeState, body: number): boolean => (slot(state, body, BODY.flags) & FLAG.alive) !== 0;
/** Sloty tvaru zdi v předem vyhrazeném těle (konce úsečky a délka, `drawsave` `SEGMENT_SLOTS`). */
const WALL_SHAPE: readonly number[] = [BODY.x, BODY.y, BODY.vx, BODY.vy, BODY.aux0];
const counter = (state: ArcadeState, name: ArcadeCounter): number => state[HEADER.counters + COUNTER[name]] as number;
const metres = (units: number): string => (units / UNIT).toFixed(1);

/** Držák `railfps`: první tělo (i mrtvá předloha) s modelem `RAILFPS_KEEPER_ROLE`, jinak −1. */
function rigOf(world: ArcadeWorld, state: ArcadeState): number {
  const kind = kindIndex(world, RAILFPS_KEEPER_ROLE);
  if (kind < 0) return -1;
  for (let body = 0; body < capacity(state); body += 1) if (slot(state, body, BODY.kind) === kind) return body;
  return -1;
}

/**
 * Slabý hráč hry, kde dovednost je rozvržení, ne reakce: v obchodě `buildshift` vyhraje i pomalý robot s dobrým
 * rozvržením, takže „slabý“ = táž obsluha nad pevně špatným rozvržením kategorie (`badLayout`, důkaz P68-S T3).
 */
const WEAK_BOTS: Readonly<Record<string, BotPiece>> = { buildshift_bot: serveWithLayout(badLayout()) as BotPiece };

/**
 * Slabý hráč jako parametry robota hry (T8): profil `novice` jen zpožďuje reakci, a to minigolf (rána z klidu) ani
 * závod s předpovědí trati neoslabí – oba roboti vyhrají. Kategorie `vozidla-sport` proto slabého hráče definuje sama:
 * `stunt` týž robot se zpožděním a chybou řízení (`STUNT_WEAK`), `minigolf` pevná chyba míření a síly (`MINIGOLF_BOT.weak`).
 */
const WEAK_PARAMS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = { stunt_bot: { weak: true }, minigolf_bot: MINIGOLF_BOT.weak };

/**
 * Slabý hráč jako hotové vstupy (T12): robot `drawsave` profil nečte, `novice` by vyhrál. Kategorie `stavba` definuje
 * slabého hráče jako čáru mimo postavu (`arcade/__tests__/drawsave.test.ts`: vodorovný tah ve druhé řadě na opačné
 * polovině desky prohraje ≥ 10 z 12).
 */
const WEAK_INPUTS: Readonly<Record<string, (world: ArcadeWorld) => readonly InputEvent[]>> = {
  drawsave_bot: (world) => {
    const left = colOf(heroCellOf(instantiate(world))) >= DRAWSAVE.cols / 2;
    const cells = left ? [cellOf(0, 1), cellOf(2, 1)] : [cellOf(5, 1), cellOf(7, 1)];
    return cells.map((cell, k) => ({ tick: 5 + k, buttons: BUTTON[DRAWSAVE_STROKE.hold], axis: axisOfCell(cell) }));
  },
};

function inputsOf(world: ArcadeWorld, driver: TraceDriver, library: ArcadeLibrary): readonly InputEvent[] {
  if (driver === 'idle') return [];
  if (driver === 'bot') return runBot(world, library).inputs;
  const ready = WEAK_INPUTS[world.bot.id];
  if (ready !== undefined) return ready(world);
  const params = WEAK_PARAMS[world.bot.id];
  if (params !== undefined) return runBot({ ...world, bot: { ...world.bot, params: { ...(world.bot.params as object), ...params } } }, library).inputs;
  const weak = WEAK_BOTS[world.bot.id];
  if (weak === undefined) return runBot(world, library, { profile: 'novice' }).inputs;
  return runBot(world, { ...library, bots: { ...library.bots, [world.bot.id]: weak } }).inputs;
}

/**
 * Stopa stavu jednoho běhu do konce hry nebo `ticks`. Hráč jen vyrobí vstupy; stav vzniká přehráním (`step`) bez
 * sledování efektů pravidel.
 */
export function traceRun(world: ArcadeWorld, driver: TraceDriver, ticks: number = P68_MAX_TICKS, library: ArcadeLibrary = ARCADE_LIBRARY): StateTrace {
  const inputs = inputsOf(world, driver, library);
  const program = loadProgram(world, library);
  const state = instantiate(world);
  const rig = rigOf(world, state);
  const frame = (input: ArcadeInput): TraceFrame => ({
    tick: state[HEADER.tick] as number,
    input,
    state: state.slice(),
    yawStep: rig < 0 ? null : slot(state, rig, RAILFPS_SLOTS.yawStep),
    outcome: outcomeOf(state),
  });
  const frames: TraceFrame[] = [frame(NO_INPUT)];
  const used: InputEvent[] = [];
  let next = 0;
  for (let tick = 0; tick < ticks && outcomeOf(state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    const input = event !== undefined && event.tick === tick ? event : NO_INPUT;
    if (input !== NO_INPUT) used.push(event as InputEvent);
    step(state, input, program);
    frames.push(frame(input));
  }
  releasePhysics(state);
  return { driver, world, frames, inputs: used, outcome: outcomeOf(state), endTick: state[HEADER.tick] as number, maxTicks: ticks };
}

// ---------------------------------------------------------------------------
// Kontroly

/**
 * Strojová podoba prózy `expect` (pole `check` v `assertions.json`). Jednotky: délky v jednotkách jádra (1 m = `UNIT`),
 * rychlosti v jednotkách za tik, časy v ticích.
 */
export type GameplayCheck =
  /** Běh skončí výsledkem `is` do `maxTicks`. */
  | { readonly kind: 'outcome'; readonly is: 'won' | 'lost' }
  /** Příď hráče (přední hrana těla) překročí cílovou čáru: přední hrana (nejmenší z) živých těl role `goal` v tiku 0, bez nich `world.length`. */
  | { readonly kind: 'crosses' }
  /** Hráč bez `FLAG.grounded` a aspoň `minClearance` nad nejvyšší pevnou plochou pod sebou, `minTicks` tiků v řadě. */
  | { readonly kind: 'airborne'; readonly minClearance: number; readonly minTicks: number }
  /**
   * Trosky = nehráčská tělesa s `FLAG.physics` (ne `goal`). Aspoň jedno se od svého klidového místa posune o `minMove`
   * nebo zmizí, a hráč byl v posledních 30 tikách nejvýš `near` od něj; živých trosek nikdy víc než `STUNT_DEBRIS_MAX`.
   */
  | { readonly kind: 'disturbs'; readonly minMove: number; readonly near: number }
  /**
   * Míček = nehráčské těleso s `FLAG.ball` (bez něj hráč) se středem v půdorysu těla role `goal` a se všemi složkami
   * rychlosti nejvýš `maxSpeed` po `restTicks` tiků v řadě (nebo až do konce hry).
   */
  | { readonly kind: 'restsIn'; readonly maxSpeed: number; readonly restTicks: number }
  /**
   * Odpal = vstup s `TAP`. Údery = součet poklesů čítače `counter`, limit = jeho hodnota v tiku 0; s `limit` součet
   * nárůstů a limit = čítač `limit.counter` v tiku 0 + `limit.plus`. Údery = odpaly ≤ limit.
   */
  | { readonly kind: 'strokes'; readonly counter: ArcadeCounter; readonly limit?: { readonly counter: ArcadeCounter; readonly plus: number } }
  /** `yawStep` na držáku nabude aspoň `min` různých hodnot. */
  | { readonly kind: 'distinctYaw'; readonly min: number }
  /**
   * Těleso role `target`, živé v tiku `FIRE`, zmizí do `within` tiků; krok terče = směr od hráče k terči v rovině x–z
   * (0 = +z, kladný krok k +x), `arcDeg` stupňů na `RAILFPS_YAW_STEPS` kroků; `yawStep` v tiku výstřelu od něj nejvýš `tolerance`.
   */
  | { readonly kind: 'hitOnFire'; readonly within: number; readonly arcDeg: number; readonly tolerance: number }
  /** Čítač `counter` (životy) někdy klesne pod hodnotu z tiku 0. */
  | { readonly kind: 'counterDrops'; readonly counter: ArcadeCounter }
  /**
   * Stavba = nehráčské tělo, které ožije do `within` tiků po vstupu s `TAP` a 30 tiků (nebo do konce) stojí na místě;
   * aspoň `min` staveb na různých buňkách (různé x, z).
   */
  | { readonly kind: 'builds'; readonly within: number; readonly min: number }
  /**
   * Některý z čítačů `counters` – nebo slot `slots` těla úrovně (zásoba, kterou hra drží mimo čítače, např. mince
   * obchodu na těle směny) – do `within` tiků po stavbě klesne pod hodnotu před ní.
   */
  | { readonly kind: 'spends'; readonly counters: readonly ArcadeCounter[]; readonly slots?: readonly BodySlot[]; readonly within: number }
  /** Čítač `counter` dosáhne cíle = první číselný parametr `goalParam` mezi pravidly světa. */
  | { readonly kind: 'reaches'; readonly counter: ArcadeCounter; readonly goalParam: string }
  /** Tah = souvislé tiky s `HOLD` a nenulovou osou; během tahu nebo `within` tiků po něm ožije pevné tělo (zeď). */
  | { readonly kind: 'strokeWalls'; readonly within: number }
  /** Chráněné tělo = hráč: živé v každém snímku, na konci HP (má-li ho) i čítač `health` (má-li ho) nad nulou. */
  | { readonly kind: 'survives' }
  /** Chráněné tělo = hráč: někdy zmizí, nebo mu HP či čítač `health` (měl-li ho) klesne na nulu. */
  | { readonly kind: 'protectedLost' };

export interface GameplayRequirement {
  readonly id: string;
  readonly run: TraceDriver;
  readonly expect: string;
  readonly check?: GameplayCheck;
}

export interface AssertionsDoc {
  readonly maxTicks: number;
  readonly every: readonly GameplayRequirement[];
  readonly games: Readonly<Record<string, readonly GameplayRequirement[]>>;
}

export interface AssertionResult {
  readonly id: string;
  readonly run: TraceDriver;
  readonly pass: boolean;
  readonly evidence: string;
}

type Verdict = Omit<AssertionResult, 'id' | 'run'>;

const verdict = (pass: boolean, evidence: string): Verdict => ({ pass, evidence });
const last = (trace: StateTrace): TraceFrame => trace.frames[trace.frames.length - 1] as TraceFrame;
const ended = (trace: StateTrace): string => `run ${trace.outcome} at tick ${String(trace.endTick)}`;

function outcomeCheck(trace: StateTrace, is: 'won' | 'lost'): Verdict {
  return verdict(trace.outcome === is && trace.endTick <= trace.maxTicks, `${trace.driver}: ${ended(trace)} (needs ${is} by tick ${String(trace.maxTicks)})`);
}

function finishLine(trace: StateTrace): number | null {
  const state = (trace.frames[0] as TraceFrame).state;
  let line = Number.POSITIVE_INFINITY;
  for (let body = 0; body < capacity(state); body += 1) {
    if (isAlive(state, body) && slot(state, body, BODY.role) === ROLE.goal) line = Math.min(line, slot(state, body, BODY.z) - slot(state, body, BODY.d) / 2);
  }
  if (Number.isFinite(line)) return line;
  return trace.world.length > 0 ? trace.world.length : null;
}

function crosses(trace: StateTrace): Verdict {
  const line = finishLine(trace);
  if (line === null) return verdict(false, 'no finish line: no goal body and world.length 0');
  let best = Number.NEGATIVE_INFINITY;
  for (const frame of trace.frames) {
    const player = frame.state[HEADER.player] as number;
    // T8: čáru překročí příď vozidla (přední hrana těla), jako v závodě – ne jeho střed.
    const z = slot(frame.state, player, BODY.z) + slot(frame.state, player, BODY.d) / 2;
    if (z >= line) return verdict(true, `player front z ${metres(z)} m >= finish ${metres(line)} m at tick ${String(frame.tick)}`);
    best = Math.max(best, z);
  }
  return verdict(false, `player front reached z ${metres(best)} m < finish ${metres(line)} m; ${ended(trace)}`);
}

/** Výška hráče nad nejvyšší pevnou plochou pod jeho půdorysem (vršek nejvýš 0,25 m nad chodidly), jinak nad zemí. */
function clearance(state: ArcadeState, player: number): number {
  const x = slot(state, player, BODY.x);
  const y = slot(state, player, BODY.y);
  const z = slot(state, player, BODY.z);
  const w = slot(state, player, BODY.w);
  const d = slot(state, player, BODY.d);
  let ground = 0;
  for (let body = 0; body < capacity(state); body += 1) {
    if (body === player || !isAlive(state, body) || (slot(state, body, BODY.flags) & FLAG.solid) === 0) continue;
    if (Math.abs(slot(state, body, BODY.x) - x) * 2 >= slot(state, body, BODY.w) + w) continue;
    if (Math.abs(slot(state, body, BODY.z) - z) * 2 >= slot(state, body, BODY.d) + d) continue;
    const top = slot(state, body, BODY.y) + slot(state, body, BODY.h);
    if (top <= y + UNIT / 4 && top > ground) ground = top;
  }
  return y - ground;
}

function airborne(trace: StateTrace, minClearance: number, minTicks: number): Verdict {
  let run = 0;
  let longest = 0;
  let from = -1;
  let peak = Number.NEGATIVE_INFINITY;
  for (const frame of trace.frames) {
    const player = frame.state[HEADER.player] as number;
    const height = clearance(frame.state, player);
    peak = Math.max(peak, height);
    const up = height >= minClearance && (slot(frame.state, player, BODY.flags) & FLAG.grounded) === 0;
    run = up ? run + 1 : 0;
    if (run > longest) {
      longest = run;
      from = frame.tick - run + 1;
    }
    if (longest >= minTicks) return verdict(true, `airborne >= ${metres(minClearance)} m for ${String(minTicks)} ticks from tick ${String(from)}`);
  }
  return verdict(false, `longest airborne run ${String(longest)} ticks (needs ${String(minTicks)}), peak clearance ${metres(peak)} m`);
}

const isDebris = (state: ArcadeState, body: number): boolean =>
  body !== (state[HEADER.player] as number) && (slot(state, body, BODY.flags) & FLAG.physics) !== 0 && slot(state, body, BODY.role) !== ROLE.goal;

/** Mezera dvou AABB (Čebyševova přes osy), 0 = dotek nebo průnik. */
function gap(state: ArcadeState, a: number, b: number): number {
  const along = (centre: number, size: number): number => Math.abs(slot(state, a, centre) - slot(state, b, centre)) - (slot(state, a, size) + slot(state, b, size)) / 2;
  const ay = slot(state, a, BODY.y);
  const by = slot(state, b, BODY.y);
  const vertical = Math.max(by - (ay + slot(state, a, BODY.h)), ay - (by + slot(state, b, BODY.h)));
  return Math.max(0, along(BODY.x, BODY.w), along(BODY.z, BODY.d), vertical);
}

const CRASH_WINDOW = 30;

function disturbs(trace: StateTrace, minMove: number, near: number): Verdict {
  const rest = new Map<number, readonly [number, number, number]>();
  const settled = new Set<number>();
  let crash: string | null = null;
  let moved = 0;
  for (let k = 0; k < trace.frames.length; k += 1) {
    const { state, tick } = trace.frames[k] as TraceFrame;
    let alive = 0;
    for (let body = 0; body < capacity(state); body += 1) {
      if (!isDebris(state, body)) continue;
      const living = isAlive(state, body);
      if (living) alive += 1;
      if (settled.has(body)) continue;
      const home = rest.get(body);
      if (home === undefined) {
        if (living) rest.set(body, [slot(state, body, BODY.x), slot(state, body, BODY.y), slot(state, body, BODY.z)]);
        continue;
      }
      const dx = slot(state, body, BODY.x) - home[0];
      const dy = slot(state, body, BODY.y) - home[1];
      const dz = slot(state, body, BODY.z) - home[2];
      if (living && dx * dx + dy * dy + dz * dz < minMove * minMove) continue;
      settled.add(body);
      moved += 1;
      if (crash !== null) continue;
      // Náraz: hráč byl u trosky v posledních `CRASH_WINDOW` tikách (mrtvé tělo má sloty čitelné).
      for (let j = Math.max(0, k - CRASH_WINDOW); j <= k; j += 1) {
        const seen = (trace.frames[j] as TraceFrame).state;
        if (gap(seen, seen[HEADER.player] as number, body) <= near) {
          crash = `debris body ${String(body)} ${living ? 'moved' : 'removed'} at tick ${String(tick)}, player within ${metres(near)} m`;
          break;
        }
      }
    }
    if (alive > STUNT_DEBRIS_MAX) return verdict(false, `${String(alive)} live debris bodies at tick ${String(tick)} > STUNT_DEBRIS_MAX ${String(STUNT_DEBRIS_MAX)}`);
  }
  if (crash !== null) return verdict(true, crash);
  return verdict(false, rest.size === 0 ? 'no debris bodies (FLAG.physics) in the run' : `${String(rest.size)} debris bodies, ${String(moved)} moved or removed, none near the player`);
}

function ballsOf(state: ArcadeState): number[] {
  const player = state[HEADER.player] as number;
  const balls: number[] = [];
  for (let body = 0; body < capacity(state); body += 1) {
    if (body !== player && (slot(state, body, BODY.flags) & (FLAG.physics | FLAG.ball)) === (FLAG.physics | FLAG.ball)) balls.push(body);
  }
  return balls.length > 0 ? balls : [player];
}

function insideGoal(state: ArcadeState, body: number): boolean {
  for (let goal = 0; goal < capacity(state); goal += 1) {
    if (goal === body || !isAlive(state, goal) || slot(state, goal, BODY.role) !== ROLE.goal) continue;
    if (Math.abs(slot(state, body, BODY.x) - slot(state, goal, BODY.x)) * 2 <= slot(state, goal, BODY.w) && Math.abs(slot(state, body, BODY.z) - slot(state, goal, BODY.z)) * 2 <= slot(state, goal, BODY.d)) return true;
  }
  return false;
}

/** Zrychlení volného pádu v jednotkách za tik² (9,81 m/s² při 60 tikách). */
const FALL_PER_TICK2 = (9.81 * UNIT) / 3600;

/**
 * Nejvyšší rychlost (jednotky za tik), při které míček do jamky spadne, místo aby ji přeskočil: za dobu pádu o vlastní
 * poloměr (`√(2r/g)`) neujede víc než průměr jamky (menší z šířky a hloubky těla `goal`). T8: hra, která výhrou skončí
 * v okamžiku pádu, míček na ploše „v klidu“ nikdy neukáže – v klidu leží až na dně jamky, kam stav nevidí.
 */
function dropSpeed(state: ArcadeState, ball: number): number {
  let cup = 0;
  for (let goal = 0; goal < capacity(state); goal += 1) {
    if (goal !== ball && isAlive(state, goal) && slot(state, goal, BODY.role) === ROLE.goal) cup = Math.max(cup, Math.min(slot(state, goal, BODY.w), slot(state, goal, BODY.d)));
  }
  const radius = Math.min(slot(state, ball, BODY.w), slot(state, ball, BODY.d)) / 2;
  return cup / Math.sqrt((2 * radius) / FALL_PER_TICK2);
}

function restsIn(trace: StateTrace, maxSpeed: number, restTicks: number): Verdict {
  const balls = ballsOf((trace.frames[0] as TraceFrame).state);
  let longest = 0;
  for (const ball of balls) {
    let run = 0;
    for (let k = 0; k < trace.frames.length; k += 1) {
      const { state, tick } = trace.frames[k] as TraceFrame;
      const speed = Math.hypot(slot(state, ball, BODY.vx), slot(state, ball, BODY.vy), slot(state, ball, BODY.vz));
      const still = [BODY.vx, BODY.vy, BODY.vz].every((v) => Math.abs(slot(state, ball, v)) <= maxSpeed);
      const inside = isAlive(state, ball) && insideGoal(state, ball);
      run = inside && still ? run + 1 : 0;
      longest = Math.max(longest, run);
      const final = k === trace.frames.length - 1 && trace.outcome !== 'running';
      if (run >= restTicks || (run > 0 && final)) return verdict(true, `ball body ${String(ball)} at rest in the hole zone for ${String(run)} ticks at tick ${String(tick)}`);
      // Výhra v tiku, kdy střed míčku je nad jamkou a jede dost pomalu, aby do ní spadl (`dropSpeed`).
      if (final && trace.outcome === 'won' && inside && speed <= dropSpeed(state, ball)) {
        return verdict(true, `ball body ${String(ball)} drops into the hole zone at tick ${String(tick)}: speed ${speed.toFixed(0)} <= drop speed ${dropSpeed(state, ball).toFixed(0)} per tick`);
      }
    }
  }
  return verdict(false, `ball never at rest in a goal zone nor dropping into one at the win (longest rest ${String(longest)} ticks, needs ${String(restTicks)}); ${ended(trace)}`);
}

/**
 * Údery: čítač `counter` klesá (zbývající rány, limit = hodnota v tiku 0), nebo s `limit` roste (rány od nuly, limit =
 * čítač `limit.counter` v tiku 0 + `limit.plus`, např. par + 3 u `minigolf`).
 */
function strokes(trace: StateTrace, name: ArcadeCounter, cap?: { readonly counter: ArcadeCounter; readonly plus: number }): Verdict {
  const shots = trace.inputs.filter((input) => (input.buttons & BUTTON.TAP) !== 0).length;
  const first = (trace.frames[0] as TraceFrame).state;
  const limit = cap === undefined ? counter(first, name) : counter(first, cap.counter) + cap.plus;
  let used = 0;
  for (let k = 1; k < trace.frames.length; k += 1) {
    const change = counter((trace.frames[k] as TraceFrame).state, name) - counter((trace.frames[k - 1] as TraceFrame).state, name);
    used += Math.max(0, cap === undefined ? -change : change);
  }
  const pass = limit > 0 && shots > 0 && used === shots && used <= limit;
  return verdict(pass, `strokes ${String(used)} (counter ${name} ${cap === undefined ? 'drops' : 'rises'}), shot inputs ${String(shots)}, course limit ${String(limit)}`);
}

function distinctYaw(trace: StateTrace, min: number): Verdict {
  if ((trace.frames[0] as TraceFrame).yawStep === null) return verdict(false, `no ${RAILFPS_KEEPER_ROLE} body (kind) holds yawStep`);
  const values = [...new Set(trace.frames.map((frame) => frame.yawStep as number))].sort((a, b) => a - b);
  return verdict(values.length >= min, `yawStep took ${String(values.length)} distinct values [${values.join(', ')}] (needs ${String(min)})`);
}

/** Krok, kterým hráč míří na tělo: směr v rovině x–z, 0 = +z, kladný k +x. */
function stepToward(state: ArcadeState, from: number, to: number, arcDeg: number): number {
  const angle = (Math.atan2(slot(state, to, BODY.x) - slot(state, from, BODY.x), slot(state, to, BODY.z) - slot(state, from, BODY.z)) * 180) / Math.PI;
  return Math.max(-RAILFPS_YAW_STEPS, Math.min(RAILFPS_YAW_STEPS, Math.round((angle * RAILFPS_YAW_STEPS) / arcDeg)));
}

function hitOnFire(trace: StateTrace, within: number, arcDeg: number, tolerance: number): Verdict {
  if ((trace.frames[0] as TraceFrame).yawStep === null) return verdict(false, `no ${RAILFPS_KEEPER_ROLE} body (kind) holds yawStep`);
  let fires = 0;
  let gone = 0;
  for (let k = 1; k < trace.frames.length; k += 1) {
    const frame = trace.frames[k] as TraceFrame;
    if ((frame.input.buttons & BUTTON.FIRE) === 0) continue;
    fires += 1;
    const aimed = trace.frames[k - 1] as TraceFrame;
    const player = aimed.state[HEADER.player] as number;
    for (let target = 0; target < capacity(aimed.state); target += 1) {
      if (!isAlive(aimed.state, target) || slot(aimed.state, target, BODY.role) !== ROLE.target) continue;
      const end = Math.min(trace.frames.length - 1, k - 1 + within);
      let at = -1;
      for (let j = k; j <= end && at < 0; j += 1) if (!isAlive((trace.frames[j] as TraceFrame).state, target)) at = j;
      if (at < 0) continue;
      gone += 1;
      // „Zmizí, zatímco natočení míří na terč“: natočení i poloha terče ze stavu těsně před zmizením – výstřel
      // se v `railfps` vyřeší až po dotočení k cíli, který FIRE nese v ose, ne v tiku vstupu.
      const shot = trace.frames[at - 1] as TraceFrame;
      const wanted = stepToward(shot.state, player, target, arcDeg);
      if (Math.abs((shot.yawStep as number) - wanted) <= tolerance) {
        return verdict(true, `FIRE at tick ${String(aimed.tick)}, yawStep ${String(shot.yawStep)} at tick ${String(shot.tick)}, target body ${String(target)} (step ${String(wanted)}) gone at tick ${String((trace.frames[at] as TraceFrame).tick)}`);
      }
    }
  }
  return verdict(false, `${String(fires)} FIRE inputs, ${String(gone)} targets gone within ${String(within)} ticks of one, none with a matching yawStep`);
}

function counterDrops(trace: StateTrace, name: ArcadeCounter): Verdict {
  const start = counter((trace.frames[0] as TraceFrame).state, name);
  if (start <= 0) return verdict(false, `counter ${name} starts at ${String(start)}: nothing to lose`);
  for (const frame of trace.frames) {
    const value = counter(frame.state, name);
    if (value < start) return verdict(true, `${name} ${String(start)} -> ${String(value)} at tick ${String(frame.tick)}`);
  }
  return verdict(false, `${name} stayed ${String(start)}; ${ended(trace)}`);
}

interface Build {
  readonly body: number;
  readonly frame: number;
  readonly x: number;
  readonly z: number;
}

const STAND_TICKS = 30;

/** Těla, která ožila do `within` tiků po `TAP` a pak stála na místě (stanice). */
function buildsOf(trace: StateTrace, within: number): Build[] {
  const builds: Build[] = [];
  let tapped = Number.NEGATIVE_INFINITY;
  for (let k = 1; k < trace.frames.length; k += 1) {
    const { state, input } = trace.frames[k] as TraceFrame;
    if ((input.buttons & BUTTON.TAP) !== 0) tapped = k;
    if (k - tapped > within) continue;
    const before = (trace.frames[k - 1] as TraceFrame).state;
    const player = state[HEADER.player] as number;
    for (let body = 0; body < capacity(state); body += 1) {
      if (body === player || !isAlive(state, body) || isAlive(before, body)) continue;
      const x = slot(state, body, BODY.x);
      const z = slot(state, body, BODY.z);
      let stands = true;
      for (let j = k + 1; j <= Math.min(trace.frames.length - 1, k + STAND_TICKS) && stands; j += 1) {
        const later = (trace.frames[j] as TraceFrame).state;
        stands = isAlive(later, body) && slot(later, body, BODY.x) === x && slot(later, body, BODY.z) === z;
      }
      if (stands) builds.push({ body, frame: k, x, z });
    }
  }
  return builds;
}

function builds(trace: StateTrace, within: number, min: number): Verdict {
  const cells = new Map<string, Build>();
  for (const build of buildsOf(trace, within)) if (!cells.has(`${String(build.x)},${String(build.z)}`)) cells.set(`${String(build.x)},${String(build.z)}`, build);
  const list = [...cells.values()].map((build) => `body ${String(build.body)} at (${metres(build.x)}, ${metres(build.z)}) m tick ${String((trace.frames[build.frame] as TraceFrame).tick)}`);
  return verdict(cells.size >= min, `${String(cells.size)} stations built on distinct cells (needs ${String(min)})${list.length > 0 ? `: ${list.slice(0, 4).join('; ')}` : ''}`);
}

function spends(trace: StateTrace, names: readonly ArcadeCounter[], slots: readonly BodySlot[], within: number): Verdict {
  const all = buildsOf(trace, within);
  if (all.length === 0) return verdict(false, 'no build in the run');
  const sources = [
    ...names.map((name) => ({ label: name, read: (state: ArcadeState) => counter(state, name) })),
    ...slots.map((at) => ({ label: `body ${String(at.body)}.${at.slot}`, read: (state: ArcadeState) => slot(state, at.body, BODY[at.slot]) })),
  ];
  for (const build of all) {
    const before = (trace.frames[build.frame - 1] as TraceFrame).state;
    for (let j = build.frame; j <= Math.min(trace.frames.length - 1, build.frame + within); j += 1) {
      const frame = trace.frames[j] as TraceFrame;
      const source = sources.find((candidate) => candidate.read(frame.state) < candidate.read(before));
      if (source !== undefined) return verdict(true, `${source.label} ${String(source.read(before))} -> ${String(source.read(frame.state))} at tick ${String(frame.tick)} after the build of body ${String(build.body)}`);
    }
  }
  return verdict(false, `${String(all.length)} builds, none followed by a drop of ${sources.map((source) => source.label).join('/')} within ${String(within)} ticks`);
}

function reaches(trace: StateTrace, name: ArcadeCounter, goalParam: string): Verdict {
  const goal = trace.world.rules.map((ref) => underlyingRule(ref).params[goalParam]).find((value): value is number => typeof value === 'number' && value > 0);
  if (goal === undefined) return verdict(false, `no rule of the world declares a numeric ${goalParam}`);
  let best = Number.NEGATIVE_INFINITY;
  for (const frame of trace.frames) {
    const value = counter(frame.state, name);
    if (value >= goal) return verdict(true, `${name} ${String(value)} >= ${goalParam} ${String(goal)} at tick ${String(frame.tick)}`);
    best = Math.max(best, value);
  }
  return verdict(false, `${name} peaked at ${String(best)} < ${goalParam} ${String(goal)}`);
}

function strokeWalls(trace: StateTrace, within: number): Verdict {
  const drawing = (input: ArcadeInput): boolean => (input.buttons & BUTTON.HOLD) !== 0 && input.axis !== 0;
  let strokes = 0;
  for (let k = 1; k < trace.frames.length; k += 1) {
    if (!drawing((trace.frames[k] as TraceFrame).input) || drawing((trace.frames[k - 1] as TraceFrame).input)) continue;
    strokes += 1;
    let end = k;
    while (end + 1 < trace.frames.length && drawing((trace.frames[end + 1] as TraceFrame).input)) end += 1;
    for (let j = k; j <= Math.min(trace.frames.length - 1, end + within); j += 1) {
      const { state, tick } = trace.frames[j] as TraceFrame;
      const before = (trace.frames[j - 1] as TraceFrame).state;
      for (let body = 0; body < capacity(state); body += 1) {
        if (isAlive(state, body) && !isAlive(before, body) && (slot(state, body, BODY.flags) & FLAG.solid) !== 0) {
          return verdict(true, `stroke from tick ${String((trace.frames[k] as TraceFrame).tick)} made solid body ${String(body)} at tick ${String(tick)}`);
        }
        // P68 T12: zeď může být i předem vyhrazené tělo role překážky, kterému tah zapíše tvar (`drawsave` – úsečka
        // v mrtvém slotu, srážky počítá hra sama): stav těla se během tahu změní, aniž by se tělo samo hýbalo.
        if (slot(state, body, BODY.role) === ROLE.obstacle && WALL_SHAPE.some((at) => slot(state, body, at) !== slot(before, body, at))) {
          return verdict(true, `stroke from tick ${String((trace.frames[k] as TraceFrame).tick)} drew wall body ${String(body)} at tick ${String(tick)}`);
        }
      }
    }
  }
  return verdict(false, strokes === 0 ? 'no stroke (HOLD with a cell axis) in the run' : `${String(strokes)} strokes, no solid body appeared during one or within ${String(within)} ticks`);
}

function protectedState(trace: StateTrace, frame: TraceFrame): { readonly alive: boolean; readonly hp: number | null; readonly health: number | null } {
  const first = (trace.frames[0] as TraceFrame).state;
  const player = frame.state[HEADER.player] as number;
  return {
    alive: isAlive(frame.state, player),
    hp: bodyHp(first, player) > 0 ? bodyHp(frame.state, player) : null,
    health: counter(first, 'health') > 0 ? counter(frame.state, 'health') : null,
  };
}

function survives(trace: StateTrace): Verdict {
  const dead = trace.frames.find((frame) => !protectedState(trace, frame).alive);
  if (dead !== undefined) return verdict(false, `protected body (player) gone at tick ${String(dead.tick)}`);
  const end = protectedState(trace, last(trace));
  const pass = (end.hp === null || end.hp > 0) && (end.health === null || end.health > 0);
  return verdict(pass, `protected body (player) alive at tick ${String(trace.endTick)}, hp ${String(end.hp ?? '-')}, health ${String(end.health ?? '-')}; ${ended(trace)}`);
}

function protectedLost(trace: StateTrace): Verdict {
  for (const frame of trace.frames) {
    const now = protectedState(trace, frame);
    if (!now.alive || now.hp === 0 || now.health === 0) {
      return verdict(true, `protected body (player) ${!now.alive ? 'gone' : now.hp === 0 ? 'at 0 hp' : 'at 0 health'} at tick ${String(frame.tick)}`);
    }
  }
  // P68 T12: hra, ve které jeden zásah prohrává a postava zůstane stát (`drawsave`): prohra, při které se postavy
  // dotýká živý nepřítel (obdélníky z pozic a rozměrů, `y` = spodní hrana).
  const last = trace.frames.at(-1) as TraceFrame;
  if (trace.outcome === 'lost') {
    const hit = touchingEnemy(last.state);
    if (hit !== null) return verdict(true, `protected body (player) hit by enemy body ${String(hit)} when the run was lost at tick ${String(last.tick)}`);
  }
  return verdict(false, `protected body (player) intact; ${ended(trace)}`);
}

/** Živé tělo role nepřítele, jehož obdélník se dotýká obdélníku hráče; `null` = žádné. */
function touchingEnemy(state: ArcadeState): number | null {
  const player = state[HEADER.player] as number;
  const box = (body: number): readonly [number, number, number, number] => {
    const x = slot(state, body, BODY.x);
    const y = slot(state, body, BODY.y);
    const halfW = slot(state, body, BODY.w) / 2;
    return [x - halfW, x + halfW, y, y + slot(state, body, BODY.h)];
  };
  const [left, right, bottom, top] = box(player);
  for (let body = 0; body < capacity(state); body += 1) {
    if (body === player || !isAlive(state, body) || slot(state, body, BODY.role) !== ROLE.enemy) continue;
    const [l, r, b, t] = box(body);
    if (l <= right && r >= left && b <= top && t >= bottom) return body;
  }
  return null;
}

export function evaluateCheck(check: GameplayCheck, trace: StateTrace): Verdict {
  switch (check.kind) {
    case 'outcome':
      return outcomeCheck(trace, check.is);
    case 'crosses':
      return crosses(trace);
    case 'airborne':
      return airborne(trace, check.minClearance, check.minTicks);
    case 'disturbs':
      return disturbs(trace, check.minMove, check.near);
    case 'restsIn':
      return restsIn(trace, check.maxSpeed, check.restTicks);
    case 'strokes':
      return strokes(trace, check.counter, check.limit);
    case 'distinctYaw':
      return distinctYaw(trace, check.min);
    case 'hitOnFire':
      return hitOnFire(trace, check.within, check.arcDeg, check.tolerance);
    case 'counterDrops':
      return counterDrops(trace, check.counter);
    case 'builds':
      return builds(trace, check.within, check.min);
    case 'spends':
      return spends(trace, check.counters, check.slots ?? [], check.within);
    case 'reaches':
      return reaches(trace, check.counter, check.goalParam);
    case 'strokeWalls':
      return strokeWalls(trace, check.within);
    case 'survives':
      return survives(trace);
    case 'protectedLost':
      return protectedLost(trace);
  }
}

export const P68_ASSERTIONS = assertionsJson as unknown as AssertionsDoc;

/**
 * Vyhodnotí požadavky hry `id` (`every` + `games[id]`) nad stopami; každý hráč (`run`) jede jednou. Požadavek bez
 * `check` neprojde – próza sama stroj nic nedokáže. Hra bez vlastního seznamu (starý žánr) jede jen `every`.
 */
export function assertGame(id: string, world: ArcadeWorld, library: ArcadeLibrary = ARCADE_LIBRARY, doc: AssertionsDoc = P68_ASSERTIONS): AssertionResult[] {
  const requirements = [...doc.every, ...(doc.games[id] ?? [])];
  const results = new Map<string, AssertionResult>();
  for (const driver of TRACE_DRIVERS) {
    const mine = requirements.filter((requirement) => requirement.run === driver);
    if (mine.length === 0) continue;
    // Jedna stopa naráz: stav celého světa po každém tiku je desítky MB.
    const trace = traceRun(world, driver, doc.maxTicks, library);
    for (const requirement of mine) {
      const result = requirement.check === undefined ? verdict(false, 'no machine check for this requirement') : evaluateCheck(requirement.check, trace);
      results.set(requirement.id, { id: requirement.id, run: driver, ...result });
    }
  }
  return requirements.map((requirement) => results.get(requirement.id) as AssertionResult);
}
