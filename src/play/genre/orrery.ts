/**
 * Typ Klikací simulace (P83C T2, `orrery`): věta, která nepopisuje hru, ale věc k prozkoumání („a solar system where
 * clicking a planet shows its name and makes it orbit faster“). Na scéně stojí 2–9 věcí z věty, hýbou se a klepnutí na
 * věc ji probudí – jmenovka a efekt podle věty (svítí / zrychlí / vyroste), další klepnutí efekt stupňuje (max 3).
 * Jádro, robot a generátor `orrery_scene` jsou v `arcade/pieces/orrery.ts`.
 *
 * **Parametry jsou celá čísla** (tvar `GenreSpec.params`): `things` 2–9, `layout` = index v `ORRERY_LAYOUTS`
 * (oběh, kruh, řada, rozházené), `answer` = index v `ORRERY_ANSWERS` (svítí, zrychlí, vyroste), `hub` 0/1 (první věc
 * stojí ve středu – slunce, jádro), `whole` = pořadí v `ORRERY_WHOLES` + 1 (0 = věci z věty). Věty sem vede znak
 * `explore` v `classify.ts` (P83C T4): klepnutí na věc, která odpoví jménem nebo změnou.
 *
 * **Věci z věty:** role `orrery0`–`orrery8` (druh těla jádra = id role, scéna najde popisek přes vazbu rolí). Věta
 * s méně věcmi, než je počet, je opakuje dokola (zahrada s „flower“ dá pět květin); s věcí ve středu jen věci kolem.
 */

import { ORRERY, ORRERY_ANSWERS, ORRERY_LAYOUTS, orreryKind } from '../arcade/pieces/orrery';
import { counted, nounPhrase, plural, readCountedNouns, singular } from '../draft/lexicon';

import { CAST_MAX, type CastItem, type GenreModule, draftRoles, legacySpec, titleCase } from './contract';

/** Věc, když věta žádnou nejmenuje. */
export const ORRERY_DEFAULTS = { things: ['planet'] } as const;

type Layout = (typeof ORRERY_LAYOUTS)[number];

/**
 * Známé celky (P83C T4): věta jmenuje celek, věci dá tabulka – „the solar system“ neřekne jména planet. Malá tabulka
 * z návrhu T1; celek, který tu není, bere věci z věty.
 */
export const ORRERY_WHOLES: readonly { readonly said: RegExp; readonly things: readonly string[]; readonly layout: Layout; readonly hub: boolean }[] = [
  { said: /\bsolar system\b/, things: ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'], layout: 'orbit', hub: true },
  { said: /\batoms?\b/, things: ['nucleus', 'electron', 'electron', 'electron', 'electron', 'electron', 'electron'], layout: 'orbit', hub: true },
  { said: /(?<!o')\bclocks?\b/, things: ['clock face', '12', '3', '6', '9'], layout: 'ring', hub: true },
  { said: /\borchestras?\b/, things: ['conductor', 'violin', 'cello', 'flute', 'trumpet', 'drum', 'harp'], layout: 'ring', hub: true },
  { said: /\brainbows?\b/, things: ['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet'], layout: 'row', hub: false },
  { said: /\bseasons\b/, things: ['spring', 'summer', 'autumn', 'winter'], layout: 'ring', hub: false },
];

/** Odpověď věty: zrychlí, vyroste, jinak svítí (jmenovku ukáže každé klepnutí). Vyhrává ta, kterou věta řekne dřív. */
const ANSWER_SAID: readonly (readonly [(typeof ORRERY_ANSWERS)[number], RegExp])[] = [
  ['faster', /\bfaster\b|\bquicker\b|\bspeed(?:s|ing)? (?:it |them |each one )?up\b|\bspin(?:s|ning)?\b|\bstarts? moving\b|\bwhirl/],
  ['bigger', /\bbigger\b|\blarger\b|\bgrow(?:s|ing)?\b|\bbloom(?:s|ing)?\b|\bswell/],
];
const ORBIT_SAID = /\borbit|\baround\b|\bcircl|\bround and round\b|\bcarousel|\brevolv/;
const ROW_SAID = /\brows?\b|\blines?\b|\bshel(?:f|ves)\b|\bshelf\b/;

/** Jmenná fráze výčtu: člen nebo číslovka, nejvýš dvě slova, žádné spojky, předložky ani klepnutí. */
const STOP = String.raw`(?:and|or|with|where|that|which|when|to|of|in|on|at|me|you|it|its|them|one|let|makes?|a|an|the|tap(?:s|ping)?|click(?:s|ing)?|touch(?:es|ing)?|explore|show|see)`;
const WORD = String.raw`(?!${STOP}\b)[a-z-]+`;
const DET = String.raw`(?:a|an|the|some|little|small|tiny|big|giant|\d+|two|three|four|five|six|seven|eight|nine)`;
const NP = String.raw`(?:${DET} )?(?:${WORD} )?${WORD}`;
/** „a cow, a pig, a sheep and a horse“, „lollipops, cupcakes and donuts“, „an apple, a banana or a pear“. */
const LIST = new RegExp(String.raw`\b${NP}(?:, ${NP})*,? (?:and|or) ${NP}\b`, 'g');
/** Položka výčtu je věc: má člen nebo je v množném čísle („ring and glow“ výčet věcí není). */
const THING_ITEM = new RegExp(String.raw`^(?:${DET} |.*[a-rt-z]s\b)`);
/** Množné číslo a za ním slovo je věc a její sloveso („donuts light up“), ne dvouslovná věc („lily pads“). */
const PLURAL_THEN = /^([a-z-]*[a-rt-z]s) [a-z-]+$/;
/** Předmět klepnutí („tapping each flower“, „click the mushroom“). */
const TOUCHED_THING = new RegExp(String.raw`\b(?:tap|click|touch|press|poke)(?:s|es|ed|ped|ing|ping)? (?:on )?(?:a|an|the|each|every|any) (${NP})`, 'g');
/** Věc za „with“ / „of“, když věta nemá výčet („a row of bells“, „a toy train with five wagons“). */
const HELD_THING = new RegExp(String.raw`\b(?:with|of) (${NP})`, 'g');
/** Věc ve středu („fireflies circling a lamp“, „a beehive with bees flying around it“). */
const AROUND = new RegExp(String.raw`\b(?:around|circling|orbiting|round) (?:a|an|the) (${NP})`);
const AROUND_IT = new RegExp(String.raw`\b(?:a|an|the) (${NP}) with (?:[a-z]+ )?[a-z-]+ [a-z]+ing (?:around|round) it\b`);
const PATH = /^(?:track|road|path|room|field|table|park|world|town|city|corner|block)$/;
const NOT_THING = /^(?:one|it|them|thing|name|color|colour|time|way|lights?|night|day)$/;

/** Popisek věci: bez členu a číslovky, v jednotném čísle; `null` pro slovo, které věc není. */
function thingOf(phrase: string): string | null {
  const noun = nounPhrase(phrase.replace(/^(?:little|small|tiny|big|giant) /, ''), 2);
  if (noun === null) return null;
  const one = singular(PLURAL_THEN.exec(noun)?.[1] ?? noun);
  return NOT_THING.test(one) ? null : one;
}

/** Věci, které věta jmenuje: výčty, předmět klepnutí, věc za „with“ / „of“ (jen bez výčtu); věc ve středu první. */
export function orreryThingsOf(sentence: string): { readonly things: readonly string[]; readonly hub: string | null } {
  const text = sentence.toLowerCase().replace(/\s+/g, ' ');
  const listed = [...text.matchAll(LIST)].flatMap((match) => {
    const items = match[0].split(/, (?:and |or )?| and | or /);
    return items.every((item) => THING_ITEM.test(item)) ? items : [];
  });
  const touched = [...text.matchAll(TOUCHED_THING)].map((match) => match[1] as string);
  const held = listed.length > 0 ? [] : [...text.matchAll(HELD_THING)].map((match) => match[1] as string);
  const center = AROUND.exec(text)?.[1] ?? AROUND_IT.exec(text)?.[1];
  const hub = center === undefined ? null : thingOf(center);
  const things = [...new Set([...listed, ...touched, ...held].map(thingOf).filter((thing): thing is string => thing !== null && thing !== hub))];
  return { things, hub: hub !== null && !PATH.test(hub) && things.length > 0 ? hub : null };
}

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

/**
 * Věci k prozkoumání: kulisy a sbírané z obsazení, bez opakování. Popisek zůstane, jak ho věta dala – `singular`
 * by z vlastních jmen udělal nesmysl („mars“ → „mar“); jednotné číslo dává čtení věty (`orreryThingsOf`).
 */
function thingLabels(cast: readonly CastItem[]): string[] {
  const labels = cast.filter((item) => item.does === 'scenery' || item.does === 'collect').map((item) => item.label);
  return [...new Set(labels)].slice(0, ORRERY.things.max);
}

/** Index z parametru, oříznutý do délky výčtu. */
const pick = <T>(list: readonly T[], index: number | undefined, fallback: number): T => list[Math.min(list.length - 1, Math.max(0, index ?? fallback))] as T;

const clampThings = (count: number): number => Math.min(ORRERY.things.max, Math.max(ORRERY.things.min, count));

export const orreryGenre: GenreModule<'orrery'> = {
  id: 'orrery',
  modes: ['default'],
  // Věty vede znak `explore` v `classify.ts`; narážka přidá bod jen slovu, které jinou hru nejmenuje.
  cues: ['interactive model'],
  heroClasses: ['humanoid', 'animal', 'robot', 'monster', 'prop'],
  paramBounds: {
    things: { min: ORRERY.things.min, max: ORRERY.things.max },
    layout: { min: 0, max: ORRERY_LAYOUTS.length - 1 },
    answer: { min: 0, max: ORRERY_ANSWERS.length - 1 },
    hub: { min: 0, max: 1 },
    whole: { min: 0, max: ORRERY_WHOLES.length },
  },
  // P83C T4: věty sem vede znak `explore`; buňka `orrery.default` je v `PRESETS`.
  availability: () => 'ready',
  compile: (spec) => {
    const whole = (spec.params?.whole ?? 0) > 0 ? ORRERY_WHOLES[(spec.params?.whole as number) - 1] : undefined;
    const said = thingLabels(spec.cast ?? []);
    const labels = whole?.things ?? (said.length > 0 ? said : [...ORRERY_DEFAULTS.things]);
    const things = clampThings(spec.params?.things ?? (whole !== undefined ? whole.things.length : said.length >= ORRERY.things.min ? said.length : ORRERY.things.default));
    const layout = pick(ORRERY_LAYOUTS, spec.params?.layout, whole === undefined ? 0 : ORRERY_LAYOUTS.indexOf(whole.layout));
    const answer = pick(ORRERY_ANSWERS, spec.params?.answer, 0);
    const hub = spec.params?.hub === undefined ? whole?.hub === true : spec.params.hub === 1;
    // Věc ve středu je jedna; věci kolem ní se opakují dokola („a lamp“ a pět světlušek).
    const centered = hub && labels.length > 1;
    const labelOf = (index: number): string =>
      (centered ? (index === 0 ? labels[0] : labels[1 + ((index - 1) % (labels.length - 1))]) : labels[index % labels.length]) as string;
    const unique = [...new Set(labels)];
    const named = unique.slice(0, 3).map((label) => (unique.length === 1 ? plural(label, 2) : label));
    const list = named.length === 1 ? (named[0] as string) : `${named.slice(0, -1).join(', ')} and ${named.at(-1) as string}`;
    const does = answer === 'faster' ? 'spin faster' : answer === 'bigger' ? 'grow' : 'light up';
    return legacySpec(spec, {
      control: 'orrery',
      controlParams: { generator: 'orrery_scene', tuning: { things, layout, answer, hub } },
      archetype: 'collect_exit',
      title: fit(80, titleCase(spec.setting), 'Tap and See'),
      objective: {
        kind: 'collect',
        description: fit(120, `Tap the ${list} to see their names and make them ${does}: wake all ${String(things)}.`, `Tap each of the ${counted(things, 'thing')} to wake it.`),
        count: things,
        role: orreryKind(0),
      },
      mechanics: [],
      roles: Array.from({ length: things }, (_, index) => ({ id: orreryKind(index), kind: 'target' as const, label: labelOf(index) })),
      tutorial: {
        goalLine: fit(50, `Tap the ${list}!`, `Wake all ${counted(things, 'thing')}!`),
        controlsHint: 'Tap a thing to wake it, tap again for more. Arrows and Space work too.',
        // Prohra žádná (návrh T1): řádek to řekne, jinak by obrazovka pravidel prohru mlčky vynechala.
        loseLine: 'Nothing to lose here, tap as long as you like.',
      },
      mood: 'curious',
      targetDurationSec: ORRERY.parSeconds,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    const text = sentence.toLowerCase();
    const wholeIndex = ORRERY_WHOLES.findIndex((entry) => entry.said.test(text));
    const whole = ORRERY_WHOLES[wholeIndex];
    const read = orreryThingsOf(sentence);
    // Klikací simulace nemá nepřítele: z obsazení zůstanou jen věci k prozkoumání, když věta sama žádné nejmenuje.
    const spare = (cast ?? []).filter((item) => item.does === 'scenery' || item.does === 'collect').map((item) => singular(item.label));
    const said = read.things.length > 0 ? read.things : spare;
    const labels = whole?.things ?? [...(read.hub === null ? [] : [read.hub]), ...said];
    const hub = whole?.hub ?? read.hub !== null;
    // Počet z věty („five wagons“, „three machines“) u věci, kterou věta jmenuje; jinak výčet, jinak výchozí.
    const countedThing = readCountedNouns(sentence).find((entry) => said.includes(singular(entry.noun)));
    const around = hub ? 1 : 0;
    const things = clampThings(
      whole !== undefined ? whole.things.length : countedThing !== undefined ? countedThing.count + around : labels.length >= ORRERY.things.min && said.length > 1 ? labels.length : ORRERY.things.default,
    );
    const layout: Layout = whole?.layout ?? (hub || ORBIT_SAID.test(text) ? 'orbit' : ROW_SAID.test(text) ? 'row' : things >= 6 ? 'ring' : 'scatter');
    const answer = ANSWER_SAID.map(([name, pattern]) => [name, pattern.exec(text)?.index ?? Infinity] as const).sort((a, b) => a[1] - b[1]).find(([, at]) => at !== Infinity)?.[0] ?? 'glow';
    const roles = [...new Set(labels)].slice(0, CAST_MAX).map((label): CastItem => ({ label, does: 'scenery' }));
    return {
      genre: 'orrery',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(roles.length === 0 ? {} : { cast: roles }),
      params: { things, layout: ORRERY_LAYOUTS.indexOf(layout), answer: ORRERY_ANSWERS.indexOf(answer), hub: hub && (layout === 'orbit' || layout === 'ring') ? 1 : 0, whole: wholeIndex + 1 },
    };
  },
};
