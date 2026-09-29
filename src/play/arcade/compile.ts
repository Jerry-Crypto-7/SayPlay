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
import { ARCADE_LIMITS, ARCADE_RUNTIME_VERSION, type ArcadeWorld, COUNTED_ROLES, type ModeGeneratorPiece, type PieceRef, rampMarks } from './contract';
import { buildWorld, replay, worldHasPhysics } from './kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from './library';
import { rapierIfLoaded } from './physics/world';
import { arenaBotRef, arenaControlRef, arenaLevel, arenaRules } from './pieces/arena';
import { flapRules, flapTrack } from './pieces/flap';
import { platformLevel, platformRules } from './pieces/platform';
import { runnerTrack } from './pieces/runner';
import { duelParts } from './pieces/duel';
import { rhythmParts } from './pieces/rhythm';
import { shooterBotRef, shooterRange, shooterRules } from './pieces/shooter';
import { steerBotRef, steerControlRef, steerRules, steerTrack } from './pieces/steer';
import { throwField, throwRules } from './pieces/throw';
import { timingParts } from './pieces/timing';
import { compileRules, rulesOwnGoal, yardParts } from './rules/compile';
import { runBot } from './verify';

/** Verze kompilátoru arkádové hry: mřížkový kompilátor + verze jádra. */
export const ARCADE_COMPILER_VERSION = `${GAME_COMPILER_VERSION}/${ARCADE_RUNTIME_VERSION}`;

export type ArcadeWorldResult = { readonly ok: true; readonly world: ArcadeWorld } | { readonly ok: false; readonly issues: readonly string[] };

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

/** Ovládání, trať a pravidla, která se liší podle `control`. */
function partsOf(spec: GameSpecV1, seed: number, health: number | undefined): ArcadeParts {
  const counts = countParams(spec);
  if (spec.control === 'timing') return timingParts(seed, { ...spec.controlParams }, health);
  if (spec.control === 'rhythm') return rhythmParts(seed, { ...spec.controlParams }, health);
  if (spec.control === 'duel') return duelParts(seed, { ...spec.controlParams }, health);
  if (spec.control === 'platform') {
    const params = platformLevel.params.parse({ ...spec.controlParams, ...counts });
    return {
      control: { id: 'platform', params: { doubleJump: params.doubleJump } },
      bot: { id: 'platform_bot', params: {} },
      level: platformLevel.generate(seed, params),
      rules: platformRules(params, health),
    };
  }
  if (spec.control === 'steer') {
    const params = steerTrack.params.parse({ ...spec.controlParams });
    const level = steerTrack.generate(seed, params);
    // Závod životy nebere (P26 T5): bez `health: undefined` by svět nesl počet, který nic neubere.
    return { control: steerControlRef(level, params), bot: steerBotRef(level, params), level, rules: steerRules(level), health: undefined };
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
    return { control: { id: 'flap', params: { ramp } }, bot: { id: 'flap_bot', params: { ramp } }, level, rules: flapRules(health) };
  }
  if (spec.control === 'shooter') {
    const params = shooterRange.params.parse({ ...spec.controlParams, ...counts });
    return { control: { id: 'shooter', params: {} }, bot: shooterBotRef(params), level: shooterRange.generate(seed, params), rules: shooterRules(params, health) };
  }
  if (spec.control === 'throw') {
    // Hod nemá čím ubrat život: `health` se nečte, prohra je „hody došly“.
    const params = throwField.params.parse({ ...spec.controlParams });
    return { control: { id: 'throw', params: {} }, bot: { id: 'throw_bot', params: {} }, level: throwField.generate(seed, params), rules: throwRules(), health: undefined };
  }
  const params = runnerTrack.params.parse({ ...spec.controlParams, ...counts });
  const rules: PieceRef[] = [
    { id: 'hit', params: { role: 'obstacle', effect: health === undefined ? 'lose' : 'damage' } },
    { id: 'pickup', params: {} },
    { id: 'finish', params: {} },
  ];
  if (health !== undefined) rules.push({ id: 'out_of_health', params: {} });
  const level = runnerTrack.generate(seed, params);
  return { control: { id: 'runner', params: { speed: params.speed, ramp: rampMarks(level.length) } }, bot: { id: 'runner_bot', params: {} }, level, rules };
}

/** Generátor, který ovládání staví bez `controlParams.generator`. */
const CONTROL_GENERATORS: Readonly<Record<string, string>> = {
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

/** Spec + seed → svět. Bez ověření robotem – to dělá `compileArcade`. */
export function arcadeWorldOf(spec: GameSpecV1, seed: number): ArcadeWorldResult {
  const health = (spec.mechanics.find((mechanic) => mechanic.id === 'health')?.params as { readonly max: number } | undefined)?.max ?? addonLives(spec);
  const timer = spec.mechanics.find((mechanic) => mechanic.id === 'timer')?.params as { readonly seconds: number; readonly onEnd: string } | undefined;
  const generator = generatorOf(spec);
  const mode: ModeGeneratorPiece | undefined = MODE_GENERATORS[generator];
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
  if (timer?.onEnd === 'lose') rules.push({ id: 'time_limit', params: { seconds: Math.min(ARCADE_LIMITS.maxTicks / 60, Math.max(10, timer.seconds)) } });

  const built = buildWorld({ seed, control, rules, bot, level, ...(lives === undefined ? {} : { health: lives }) }, ARCADE_LIBRARY);
  return built.ok ? { ok: true, world: built.world } : built;
}

/** Chce spec fyzikální tělesa (P29A T13)? Jen pak se smí stahovat Rapier. */
export const specNeedsPhysics = (spec: GameSpecV1): boolean => (spec.things ?? []).some((thing) => thing.physics === true);

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
  const made = arcadeWorldOf(spec, seed);
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
