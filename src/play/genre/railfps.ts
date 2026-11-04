/**
 * Žánr Střelnice z očí na kolejích (P68-F T4, kategorie `prvni-osoba`): hráč jede po kolejích pohledem z očí (`first`),
 * natáčí se jednou kvantovanou osou po 9 sektorech a ťukem střílí terče a nepřátele z věty; nepřítel, který dojde až
 * k hráči, vezme život (ovládání `railfps`, vlastní dotykový adaptér `genres/railfps/RailfpsTouch.tsx`, generátor
 * `railfps_rail` a robot `railfps_bot` v `arcade/pieces/railfps*.ts`).
 *
 * Obsazení: kdo jde na hráče, je nepřítel věty (`shoot_at`, `chase_me`, `fight`, `avoid`; výchozí mimozemšťan), boss
 * je boss režiséra (`spec.boss`), jinak velký nepřítel téhož druhu; co stojí jako terč, je sbíraná věc nebo kulisa
 * věty (`collect`, `scenery`), jinak terč. Místo věty jde do `theme.setting` (vzhled z něj hádá `arcade/look`).
 *
 * Hloubka: `targets` věcí ke zničení dohromady (terče + nepřátelé + boss, `COUNT_PARAMS.railfps.default.enemy`),
 * `waves` vln (poslední končí bossem); 3 životy. Robot vyhraje do 90 s, nečinný hráč prohraje.
 *
 * Dostupnost zůstává `staged` jako v kostře P68-I T1: klasifikátor ani režisér žánr nevidí, dokud ho nezapne úloha
 * P68-I „zapoj railfps“ (buňka `PRESETS`, narážky v `classify.ts`, `ROUTE_PENDING`). E2e hraje z ručního specu
 * (`e2e/fixtures/p68-railfps-spec.json`).
 */

import { RAILFPS, railfpsWaveSizes } from '../arcade/pieces/railfps';
import { counted, nounPhrase, plural, singular, withoutPossessor } from '../draft/lexicon';

import { type CastItem, type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Výchozí obsazení, když ho věta nejmenuje. */
export const RAILFPS_DEFAULTS = { enemy: 'alien', target: 'target' } as const;

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

/** Nepřátel a terčů, jak je generátor rozdělí do vln (`railfpsWave`: nepřátel `enemyPct` % vlny, zaokrouhleno nahoru). */
export function railfpsSplit(targets: number, waves: number): { readonly foes: number; readonly marks: number } {
  const sizes = railfpsWaveSizes(targets, waves);
  const foes = sizes.reduce((sum, size) => sum + Math.ceil((size * RAILFPS.enemyPct) / 100), 0);
  return { foes, marks: sizes.reduce((sum, size) => sum + size, 0) - foes };
}

// ---------------------------------------------------------------------------
// Čtení věty: nepřítel z předmětu střelby, místo mimo jízdu

/** Míření s „at“ hned za slovesem („aim at crocodiles“, „fire at the monkeys“). */
const AIM = 'shoot|shoots|shooting|fire|fires|firing|blast|blasts|blasting|zap|zaps|zapping|aim|aims|aiming';
/** Vrh s nástrojem a cílem („splat paint balloons at clowns“, „fire arrows at the skeletons“). */
const FLING = 'splat|splats|splatting|throw|throws|throwing|toss|tosses|tossing|lob|lobs|lobbing|fling|flings|flinging|hurl|hurls|hurling|squirt|squirts|squirting|spray|sprays|spraying|fire|fires|firing|shoot|shoots|shooting|blast|blasts|blasting';
/** Předmět je zasažený („zap the ghosts“, „soak the pirates“, „gun down the orcs“); víceslovné tvary napřed. */
const HIT = [
  '(?:shoot|shoots|shooting|blast|blasts|blasting|take|takes|taking|gun|guns|gunning|knock|knocks|knocking|mow|mows|mowing) down',
  '(?:pick|picks|picking|fight|fights|fighting|fend|fends|fending|hold|holds|holding) off',
  '(?:wipe|wipes|wiping) out',
  'shoot|shoots|shooting|blast|blasts|blasting|zap|zaps|zapping|hit|hits|hitting|soak|soaks|soaking|splat|splats|splatting',
  'pop|pops|popping|kill|kills|killing|stop|stops|stopping|destroy|destroys|destroying|smash|smashes|smashing',
  'defeat|defeats|defeating|fight|fights|fighting|battle|battles|battling|freeze|freezes|freezing|stun|stuns|stunning',
].join('|');
/** Členy a množství před nepřítelem („all the“, „waves of“, „a swarm of“). */
const MANY = String.raw`(?:(?:the|all|every|endless|those|some|any|more)\s+)*(?:(?:a\s+)?(?:waves?|hordes?|swarms?|armies|army|packs?|hundreds|dozens|lots|rows?|gangs?|squads?|fleets?|flocks?|groups?|crowds?)\s+of\s+(?:the\s+)?)?`;
// Předmět v lookaheadu: shoda spotřebuje jen sloveso, takže `matchAll` najde i další výskyt po zájmenu („zap them“).
// „a shooting gallery at the county fair“: galerie není nástroj a pouť není nepřítel.
const FOE_OBJECT = new RegExp(String.raw`\b(?:(?:${AIM})\s+at|(?:${FLING})\s+(?!(?:the|a|an|all|every|at|gallery|range|game|games|shooter)\b)[a-z-]+(?:\s+[a-z-]+)?\s+at|(?:${HIT}))\s+${MANY}(?=([a-z][a-z -]*))`, 'g');
/** „zap them“, „shoot back“ nepřítel nejsou. */
const PRONOUN = /^(?:it|him|her|them|me|you|us|on|out|off|up|down|back|at|everything|everyone|anything|something)\b/;
/** „a shooting gallery“, „a shooting game“: druh hry, ne nepřítel. */
const NOT_FOE = new Set(['gallery', 'range', 'game', 'games', 'shooter', 'ride']);

/** Nepřítel z předmětu střelby (první platný výskyt ve větě), nebo `null`. */
function foeOf(sentence: string): string | null {
  for (const found of withoutPossessor(sentence.toLowerCase()).matchAll(FOE_OBJECT)) {
    const phrase = nounPhrase(found[1] as string);
    if (phrase !== null && !PRONOUN.test(phrase) && !NOT_FOE.has(phrase.split(' ').at(-1) as string)) return singular(phrase);
  }
  return null;
}

/** Na čem hráč jede (kolej, vozík, loď): jízda, ne místo – místo je to, čím jede („a mine cart through the tunnels“). */
const RIDES = new Set(['cart', 'carts', 'minecart', 'train', 'trains', 'boat', 'boats', 'coaster', 'coasters', 'jeep', 'jeeps', 'monorail', 'flume', 'rail', 'rails', 'track', 'tracks', 'ride', 'rides', 'car', 'cars', 'truck', 'raft', 'sled', 'sleigh', 'horseback', 'wagon', 'tram', 'trolley', 'bus', 'gondola', 'buggy', 'lift', 'elevator']);
/** Hlava fráze po předložce, která místo nejmenuje („through my own eyes“, „in the dark“, „on its own“). */
const NOT_PLACE = new Set(['eyes', 'eye', 'view', 'sight', 'way', 'own', 'time', 'turn', 'turns', 'once', 'front', 'order', 'aim', 'dark', 'darkness', 'rain', 'snow', 'fog', 'night', 'daylight', 'moonlight', 'air', 'person', 'first']);
/** Předložka místa; „follows the jungle road“ taky. Fráze v lookaheadu, ať `matchAll` najde každou předložku. */
const PLACE_AT = /\b(in|inside|across|through|on|around|into|along|aboard|out of|follows?|following|at)\s+(?=([a-z][a-z -]*))/g;
/** „at“ hned za střelbou míří, místo nejmenuje („fire at the monkeys“). */
const AIMED_AT = new RegExp(String.raw`\b(?:${AIM})\s+$`);

/**
 * Místo věty: první fráze po předložce, která není jízda ani nepřítel; „at“ až potom (jinak míří: „flying at your
 * cart“), jízda jako poslední možnost („on a roller coaster“). `null`, když věta místo neříká.
 */
function placeOf(sentence: string, foe: string | null): string | null {
  const text = withoutPossessor(sentence.toLowerCase().replace(/\s+/g, ' '));
  let atPlace: string | null = null;
  let ride: string | null = null;
  for (const found of text.matchAll(PLACE_AT)) {
    const phrase = nounPhrase(found[2] as string);
    if (phrase === null || PRONOUN.test(phrase)) continue;
    const head = phrase.split(' ').at(-1) as string;
    if (NOT_PLACE.has(head) || (foe !== null && singular(phrase) === foe)) continue;
    if (RIDES.has(head)) ride ??= phrase;
    else if (found[1] !== 'at') return phrase;
    else if (!AIMED_AT.test(text.slice(0, found.index))) atPlace ??= phrase;
  }
  return atPlace ?? ride;
}

const isRide = (label: string): boolean => RIDES.has(label.toLowerCase().split(' ').at(-1) ?? '');

export const railfpsGenre: GenreModule<'railfps'> = {
  id: 'railfps',
  modes: ['default'],
  // P68-I T10 („zapoj railfps“): doplněk znaku `railshoot` v `classify.ts`, který nese pohled se střelbou
  // (`integration.md` → Narážky).
  cues: ['first person', 'on rails', 'rail shooter'],
  heroClasses: ['humanoid', 'robot', 'animal', 'monster'],
  paramBounds: {
    targets: { min: RAILFPS.targets.min, max: RAILFPS.targets.max },
    waves: { min: RAILFPS.waves.min, max: RAILFPS.waves.max },
  },
  // Zapnuto v P68-I T10 („zapoj railfps“); režisér a čtečka ho nabízejí od R9.
  availability: () => 'ready',
  compile: (spec) => {
    const targets = spec.params?.targets ?? RAILFPS.targets.default;
    const waves = spec.params?.waves ?? RAILFPS.waves.default;
    const foe = castFor(spec, 'shoot_at', 'chase_me', 'fight', 'avoid')?.label ?? RAILFPS_DEFAULTS.enemy;
    const mark = castFor(spec, 'collect', 'scenery')?.label ?? RAILFPS_DEFAULTS.target;
    const one = singular(foe);
    const { foes, marks } = railfpsSplit(targets, waves);
    const total = foes + marks;
    const foesText = plural(one, foes);
    const marksText = plural(singular(mark), marks);
    const tuning = {
      ...(targets === RAILFPS.targets.default ? {} : { targets }),
      ...(waves === RAILFPS.waves.default ? {} : { waves }),
    };
    const wavesText = `${counted(waves, 'wave')}`;
    return legacySpec(spec, {
      control: 'railfps',
      controlParams: { generator: 'railfps_rail', ...(Object.keys(tuning).length === 0 ? {} : { tuning }) },
      archetype: 'combat_lite',
      title: fit(60, `${titleCase(one)} Range`, 'Rail Range'),
      objective: {
        kind: 'defeat_targets',
        description: fit(
          120,
          `Hit all ${String(total)} in ${wavesText}: ${String(foes)} ${foesText} and ${String(marks)} ${marksText}. Stop them before they reach you.`,
          `Hit all ${String(total)} in ${wavesText} before they reach you.`,
        ),
        count: total,
        role: 'enemy',
      },
      mechanics: [livesMechanic()],
      roles: [
        { id: 'enemy', kind: 'chaser', label: foe, count: foes },
        { id: 'target', kind: 'target', label: mark, count: marks },
        // Boss bez režiséra je velký nepřítel téhož druhu: scéna ho kreslí modelem nepřítele.
        ...(spec.boss === undefined ? [] : [{ id: 'boss', kind: 'target' as const, label: spec.boss.role }]),
      ],
      tutorial: {
        goalLine: fit(50, `Stop the ${plural(one, 2)} before they reach you!`, 'Stop them before they reach you!'),
        controlsHint: 'Tap to aim and shoot. Drag or arrows to look around.',
      },
      mood: 'tense',
      targetDurationSec: 70,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    // Střelnice zná nepřítele a terč: ostatní věci z věty se střílejí s nepřítelem.
    let roles: CastItem[] = (cast ?? []).filter((item) => item.does !== 'reach').map((item): CastItem => (item.does === 'collect' || item.does === 'scenery' ? item : { ...item, does: 'shoot_at' }));
    const foe = foeOf(sentence);
    if (foe !== null) roles = [{ label: foe, does: 'shoot_at' }, ...roles.filter((item) => item.label !== foe && item.does !== 'shoot_at')];
    // „aim at the giant spiders“: fráze po „at“, kterou čte slovník jako místo, je nepřítel, ne místo.
    const place = reading?.setting ?? placeOf(sentence, foe) ?? (setting !== undefined && singular(setting) !== foe ? setting : undefined);
    // „ride a train through the wild west“: vlak je jízda, ne hrdina – hrdinu doplní návrh.
    const rider = hero === undefined || isRide(hero) ? undefined : hero;
    return {
      genre: 'railfps',
      mode: 'default',
      ...(rider === undefined ? {} : { hero: rider }),
      ...(place === undefined || place === null ? {} : { setting: place }),
      ...(roles.length === 0 ? {} : { cast: roles.slice(0, 4) }),
    };
  },
};
