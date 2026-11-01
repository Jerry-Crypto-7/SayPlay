/**
 * Žánr Minigolf (P68 T7, kategorie `vozidla-sport`): jedna jamka s odpalištěm, mantinely, odrazníky z věty a nejvýš
 * jednou pohyblivou překážkou; míček se odpálí nabitím a puštěním (vstup hodu `throw-rig`, ovládání `minigolf`,
 * generátor `minigolf_course` v `arcade/pieces/minigolf.ts`), pohled přes rameno (`shoulder`). Výhra = míček v jamce
 * do limitu ran (par + 3), prohra = rány došly nebo 90 s.
 *
 * Obsazení: hráč je vždy míček (model `gen3d-golf-ball`), hrdina věty jde jen do popisku. Věci z věty jsou odrazníky
 * (první věc → model odrazníků přes `sceneModelOf`); věc, kterou věta hýbe („a spinning windmill“, „a sliding snake“,
 * „a moving coffin“), je pohyblivá překážka (`patrol` v obsazení → `moving` a její model). Místo jde do `theme`.
 *
 * Parametry (`paramBounds`): `bends` 0–2 = rovná / L / S, `obstacles` 1–3 odrazníků, `moving` 0–1, `par` 2–4. Bez nich
 * tvar a počet odrazníků losuje stream jamky (`minigolf-hole.ts`); par bez tvaru tvar určí (par 2 rovná, 3 L, 4 S).
 *
 * **Brána aktivace:** modul zůstává `staged`, jak ho kostra P68-I určila, a dokud je `staged`, překlad hází jako kostra
 * (test kostry `p68-staged.test.ts`). Skutečný překlad je `compileMinigolf`; zapojení (P68-I „zapoj minigolf“) přepne
 * `availability` na `ready` a `compile` tím ožije – víc není třeba.
 */

import { sceneModelOf } from '../arcade/models';
import { MINIGOLF_SHAPES } from '../arcade/pieces/minigolf-hole';
import { nounPhrase, singular } from '../draft/lexicon';
import type { GameSpecV1 } from '../spec';

import { type CastItem, type GenreModule, type GenreSpecOf, draftRoles, legacySpec, titleCase } from './contract';

/** Meze parametrů modulu (celá čísla, jak je nese `GenreSpec.params`). */
export const MINIGOLF_GENRE = {
  bends: { min: 0, max: 2 },
  obstacles: { min: 1, max: 3 },
  moving: { min: 0, max: 1 },
  par: { min: 2, max: 4 },
} as const;

/** Narážky klasifikátoru (zapojí je P68-I; tady jen seznam). */
export const MINIGOLF_CUES = ['mini golf', 'minigolf', 'putt', 'golf course', 'hole in one', 'golf ball through'] as const;

/** Slova věty, která jsou hra sama, ne věc na dráze. */
const GOLF_WORDS = /^(?:(?:mini |crazy )?golf(?: ball| course| green| hole| club)?|minigolf|ball|hole|hole in one|flag|green|course|putt|club|tee|par|stroke)s?$/;
/** Pohyb věci ve větě: „a spinning windmill“, „a sliding snake“, „a moving coffin“. */
const MOTION = /^(?:(?:a|an|the)\s+)?(?:moving|sliding|spinning|swinging|rolling|rotating|turning|sweeping|slithering|swaying|bouncing|patrolling)\s+/;
/** Předložky, na kterých se věta dělí na úseky: za překážkovou jsou věci dráhy, za místní místo. */
const PREPOSITION = /\b(with|past|around|between|through|over|among|dodging|avoiding|behind|beside|under|in|inside|on|at|across|to|into|onto|as|near|by|from|for)\b/;
const THING_AFTER = new Set(['with', 'past', 'around', 'between', 'through', 'over', 'among', 'dodging', 'avoiding', 'behind', 'beside', 'under']);
const PLACE_AFTER = new Set(['in', 'inside', 'on', 'at', 'under', 'across']);
const GOLF_TAIL = /(?:^|\s+)(?:mini|crazy|golf|minigolf|course|green|hole)$/;

/** Úseky věty `[předložka, text do další předložky]`. */
function segmentsOf(text: string): [string, string][] {
  const parts = text.split(PREPOSITION);
  return Array.from({ length: (parts.length - 1) / 2 }, (_, k) => [parts[2 * k + 1] as string, parts[2 * k + 2] as string]);
}

/** Místo z věty minigolfu („on a candy island“, „in a museum mini golf course“ bez golfových slov na konci), nebo nic. */
function placeOf(text: string): string | undefined {
  for (const [word, rest] of segmentsOf(text)) {
    if (!PLACE_AFTER.has(word)) continue;
    let phrase = nounPhrase(rest, 4) ?? '';
    while (GOLF_TAIL.test(phrase)) phrase = phrase.replace(GOLF_TAIL, '');
    if (phrase !== '' && !GOLF_WORDS.test(phrase)) return phrase;
  }
  return undefined;
}

/** Věci dráhy z věty v pořadí výskytu (víc jich spojí čárka nebo „and“); `patrol` = věta jimi hýbe. Bez místa a golfových slov. */
function thingsOf(text: string, setting: string | undefined): CastItem[] {
  const out: CastItem[] = [];
  for (const [word, rest] of segmentsOf(text)) {
    if (!THING_AFTER.has(word)) continue;
    for (const part of rest.trim().split(/\s*(?:,|\band\b)\s*/)) {
      const moving = MOTION.test(part);
      const phrase = nounPhrase(part.replace(MOTION, ''), 2);
      const label = phrase === null ? null : singular(phrase);
      if (label === null || GOLF_WORDS.test(label) || label === setting || out.some((item) => item.label === label)) continue;
      out.push({ label, does: 'scenery', ...(moving ? { patrol: true } : {}) });
    }
  }
  return out;
}

/** Model věci z věty pro tělo dráhy (id katalogu, které `minigolfParams` vezme), nebo nic. */
const kindOf = (label: string | undefined): string | undefined => {
  const model = label === undefined ? undefined : sceneModelOf(label, false);
  return model !== undefined && /^[a-z0-9][a-z0-9-]{0,36}$/.test(model) ? model : undefined;
};

/** Překlad `GenreSpec` → spec hry (bez brány aktivace). Exportovaný pro testy a pro zapojení. */
export function compileMinigolf(spec: GenreSpecOf<'minigolf'>): GameSpecV1 {
  const params = spec.params ?? {};
  const things = (spec.cast ?? []).filter((item) => !GOLF_WORDS.test(item.label));
  const mover = things.find((item) => item.patrol === true);
  // Odrazníky kreslí model první věci, která ho v katalogu má („craters and a rocket“ → raketa).
  const bumper = things.find((item) => item !== mover && kindOf(item.label) !== undefined) ?? things.find((item) => item !== mover);
  const moving = params.moving === undefined ? mover !== undefined : params.moving === 1;
  const bends = params.bends ?? (params.par === undefined ? undefined : params.par - 2);
  // Par pod počtem úseků trasy by jamka odmítla (`checkMinigolfHole`): zvedne se na ně.
  const par = params.par === undefined ? undefined : Math.max(params.par, (bends ?? 0) + 1);
  const bumperKind = kindOf(bumper?.label);
  const moverKind = moving ? kindOf(mover?.label) : undefined;
  const tuning = {
    ...(bends === undefined ? {} : { shape: MINIGOLF_SHAPES[bends] as string }),
    ...(params.obstacles === undefined ? {} : { obstacles: params.obstacles }),
    ...(moving ? { moving: true } : {}),
    ...(par === undefined ? {} : { par }),
    ...(bumperKind === undefined ? {} : { bumper: bumperKind }),
    ...(moverKind === undefined ? {} : { mover: moverKind }),
  };
  const place = titleCase(spec.setting);
  const title = `${place} Mini Golf`;
  return legacySpec(spec, {
    control: 'minigolf',
    controlParams: { generator: 'minigolf_course', ...(Object.keys(tuning).length === 0 ? {} : { tuning }) },
    archetype: 'hazard_crossing',
    title: title.length <= 60 ? title : 'Mini Golf',
    objective: { kind: 'reach', description: 'Putt the ball around the obstacles into the hole in as few strokes as you can.', role: 'hole' },
    mechanics: [],
    roles: [
      { id: 'hole', kind: 'destination', label: 'hole' },
      ...(bumper === undefined ? [] : [{ id: 'bumper', kind: 'prop' as const, label: bumper.label, count: params.obstacles ?? 1 }]),
      ...(moving && mover !== undefined ? [{ id: 'mover', kind: 'prop' as const, label: mover.label }] : []),
    ],
    tutorial: { goalLine: 'Sink the ball in as few strokes as you can!', controlsHint: 'Drag back from the ball and let go. Keys: arrows aim, hold Space.' },
    mood: 'playful',
    targetDurationSec: 30,
  });
}

export const minigolfGenre: GenreModule<'minigolf'> = {
  id: 'minigolf',
  modes: ['default'],
  cues: [...MINIGOLF_CUES],
  heroClasses: ['prop', 'animal', 'humanoid', 'robot'],
  paramBounds: MINIGOLF_GENRE,
  // Zapnuto v P68-I T9 („zapoj minigolf“, `vozidla-sport/integration.md` → Modul na `ready`); režisér a čtečka dál
  // za branou `DIRECTOR_PENDING` / `READER_PENDING`.
  availability: () => 'ready',
  compile: (spec) => {
    if (minigolfGenre.availability(spec.mode) !== 'ready') throw new Error('Genre minigolf is not live yet');
    return compileMinigolf(spec);
  },
  draftFill: (sentence, reading) => {
    const roles = draftRoles(sentence, reading);
    const text = sentence.toLowerCase();
    const setting = placeOf(text) ?? roles.setting;
    // Věci z věty jsou překážky dráhy (ta, kterou věta hýbe, jezdí – `patrol`); obsazení čtení jde za nimi.
    const said = thingsOf(text, setting);
    const read = (roles.cast ?? []).filter((item) => !GOLF_WORDS.test(item.label) && item.label !== setting && !said.some((other) => other.label === item.label)).map((item): CastItem => ({ label: item.label, does: 'scenery' }));
    const cast = [...said, ...read].slice(0, 4);
    return {
      genre: 'minigolf',
      mode: 'default',
      hero: 'golf ball',
      ...(setting === undefined ? {} : { setting }),
      ...(cast.length === 0 ? {} : { cast }),
      ...(cast.some((item) => item.patrol === true) ? { params: { moving: 1 } } : {}),
    };
  },
};
