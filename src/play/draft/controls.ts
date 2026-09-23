/**
 * Výběr ovládání ze slov (P25A T7, P25C T7): věta → `runner`, `platform`,
 * `flap`, nebo `null` (= dnešní `tap_go` bez pole `control`).
 *
 * Silné narážky (žánr, známý titul) stačí samy. Slabé („run“, „jump“,
 * „dodge“) se sčítají a běžce dají až dvě – jedno slovo samo je v korpusu
 * i u plošinovek, přechodů a načasovaných her („ski jumping“, „dodging
 * ghosts“). Přednost: poletování > silný běžec > silná plošinovka > slabý
 * běžec > slabá plošinovka – „endless runner“ zůstává běžcem, i když skáče.
 * Hustotu a obtížnost čte jen z kvantifikátorů; co věta neřekne, doplní
 * generátor svým výchozím.
 *
 * P25H: rytmus, souboj a načasování mají jen silné narážky (žánr, titul,
 * sloveso hry) a jdou hned za poletováním – „tap to the beat“ ani „time
 * your jumps“ nejsou skákačka, „sword fighting with ninjas“ není běh.
 */

import type { DuelDifficulty } from '../arcade/pieces/duel';
import type { FlapDifficulty } from '../arcade/pieces/flap';
import type { PlatformDifficulty } from '../arcade/pieces/platform';
import type { RhythmDensity } from '../arcade/pieces/rhythm';
import type { RunnerDensity } from '../arcade/pieces/runner';
import type { TimingMode, TimingSpeed } from '../arcade/pieces/timing';

const RHYTHM_CUES: readonly RegExp[] = [
  /\brhythm\b/,
  /\b(?:to|with|on) the beat\b/,
  /\bbeat saber\b/,
  /\bpiano tiles\b/,
  /\bguitar hero\b/,
  /\bmusic game\b/,
  /\bto (?:the )?music\b/,
  /\bdanc(?:e|es|ing)\b/,
  /\bdrumm(?:er|ing)\b/,
  /\bdisco\b/,
];

// Holé „fight“ a „ninja“ jsou moc široké („fight the boss“, „ninja running on
// rooftops“, „water gun fight“) – jen spojení, která znamenají souboj zblízka.
const DUEL_CUES: readonly RegExp[] = [
  /\bfight(?:s|ing)? (?:game|match|with|against)\b/,
  /\b(?:sword|stickman|pillow|fist|street|ninja|samurai) ?fight/,
  /\bduel\b(?!.*\bshoot)/,
  /\bbox(?:ing|er)\b/,
  /\bkarate\b/,
  /\bkung fu\b/,
  /\bdodge and (?:strike|hit|punch)\b/,
];

const TIMING_CUES: readonly RegExp[] = [
  /\bstack(?:s|ing)?\b/,
  // „tower of moving platforms“ je plošinovka – jen věž, která se staví.
  /\b(?:tallest|highest)\b[a-z ]* tower\b/,
  /\b(?:at )?the right (?:time|moment)\b/,
  /\bperfect timing\b/,
  /\btime your\b/,
  /\bstop the (?:bar|moving|block|needle)\b/,
  /\bhelix\b/,
  /\bcut the rope\b/,
  /\b(?:grow|build) a bridge\b/,
  /\bfishing\b/,
  /\bcatch it on\b/,
];

const STRONG_CUES: readonly RegExp[] = [
  /\bend+les+ runner\b/,
  /\brunner\b/,
  /\bsubway surfers?\b/,
  /\btemple run\b/,
  /\bgeometry dash\b/,
  /\bparkour\b/,
];

const WEAK_CUES: readonly RegExp[] = [
  // „run a supermarket“ je provozovat, ne běžet.
  /\b(?:run|runs)\b(?! (?:a|an|the|my|your) )/,
  /\brunning\b/,
  /\b(?:jump|jumps|jumping|hop|hops|hopping)\b/,
  /\b(?:dodge|dodges|dodging|avoid|avoids|avoiding)\b/,
  /\bobstacles?\b/,
  /\b(?:slide|slides|sliding) under\b/,
  /\bendless\b/,
  /\bskateboard\w*\b/,
];

// Narážka na mřížkovou hru přebije slabé skóre: „hop across the road and dodge
// cars“ je přechod, „run from the zombie and avoid the traps“ honička. Silnou
// narážku (žánr, titul) nepřebije.
const GRID_CUES: readonly RegExp[] = [
  /\b(?:cross|crosses|crossing)\b/,
  /\bacross the (?:road|street|river|highway|lava)\b/,
  /\b(?:runs?|running) (?:from|away)\b/,
  /\b(?:escape|escapes|escaping|flee|flees|chase|chases|chased|chasing|hunts?|hunting)\b/,
];

const FLAP_CUES: readonly RegExp[] = [/\bflapp?(?:y|s|ing)?\b/, /\btap to fly\b/, /\bbird\b.*\bpipes?\b/, /\bfly (?:through|between) (?:the )?(?:pipes|gaps)\b/];

const PLATFORM_STRONG: readonly RegExp[] = [
  /\bplatformer\b/,
  /\bplatform game\b/,
  /\bobby\b/,
  // „mario kart“ je řízení.
  /\bmario\b(?! kart)/,
  /\bjump king\b/,
  /\bonly up\b/,
  /\bdoodle jump\b/,
  /\bfall guys\b/,
  // Jednotné číslo je v korpusu načasování („stop the moving platform“).
  // „floating islands/platforms“ tu schválně chybí: startovní věta a zlatá sada
  // („Cross floating islands…“, „Hop between floating platforms…“) jsou mřížkový přechod.
  /\bmoving platforms\b/,
  /\bdouble jump\b/,
  /\bledges?\b/,
  /\bjump(?:s|ing)? (?:across|between|from|onto) (?!the (?:road|street|river|highway))/,
];

// „hill climb racing“ je řízení.
const PLATFORM_WEAK: readonly RegExp[] = [/(?<!hill )\bclimb(?:s|ing)?\b/, /\bbounc(?:e|es|ing)\b/, /\bspikes?\b/];

const HIGH_DENSITY = /\b(?:a lot of|lots of|many|tons of|loads of|full of|everywhere|hard|super hard)\b/;
const LOW_DENSITY = /\b(?:few|easy|simple|chill|relaxing|calm)\b/;

export type ControlChoice =
  | { readonly control: 'runner'; readonly density: RunnerDensity | null }
  | {
      readonly control: 'platform';
      readonly difficulty: PlatformDifficulty | null;
      readonly movingPlatforms: boolean;
      readonly doubleJump: boolean;
    }
  | { readonly control: 'flap'; readonly difficulty: FlapDifficulty | null }
  | { readonly control: 'timing'; readonly mode: TimingMode; readonly speed: TimingSpeed | null }
  | { readonly control: 'rhythm'; readonly density: RhythmDensity | null }
  | { readonly control: 'duel'; readonly difficulty: DuelDifficulty | null };

export function runnerScore(text: string): number {
  if (STRONG_CUES.some((cue) => cue.test(text))) return 2;
  if (GRID_CUES.some((cue) => cue.test(text))) return 0;
  return WEAK_CUES.filter((cue) => cue.test(text)).length;
}

/** 2 = silná narážka, 1 = slabá (a žádná mřížková), 0 = nic. */
function platformScore(text: string): number {
  if (PLATFORM_STRONG.some((cue) => cue.test(text))) return 2;
  if (GRID_CUES.some((cue) => cue.test(text))) return 0;
  return PLATFORM_WEAK.some((cue) => cue.test(text)) ? 1 : 0;
}

const difficultyOf = (text: string): 'easy' | 'hard' | null => (HIGH_DENSITY.test(text) ? 'hard' : LOW_DENSITY.test(text) ? 'easy' : null);

/** `text` je věta malými písmeny. */
export function pickControl(text: string): ControlChoice | null {
  if (FLAP_CUES.some((cue) => cue.test(text))) return { control: 'flap', difficulty: difficultyOf(text) };
  const level = difficultyOf(text);
  if (RHYTHM_CUES.some((cue) => cue.test(text))) return { control: 'rhythm', density: level === 'hard' ? 'dense' : level === 'easy' ? 'sparse' : null };
  if (DUEL_CUES.some((cue) => cue.test(text))) return { control: 'duel', difficulty: level };
  if (TIMING_CUES.some((cue) => cue.test(text))) {
    const mode = /\b(?:bridge|rope)\b/.test(text) ? 'bridge' : /\b(?:stack|stacks|stacking|tower|pile)\b/.test(text) ? 'stack' : 'precision';
    return { control: 'timing', mode, speed: level === 'hard' ? 'fast' : level === 'easy' ? 'slow' : null };
  }
  const runner = runnerScore(text);
  const platform = platformScore(text);
  const strongRunner = STRONG_CUES.some((cue) => cue.test(text));
  if (!strongRunner && (platform === 2 || (runner < 2 && platform === 1))) {
    return { control: 'platform', difficulty: difficultyOf(text), movingPlatforms: /\bmoving platforms?\b/.test(text), doubleJump: /\bdouble jump/.test(text) };
  }
  if (runner < 2) return null;
  const density = HIGH_DENSITY.test(text) ? 'high' : LOW_DENSITY.test(text) ? 'low' : null;
  return { control: 'runner', density };
}
