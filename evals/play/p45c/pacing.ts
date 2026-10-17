/**
 * Měřidlo průběhu hry (P45C T1): stoupá tlak hrozeb od začátku ke konci běhu,
 * má hra finále a kolik různých chování nepřátel nese? Čte jen stav jádra a
 * kusy světa – telemetrii P45A ne, ta definuje vlastní „mrtvý čas“ a „finále“
 * a T17 obě definice porovná.
 *
 * - **tlak tiku** = součet rychlostí (m/s) živých těl rolí `chaser`, `enemy`,
 *   `hazard`. Role `projectile` ne: v jádře ji má jen výstřel hráče (`blaster`,
 *   `gun`, `launch`) a hod by četl jako stoupající tlak hráčovu vlastní
 *   aktivitu; výstřely nepřátel P45C jsou `hazard`. Rychlost = posun těla mezi dvěma tiky, takže ji
 *   změří i ovládání, které tělo posouvá přímo. Tělo, které v předchozím tiku
 *   nežilo (předloha, právě oživené), se nepočítá; posun nad `TELEPORT` za tik
 *   je přesun (nová vlna na vstupu), ne pohyb, a počítá se jako 0;
 * - **třetiny** = tři stejné úseky **měřeného běhu** (tik 1 až konec), ne
 *   horizontu 90 s – krátká hra má třetiny krátké;
 * - **stoupá** = průměrný tlak poslední třetiny je aspoň o `RISE_MIN` vyšší než
 *   první (a nenulový).
 */

import { ARCADE_LIMITS, BODY, FLAG, HEADER, type ArcadeState, type ArcadeWorld, type InputEvent, NO_INPUT, type PieceRef, ROLE, UNIT, ARCADE_HZ, bodyBase, underlyingRule } from '@/play/arcade/contract';
import { type ArcadeLibrary, type ArcadeOutcome, hashArcade, instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { releasePhysics } from '@/play/arcade/physics/step';

export const RISE_MIN = 0.15;
/** Posun za tik nad 500 jednotek (30 m/s) neujede žádná hrozba jádra – je to přesun, ne pohyb. */
export const TELEPORT = 500;

const THREAT_ROLES: ReadonlySet<number> = new Set([ROLE.chaser, ROLE.enemy, ROLE.hazard]);

export type Thirds = readonly [number, number, number];

export interface PressureRun {
  /** Průměrný tlak (m/s) po třetinách běhu. */
  readonly threatsPerThird: Thirds;
  /** Průměrný počet živých hrozeb po třetinách běhu. */
  readonly countPerThird: Thirds;
  readonly outcome: ArcadeOutcome;
  readonly tick: number;
  readonly hash: string;
}

const alive = (state: ArcadeState, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Tlak a počet hrozeb jednoho tiku: `prev` je stav před tikem, `next` po něm. */
function tickPressure(prev: ArcadeState, next: ArcadeState): readonly [pressure: number, count: number] {
  const bodies = next[HEADER.bodyCount] as number;
  let pressure = 0;
  let count = 0;
  for (let body = 0; body < bodies; body += 1) {
    const base = bodyBase(body);
    if (!THREAT_ROLES.has(next[base + BODY.role] as number) || !alive(next, body)) continue;
    count += 1;
    if (!alive(prev, body)) continue;
    const moved = Math.hypot((next[base + BODY.x] as number) - (prev[base + BODY.x] as number), (next[base + BODY.y] as number) - (prev[base + BODY.y] as number), (next[base + BODY.z] as number) - (prev[base + BODY.z] as number));
    if (moved <= TELEPORT) pressure += (moved * ARCADE_HZ) / UNIT;
  }
  return [pressure, count];
}

const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);

function thirdsOf(samples: readonly number[]): Thirds {
  const cut = (k: number): number => Math.round((samples.length * k) / 3);
  return [mean(samples.slice(0, cut(1))), mean(samples.slice(cut(1), cut(2))), mean(samples.slice(cut(2)))];
}

export const risingOf = (thirds: Thirds): boolean => thirds[2] > 0 && thirds[2] >= thirds[0] * (1 + RISE_MIN);

/** Přehraje záznam a cestou měří tlak; hash na konci = hash přehrání. */
export function pressureRun(world: ArcadeWorld, inputs: readonly InputEvent[], library: ArcadeLibrary = ARCADE_LIBRARY, horizon: number = ARCADE_LIMITS.maxTicks): PressureRun {
  const program = loadProgram(world, library);
  const state = instantiate(world);
  const prev = state.slice();
  const pressure: number[] = [];
  const count: number[] = [];
  let next = 0;
  for (let tick = 0; tick < horizon && outcomeOf(state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    prev.set(state);
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
    const [p, c] = tickPressure(prev, state);
    pressure.push(p);
    count.push(c);
  }
  releasePhysics(state);
  return { threatsPerThird: thirdsOf(pressure), countPerThird: thirdsOf(count), outcome: outcomeOf(state), tick: state[HEADER.tick] as number, hash: hashArcade(state) };
}

/** Řetěz ovládání světa od obalu k základu (`addon_control` → `runner`, `pacing_control` → …). */
function controlChain(ref: PieceRef): readonly PieceRef[] {
  const base = (ref.params as { base?: unknown }).base;
  return typeof base === 'object' && base !== null && 'id' in base ? [ref, ...controlChain(base as PieceRef)] : [ref];
}

/**
 * Chování nepřátel, která svět nese, seřazená podle jména. Šest dnešních se
 * pozná z kusů světa a počátečních těl:
 * - `wander-flee` – buňky arény bloudí, větší honí, menší utíkají (`move_free`, živé kinematické `enemy`);
 * - `pursue` – pronásledovatel v rovině (`move_free` s `chase`, hlídka; `walker` s `chaseSpeed`);
 * - `pursue-track` – doplněk pronásledovatele na trati (`addon_control` s `chase`);
 * - `fight` – stavový automat souboje s telegrafem (ovládání `fight`);
 * - `guard` – stráž plížení s kuželem (`walker_caught`);
 * - `pendulum` – kinematická hrozba tam a zpět (`period`), mimo stráž.
 * Nová chování P45C (T4–T9) nese obal `pacing_control` v `behaviours`, bosse pravidlo `boss_beat`.
 */
export function behavioursOf(world: ArcadeWorld): string[] {
  const chain = controlChain(world.control);
  const ids = new Set(chain.map((ref) => ref.id));
  const params = (id: string): Readonly<Record<string, unknown>> | undefined => chain.find((ref) => ref.id === id)?.params;
  const rules = new Set(world.rules.map((ref) => underlyingRule(ref).id));
  const state = Int32Array.from(world.initial);
  const bodies = state[HEADER.bodyCount] as number;
  let liveEnemy = false;
  let pendulum = false;
  for (let body = 1; body < bodies; body += 1) {
    const base = bodyBase(body);
    const flags = state[base + BODY.flags] as number;
    const role = state[base + BODY.role] as number;
    if ((flags & FLAG.alive) === 0 || !THREAT_ROLES.has(role)) continue;
    if ((flags & FLAG.kinematic) !== 0 && role === ROLE.enemy) liveEnemy = true;
    if ((flags & FLAG.kinematic) !== 0 && (state[base + BODY.aux1] as number) > 0) pendulum = true;
  }
  const found = new Set<string>();
  if (ids.has('move_free') && liveEnemy) found.add('wander-flee');
  if (params('move_free')?.chase !== undefined || ((params('walker')?.chaseSpeed as number | undefined) ?? 0) > 0) found.add('pursue');
  if (params('addon_control')?.chase !== undefined) found.add('pursue-track');
  if (ids.has('fight')) found.add('fight');
  if (rules.has('walker_caught')) found.add('guard');
  else if (pendulum) found.add('pendulum');
  const paced = params('pacing_control')?.behaviours;
  if (Array.isArray(paced)) for (const item of paced) found.add(typeof item === 'string' ? item : String((item as { id?: unknown }).id));
  if (rules.has('boss_beat')) found.add('boss');
  return [...found].sort();
}

/** Svět nese finále: bosse (`boss_beat`), nebo pravidlo `pacing` s finále. */
export function finaleOf(world: ArcadeWorld): boolean {
  return world.rules.map(underlyingRule).some((ref) => ref.id === 'boss_beat' || (ref.id === 'pacing' && ref.params.finale !== undefined && ref.params.finale !== 'none'));
}

/** Kvantil seřazením (vzor `evals/play/p37a`). */
export function quantile(values: readonly number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] as number;
}
