/**
 * Žánr Plavba/Let (P32F T3): volné řízení – loď, koště, letadlo, raketa, pes
 * ve městě. Režimy jdou na generátory T1 přes `controlParams.generator`:
 * `race` na `voyage_race` (brány, střely a stojící překážky mezi břehy, cíl na
 * konci), `land` na `voyage_land` (tah a náklon, měkký dotyk na ploše).
 * Ovládání ve specu je `steer`, takže obtížnost a délku soudí `readGameSpec`
 * jako dřív; vlastní klíče režimu (`terrain`, `topSpeed`, `gravity`) nese
 * `tuning` a validuje je schéma generátoru.
 *
 * Referenční věty: „A pirate ship dodges cannonballs while sailing between
 * islands to find buried treasure“, „A rocket lands on Mars“, „A dog walks
 * through a city“ (`evals/play/p32/sentences.json`).
 */

import { type LookId, lookFor } from '../arcade/look';
import { LAND, VOYAGE, VOYAGE_TERRAINS } from '../arcade/pieces/steer';
import { nounPhrase } from '../draft/lexicon';

import { type GenreModule, type GenreSpecOf, type ModelClass, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

type Terrain = (typeof VOYAGE_TERRAINS)[number];

/** Sady vzhledu, kde se jede po vodě mezi ostrovy, a kde ulicemi mezi domy; ostatní mají skály. */
const WATER: readonly LookId[] = ['ocean', 'beach', 'underwater'];
const STREETS: readonly LookId[] = ['city', 'mall', 'supermarket', 'factory', 'living_room'];

const terrainOf = (look: LookId | undefined): Terrain => (look === undefined || WATER.includes(look) ? 'islands' : STREETS.includes(look) ? 'buildings' : 'rocks');

/**
 * Co letí přes trať, když věta nejmenuje nepřítele: koule mezi ostrovy, balvan mezi skálami, auto přes ulici.
 * Scéna je kreslí primitivem jádra (`arcade/models.ts`), model z popisku dostane jen nástraha z věty (P39 T9).
 */
export const CROSSING:Readonly<Record<Terrain, string>> = { islands: 'cannonball', rocks: 'boulder', buildings: 'car' };

/**
 * Kam se jede, když věta cíl neříká (P35 T8): místo, které k prostředí patří
 * a katalog pro ně má model. Procházka psa městem končila u mince, kterou věta
 * nezmínila, a AI verze u „finish line“; bez sady vzhledu se pluje k majáku.
 */
const DESTINATION: Readonly<Record<LookId, string>> = {
  meadow: 'windmill',
  city: 'fountain',
  mall: 'shop',
  supermarket: 'checkout',
  living_room: 'sofa',
  factory: 'exit',
  forest: 'cabin',
  jungle: 'temple',
  desert: 'well',
  beach: 'lighthouse',
  ocean: 'lighthouse',
  underwater: 'ruins',
  snow: 'igloo',
  volcano: 'volcano',
  cave: 'exit',
  space: 'planet',
  castle: 'tower',
  graveyard: 'tower',
};

export const destinationOf = (look: LookId | undefined): string => (look === undefined ? 'lighthouse' : DESTINATION[look]);

/**
 * Třída hrdiny podle slov popisku, čtených od konce jako v `heroFor`
 * (`assets/manifest.ts`): „pirate ship“ je loď, ne pirát. Pro scénu, když
 * manifest pro hrdinu model nemá; loď je vždy `boat`, nikdy `vehicle`.
 */
const CLASS_WORDS: readonly (readonly [ModelClass, RegExp])[] = [
  ['boat', /^(?:boat|ship|sailboat|sailship|yacht|submarine|canoe|kayak|raft|ferry|galleon|gondola|steamboat)s?$/],
  ['aircraft', /^(?:plane|airplane|aeroplane|jet|helicopter|rocket|spaceship|spacecraft|shuttle|lander|ufo|drone|balloon|glider|airship)s?$/],
  ['humanoid', /^(?:broom|broomstick|witch|wizard|pilot|astronaut|pirate|knight|man|woman|boy|girl|kid)s?$/],
  ['vehicle', /^(?:car|truck|bus|bike|bicycle|motorcycle|motorbike|kart|tank|train|tractor|taxi|van|scooter|skateboard)s?$/],
  ['animal', /^(?:dog|puppy|puppies|cat|kitten|horse|pony|ponies|fox|wolf|wolves|bear|rabbit|bunny|bunnies|frog|turtle|duck|fish|dolphin|whale|shark|penguin|pig|cow|mouse|mice|lion|tiger|deer|unicorn)s?$/],
];

export function voyageHeroClass(hero: string): ModelClass {
  const words = hero.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const word of words.reverse()) {
    const hit = CLASS_WORDS.find(([, pattern]) => pattern.test(word));
    if (hit !== undefined) return hit[0];
  }
  return 'vehicle';
}

/** „lands“, „landing“, „touches down“ – přistání; „island“ ne. */
const LAND_CUE = /\b(?:land(?:s|ed|ing)?|touch(?:es|ed|ing)? down)\b/i;

/** Kudy se jede, když věta místo neuvede předložkou „in/on/at“: „sailing between islands“. */
const COURSE_CUE = /\b(?:between|through|across|over|along|around|past) (?:the |a |an )?([a-z][a-z -]*)/;

function compileVoyage(spec: GenreSpecOf<'voyage'>) {
  const palette = spec.palette ?? lookFor(spec.setting) ?? undefined;
  const looked = palette === undefined ? spec : { ...spec, palette };
  const title = titleCase(spec.hero);
  const params = spec.params ?? {};
  if (spec.mode === 'land') {
    return legacySpec(looked, {
      control: 'steer',
      controlParams: { generator: 'voyage_land', difficulty: 'normal', tuning: { gravity: params.gravity ?? LAND.gravity.default } },
      archetype: 'hazard_crossing',
      title: `${title} Landing`,
      objective: { kind: 'reach', description: 'Touch down slowly and level on the landing pad.', role: 'pad' },
      roles: [{ id: 'pad', kind: 'exit', label: 'landing pad' }],
      tutorial: { goalLine: 'Land softly and level on the pad.', controlsHint: 'Arrows or drag to tilt. Up, Space or a second finger fires the engine.' },
      // Tvrdý dotyk ubere život a loď začne znovu nahoře (P36A T2).
      mechanics: [livesMechanic()],
      mood: 'tense',
      targetDurationSec: 45,
    });
  }
  const terrain = terrainOf(palette);
  // Plavba neumí střelbu ani honičku: každý protivník věty je nástraha na trati, věc i cíl jsou místo, kam se pluje (P39).
  const hazard = castFor(spec, 'avoid', 'chase_me', 'shoot_at', 'fight', 'throw_at')?.label ?? CROSSING[terrain];
  const goal = castFor(spec, 'collect', 'reach')?.label ?? destinationOf(palette);
  return legacySpec(looked, {
    control: 'steer',
    controlParams: {
      generator: 'voyage_race',
      difficulty: 'normal',
      // Delší trať ve třetinách, ke konci hustší překážky (P36A T4); uložená hra bez `sections` jede jako dřív.
      lengthM: params.lengthM ?? VOYAGE.sectionLengthM,
      tuning: { terrain, sections: 3, ...(params.topSpeed === undefined ? {} : { topSpeed: params.topSpeed }) },
    },
    archetype: 'hazard_crossing',
    title: `${title} Voyage`,
    objective: { kind: 'reach', description: `Pass every gate, dodge the ${hazard} and reach the ${goal}.`, role: 'finish' },
    roles: [
      { id: 'gate', kind: 'checkpoint', label: 'gate' },
      { id: 'hazard', kind: 'hazard', label: hazard },
      { id: 'finish', kind: 'exit', label: goal },
    ],
    tutorial: { goalLine: `Pass every gate and reach the ${goal}.`, controlsHint: 'Drag or arrows to steer. Down or a second finger brakes.' },
    // Tři životy měla plavba vždy (`VOYAGE.lives`); ve specu je vidí i HUD a nese číslo z věty (P36A T2).
    mechanics: [livesMechanic()],
    mood: 'adventurous',
  });
}

export const voyageGenre: GenreModule<'voyage'> = {
  id: 'voyage',
  modes: ['race', 'land'],
  cues: ['sail', 'fly', 'ride', 'drive', 'pilot', 'walk through', 'cruise', 'land'],
  heroClasses: ['boat', 'aircraft', 'vehicle', 'animal', 'humanoid'],
  paramBounds: {
    lengthM: { min: VOYAGE.lengthM.min, max: VOYAGE.lengthM.max },
    topSpeed: { min: VOYAGE.topSpeed.min, max: VOYAGE.topSpeed.max },
    /** Gravitace přistání v tisícinách jednotky za tik² (1000 ≈ Mars). */
    gravity: { min: LAND.gravity.min, max: LAND.gravity.max },
  },
  availability: () => 'ready',
  compile: compileVoyage,
  draftFill: (sentence, reading) => {
    const roles = draftRoles(sentence, reading);
    const course = COURSE_CUE.exec(sentence.toLowerCase());
    const setting = roles.setting ?? (course === null ? null : nounPhrase(course[1]!, 2)) ?? undefined;
    const palette = setting === undefined ? null : lookFor(setting);
    return {
      genre: 'voyage',
      mode: LAND_CUE.test(sentence) ? 'land' : 'race',
      ...roles,
      ...(setting === undefined ? {} : { setting }),
      ...(palette === null ? {} : { palette }),
    };
  },
};
