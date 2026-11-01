/**
 * Žánr Závod s triky (P68, kategorie `vozidla-sport`): vozidlo z věty jede krátkou trať (~30–50 s), skáče z ramp,
 * prorazí hromady věcí z věty (trosky Rapieru, nejvýš `STUNT_DEBRIS_MAX` těl, `p68-contract.ts`), náraz do mantinelu
 * stojí život a vyhrává průjezd cílem do limitu trati (ovládání `stunt`, vstup náklonu `steer`, generátor `stunt_track`
 * v `arcade/pieces/stunt.ts`, robot `stunt_bot`, kamera za autem `chase`).
 *
 * Obsazení (`compileStunt`): hrdina věty je vozidlo – model hráče z `modelOf` (jinak auto); věc, do které se bourá
 * (první z obsazení kromě cíle), je role `pile` – hromady (jinak bedny); místo jde do `theme.look` (`lookFor`).
 * Meze: rampy 2–4, hromady 2–4, délka okruhu 200–360 m (s triky ~300–580 m), obtížnost 1–3 (šířka a zatáčky trati).
 *
 * **Viditelnost (P68-I):** modul je pořád kostra – `availability` `staged` a překlad v registru hází („not live“), jak
 * kostru drží `p68-staged.test.ts`; klasifikátor ani režisér ho nevidí (`ROUTE_PENDING`, `DIRECTOR_PENDING`). Hotový
 * překlad je `compileStunt` (a celý modul `stuntLiveGenre`); úloha „zapoj stunt“ v P68-I ho do registru dosadí
 * (`stuntGenre` = `stuntLiveGenre`) a hru odebere z bran aktivace. Hraje se zatím z ručního specu (fixture).
 */

import { lookFor } from '../arcade/look';
import { modelOf } from '../arcade/models';
import { STUNT } from '../arcade/pieces/stunt-track';
import { nounPhrase, plural, singular, withoutPossessor } from '../draft/lexicon';
import type { GameSpecV1 } from '../spec';

import { type CastItem, type GenreModule, type GenreSpecOf, castFor, draftRoles, legacySpec, livesMechanic, stagedGenre, titleCase } from './contract';

/** Výchozí obsazení, když ho věta nejmenuje. */
export const STUNT_DEFAULTS = { thing: 'crate', finish: 'finish line' } as const;

/** Obtížnost jako číslo parametru (1–3) → obtížnost trati řízení. */
export const STUNT_DIFFICULTY = ['easy', 'normal', 'hard'] as const;

export const STUNT_PARAM_BOUNDS = {
  ramps: { min: STUNT.ramps.min, max: STUNT.ramps.max },
  piles: { min: STUNT.piles.min, max: STUNT.piles.max },
  lengthM: { min: STUNT.lengthM.min, max: STUNT.lengthM.max },
  difficulty: { min: 1, max: STUNT_DIFFICULTY.length },
} as const;

/**
 * Narážky klasifikátoru (jen seznam – do výběru je zapojí P68-I odebráním z `ROUTE_PENDING`). Kaskadérské slovo, skok
 * a bourání; u víceslovné narážky `cuePattern` ohýbá jen poslední slovo, proto „jumps the“ i „jump the“. Samotné
 * „race“ ani „drive“ ne – závod bez skoku a bourání patří plavbě (`voyage`); „drift“ ne – v `test-200` ho má
 * medúza („a jellyfish drifts upward“).
 */
export const STUNT_CUES = [
  'stunt',
  'ramp',
  'jump the',
  'jumps the',
  'crash into',
  'crashes into',
  'crash through',
  'crashes through',
  'smash through',
  'smashes through',
  'plows through',
  'monster truck',
  'daredevil',
  'demolition',
  'race over',
  'races over',
] as const;

/** Hromada věcí ve větě: „a tower of crates“, „a wall of tires“, „a junkyard full of old cars“. */
const PILE = /\b(?:tower|wall|pile|stack|heap|pyramid|row|mountain|line|bunch|full)s?\s+of\s+([a-z][a-z -]*)/;
/** Do čeho se bourá, když věta hromadu nejmenuje: „plows through a fence“, „crashes into the barrels“. */
const SMASH = /\b(?:smash(?:es|ing)?(?: into| through)?|crash(?:es|ing)? (?:into|through)|plows? through|plowing through|bursts? through|rams?|ramming|knocks? (?:down|over))\s+([a-z][a-z -]*)/;
/** Slova, která věc hromady ani místo nejsou („smashes through it“, „into a tower of“). */
const NOT_A_THING = /^(?:it|them|everything|anything|finish|ramps?|jumps?|towers?|walls?|piles?|stacks?|heaps?|pyramids?|rows?|mountains?|lines?|bunch)\b/;
/** Vozidlo věty (poslední slovo jeho popisku). */
const VEHICLE = /^(?:car|truck|bus|scooter|buggy|tractor|motorbike|motorcycle|bike|bicycle|kart|go-kart|van|jeep|taxi|ambulance|tank|quad|atv|limo|limousine|pickup|lorry|rover|snowmobile|skateboard|sled|firetruck|bulldozer|digger)s?$/;
/** Slova, která do popisku vozidla nepatří (člen, předložka, sloveso před ním). */
const NOT_A_MODIFIER = /^(?:a|an|the|my|his|her|their|our|your|on|in|at|of|and|with|into|onto|drives?|rides?|races?|jumps?)$/;
/** Předložky místa; místo je fráze za poslední z nich, která není hromada ani rampa. */
const PLACE_PREP = /^(?:in|on|at|across|through|down|along|around|over|inside)$/;
/** Kde fráze místa končí. */
const PLACE_END = /^(?:and|with|full|of|into|past|to|then|while|where|that|for)$/;

/** Věc hromad z věty, nebo `null`. */
function pileThingOf(text: string): string | null {
  const phrase = PILE.exec(text)?.[1] ?? SMASH.exec(text)?.[1];
  const noun = phrase === undefined ? null : nounPhrase(phrase, 2);
  return noun === null || NOT_A_THING.test(noun) ? null : singular(noun);
}

/** Vozidlo z věty s nejvýš dvěma slovy před ním („monster truck“, „pizza delivery scooter“), nebo `null`. */
function vehiclePhraseOf(words: readonly string[]): string | null {
  const at = words.findIndex((word) => VEHICLE.test(word));
  if (at < 0) return null;
  let from = at;
  while (from > 0 && at - from < 2 && !NOT_A_MODIFIER.test(words[from - 1] as string)) from -= 1;
  return singular(words.slice(from, at + 1).join(' '));
}

/** Místo za poslední předložkou místa („in a desert“, „at the county fair“, „through a junkyard full of …“). */
function placeOf(words: readonly string[]): string | null {
  for (let k = words.length - 2; k >= 0; k -= 1) {
    if (!PLACE_PREP.test(words[k] as string)) continue;
    const rest: string[] = [];
    for (const word of words.slice(k + 1)) {
      if (PLACE_END.test(word)) break;
      rest.push(word);
    }
    const phrase = nounPhrase(rest.join(' '), 3);
    if (phrase !== null && !NOT_A_THING.test(phrase) && !VEHICLE.test(phrase.split(' ').at(-1) as string)) return phrase;
  }
  return null;
}

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

/** Model vozidla z popisku hrdiny (`modelOf`), jinak auto jádra. */
export const vehicleOf = (hero: string): string => modelOf(hero, true) ?? STUNT.kinds.vehicle;

/** Spec žánru → hra `stunt` (generátor `stunt_track` přes `tuning`). */
export function compileStunt(spec: GenreSpecOf<'stunt'>): GameSpecV1 {
  const palette = spec.palette ?? lookFor(spec.setting) ?? undefined;
  const looked = palette === undefined ? spec : { ...spec, palette };
  const params = spec.params ?? {};
  // Věc hromad: první věc obsazení, která není cíl cesty (`FOE_DOES.stunt` = `avoid`, překážka na trati triků).
  const thing = singular(spec.cast?.find((item) => item.does !== 'reach' && item.does !== 'hero')?.label ?? STUNT_DEFAULTS.thing);
  const goal = castFor(spec, 'reach')?.label ?? STUNT_DEFAULTS.finish;
  const difficulty = params.difficulty === undefined ? undefined : STUNT_DIFFICULTY[params.difficulty - 1];
  const tuning = {
    vehicle: vehicleOf(spec.hero),
    ...(difficulty === undefined ? {} : { difficulty }),
    ...(params.lengthM === undefined ? {} : { lengthM: params.lengthM }),
    ...(params.ramps === undefined ? {} : { ramps: params.ramps }),
    ...(params.piles === undefined ? {} : { piles: params.piles }),
  };
  const things = plural(thing, 2);
  const hero = titleCase(spec.hero);
  return legacySpec(looked, {
    control: 'stunt',
    controlParams: { generator: 'stunt_track', tuning },
    archetype: 'hazard_crossing',
    title: fit(80, `${hero} Stunt Run`, 'Stunt Run'),
    objective: { kind: 'reach', description: fit(120, `Jump the ramps, smash through the ${things} and reach the ${goal}.`, `Jump the ramps, smash the ${things}, reach the finish.`, 'Jump the ramps, smash the piles, reach the finish.'), role: 'finish' },
    roles: [
      { id: 'pile', kind: 'target', label: thing },
      { id: 'finish', kind: 'exit', label: goal },
    ],
    tutorial: {
      goalLine: fit(80, `Jump, smash the ${things}, reach the ${goal}!`, 'Jump the ramps, smash the piles, reach the finish!'),
      controlsHint: 'Drag or arrows to steer. Down or the brake button brakes.',
    },
    // Tři životy: náraz do mantinelu jeden stojí (`stunt_crash`).
    mechanics: [livesMechanic()],
    mood: 'adventurous',
    targetDurationSec: 45,
  });
}

/**
 * Rychlý návrh z věty bez AI: vozidlo (slovo vozidla s nejvýš dvěma slovy před ním, jinak hrdina slovníku), věc hromad
 * („a tower of crates“, „plows through a fence“) a místo za poslední předložkou místa (jinak místo slovníku, pokud to
 * není hromada – „into a tower of crates“ místo není). Ostatní věci věty hra nehraje.
 */
function draftStunt(sentence: string, reading: Parameters<GenreModule<'stunt'>['draftFill']>[1]): Partial<GenreSpecOf<'stunt'>> {
  const roles = draftRoles(sentence, reading);
  const text = withoutPossessor(sentence.toLowerCase());
  const words = text.match(/[a-z][a-z'-]*/g) ?? [];
  const hero = vehiclePhraseOf(words) ?? roles.hero;
  const thing = pileThingOf(text);
  const known = roles.setting === undefined || NOT_A_THING.test(roles.setting.toLowerCase()) ? undefined : roles.setting;
  const setting = placeOf(words) ?? known;
  const palette = setting === undefined ? null : lookFor(setting);
  const cast: CastItem[] = thing === null ? [] : [{ label: thing, does: 'avoid' }];
  return {
    genre: 'stunt',
    mode: 'default',
    ...(hero === undefined ? {} : { hero }),
    ...(setting === undefined ? {} : { setting }),
    ...(palette === null ? {} : { palette }),
    ...(cast.length === 0 ? {} : { cast }),
  };
}

/** Hotový modul: hraje, co slibuje. Do registru ho dosadí P68-I („zapoj stunt“). */
export const stuntLiveGenre: GenreModule<'stunt'> = {
  id: 'stunt',
  modes: ['default'],
  cues: STUNT_CUES,
  heroClasses: ['vehicle', 'animal', 'humanoid', 'robot'],
  paramBounds: STUNT_PARAM_BOUNDS,
  availability: () => 'ready',
  compile: compileStunt,
  draftFill: draftStunt,
};

const staged = stagedGenre('stunt', stuntLiveGenre.heroClasses);

/**
 * Modul v registru: narážky, meze a návrh hotové hry, ale viditelnost a překlad kostry (`stagedGenre`) – dokud P68-I
 * hru nezapojí. `paramBounds` čte i `readGenreSpec` ručního specu.
 */
export const stuntGenre: GenreModule<'stunt'> = { ...stuntLiveGenre, availability: staged.availability, compile: staged.compile };
