/**
 * Výběr ovládání ze slov (P25A T7, P25C T7, P25G T6): věta → `runner`,
 * `platform`, `flap`, `throw`, `shooter`, nebo `null` (= dnešní `tap_go`
 * bez pole `control`). Hod a střelba mají přednost před běžcem a plošinovkou:
 * „shoot“ nebo „throw“ ve větě říká, co hráč dělá, „run“ a „jump“ ne.
 *
 * Silné narážky (žánr, známý titul) stačí samy. Slabé („run“, „jump“,
 * „dodge“) se sčítají a běžce dají až dvě – jedno slovo samo je v korpusu
 * i u plošinovek, přechodů a načasovaných her („ski jumping“, „dodging
 * ghosts“). Přednost: poletování > silný běžec > silná plošinovka > slabý
 * běžec > slabá plošinovka – „endless runner“ zůstává běžcem, i když skáče.
 * Hustotu a obtížnost čte jen z kvantifikátorů; co věta neřekne, doplní
 * generátor svým výchozím.
 */

import type { FlapDifficulty } from '../arcade/pieces/flap';
import type { PlatformDifficulty } from '../arcade/pieces/platform';
import type { RunnerDensity } from '../arcade/pieces/runner';
import type { ShooterDifficulty } from '../arcade/pieces/shooter';
import type { ThrowDifficulty, ThrowGoal } from '../arcade/pieces/throw';

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

// Hod před střelbou: „slingshot“ a „trick shots“ nejsou střílečka. Házení nožů
// na točící se kládu a „toss and catch“ jsou v korpusu načasování, kutálející
// se sněhová koule řízení.
const THROW_CUES: readonly RegExp[] = [
  /(?<!knife )\b(?:throw|throws|throwing)\b/,
  /\b(?:toss|tosses|tossing)\b(?!.*\bcatch)/,
  /\bsling ?shots?\b/,
  /\bsling\b/,
  /\bcatapult\b/,
  /\bangry birds\b/,
  // Samotné „hoops“ ne: „fly a paper plane through four hoops“ je závod přes checkpointy.
  /\bbasketball\b/,
  /\bknock(?:s|ing)? (?:down|over)\b/,
  /\bbowling\b/,
  /\bpenalty (?:kicks?|shots?)\b/,
  /\bdarts?\b/,
  /\blaunch\w* .*\bfrom a cannon\b/,
];

// „auto shooting“ (vampire survivors) je volný pohyb – střílí se samo.
const SHOOTER_CUES: readonly RegExp[] = [
  /(?<!auto[- ])\bshoot(?:s|ing|er|ers)?\b(?! stars?)/,
  /\bguns?\b/,
  /\bsniper\b/,
  /\barchery\b/,
  /\bbow and arrows?\b/,
  /\barrows?\b/,
  /\bfps\b/,
  /\bkrunker\b/,
  /\btanks? (?:battle|war|fight)s?\b/,
  /\baim(?:s|ing)? (?:at|and)\b/,
  /\btower defen[cs]e\b/,
  /\bzombie waves?\b/,
  /\bwaves? of (?:zombies|enemies|aliens|robots)\b/,
  /\bspace invaders\b/,
];

// Co se hází: koš, věž k sestřelení, jinak podle semínka.
const HOOP_CUES = /\b(?:basketball|hoops?|free throws?|trash can|bin|bucket)\b/;
const TOWER_CUES = /\b(?:angry birds|knock(?:s|ing)? (?:down|over)|towers?|boxes|bowling|pins|cans)\b/;

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
  | { readonly control: 'shooter'; readonly difficulty: ShooterDifficulty | null }
  | { readonly control: 'throw'; readonly difficulty: ThrowDifficulty | null; readonly goal: ThrowGoal | null };

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
  // Výslovný žánr plošinovky přebije hod i střelbu („a tower defense platformer“).
  const platformer = /\bplatform(?:er| game)\b/.test(text);
  if (!platformer && THROW_CUES.some((cue) => cue.test(text))) {
    return { control: 'throw', difficulty: difficultyOf(text), goal: HOOP_CUES.test(text) ? 'hoop' : TOWER_CUES.test(text) ? 'tower' : null };
  }
  if (!platformer && SHOOTER_CUES.some((cue) => cue.test(text))) return { control: 'shooter', difficulty: difficultyOf(text) };
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
