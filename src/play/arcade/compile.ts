/**
 * Arkádová cesta kompilátoru (P25A, T5; P25C, T5): `GameSpec` s `control`
 * `runner` / `platform` / `flap` / `shooter` / `throw` + seed → `ArcadeWorld` a `CompiledGame`.
 *
 * Ze specu se čte ovládání a jeho parametry a dvě koření z registru mechanik:
 * `health` (náraz ubere život místo prohry) a `timer` s `onEnd: 'lose'`
 * (časový limit). Ostatní mechaniky a role popisují příběh pro obálku, trať
 * je z generátoru. Hru, kterou robot nevyhraje, kompilátor vrátí jako
 * `UNWINNABLE` – dveře publikace pak zkusí další semínko.
 */

import { canonicalHash } from '@/ir/worlddoc';
import { type CompileGameResult, GAME_COMPILER_VERSION } from '@/play/contracts';
import { type GameSpecV1, arenaWinOf } from '@/play/spec';

import { type ArcadeParts, addonControlParams, addonLives, applyAddons } from './addons';
import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  ARCADE_RUNTIME_VERSION,
  type ArcadeLevel,
  type ArcadeWorld,
  type BodyInit,
  COUNTED_ROLES,
  COUNTER,
  HEADER,
  HIT_GRACE,
  type InputEvent,
  type ModeGeneratorPiece,
  NO_INPUT,
  type PieceRef,
  rampMarks,
} from './contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, replay, step, worldHasPhysics } from './kernel';
import { releasePhysics } from './physics/step';
import { ARCADE_LIBRARY, MODE_GENERATORS } from './library';
import { glideCourse } from './pieces/glide';
import { walkerLabyrinth } from './pieces/walker';
import { ballPitch } from './pieces/ball';
import { rapierIfLoaded } from './physics/world';
import { arenaBotRef, arenaControlRef, arenaLevel, arenaRules } from './pieces/arena';
import { flapRules, flapTrack } from './pieces/flap';
import { platformControlRef, platformLevel, platformRules, platformSeconds } from './pieces/platform';
import { runnerTrack } from './pieces/runner';
import { duelParts } from './pieces/duel';
import { rhythmParts } from './pieces/rhythm';
import { shooterBotRef, shooterRange, shooterRules } from './pieces/shooter';
import { steerBotRef, steerControlRef, steerRules, steerTrack } from './pieces/steer';
import { throwBudgetIn, throwField, throwParts } from './pieces/throw';
import { timingParts } from './pieces/timing';
import { compileRules, rulesOwnGoal, yardParts } from './rules/compile';
import { runBot } from './verify';
import { bindRoles, type RoleBinding } from './witness';

/** Verze kompilátoru arkádové hry: mřížkový kompilátor + verze jádra. */
export const ARCADE_COMPILER_VERSION = `${GAME_COMPILER_VERSION}/${ARCADE_RUNTIME_VERSION}`;

export type ArcadeWorldResult = { readonly ok: true; readonly world: ArcadeWorld; readonly roleBindings: readonly RoleBinding[] } | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Počet role jako parametr generátoru (P26D T9). Schéma dává `count` výchozí 1,
 * takže 1 od „neřečeno“ nejde rozlišit – čte se až počet od 2.
 */
function countOf(spec: GameSpecV1, roleId: string): number | undefined {
  const count = spec.roles.find((role) => role.id === roleId)?.count ?? 1;
  return count >= 2 ? count : undefined;
}

/** Počty rolí, které generátor ovládání čte (klíče jeho parametrů); `capabilities.ts` `counts` to tvrdí. */
function countParams(spec: GameSpecV1): Record<string, number> {
  // Víc, než generátor unese, se ořízne (`within_limits`).
  const out: Record<string, number> = {};
  for (const { roleId, key, max } of COUNTED_ROLES[spec.control ?? ''] ?? []) {
    const count = countOf(spec, roleId);
    if (count !== undefined) out[key] = Math.min(count, max);
  }
  return out;
}

/** Hodiny, které jádro opravdu hlídá: časovač specu oříznutý na 10 s až horizont ověření. */
const limitSeconds = (seconds: number): number => Math.min(ARCADE_LIMITS.maxTicks / 60, Math.max(10, seconds));

/** Ovládání, trať a pravidla, která se liší podle `control`. */
function partsOf(spec: GameSpecV1, seed: number, health: number | undefined): ArcadeParts {
  const counts = countParams(spec);
  if (spec.control === 'ball') return ballPitch.parts(seed, ballPitch.params.parse(ownParams(spec) ?? {}), health);
  if (spec.control === 'walker') return walkerLabyrinth.parts(seed, walkerLabyrinth.params.parse(ownParams(spec) ?? {}), health);
  if (spec.control === 'glide') return glideCourse.parts(seed, glideCourse.params.parse(ownParams(spec) ?? {}), health);
  if (spec.control === 'timing') return timingParts(seed, { ...spec.controlParams }, health);
  if (spec.control === 'rhythm') return rhythmParts(seed, { ...spec.controlParams }, health);
  if (spec.control === 'duel') return duelParts(seed, { ...spec.controlParams }, health);
  if (spec.control === 'platform') {
    const params = platformLevel.params.parse({ ...spec.controlParams, ...counts });
    const level = platformLevel.generate(seed, params);
    return {
      // `feel: 2` z `tuning` žánru Skákačka dojde až k ovládání (P36A T6); úroveň bez něj má dál dnešní ovládání.
      control: platformControlRef(params),
      bot: { id: 'platform_bot', params: {} },
      level,
      // Úroveň z úseků má hodiny: nečinný hráč na startu prohraje (P36A T4).
      rules: platformRules(params, health, params.sections === undefined ? undefined : platformSeconds(level, params.difficulty)),
    };
  }
  if (spec.control === 'steer') {
    const params = steerTrack.params.parse({ ...spec.controlParams });
    const level = steerTrack.generate(seed, params);
    // Závod životy nebere (P26 T5): bez `health: undefined` by svět nesl počet, který nic neubere.
    return { control: steerControlRef(level, params), bot: steerBotRef(level, params), level, rules: steerRules(level, params), health: params.crashBudget };
  }
  if (spec.control === 'move_free') {
    // `readGameSpec` už odmítl spec, kde by cíl a časovač nesouhlasily.
    const win = arenaWinOf(spec);
    const params = arenaLevel.params.parse({ ...spec.controlParams, ...('goal' in win ? win : {}) });
    const level = arenaLevel.generate(seed, params);
    return { control: arenaControlRef(), bot: arenaBotRef(), level, rules: arenaRules(level, params, health) };
  }
  if (spec.control === 'flap') {
    const params = flapTrack.params.parse({ ...spec.controlParams, ...counts });
    const level = flapTrack.generate(seed, params);
    const ramp = rampMarks(level.length);
    // Odpuštění pozdního vzletu (P37A T7) jen s `feel` ze specu – uložený spec bez něj staví tentýž svět.
    const feel = params.feel === undefined ? {} : { feel: params.feel };
    return { control: { id: 'flap', params: { ramp, ...feel } }, bot: { id: 'flap_bot', params: { ramp } }, level, rules: flapRules(health, params.rise === true, params.feel === 2, params.collectAll === true) };
  }
  if (spec.control === 'shooter') {
    const params = shooterRange.params.parse({ ...spec.controlParams, ...counts });
    return { control: { id: 'shooter', params: {} }, bot: shooterBotRef(params), level: shooterRange.generate(seed, params), rules: shooterRules(params, health) };
  }
  if (spec.control === 'throw') {
    // Hod nemá čím ubrat život: `health` se nečte, prohra je „hody došly“.
    const params = throwField.params.parse({ ...spec.controlParams });
    // Rozpočet kol a hodiny jsou dvě pole specu: remix, který zkrátí jen hodiny, by nechal kola na delší hru (review P36A F5).
    const clock = spec.mechanics.find((mechanic) => mechanic.id === 'timer')?.params as { readonly seconds: number; readonly onEnd: string } | undefined;
    // The opt-in pace ratio keeps the authored work budget, but the actual timer
    // and HUD use the shorter deadline. Without it the legacy remix clamp is unchanged.
    const fitted = params.budget === undefined || clock?.onEnd !== 'lose' ? params : { ...params, budget: Math.min(params.budget, throwBudgetIn(limitSeconds(params.paceBudgetPct === undefined ? clock.seconds : Math.ceil(clock.seconds * 100 / params.paceBudgetPct)))) };
    return { control: { id: 'throw', params: {} }, bot: { id: 'throw_bot', params: {} }, ...throwParts(seed, fitted), health: undefined };
  }
  const params = runnerTrack.params.parse({ ...spec.controlParams, ...counts });
  // Se životy náraz ubere život, překážka zmizí, běh jede dál a vteřinu milosti další náraz nic nebere (P36A T2).
  const rules: PieceRef[] = [
    { id: 'hit', params: health === undefined ? { role: 'obstacle', effect: 'lose' } : { role: 'obstacle', effect: 'damage', grace: HIT_GRACE } },
    { id: 'pickup', params: {} },
    { id: 'finish', params: {} },
  ];
  if (health !== undefined) rules.push({ id: 'out_of_health', params: {} });
  const level = runnerTrack.generate(seed, params);
  // Odpuštění skoku (P36A T6) jen s `feel` ze specu – uložený spec bez něj staví tentýž svět.
  // Trať z úseků (P36A T4) zrychlí na začátku každého úseku, jinak na třetinách tratě.
  const ramp = level.sectionStarts ?? rampMarks(level.length);
  const control: PieceRef = { id: 'runner', params: { speed: params.speed, ramp, ...(params.feel === undefined ? {} : { feel: params.feel }) } };
  return { control, bot: { id: 'runner_bot', params: {} }, level, rules };
}

/** Generátor, který ovládání staví bez `controlParams.generator`. */
const CONTROL_GENERATORS: Readonly<Record<string, string>> = {
  glide: 'glide_course',
  walker: 'walker_labyrinth',
  ball: 'ball_pitch',
  runner: 'runner_track',
  platform: 'platform_level',
  flap: 'flap_track',
  steer: 'steer_track',
  move_free: 'arena',
  shooter: 'shooter_range',
  throw: 'throw_field',
  timing: 'timing_level',
  rhythm: 'rhythm_level',
  duel: 'duel_arena',
};

/** Generátor, který svět postaví: `controlParams.generator` (P32-0 T4), jinak ten, který ovládání bere dnes. */
export function generatorOf(spec: GameSpecV1): string {
  const chosen = (spec.controlParams as { readonly generator?: string } | undefined)?.generator;
  if (chosen !== undefined) return chosen;
  // Neznámé ovládání staví běžce – poslední větev `partsOf`.
  return rulesOwnGoal(spec) ? 'yard' : (CONTROL_GENERATORS[spec.control ?? ''] ?? 'runner_track');
}

/**
 * Parametry ovládání bez polí delegace: `tuning` se rozbalí mezi ostatní, takže
 * ho validuje schéma vybraného generátoru, a `generator` zmizí.
 */
function ownParams(spec: GameSpecV1): Record<string, unknown> | undefined {
  if (spec.controlParams === undefined) return undefined;
  const { generator: _generator, tuning, ...own } = spec.controlParams as Record<string, unknown> & { readonly generator?: string; readonly tuning?: Record<string, unknown> };
  return { ...own, ...tuning };
}

/** Spec + seed → svět. Bez ověření robotem – to dělá `compileArcade`. `target` přebije cílové skóre specu (ořez na dosažitelné). */
export function arcadeWorldOf(spec: GameSpecV1, seed: number, target?: number): ArcadeWorldResult {
  const health = (spec.mechanics.find((mechanic) => mechanic.id === 'health')?.params as { readonly max: number } | undefined)?.max ?? addonLives(spec);
  const timer = spec.mechanics.find((mechanic) => mechanic.id === 'timer')?.params as { readonly seconds: number; readonly onEnd: string } | undefined;
  const generator = generatorOf(spec);
  // Jen vlastní klíče: `generator: "constructor"` by jinak našel `Object` z prototypu (revize fáze P32-0).
  const mode: ModeGeneratorPiece | undefined = Object.hasOwn(MODE_GENERATORS, generator) ? MODE_GENERATORS[generator] : undefined;
  const delegation = (spec.controlParams ?? {}) as { readonly generator?: string; readonly tuning?: unknown };
  if (delegation.generator !== undefined && mode === undefined && generator !== CONTROL_GENERATORS[spec.control ?? '']) {
    return { ok: false, issues: [`/controlParams/generator: no generator ${generator} for the ${spec.control} control`] };
  }
  // `tuning` validuje schéma vybraného generátoru, ne `spec.ts` – tady, ať neplatná hodnota nespadne až v `parse` generátoru.
  const params = mode !== undefined || delegation.tuning !== undefined ? (mode ?? ARCADE_LIBRARY.generators[generator])?.params.safeParse(ownParams(spec) ?? {}) : undefined;
  if (params !== undefined && !params.success) {
    return { ok: false, issues: params.error.issues.map((issue) => `/controlParams/${issue.path.join('/')}: ${issue.message} (generator ${generator})`) };
  }
  // Doplňky (P26D) dostanou hotové části základního ovládání.
  const plain = { ...spec, controlParams: ownParams(spec) } as GameSpecV1;
  const base = { ...plain, controlParams: addonControlParams(plain) } as GameSpecV1;
  // Pravidla, která sama vyhrávají, hrají na dvorku místo arény (P29A, `rules/compile.ts`).
  const own = mode !== undefined ? mode.parts(seed, params?.data, health) : rulesOwnGoal(spec) ? yardParts(health) : partsOf(base, seed, health);
  // Pahýl módu vrací prázdnou úroveň s issue; doplňky by z ní četly tělo hráče (revize T4 kolo 2).
  if (own.issues !== undefined && own.issues.length > 0) return { ok: false, issues: own.issues };
  const lives = 'health' in own ? own.health : health;
  const { control, bot, level: baseLevel, rules, issues } = applyAddons(own, { spec, seed, health: lives });
  if (issues !== undefined && issues.length > 0) return { ok: false, issues };
  // Pravidla ze specu za pravidly dílků; bez nich se úroveň ani seznam nemění.
  const ruled = compileRules(spec, baseLevel, seed);
  if (ruled.issues.length > 0) return { ok: false, issues: ruled.issues };
  const level = ruled.level;
  const builtIn = rules.length + (timer?.onEnd === 'lose' ? 1 : 0);
  // Strop jádra platí na všechna pravidla dohromady; režisér musí vědět, kolik mu jich zbylo.
  if (builtIn + ruled.rules.length > ARCADE_LIMITS.maxRules) {
    return { ok: false, issues: [`rules: this ${spec.control} game already uses ${builtIn} built-in rules, so the spec may add at most ${ARCADE_LIMITS.maxRules - builtIn} (it has ${ruled.rules.length}) – merge or drop rules`] };
  }
  rules.push(...ruled.rules);
  if (timer?.onEnd === 'lose') rules.push({ id: 'time_limit', params: { seconds: limitSeconds(timer.seconds) } });
  const scored = spec.scoring === undefined ? { level, rules } : withScoring(level, rules, lives ?? 0, target ?? spec.scoring.target ?? 0);
  if (scored.rules.length > ARCADE_LIMITS.maxRules) {
    return { ok: false, issues: [`rules: this ${spec.control} game with scoring uses ${scored.rules.length} rules, over the ${ARCADE_LIMITS.maxRules} limit – merge or drop rules`] };
  }

  const built = buildWorld({ seed, control, rules: scored.rules, bot, level: scored.level, ...(lives === undefined ? {} : { health: lives }) }, ARCADE_LIBRARY);
  return built.ok ? { ok: true, world: built.world, roleBindings: bindRoles(spec, built.world) } : built;
}

/**
 * Skóre, které rozhoduje (P36A T5), pro spec s `scoring`: za tělesa úrovně
 * počítadlo komba (mrtvá předloha s modelem hráče – nic ho nekreslí ani
 * nesrazí; `spawn` mrtvé sloty bere až od `spawnBase`, tedy za ním), sbírání
 * `pickup` s kombem a pravidlo `score_bonus` s bonusem na konci a cílovým
 * skóre. Limit bonusu za čas = časový limit hry, jinak horizont jádra.
 * Aréna sbírá přes `arena_eat` a skóre v ní je velikost hrdiny a postup
 * k cíli (`grow_to`) – kombo by cíl zkrátilo, takže tam jen bonus na konci.
 */
function withScoring(level: ArcadeLevel, rules: readonly PieceRef[], lives: number, target: number): { readonly level: ArcadeLevel; readonly rules: PieceRef[] } {
  const keeper = level.bodies.length;
  const hero = level.bodies[0] as BodyInit;
  const counter: BodyInit = { role: 'thing', kind: hero.kind, x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true };
  const clock = rules.find((ref) => ref.id === 'time_limit' || ref.id === 'survive_time')?.params as { readonly seconds: number } | undefined;
  const limit = clock === undefined ? ARCADE_LIMITS.maxTicks : Math.min(ARCADE_LIMITS.maxTicks, clock.seconds * ARCADE_HZ);
  return {
    level: { ...level, bodies: [...level.bodies, counter] },
    rules: [
      ...rules.map((ref) => (ref.id === 'pickup' || ref.id === 'shot_hit' ? { id: ref.id, params: { ...ref.params, combo: keeper } } : ref)),
      { id: 'score_bonus', params: { lives, limit, target } },
    ],
  };
}

/** Skóre na konci přehrání záznamu `inputs` (táž smyčka jako `replay` v jádře). */
export function finalScore(world: ArcadeWorld, inputs: readonly InputEvent[]): number {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  let next = 0;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
  }
  releasePhysics(state);
  return state[HEADER.counters + COUNTER.score] as number;
}

/**
 * Cílové skóre, které robot opravdu dosáhne (P36A T5): svět bez cíle, výhra
 * robota a její skóre. Cíl nad ním se ořízne dolů na desítky, ať hra z věty
 * „score 500 points“ jde vyhrát; `null` = cíl beze změny (nebo robot nevyhrál
 * ani bez něj – to ohlásí `compileArcade` sám).
 */
function reachableTarget(spec: GameSpecV1, seed: number, target: number): number | null {
  const free = arcadeWorldOf(spec, seed, 0);
  if (!free.ok) return null;
  const run = runBot(free.world);
  if (run.outcome !== 'won') return null;
  const reached = finalScore(free.world, run.inputs);
  return reached >= target ? null : Math.max(10, Math.floor(reached / 10) * 10);
}

/** Chce spec fyzikální tělesa (P29A T13)? Jen pak se smí stahovat Rapier. */
export const specNeedsPhysics = (spec: GameSpecV1): boolean => spec.control === 'ball' || (spec.things ?? []).some((thing) => thing.physics === true);

/**
 * Načte Rapier, když ho hra potřebuje; hra bez fyziky modul nestáhne. Jádro je
 * synchronní, takže tohle musí proběhnout před `compileArcade` i před prvním
 * tikem v prohlížeči (`worldHasPhysics`).
 */
/** Přechodná chyba serveru, ne vada specu: režisér ji v opravném kole nedostane (`playabilityIssues`). */
export const PHYSICS_NOT_LOADED = 'physics: the physics engine is not loaded yet (preloadPhysics)';

export async function preloadPhysics(spec: GameSpecV1, loadRapier: () => Promise<unknown>): Promise<void> {
  // Zavaděč se předává (P32-0 T4): jak se Rapier načítá, mění jen `physics/world.ts` a volající.
  if (specNeedsPhysics(spec)) await loadRapier();
}

export function compileArcade(spec: GameSpecV1, seed: number): CompileGameResult {
  // Sonda cílového skóre pouští robota taky – bez Rapieru by spadla na výjimce jádra dřív než kontrola níž.
  if (specNeedsPhysics(spec) && rapierIfLoaded() === null) return { ok: false, reason: 'WORLD_REJECTED', issues: [PHYSICS_NOT_LOADED] };
  const wanted = spec.scoring?.target ?? 0;
  const made = arcadeWorldOf(spec, seed, wanted > 0 ? (reachableTarget(spec, seed, wanted) ?? wanted) : undefined);
  if (!made.ok) return { ok: false, reason: 'WORLD_REJECTED', issues: made.issues };
  const { world } = made;
  // Bez načteného Rapieru by robot spadl na výjimce jádra; volající má zavolat `preloadPhysics`.
  if (worldHasPhysics(world) && rapierIfLoaded() === null) return { ok: false, reason: 'WORLD_REJECTED', issues: [PHYSICS_NOT_LOADED] };
  const bot = runBot(world);
  if (bot.outcome !== 'won') return { ok: false, reason: 'UNWINNABLE', issues: [`the bot ${bot.outcome === 'lost' ? 'lost' : 'did not finish'} at tick ${bot.tick}, ${bot.distanceM} m into the track`] };
  // Trať, kterou vyhraje i nečinný hráč, je vada rozvržení – dveře publikace
  // zkusí další semínko, místo aby `verifyArcade` hru až potom odmítl (R3).
  const idle = replay(world, [], ARCADE_LIBRARY);
  if (idle.outcome === 'won') return { ok: false, reason: 'LAYOUT_FAILED', issues: [`a player who does nothing wins at tick ${idle.tick}`] };
  return {
    ok: true,
    value: {
      spec,
      specHash: canonicalHash(spec),
      seed,
      compilerVersion: ARCADE_COMPILER_VERSION,
      blueprint: null,
      arcade: world,
      worldHash: canonicalHash(world),
      mechanics: [],
      roles: [],
      winsAtTick: bot.tick,
    },
  };
}
