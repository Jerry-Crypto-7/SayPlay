/**
 * Nálada, počasí a denní doba z celé věty (P54B T11). Čte se slovo kdekoli ve větě
 * („a witch brews potions in a crooked tower during a thunderstorm“), ne jen v místě,
 * které z věty vypadlo. Zápor („but not at night“, „no rain in sight“), přirovnání
 * („punches like a thunderstorm“, „as silent as the night“), metafora („a storm of
 * arrows“) a sloveso („knights storm the castle“) se nepočítají.
 *
 * Výsledek zapíše návrh do uloženého `theme` (`sentenceSky`); místo a náladu specu čte
 * scéna dál postaru (`placeMood`, `placeTime`), takže stará uložená hra vypadá stejně.
 */

import type { Mood, TimeOfDay, Weather } from './index';

/** Zápor nejvýš dvě slova před slovem světla ve stejné větě (čárka větu dělí). */
const NEGATED = /\b(?:not|no|never|without|nor|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|can't|cannot)\s+(?:\S+\s+){0,2}$/;
/** Přirovnání těsně před slovem: „like a …“, „as silent as the …“. */
const SIMILE = /\b(?:like|as\s+\S+\s+as)\s+(?:(?:a|an|the)\s+)?$/;
/** Metafora za slovem: „a storm of arrows“, „a rain of fire“. */
const METAPHOR = /^\s+of\b/;
/** „storm“ jako sloveso: za ním předmět, před ním není člen ani přívlastek bouře. */
const STORM_VERB_AFTER = /^\s+(?:the|a|an|into|through|across|past|towards?|out|his|her|their|its|our|my|your)\b/;
const STORM_NOUN_BEFORE = /\b(?:a|an|the|during|heavy|big|raging|wild|great|huge|sudden|tropical|winter|summer|massive|dark|electric|perfect|epic|thunder)\s+$/;

/** Věta slovo vzorku opravdu říká: aspoň jeden výskyt není v záporu, přirovnání, metafoře ani sloveso. */
function affirmed(text: string, pattern: RegExp): boolean {
  const lower = text.toLowerCase().replaceAll('’', "'");
  for (const hit of lower.matchAll(new RegExp(pattern.source, 'g'))) {
    const before = lower.slice(0, hit.index).split(/[,.;:!?]/).at(-1)!;
    const after = lower.slice(hit.index + hit[0].length);
    if (NEGATED.test(before) || SIMILE.test(before) || METAPHOR.test(after)) continue;
    if (/^storms?$/.test(hit[0]) && STORM_VERB_AFTER.test(after) && !STORM_NOUN_BEFORE.test(before)) continue;
    return true;
  }
  return false;
}

/*
 * Denní doba: noc, a soumrak i úsvit a ráno – nízké teplé slunce; denní doba „úsvit“
 * v `TIMES_OF_DAY` není, kreslí se jako soumrak. Noc má přednost.
 */
const NIGHT = /\b(?:night|nights|nighttime|night-time|midnight|tonight|moonlit|moonlight|after dark)\b/;
const DUSK = /\b(?:dusk|sunset|sundown|evening|twilight|dawn|sunrise|daybreak|morning)\b/;

export function timeOfDayFor(text: string): TimeOfDay | null {
  if (affirmed(text, NIGHT)) return 'night';
  if (affirmed(text, DUSK)) return 'dusk';
  return null;
}

/** Počasí: sníh („snowy“, „blizzard“; koule a pevnost ze sněhu ne), déšť a bouřka, mlha. Sníh má přednost – je konkrétnější. */
const SNOW = /\b(?:snowy|snowing|snows|snowfall|snowstorms?|blizzards?|sleet|falling snow|snow falls|snow is falling)\b/;
const RAIN = /\b(?:rain|rains|rainy|raining|rainfall|rainstorms?|downpour|drizzle|drizzling|storms?|stormy|thunderstorms?|thunder|monsoon)\b/;
const FOG = /\b(?:fog|foggy|mist|misty|haze|hazy|smog)\b/;

export function weatherFor(text: string): Weather | null {
  if (affirmed(text, SNOW)) return 'snow';
  if (affirmed(text, RAIN)) return 'rain';
  if (affirmed(text, FOG)) return 'fog';
  return null;
}

/** Místa, u kterých „dark“ znamená šero („a dark forest“); „dark armor“ je barva. */
const DARK_PLACES =
  'forest|forests|woods|wood|woodland|jungle|swamp|cave|caves|cavern|tunnel|tunnels|dungeon|crypt|castle|tower|mansion|house|room|rooms|hall|hallway|corridor|corridors|basement|alley|alleys|street|streets|road|city|town|village|world|place|maze|valley|sea|ocean|depths|sky|skies|space|planet|lair|night';

/**
 * Slova → nálada, pořadí rozhoduje (strašidelný temný les je strašidelný). Druhý vzorek čte
 * náladu specu postaru – „cozy“ a „eerie“ v ní píšou žánry samy, takže světlo z ní nečtou.
 */
const MOODS: readonly (readonly [Mood, RegExp, RegExp | null])[] = [
  ['spooky', /\b(?:spooky|haunted|creepy|eerie)\b/, /\b(?:spooky|haunted|creepy)\b/],
  ['storm', RAIN, /\b(?:storm|stormy|rain|rainy|raining)\b/],
  ['gloom', new RegExp(`\\b(?:darkness|gloomy|gloom|shadowy|pitch[- ]black|in the dark|dark\\s+(?:\\w+\\s+)?(?:${DARK_PLACES}))\\b`), /\b(?:dark|darkness|gloomy|shadowy)\b/],
  ['fog', FOG, /\b(?:fog|foggy|mist|misty)\b/],
  ['bright', /\b(?:sunny|sunshine|sunlit|sun-drenched|bright\s+(?:\w+\s+)?(?:day|days|sun|sky|skies|morning|afternoon|light|meadow|beach))\b/, /\b(?:sunny|bright)\b/],
  ['dusk', /\b(?:sunset|sundown|dusk)\b/, /\b(?:sunset|dusk)\b/],
  ['cozy', /\b(?:cozy|cosy)\b/, null],
];

/** Nálada z věty (nebo místa) a nálady specu; `null` = o světle nic. */
export function moodFor(text: string, mood = ''): Mood | null {
  const spec = mood.toLowerCase();
  return MOODS.find(([, said, written]) => affirmed(text, said) || (written !== null && written.test(spec)))?.[0] ?? null;
}

/*
 * Čtení uloženého místa a nálady specu, jak ho sada měla před P54B T11 (P46G T5, P29D): stará hra
 * bez `theme.weather` a `theme.timeOfDay` musí vypadat stejně, tak tady nová slova ani zápor nejsou.
 */

/** Denní doba z uloženého místa. */
export function placeTime(setting: string): TimeOfDay | null {
  if (/\b(?:at night|nighttime|night-time|midnight)\b/i.test(setting) || /^night$/i.test(setting.trim())) return 'night';
  if (/\b(?:dusk|sunset|evening)\b/i.test(setting)) return 'dusk';
  return null;
}

export type PlaceMood = Exclude<Mood, 'cozy' | 'snow'>;

/** Slova → nálada. Pořadí rozhoduje: strašidelný temný les je strašidelný, bouřka je tmavá i bez „dark“. */
const PLACE_MOODS: readonly (readonly [PlaceMood, RegExp])[] = [
  ['spooky', /\b(?:spooky|haunted|creepy)\b/],
  ['storm', /\b(?:storm|stormy|rain|rainy|raining)\b/],
  ['gloom', /\b(?:dark|darkness|gloomy|shadowy)\b/],
  ['fog', /\b(?:fog|foggy|mist|misty)\b/],
  ['bright', /\b(?:sunny|bright)\b/],
  ['dusk', /\b(?:sunset|dusk)\b/],
];

/** Nálada ze slov uloženého místa i nálady specu; `null` = o světle nic a sada zůstane, jaká byla. */
export function placeMood(setting: string, mood: string): PlaceMood | null {
  const text = `${setting} ${mood}`.toLowerCase();
  return PLACE_MOODS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

/**
 * Počasí a denní doba z celé věty pro uložené `theme` (P54B T11): co věta řekne o světle, uloží
 * návrh a hra to ukáže od prvního snímku. Pole, které `theme` už má, zůstane. Nálada vlastní pole
 * nemá: do denní doby jde, jen když ji místo a nálada specu samy neukážou („a goblin castle
 * through a dark forest“) – šero a strašidelno jako noc, útulno jako teplý soumrak. Jasno ve dne
 * se neukládá, je výchozí.
 */
export function sentenceSky(sentence: string, theme: { readonly setting: string; readonly mood: string; readonly weather?: Weather; readonly timeOfDay?: TimeOfDay }): { weather?: Weather; timeOfDay?: TimeOfDay } {
  const weather = theme.weather ?? weatherFor(sentence) ?? undefined;
  const said = placeMood(theme.setting, theme.mood) === null ? moodFor(sentence) : null;
  const moodTime = said === 'gloom' || said === 'spooky' ? 'night' : said === 'cozy' ? 'dusk' : null;
  const timeOfDay = theme.timeOfDay ?? timeOfDayFor(sentence) ?? moodTime ?? undefined;
  return { ...(weather === undefined ? {} : { weather }), ...(timeOfDay === undefined ? {} : { timeOfDay }) };
}
