/**
 * Žánr Díra (P66 T6): hráč táhne díru joystickem po místě z věty, věci menší než díra do ní spadnou a díra roste
 * po stupních (ovládání `hole`, generátor `hole_swallow` v `arcade/pieces/hole.ts`).
 *
 * **Věci z věty a z místa.** Každá věc obsazení (kromě hrdiny) je věc pole – role `item1`…`item3`, tělo
 * `thing:item1`, model z popisku (`cast.things`). Kolem nich kulisy sady místa (`kitFor`, `setting-kits.json`), bez
 * sady kulisy rušného města. Třída velikosti věci věty jde ze slova (`thingClass`), kulisy z výšky v tabulce sady
 * (`kitClass`). Největší věc (finále) je věc věty třídy 3, jinak nejvyšší kulisa sady.
 *
 * Hloubka: `rounds` kol (1–3, výchozí 3) po `seconds` s (60–90); v každém kole cíl bodů, v posledním navíc
 * největší věc. Bez životů – větší věc díru jen zastaví.
 *
 * Věty sem od P66 T12 vede znak žánru v `classify.ts` (díra jako podmět, která polyká); e2e hraje z ručního specu
 * (`e2e/fixtures/p66-hole-spec.json`).
 */

import { HOLE, HOLE_KINDS, type HoleKind, kindRefOf, needOf } from '../arcade/pieces/hole';
import { type KitModel, kitFor, modelHeight } from '../arcade/look';
import { counted, nounPhrase, plural, singular } from '../draft/lexicon';

import { type CastItem, type GenreModule, type GenreSpecOf, draftRoles, legacySpec, titleCase } from './contract';

/** Místo bez sady kulis: díra jí rušné město (`GENRE_SETTING.hole`). */
export const HOLE_DEFAULTS = { setting: 'busy city' } as const;

/** Nejvýš tolik věcí věty a tolik kulis jedné třídy. */
const SAID_MAX = 3;
const KIT_PER_CLASS = 3;

/** Hlava podstatného jména → třída velikosti (0 = drobnost do 0,6 m, 3 = dům). Co tu není, je drobnost. */
const CLASS_WORDS: readonly (readonly [number, RegExp])[] = [
  [3, /^(?:house|home|building|tower|skyscraper|castle|barn|church|school|hotel|hospital|shop|store|mall|factory|stadium|lighthouse|windmill|temple|palace|apartment|office|museum|station|bridge|ship|plane|airplane|jet|rocket|train|whale|dinosaur|dino|dragon|monument|pyramid)$/],
  [2, /^(?:car|truck|bus|van|taxi|tractor|tank|boat|motorcycle|cart|tree|elephant|giraffe|horse|cow|bear|hippo|rhino|camel|statue|fountain|tent|kiosk|booth|limo|ambulance|jeep|camper|wagon|crane|digger|excavator)$/],
  [1, /^(?:person|people|man|woman|kid|child|boy|girl|human|pedestrian|tourist|dog|cat|pig|sheep|goat|deer|wolf|lion|tiger|zombie|robot|monster|alien|bench|chair|table|lamp|mailbox|bin|barrel|crate|box|bush|rock|sign|bicycle|bike|scooter|fridge|sofa|couch|snowman|pumpkin|keg)$/],
];

/** Třída velikosti věci věty podle hlavy jejího popisku. */
export function thingClass(label: string): number {
  const head = singular(label.toLowerCase().trim()).split(/\s+/).at(-1) ?? '';
  return CLASS_WORDS.find(([, words]) => words.test(head))?.[0] ?? 0;
}

/** Třída kulisy sady z její výšky (m). */
export const kitClass = (height: number): number => (height < 0.9 ? 0 : height < 1.9 ? 1 : height < 3.2 ? 2 : 3);

/** Jméno kulisy z id modelu („gen3d-glass-office-tower“ → „glass office tower“). */
export const kitLabel = (id: string): string => id.replace(/^(?:gen3d|cc0)-/, '').replaceAll('-', ' ');

/** Věci obsazení, které díra polyká: každá kromě hrdiny, bez opakování, nejvýš `SAID_MAX`. */
function saidThings(spec: Pick<GenreSpecOf<'hole'>, 'hero' | 'cast'>): string[] {
  const hero = singular(spec.hero.toLowerCase());
  const labels: string[] = [];
  for (const item of spec.cast ?? []) {
    const label = singular(item.label.toLowerCase());
    if (label === hero || labels.includes(label)) continue;
    labels.push(label);
  }
  return labels.slice(0, SAID_MAX);
}

/** Kulisy sady podle tříd: nejvýš `KIT_PER_CLASS` na třídu, rozložené po výšce (nejnižší, prostřední, nejvyšší). */
function kitKinds(kit: readonly KitModel[]): HoleKind[] {
  const out: HoleKind[] = [];
  for (let cls = 0; cls < 4; cls += 1) {
    const own = kit.filter((id) => kitClass(modelHeight(id)) === cls).sort((a, b) => modelHeight(a) - modelHeight(b) || a.localeCompare(b));
    const picks = own.length <= KIT_PER_CLASS ? own : [own[0]!, own[Math.floor(own.length / 2)]!, own[own.length - 1]!];
    out.push(...picks.map((kind) => ({ cls, kind })));
  }
  return out;
}

/** Ladění generátoru z věty: druhy věcí (věc věty napřed), největší věc a její jméno. */
export function holeKinds(spec: Pick<GenreSpecOf<'hole'>, 'hero' | 'cast' | 'setting'>): { readonly kinds: readonly HoleKind[]; readonly finale: string; readonly finaleLabel: string; readonly said: readonly string[] } {
  const own = kitFor(spec.setting);
  const kit = own.length > 0 ? own : kitFor(HOLE_DEFAULTS.setting);
  const said = saidThings(spec);
  // Věta bez věci: drobnost sady je věc věty, ať má hra roli, kterou HUD a vazby rolí čtou.
  const labels = said.length > 0 ? said : [kitLabel(kit.find((id) => kitClass(modelHeight(id)) === 0) ?? kit[0]!)];
  const things = labels.map((label, index) => ({ cls: thingClass(label), kind: `thing:item${String(index + 1)}`, label }));
  const bigSaid = things.find((thing) => thing.cls === 3);
  const tallest = [...kit].sort((a, b) => modelHeight(b) - modelHeight(a) || a.localeCompare(b))[0]!;
  const kinds = [...things.filter((thing) => thing !== bigSaid).map(({ cls, kind }) => ({ cls, kind })), ...kitKinds(kit).filter((kind) => kind.kind !== tallest || bigSaid !== undefined)];
  return {
    kinds: kinds.slice(0, HOLE_KINDS),
    finale: bigSaid?.kind ?? tallest,
    finaleLabel: bigSaid?.label ?? kitLabel(tallest),
    said: labels,
  };
}

/** Předmět slovesa polykání („swallows cars“, „eat every donut“, „sucks up the trash“). */
const SWALLOW_OBJECT = /\b(?:swallow|swallows|swallowed|swallowing|eat|eats|ate|eating|devour|devours|devoured|devouring|gobble|gobbles|gobbling|suck|sucks|sucking|consume|consumes|consuming)\s+(?:up\s+)?(?:the\s+|all\s+|every\s+|some\s+|whole\s+|\d+\s+)*([a-z][a-z -]*)/;
/** „eat it“, „swallow everything“ věc nejmenují. */
const NOT_THING = /^(?:it|them|everything|anything|all|up|whole)\b/;

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

export const holeGenre: GenreModule<'hole'> = {
  id: 'hole',
  modes: ['default'],
  // P66 T12: věty sem vede znak žánru v `classify.ts` (díra jako podmět, která polyká); narážky přidají bod.
  cues: ['black hole', 'sinkhole'],
  heroClasses: ['prop', 'monster', 'animal', 'vehicle', 'robot', 'humanoid'],
  paramBounds: {
    items: { min: HOLE.items.min, max: HOLE.items.max },
    rounds: { min: HOLE.rounds.min, max: HOLE.rounds.max },
    seconds: { min: HOLE.seconds.min, max: HOLE.seconds.max },
  },
  // P66 T12: živý – buňka `hole.default` je v `PRESETS` a věty sem vede klasifikátor.
  availability: () => 'ready',
  compile: (spec) => {
    const items = spec.params?.items ?? HOLE.items.default;
    const rounds = spec.params?.rounds ?? HOLE.rounds.default;
    const seconds = spec.params?.seconds ?? HOLE.seconds.default;
    const { kinds, finale, finaleLabel, said } = holeKinds(spec);
    const tuning: Record<string, number | string> = {
      ...(items === HOLE.items.default ? {} : { items }),
      ...(rounds === HOLE.rounds.default ? {} : { rounds }),
      ...(seconds === HOLE.seconds.default ? {} : { seconds }),
      ...Object.fromEntries(kinds.map((kind, k) => [`k${String(k)}`, kindRefOf(kind)])),
      finale,
    };
    const need = needOf(items, rounds);
    const lead = said[0] as string;
    const roundsLine = rounds === 1 ? `in ${String(seconds)} s` : `in each of ${counted(rounds, 'round')} of ${String(seconds)} s`;
    return legacySpec(spec, {
      control: 'hole',
      controlParams: { generator: 'hole_swallow', tuning },
      archetype: 'collect_exit',
      title: fit(80, /\bhole\b/i.test(spec.hero) ? titleCase(spec.hero) : `${titleCase(spec.hero)} Hole`, 'Hungry Hole'),
      objective: {
        kind: 'collect',
        description: fit(
          120,
          `Swallow things smaller than the hole to grow: ${counted(need, 'point')} ${roundsLine}, then the ${finaleLabel}.`,
          `Swallow ${counted(need, 'point')} ${roundsLine}, then the ${finaleLabel}.`,
          'Swallow smaller things to grow, then swallow the biggest one.',
        ),
        // Počet cíle = kola: cíl kola je v bodech (60 a víc) a schéma unese nejvýš 50 kusů. Body kola nese
        // `finish_collected.need` světa a popis; role je věc věty, kterou díra polyká.
        count: rounds,
        seconds,
        role: 'item1',
      },
      roles: said.map((label, index) => ({ id: `item${String(index + 1)}`, kind: 'collectible' as const, label, count: 1 })),
      tutorial: {
        goalLine: fit(80, `Swallow the ${plural(lead, 2)} and grow to eat the ${finaleLabel}!`, `Grow and swallow the ${finaleLabel}!`, 'Grow and swallow the biggest thing!'),
        controlsHint: 'Drag to move the hole. Arrows work too. Bigger things block it.',
      },
      mood: 'playful',
      targetDurationSec: Math.min(180, rounds * seconds),
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    // Díra zná jen věci, které polyká: každá věc věty (i ta, před kterou se jinde utíká) padá do díry.
    let roles = (cast ?? []).map((item): CastItem => ({ label: item.label, does: 'collect' }));
    const found = SWALLOW_OBJECT.exec(sentence.toLowerCase());
    const phrase = found === null ? null : nounPhrase(found[1] as string);
    if (phrase !== null && !NOT_THING.test(phrase)) {
      const label = singular(phrase);
      roles = [{ label, does: 'collect' }, ...roles.filter((item) => item.label !== label)];
    }
    return {
      genre: 'hole',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      setting: setting ?? HOLE_DEFAULTS.setting,
      ...(roles.length === 0 ? {} : { cast: roles.slice(0, SAID_MAX) }),
    };
  },
};
