/**
 * Knihovna arkádových kusů (P25A): id → kus. Svět odkazuje na kusy jménem
 * (`PieceRef`), jádro i ověření je hledají tady. Co tu není, neexistuje.
 */

import type { ArcadeLibrary } from './kernel';
import { platformControl, platformLevel } from './pieces/platform';
import { platformBot } from './pieces/platform-bot';
import { RULES } from './pieces/rules';
import { runnerControl, runnerTrack } from './pieces/runner';
import { runnerBot } from './pieces/runner-bot';

export const ARCADE_LIBRARY: ArcadeLibrary = {
  controls: { runner: runnerControl, platform: platformControl },
  rules: RULES,
  generators: { runner_track: runnerTrack, platform_level: platformLevel },
  bots: { runner_bot: runnerBot, platform_bot: platformBot },
};
