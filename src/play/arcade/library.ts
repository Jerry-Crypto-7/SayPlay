/**
 * Knihovna arkádových kusů (P25A): id → kus. Svět odkazuje na kusy jménem
 * (`PieceRef`), jádro i ověření je hledají tady. Co tu není, neexistuje.
 */

import { ADDON_RULES, makeAddonBot, makeAddonControl } from './addons';
import type { BotPiece, ControlPiece, ModeGeneratorPiece } from './contract';
import type { ArcadeLibrary } from './kernel';
import { arenaCollect, arenaEat, arenaEscape, arenaLevel, growTo, moveFreeControl, surviveTime } from './pieces/arena';
import { arenaBot } from './pieces/arena-bot';
import { FIGHT_RULES, fightArena, fightControl } from './pieces/fight';
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
import { duelArena, duelControl } from './pieces/duel';
import { duelBot } from './pieces/duel-bot';
import { rhythmControl, rhythmLevel } from './pieces/rhythm';
import { rhythmBot } from './pieces/rhythm-bot';
import { gun, shooterControl, shooterRange } from './pieces/shooter';
import { shooterBot } from './pieces/shooter-bot';
import { SHOT_RULES } from './pieces/shots';
import { rivalFinish, steerControl, steerTrack, voyageLand, voyageRace } from './pieces/steer';
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

import { ballControl, ballPitch, ballLaunch, ballScore } from './pieces/ball';
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
} as const;

/**
 * Generátory režimů žánrů (P32-0 T4): vybírá je `controlParams.generator`
 * (`arcade/compile.ts`). Stopy P32E–G plní jen jejich těla, registrace je tady.
 */
export const MODE_GENERATORS: Readonly<Record<string, ModeGeneratorPiece>> = {
  glide_course: glideCourse,
  ball_pitch: ballPitch,
  walker_labyrinth: walkerLabyrinth, walker_stealth: walkerStealth, walker_escape: walkerEscape,
  arena_escape: arenaEscape,
  arena_collect: arenaCollect,
  fight: fightArena,
  voyage_race: voyageRace,
  voyage_land: voyageLand,
  quest_spatial: questSpatial,
  quest_station: questStation,
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
} as const;

export const ARCADE_LIBRARY: ArcadeLibrary = {
  controls: { ...BASE_CONTROLS, addon_control: makeAddonControl(BASE_CONTROLS) as ControlPiece, fight: fightControl as ControlPiece },
  rules: { ball_launch: ballLaunch, ball_score: ballScore, walker_caught: walkerCaught, glide_finish: glideFinish, ...RULES, ...SHOT_RULES, ...ADDON_RULES, gun, launch, rival_finish: rivalFinish, arena_eat: arenaEat, grow_to: growTo, survive_time: surviveTime, arena_waves: arenaWaves, throw_rounds: throwRounds, boil_over: boilOver, judge: judgeRule, ...SPEC_RULES, ...FIGHT_RULES },
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
  bots: { ...BASE_BOTS, addon_bot: makeAddonBot(BASE_BOTS) as BotPiece },
};
