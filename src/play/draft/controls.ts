/**
 * Výběr ovládání ze slov (P25A T7, P25C T7): věta → `runner`, `platform`,
 * `flap`, nebo `null` (= dnešní `tap_go` bez pole `control`).
 *
 * Silné narážky (žánr, známý titul) stačí samy. Slabé („run“, „jump“,
 * „dodge“) se sčítají a běžce dají až dvě – jedno slovo samo je v korpusu
 * i u plošinovek, přechodů a načasovaných her („ski jumping“, „dodging
 * ghosts“). Přednost: poletování > silný běžec > silná plošinovka > slabý
 * běžec > slabá plošinovka – „endless runner“ zůstává běžcem, i když skáče.
 * Řízení (`steer`) a aréna (`move_free`, P25F) mají jen silné narážky a stojí
 * hned za silným běžcem.
 * Hustotu a obtížnost čte jen z kvantifikátorů; co věta neřekne, doplní
 * generátor svým výchozím.
 */

import type { ArenaDensity } from '../arcade/pieces/arena';
import type { FlapDifficulty } from '../arcade/pieces/flap';
import type { PlatformDifficulty } from '../arcade/pieces/platform';
import type { RunnerDensity } from '../arcade/pieces/runner';
import type { SteerDifficulty } from '../arcade/pieces/steer';

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

// Řízení (P25F): vozidlo, závod, letadlo. „drive out / drive cars“ je v korpusu
// posouvačka a GTA, „food truck“ vaření, „park“ místo – proto ty výjimky.
const STEER_CUES: readonly RegExp[] = [
  /\brac(?:e|es|ing|er|ers)\b/,
  /\bdriving\b/,
  /\bdrive (?:a|an|the|your|my) /,
  /\bkart\b/,
  /\bdrift\w*/,
  /\bpark(?:ing)? (?:game|without)\b/,
  /\bbumper cars?\b/,
  /\b(?:plane|airplane|pilot)s?\b/,
  /\bfly (?:a|an|the) /,
  /\b(?:(?<!food )truck|motorbike|motorcycle|scooter|sled|boat|kayak)s?\b/,
  /\bon wheels\b/,
  /\bformula 1\b/,
  /\brocket league\b/,
  /\bsurf(?:er|ing)\b/,
  /\bsteer\w*/,
  /\broll(?:s|ing)? (?:down|through)\b/,
];

// Závod branami nebo obručemi v pořadí je mřížkový `checkpoint_race` (zlatá sada).
const GATE_RACE = /\b(?:gates?|hoops?|rings?|checkpoints?|in (?:the right )?order)\b/;

// Aréna (P25F): jíst menší a růst, io hry, strkanice. „grow a bridge / a garden“
// je načasování a idle, „gets bigger then“ běžec s davem, „hungry seal“ honička.
const ARENA_CUES: readonly RegExp[] = [
  /\bagar\b/,
  /\bslither\b/,
  /\bpaper ?io\b/,
  /\beat(?:s|ing)? (?:smaller|everything)\b/,
  /\bsmaller (?:fish|cells?|ones)\b/,
  /\bbigger the more\b/,
  /\b(?:grow|grows|growing)\b(?! (?:a|an|the|your|my) )/,
  /\bswallow\w*/,
  /\bsnake game\b/,
  /\bsumo\b/,
  /\bbattle royale\b/,
  /\bbump\w* (?:other|everyone)/,
  /\bpush everyone\b/,
  /\bsurvive (?:the )?(?:swarm|waves)\b/,
  /\barena\b/,
];

const HIGH_DENSITY =/\b(?:a lot of|lots of|many|tons of|loads of|full of|everywhere|hard|super hard)\b/;
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
  | { readonly control: 'steer'; readonly difficulty: SteerDifficulty | null; readonly drift: boolean }
  | { readonly control: 'move_free'; readonly density: ArenaDensity | null };

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
  const runner = runnerScore(text);
  const platform = platformScore(text);
  const strongRunner = STRONG_CUES.some((cue) => cue.test(text));
  // Řízení před arénou: „bumper cars arena“ je řízení, sněhová koule, která „gets
  // bigger“, taky. Silný běžec má přednost („subway surfers“).
  if (!strongRunner && !GATE_RACE.test(text) && STEER_CUES.some((cue) => cue.test(text))) return { control: 'steer', difficulty: difficultyOf(text), drift: /\bdrift/.test(text) };
  if (!strongRunner && ARENA_CUES.some((cue) => cue.test(text))) {
    return { control: 'move_free', density: HIGH_DENSITY.test(text) ? 'dense' : LOW_DENSITY.test(text) ? 'sparse' : null };
  }
  if (!strongRunner && (platform === 2 || (runner < 2 && platform === 1))) {
    return { control: 'platform', difficulty: difficultyOf(text), movingPlatforms: /\bmoving platforms?\b/.test(text), doubleJump: /\bdouble jump/.test(text) };
  }
  if (runner < 2) return null;
  const density = HIGH_DENSITY.test(text) ? 'high' : LOW_DENSITY.test(text) ? 'low' : null;
  return { control: 'runner', density };
}
