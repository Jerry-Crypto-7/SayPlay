import { makePacedControl, makePacedBot } from './pieces/phase-pieces';
import { objectiveOrder, objectiveWalkerBot } from './pieces/objective-order';
import { assemblyPart, assemblyFinish, assemblyGateRules, makeAssemblyControl, makeAssemblyBot } from './pieces/assembly-parts';
/**
 * Knihovna arkádových kusů (P25A): id → kus. Svět odkazuje na kusy jménem
 * (`PieceRef`), jádro i ověření je hledají tady. Co tu není, neexistuje.
 */

import { ADDON_RULES, makeAddonBot, makeAddonControl } from './addons';
import { ABILITY_RULES } from './abilities';
import { abilityStep } from './abilities/bot';
import type { BotPiece, ControlPiece, ModeGeneratorPiece, RulePiece } from './contract';
import { bossBeat, bossBeatHit } from './pieces/boss';
import { makePacingBot, makePacingControl, pacingRule } from './pieces/pacing';
import type { ArcadeLibrary } from './kernel';
import { arenaCollect, arenaEat, arenaEscape, arenaLevel, growTo, moveFreeControl, surviveTime } from './pieces/arena';
import { arenaCatch, arenaCatchContact } from './pieces/arena-catch';
import { arenaBot } from './pieces/arena-bot';
import { FIGHT_RULES, fightArena, fightControl } from './pieces/fight';
import { lanesControl } from './pieces/lanes';
import { CATCH_RULES, catchFall } from './pieces/catch-fall';
import { catchBot } from './pieces/catch-fall-bot';
import { WHACK_RULES, whackHoles } from './pieces/whack';
import { whackBot } from './pieces/whack-bot';
import { DEFENSE_RULES, laneDefense } from './pieces/lane-defense';
import { defenseBot } from './pieces/lane-defense-bot';
import { SLICE_RULES, sliceArcs } from './pieces/slice';
import { sliceBot } from './pieces/slice-bot';
import { HOP_RULES, hopControl, hopRows } from './pieces/hop';
import { hopBot } from './pieces/hop-bot';
import { CROWD_RULES, crowdControl, crowdTrack } from './pieces/crowd';
import { crowdBot } from './pieces/crowd-bot';
import { fightBot } from './pieces/fight-bot';
import { flapControl, flapTrack } from './pieces/flap';
import { flapBot } from './pieces/flap-bot';
import { platformControl, platformLevel } from './pieces/platform';
import { platformBot } from './pieces/platform-bot';
import { boilOver, questSpatial, questStation } from './pieces/quest';
import { questBot } from './pieces/quest-bot';
import { RULES } from './pieces/rules';
import { runnerControl, runnerTrack } from './pieces/runner';
import { runnerBot } from './pieces/runner-bot';
import { duelArena, duelControl, duelDodgeRule } from './pieces/duel';
import { duelBot } from './pieces/duel-bot';
import { rhythmControl, rhythmLevel } from './pieces/rhythm';
import { rhythmBot } from './pieces/rhythm-bot';
import { gun, shooterControl, shooterRange } from './pieces/shooter';
import { shooterBot } from './pieces/shooter-bot';
import { SHOT_RULES } from './pieces/shots';
import { rivalFinish, steerCrash, steerControl, steerTrack, voyageLand, voyageRace } from './pieces/steer';
import { steerBot } from './pieces/steer-bot';
import { launch, throwControl, throwField, throwRounds } from './pieces/throw';
import { throwBot } from './pieces/throw-bot';
import { judgeRule, timingControl, timingLevel } from './pieces/timing';
import { timingBot } from './pieces/timing-bot';
import { arenaWaves } from './pieces/waves';
import { SPEC_RULES } from './rules/compile';

import { glideControl, glideCourse, glideFinish } from './pieces/glide';
import { glideBot } from './pieces/glide-bot';

import { walkerControl, walkerLabyrinth, walkerStealth, walkerEscape, walkerCaught } from './pieces/walker';
import { walkerBot } from './pieces/walker-bot';

import { ballControl, ballPitch, ballLaunch, ballScore, ballKnockdown } from './pieces/ball';
import { ballBot } from './pieces/ball-bot';

const BASE_BOTS = {
  ball_bot: ballBot,
  walker_bot: walkerBot,
  glide_bot: glideBot,
  runner_bot: runnerBot,
  platform_bot: platformBot,
  flap_bot: flapBot,
  steer_bot: steerBot,
  arena_bot: arenaBot,
  shooter_bot: shooterBot,
  throw_bot: throwBot,
  timing_bot: timingBot,
  rhythm_bot: rhythmBot,
  duel_bot: duelBot,
  fight_bot: fightBot,
  quest_bot: questBot,
  catch_bot: catchBot,
  whack_bot: whackBot,
  defense_bot: defenseBot,
  slice_bot: sliceBot,
  hop_bot: hopBot,
  crowd_bot: crowdBot,
} as const;

/**
 * Generátory režimů žánrů (P32-0 T4): vybírá je `controlParams.generator`
 * (`arcade/compile.ts`). Stopy P32E–G plní jen jejich těla, registrace je tady.
 */
export const MODE_GENERATORS: Readonly<Record<string, ModeGeneratorPiece>> = {
  glide_course: glideCourse,
  ball_pitch: ballPitch,
  walker_labyrinth: walkerLabyrinth, walker_stealth: walkerStealth, walker_escape: walkerEscape,
  arena_catch: arenaCatch,
  arena_escape: arenaEscape,
  arena_collect: arenaCollect,
  fight: fightArena,
  voyage_race: voyageRace,
  voyage_land: voyageLand,
  quest_spatial: questSpatial,
  quest_station: questStation,
  // P54C T5: chytání v pěti pruzích.
  catch_fall: catchFall,
  // P54C T6: bouchání do pěti děr.
  whack_holes: whackHoles,
  // P54C T7: obrana pěti pruhů.
  lane_defense: laneDefense,
  // P54C T8: krájení věcí, které vylétají v pěti pruzích.
  slice_arcs: sliceArcs,
  // P54C T9: přeskákání silnice po řadách mřížky.
  hop_rows: hopRows,
  // P54C T10: dav a brány po trati.
  crowd_track: crowdTrack,
};

const BASE_CONTROLS = {
  ball: ballControl,
  walker: walkerControl,
  glide: glideControl,
  runner: runnerControl,
  platform: platformControl,
  flap: flapControl,
  steer: steerControl,
  move_free: moveFreeControl,
  shooter: shooterControl,
  throw: throwControl,
  timing: timingControl,
  rhythm: rhythmControl,
  duel: duelControl,
  // P54C T4: pět pruhů sdílených chytáním, boucháním, obranou a krájením; hraje až s generátorem žánru.
  lanes: lanesControl,
  // P54C T9: skok po polích mřížky (přeskákání silnice).
  hop: hopControl,
  // P54C T10: dav ve dvou pruzích bran.
  crowd: crowdControl,
} as const;

const PHASE_CONTROLS = { ...BASE_CONTROLS, phase_control: makePacedControl(BASE_CONTROLS) };
const PHASE_BOTS = { ...BASE_BOTS, objective_walker_bot: objectiveWalkerBot, phase_bot: makePacedBot(BASE_BOTS) };
// Průběh hry (P45C) obalí základní ovládání i souboj; doplňky obalí jeho i holý souboj s akcemi (P47B T6, souboj režiséra bez průběhu).
const FIGHT_CONTROLS = { ...PHASE_CONTROLS, fight: fightControl as ControlPiece };
const PROGRESSION_CONTROLS = { ...FIGHT_CONTROLS, pacing_control: makePacingControl(FIGHT_CONTROLS) as ControlPiece };
const PROGRESSION_BOTS = { ...PHASE_BOTS, pacing_bot: makePacingBot(PHASE_BOTS) as BotPiece };
const NATIVE_LIBRARY: ArcadeLibrary = {
  controls: { ...PROGRESSION_CONTROLS, addon_control: makeAddonControl(PROGRESSION_CONTROLS) as ControlPiece },
  rules: { pacing: pacingRule as RulePiece, boss_beat: bossBeat as RulePiece, boss_beat_hit: bossBeatHit as RulePiece, arena_catch_contact: arenaCatchContact, steer_crash: steerCrash, objective_order: objectiveOrder, ball_launch: ballLaunch, ball_score: ballScore, ball_knockdown: ballKnockdown, walker_caught: walkerCaught, glide_finish: glideFinish, ...RULES, ...SHOT_RULES, ...ADDON_RULES, gun, launch, rival_finish: rivalFinish, arena_eat: arenaEat, grow_to: growTo, survive_time: surviveTime, arena_waves: arenaWaves, throw_rounds: throwRounds, boil_over: boilOver, judge: judgeRule, duel_dodge: duelDodgeRule, ...SPEC_RULES, ...FIGHT_RULES, ...ABILITY_RULES, ...CATCH_RULES, ...WHACK_RULES, ...DEFENSE_RULES, ...SLICE_RULES, ...HOP_RULES, ...CROWD_RULES },
  generators: {
    runner_track: runnerTrack,
    platform_level: platformLevel,
    flap_track: flapTrack,
    steer_track: steerTrack,
    arena: arenaLevel,
    shooter_range: shooterRange,
    throw_field: throwField,
    timing_level: timingLevel,
    rhythm_level: rhythmLevel,
    duel_arena: duelArena,
    ...MODE_GENERATORS,
  },
  bots: { ...PROGRESSION_BOTS, addon_bot: makeAddonBot(PROGRESSION_BOTS, abilityStep) as BotPiece },
};

export const ARCADE_LIBRARY: ArcadeLibrary = {
  ...NATIVE_LIBRARY,
  controls: { ...NATIVE_LIBRARY.controls, assembly_control: makeAssemblyControl(NATIVE_LIBRARY.controls) },
  bots: { ...NATIVE_LIBRARY.bots, assembly_bot: makeAssemblyBot(NATIVE_LIBRARY.bots) },
  rules: { ...NATIVE_LIBRARY.rules, assembly_part: assemblyPart, assembly_finish: assemblyFinish, ...assemblyGateRules(NATIVE_LIBRARY.rules) },
};
