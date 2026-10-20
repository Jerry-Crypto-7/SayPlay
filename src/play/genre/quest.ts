/**
 * Žánr Úkol (P32G T4): slovesa na předmětech – zapal, uhas, oprav, uvař. Věta
 * dá sloveso, předmět a počet; sloveso určí druh vizuálu (`verbKind`) a kolik
 * viditelných stavů předmět projde. V prostoru hraje `quest_spatial` (s
 * pronásledovateli, aspoň s jedním výchozím), na místě `quest_station` (sporák,
 * dílna, s přetečením); stav cíle posouvá pravidlo `interact`.
 */

import { readCountedNouns, nounPhrase, plural, singular } from '../draft/lexicon';
import { ESCAPE } from '../arcade/pieces/arena';
import { QUEST, questRounds, questSpatial, questStation, spatialRoundSeconds, stationRoundSeconds } from '../arcade/pieces/quest';
import { WAVE_PLAN, wavesChasers } from '../arcade/pieces/waves';
import { type CastItem, type GenreModule, type GenreSpecOf, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Výchozí počty generátorů: bez `count` ve specu hraje, co by postavil generátor sám. */
const SPATIAL = questSpatial.params.parse({});
const STATION = questStation.params.parse({});
/** Pult stanoviště má tři místa (`quest_station` víc cílů nebere). */
const STATION_MAX = 3;
/** Čtyři pronásledovatelé robot vyhraje jen u 94 % semínek (T2); tři a méně spolehlivě. */
const CHASERS_MAX = 3;
/**
 * Úkol v prostoru bez honičky ve větě má jednoho pronásledovatele (P36A T3):
 * bez něj nečinnému hráči nic nehrozí a tři životy by nikdo nebral. Rychlost
 * zůstává `QUEST.chaserSpeed` – férový start ho k nečinnému pustí až po 5 s.
 */
export const DEFAULT_CHASERS = 1;

export type VerbKind = 'fire' | 'flame' | 'cook' | 'repair' | 'free' | 'grow';

/** Kolik viditelných stavů předmět druhu projde: hoří → kouří → uhašeno, knot → plamínek. */
export const KIND_STATES: Readonly<Record<VerbKind, 2 | 3>> = { fire: 3, flame: 2, cook: 3, repair: 2, free: 2, grow: 3 };

/** Sloveso → druh vizuálu; scéna podle něj kreslí stavy cíle. */
export const VERB_KIND: Readonly<Record<string, VerbKind>> = {
  extinguish: 'fire',
  spray: 'fire',
  'put out': 'fire',
  light: 'flame',
  ignite: 'flame',
  cook: 'cook',
  bake: 'cook',
  fry: 'cook',
  flip: 'cook',
  // Rodina vaření (P37A T3): cílem úkolu je sloveso věty, scéna kreslí stavy jídla jako u „cook“.
  brew: 'cook',
  grill: 'cook',
  stir: 'cook',
  whisk: 'cook',
  knead: 'cook',
  frost: 'cook',
  simmer: 'cook',
  roast: 'cook',
  pour: 'cook',
  'meal prep': 'cook',
  repair: 'repair',
  fix: 'repair',
  free: 'free',
  rescue: 'free',
  unlock: 'free',
  water: 'grow',
  plant: 'grow',
};

/**
 * Druh slovesa, nebo `null` pro sloveso bez vizuálu (třeba „paint“). Pravidlo
 * nese sloveso jedním slovem („put-out“), věta a spec dvěma („put out“).
 */
export function verbKindOf(verb: string): VerbKind | null {
  const key = verb.trim().toLowerCase().replace(/-/g, ' ');
  // Jen vlastní klíče: „constructor“ by jinak našel `Object` z prototypu.
  return Object.hasOwn(VERB_KIND, key) ? (VERB_KIND[key] as VerbKind) : null;
}

const CUES = ['light', 'ignite', 'extinguish', 'spray', 'put out', 'cook', 'bake', 'flip', 'fry', 'repair', 'fix', 'free', 'rescue', 'unlock', 'water', 'plant', 'paint'];

/** Nepravidelné tvary, které pravidla přípon níž nedají. */
const IRREGULAR: Readonly<Record<string, readonly string[]>> = { light: ['lit'] };

/** Tvary slovesa ve větě: „lights“, „fried“, „flipping“, „puts out“. Nadbytečné tvary nevadí, ve větě nejsou. */
function verbPattern(cue: string): RegExp {
  const [head = cue, ...rest] = cue.split(' ');
  const stem = head.slice(0, -1);
  const last = head.slice(-1);
  const forms = [head, `${head}s`, `${head}es`, `${head}d`, `${head}ed`, `${head}ing`, `${stem}ing`, `${stem}ies`, `${stem}ied`, `${head}${last}ed`, `${head}${last}ing`, ...(IRREGULAR[head] ?? [])];
  return new RegExp(`\\b(?:${forms.join('|')})${rest.map((word) => ` ${word}`).join('')}\\b`, 'i');
}

const CUE_PATTERNS = CUES.map((cue) => [cue, verbPattern(cue)] as const);

/** Sloveso úkolu, které ve větě stojí nejdřív, a text za ním. */
function verbIn(sentence: string): { readonly verb: string; readonly after: string } | null {
  let found: { verb: string; at: number; end: number } | null = null;
  for (const [verb, pattern] of CUE_PATTERNS) {
    const match = pattern.exec(sentence);
    if (match !== null && (found === null || match.index < found.at)) found = { verb, at: match.index, end: match.index + match[0].length };
  }
  return found === null ? null : { verb: found.verb, after: sentence.slice(found.end) };
}

/** Kuchyně a dílna hrají na místě; vaření vždy. */
const STATION_WORDS = /\b(?:kitchen|stove|oven|grill|counter|bakery|workbench|workshop)\b/i;

/** „before the ghosts catch him“, „before two ghosts get you“ → kdo honí a kolik. */
const CATCH = /\bbefore (.+?) (?:catch|catches|get|gets|grab|grabs)\b/i;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Předmět za slovesem: jmenná fráze a počet, který před ní stojí („five candles“). */
function targetOf(after: string): { readonly label: string; readonly count: number | null } | null {
  const label = nounPhrase(after);
  if (label === null) return null;
  const counted = readCountedNouns(after).find((entry) => label.endsWith(entry.noun));
  return { label, count: counted?.count ?? null };
}

function chaseOf(sentence: string): { readonly label: string; readonly count: number | null } | null {
  const match = CATCH.exec(sentence);
  const phrase = match?.[1];
  return phrase === undefined ? null : targetOf(phrase);
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Předmět cíle pro text hráči (P54C T14r2): „the candle“ u jednoho, „all 5 candles“ u víc. */
function questTargets(label: string, count: number): string {
  return count === 1 ? `the ${singular(label)}` : `all ${String(count)} ${plural(singular(label), count)}`;
}

function compileQuest(spec: GenreSpecOf<'quest'>) {
  const station = spec.mode === 'station';
  // Cíl je věc, ke které se jde; bez ní věc ke sběru nebo terč (P39).
  const goal = castFor(spec, 'reach', 'collect', 'throw_at');
  const verb = goal?.verb ?? 'use';
  const label = goal?.label ?? 'star';
  const kind = verbKindOf(verb);
  // Scéna umí nakreslit jen stavy svého druhu; počet ze specu platí jen pro sloveso bez druhu.
  const states = kind === null ? (goal?.states ?? 2) : KIND_STATES[kind];
  const count = spec.params?.count ?? (station ? STATION.count : SPATIAL.count);
  // Lovec je věc, která honí; i ta, které se hráč vyhýbá, honí – jmenovaná věc nezmizí. Úkol bez lovce = `chasers: 0`.
  const foe = castFor(spec, 'chase_me', 'avoid', 'fight', 'shoot_at');
  const said = spec.params?.chasers ?? (foe === undefined ? DEFAULT_CHASERS : ESCAPE.chasers.default);
  // Hlídka (P36A T8) aspoň jedna.
  const chasers = station ? 0 : foe?.patrol === true ? Math.max(1, said) : said;
  const patrol = foe?.patrol === true && chasers > 0 ? { patrol: ESCAPE.patrolSight } : {};
  // Kolo roste s prací: kroky stavu × čas na krok, s honičkou robot hodně uhýbá. Měřeno (T4, p95 robota):
  // 8 stromů × 3 stavy bez honičky 23 s, se třemi pronásledovateli 75 s; 5 svíček + 2 duchové 29 s.
  const steps = count * (states - 1);
  // Kola (P36A T4): po `count` cílech další kolo, výhra až v posledním; kol tolik, aby robot hrál 30–90 s.
  // Oprava na místě drží 1 s – kolo dvou stanovišť by jinak trvalo 1 s.
  const hold = station && states === 2 ? QUEST.rounds.stationHold : undefined;
  // Čas z věty (nebo `timeLimit` režiséra, `compileWith`) jsou hodiny: kol jen tolik, kolik se do nich vejde (F3).
  const clock = spec.params?.seconds;
  const plan = station
    ? questRounds(steps, () => stationRoundSeconds({ count, states, hold: hold ?? STATION.hold, after: STATION.after }), clock)
    : questRounds(steps, (k) => spatialRoundSeconds(count, states, wavesChasers(chasers, k)), clock);
  // Hodiny jako u sběru ve vlnách: robot je stihne s rezervou, pod horizontem ověření.
  const plannedSeconds = clock ?? Math.min(WAVE_PLAN.clockMax, Math.round(plan.seconds * WAVE_PLAN.clockFactor + WAVE_PLAN.clockMargin));
  const seconds = spec.params?.paceBudgetPct === undefined ? plannedSeconds : Math.floor(plannedSeconds * spec.params.paceBudgetPct / 100);
  const hunter = foe?.label ?? 'hunter';
  const verbText = capital(verb);
  const each = plan.rounds > 1 ? ` in each of ${String(plan.rounds)} rounds` : '';
  const targets = questTargets(label, count);
  return legacySpec(spec, {
    control: 'move_free',
    controlParams: {
      generator: station ? 'quest_station' : 'quest_spatial',
      // Pravidlo bere sloveso jedním slovem (`verbSchema`).
      tuning: {
        count,
        states,
        verb: verb.trim().toLowerCase().replace(/\s+/g, '-'),
        ...(plan.rounds > 1 ? { rounds: plan.rounds } : {}),
        ...(hold === undefined ? {} : { hold }),
        ...(station ? {} : { chasers }),
        ...patrol,
      },
    },
    // Změnit stav každého cíle je hádanka nad rolí cílů; počet nese `tuning` i role.
    archetype: 'switch_puzzle',
    title: `${titleCase(spec.hero)} Quest`,
    objective: {
      kind: 'puzzle',
      description:
        chasers > 0
          ? `${verbText} ${targets}${each} before the ${hunter} ${chasers === 1 ? 'catches' : 'catch'} you.`
          : `${verbText} ${targets}${each} within ${String(seconds)} seconds.`,
      role: 'target',
    },
    // Tři životy (P36A T2); berou je pronásledovatelé v prostoru a přetečení na místě (T3, `boil_over`).
    mechanics: [{ id: 'timer', params: { id: 'clock', seconds, onEnd: 'lose' } }, livesMechanic()],
    roles: [{ id: 'target', kind: 'target', label, count }, ...(chasers > 0 ? [{ id: 'hunter', kind: 'chaser' as const, label: hunter, count: chasers }] : [])],
    tutorial: {
      goalLine: `${verbText} ${targets}${plan.rounds > 1 ? `, ${String(plan.rounds)} rounds` : ''}.`,
      // Druhá věta jen pro kartu pauzy: výzva na startu bere první (`FirstPrompt`).
      controlsHint: station ? 'Drag or arrows to move, hold Use when it is ready. Stall and it boils over.' : 'Drag or arrows to move, hold Use next to a target.',
    },
    mood: chasers > 0 ? 'tense' : 'playful',
  });
}

export const questGenre: GenreModule<'quest'> = {
  id: 'quest',
  modes: ['spatial', 'station'],
  cues: CUES,
  heroClasses: ['humanoid', 'robot', 'animal', 'bird', 'monster'],
  paramBounds: {
    seconds: { min: 20, max: 80 },
    paceBudgetPct: { min: 50, max: 100 },
    count: { min: 1, max: 8 },
    chasers: { min: 0, max: CHASERS_MAX },
  },
  clockParam: 'seconds',
  availability: () => 'ready',
  compile: compileQuest,
  draftFill: (sentence, reading) => {
    const roles = draftRoles(sentence, reading);
    const found = verbIn(sentence);
    const kind = found === null ? null : verbKindOf(found.verb);
    const station = kind === 'cook' || STATION_WORDS.test(sentence);
    // Čtení modelem má přednost; bez něj předmět za slovesem.
    const read = reading?.roles.find((role) => role.kind === 'target');
    const target = read === undefined ? (found === null ? null : targetOf(found.after)) : { label: read.noun, count: read.count };
    const chase = station ? null : chaseOf(sentence);
    const count = target?.count ?? null;
    const params = {
      ...(count === null ? {} : { count: clamp(count, 1, station ? STATION_MAX : 8) }),
      // Počet honičů říká jen ten, kdo „chytí“; jinak jeden výchozí (P36A T3) – nese popisek nepřítele ze slovníku, když ho věta má.
      ...(station ? {} : { chasers: chase === null ? DEFAULT_CHASERS : clamp(chase.count ?? ESCAPE.chasers.default, 1, CHASERS_MAX) }),
    };
    // Kdo „chytí“, je pronásledovatel dřív než protivník ze čtení: draft bere z obsazení první věc každé role.
    const cast: CastItem[] = [
      ...(chase === null ? [] : [{ label: chase.label, does: 'chase_me' as const }]),
      ...(roles.cast ?? []),
      ...(found === null || target === null ? [] : [{ label: target.label, does: 'reach' as const, verb: found.verb, states: kind === null ? 2 : KIND_STATES[kind] }]),
    ];
    return {
      genre: 'quest',
      mode: station ? 'station' : 'spatial',
      ...roles,
      ...(cast.length === 0 ? {} : { cast }),
      ...(Object.keys(params).length > 0 ? { params } : {}),
    };
  },
};
